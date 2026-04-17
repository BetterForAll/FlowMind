#!/usr/bin/env python3
"""FlowMind Stage 3 desktop-control bridge.

Receives JSON-RPC requests on stdin, one per line, and writes JSON responses
to stdout. The Node.js side (src/engine/agent-desktop.ts) spawns this script
once per agent run that needs Level 2 (desktop) tools, and keeps the process
alive across many tool calls — much cheaper than spawning Python per call.

Wire format
-----------
Request (one JSON object per line, terminated by \\n):
    {"id": 1, "method": "window_focus", "params": {"title": "Notepad"}}

Response:
    {"id": 1, "result": {"focused": true, "title": "Untitled - Notepad"}}
    {"id": 1, "error": "Window not found: Notepad"}

The "id" round-trips so the Node side can correlate replies with calls.

Why JSON-RPC over stdin/stdout (not sockets, not pyinvoke):
    - One Python process per agent run keeps pywinauto + uiautomation COM
      handles warm. Spawning per-call would add ~500ms each.
    - stdin/stdout requires no port allocation, no firewall prompts, no
      shutdown-by-signal coordination — closing stdin ends the process
      cleanly.
    - The Node child_process API gives us back-pressure and error
      propagation for free.

Dependencies (installed by the Node side via pip on first use):
    pywinauto       - semantic Windows UI Automation (find by name+role)
    uiautomation    - alternative UIA wrapper, used as fallback
    pyautogui       - coordinate-based mouse/keyboard, screen capture
    pillow          - required by pyautogui for screenshot
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import traceback
from typing import Any, Callable

# Lazy imports — keep startup fast and let the Node side surface a
# clean error when a tool's dependency is missing rather than crashing
# the whole helper at import time.
_pywinauto = None
_uiautomation = None
_pyautogui = None


def _require_pywinauto():
    global _pywinauto
    if _pywinauto is None:
        import pywinauto  # type: ignore
        _pywinauto = pywinauto
    return _pywinauto


def _require_uiautomation():
    global _uiautomation
    if _uiautomation is None:
        import uiautomation as auto  # type: ignore
        _uiautomation = auto
    return _uiautomation


def _require_pyautogui():
    global _pyautogui
    if _pyautogui is None:
        import pyautogui  # type: ignore
        # Disable the failsafe corner-trip — long-running automations
        # legitimately move the mouse near the screen edge. The agent's
        # own step ceiling and the user's Stop button are the safety net.
        pyautogui.FAILSAFE = False
        _pyautogui = pyautogui
    return _pyautogui


# ----- Tools ----------------------------------------------------------


def tool_ping(_: dict) -> dict:
    """Round-trip check used by the Node bridge to confirm the helper
    is alive after spawn. No side effects."""
    return {"pong": True, "pid": os.getpid()}


def tool_window_list(_: dict) -> dict:
    """Enumerate top-level windows with non-empty titles. Returns a
    list of {title, handle, pid, class_name} — handle is what
    window_focus accepts as a stable id (titles can collide)."""
    auto = _require_uiautomation()
    windows = []
    for w in auto.GetRootControl().GetChildren():
        try:
            name = w.Name or ""
            if not name.strip():
                continue
            windows.append(
                {
                    "title": name,
                    "handle": int(w.NativeWindowHandle),
                    "pid": int(w.ProcessId),
                    "class_name": w.ClassName or "",
                }
            )
        except Exception:
            continue
    return {"windows": windows}


def tool_window_focus(params: dict) -> dict:
    """Bring a window to the foreground. Accepts either {handle: int}
    (preferred — stable across title changes) or {title: str} (substring
    match, case-insensitive)."""
    pw = _require_pywinauto()
    if "handle" in params:
        app = pw.Application(backend="uia").connect(handle=int(params["handle"]))
        win = app.top_window()
    elif "title" in params:
        title = str(params["title"])
        app = pw.Application(backend="uia").connect(title_re=f"(?i).*{title}.*")
        win = app.top_window()
    else:
        raise ValueError("window_focus requires either 'handle' or 'title'")
    win.set_focus()
    return {"focused": True, "title": win.window_text()}


def tool_app_launch(params: dict) -> dict:
    """Spawn an executable. {path: str, args?: [str]}. Returns the
    new process's pid — the agent can pass it back to window_focus
    after a brief settle delay if it needs to interact with the
    spawned window."""
    pw = _require_pywinauto()
    path = str(params["path"])
    args = params.get("args") or []
    cmdline = path if not args else f'"{path}" ' + " ".join(f'"{a}"' for a in args)
    app = pw.Application(backend="uia").start(cmdline)
    return {"launched": True, "pid": app.process}


def _find_control(window_title: str, name: str | None, role: str | None,
                  automation_id: str | None):
    """Shared element resolver. Tries pywinauto's child_window with the
    most specific criteria first; raises if no match."""
    pw = _require_pywinauto()
    app = pw.Application(backend="uia").connect(title_re=f"(?i).*{window_title}.*")
    win = app.top_window()
    criteria: dict[str, Any] = {}
    if name:
        criteria["title"] = name
    if role:
        # pywinauto uses control_type for the ARIA-equivalent role.
        criteria["control_type"] = role
    if automation_id:
        criteria["auto_id"] = automation_id
    if not criteria:
        raise ValueError("control lookup requires at least one of name/role/automation_id")
    return win.child_window(**criteria).wait("exists visible enabled", timeout=5)


def tool_control_click(params: dict) -> dict:
    """Click a UI control inside a named window. Targets via
    {window: str, name?, role?, automation_id?}. Robust against window
    moves and theme changes — uses UIA, not coordinates."""
    win_title = str(params["window"])
    ctrl = _find_control(
        win_title,
        params.get("name"),
        params.get("role"),
        params.get("automation_id"),
    )
    ctrl.click_input()
    return {"clicked": True}


def tool_control_type(params: dict) -> dict:
    """Type text into a UI control. {window, name?, role?, automation_id?,
    text}. Sets focus first; existing content is NOT cleared (caller
    can send Ctrl+A + Delete via keyboard_send if needed)."""
    win_title = str(params["window"])
    text = str(params["text"])
    ctrl = _find_control(
        win_title,
        params.get("name"),
        params.get("role"),
        params.get("automation_id"),
    )
    ctrl.set_focus()
    ctrl.type_keys(text, with_spaces=True)
    return {"typed": True, "chars": len(text)}


def tool_keyboard_send(params: dict) -> dict:
    """Send keys to the foreground window. {keys: str} — accepts the
    pyautogui hotkey shorthand: 'enter', 'tab', 'ctrl+s', etc. For raw
    text typing into the focused control, prefer control_type."""
    pg = _require_pyautogui()
    keys = str(params["keys"])
    # If the spec contains '+' it's a hotkey combination; otherwise it's
    # a single named key.
    if "+" in keys:
        parts = [k.strip().lower() for k in keys.split("+")]
        pg.hotkey(*parts)
    else:
        pg.press(keys.strip().lower())
    return {"sent": keys}


def tool_screen_screenshot(_: dict) -> dict:
    """Capture the primary monitor and save the PNG to the user's
    temp dir. Returns {path}. The Node side reads the file and either
    forwards it to the vision tool or attaches it to the trace."""
    pg = _require_pyautogui()
    out_dir = os.path.join(tempfile.gettempdir(), "flowmind-agent-screens")
    os.makedirs(out_dir, exist_ok=True)
    fname = f"shot-{int(time.time() * 1000)}.png"
    path = os.path.join(out_dir, fname)
    img = pg.screenshot()
    img.save(path)
    return {"path": path, "width": img.width, "height": img.height}


def tool_mouse_click_at(params: dict) -> dict:
    """Coordinate-based click — used by the vision-locate fallback when
    UI Automation can't reach an element. {x, y, button?: 'left'|'right',
    double?: bool}. Coordinates are absolute screen pixels."""
    pg = _require_pyautogui()
    x, y = int(params["x"]), int(params["y"])
    button = str(params.get("button") or "left")
    double = bool(params.get("double") or False)
    pg.moveTo(x, y, duration=0.1)
    if double:
        pg.doubleClick(button=button)
    else:
        pg.click(button=button)
    return {"clicked": True, "x": x, "y": y}


# ----- Dispatcher -----------------------------------------------------


TOOLS: dict[str, Callable[[dict], dict]] = {
    "ping": tool_ping,
    "window_list": tool_window_list,
    "window_focus": tool_window_focus,
    "app_launch": tool_app_launch,
    "control_click": tool_control_click,
    "control_type": tool_control_type,
    "keyboard_send": tool_keyboard_send,
    "screen_screenshot": tool_screen_screenshot,
    "mouse_click_at": tool_mouse_click_at,
}


def main() -> None:
    """JSON-RPC loop. One request per line. EOF on stdin = shutdown."""
    # Force unbuffered stdout so responses reach the Node side immediately
    # after each request.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            req_id = req.get("id")
            method = req.get("method")
            params = req.get("params") or {}
            handler = TOOLS.get(method)
            if handler is None:
                response = {"id": req_id, "error": f"Unknown tool: {method}"}
            else:
                result = handler(params)
                response = {"id": req_id, "result": result}
        except Exception as e:
            tb = traceback.format_exc(limit=4)
            response = {
                "id": req.get("id") if isinstance(req, dict) else None,
                "error": f"{type(e).__name__}: {e}",
                "traceback": tb,
            }
        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
