import { Type } from "@google/genai";
import type { Browser, Page } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { Tool, ToolContext } from "./agent-types";

/**
 * Playwright-backed browser tools. One shared browser per agent run,
 * held in a module-level handle so multiple tool calls reuse the same
 * session (clicks and types expect to land on the page the previous
 * navigate step opened). The executor calls `closeBrowserSession` at
 * run-end to release the process.
 *
 * Locator strategy — we expose three ways to target an element because
 * real flows need all three:
 *   - `role + name` (accessibility-first — getByRole) — most robust
 *   - `text` — getByText for links/buttons with distinct labels
 *   - `selector` — raw CSS/XPath fallback for pages where the above
 *     don't uniquely match
 * The agent picks based on what it sees in the live page — it can
 * inspect the DOM via extract_text or screenshot first and choose.
 */

interface BrowserSession {
  browser: Browser;
  page: Page;
}

let activeSession: BrowserSession | null = null;

/**
 * Lazily spawn (or reuse) the agent's browser session. Called via
 * ctx.getBrowser(). Headless by default so runs don't steal the user's
 * focus — `{ headed: true }` opens a visible window so the user can
 * watch the agent navigate, useful for debugging or first-time runs of
 * a new flow. The flag is honoured only on first launch within a run;
 * later getBrowser() calls return the existing session regardless.
 */
export async function getOrCreateBrowser(opts: { headed?: boolean } = {}): Promise<Page> {
  if (activeSession) return activeSession.page;
  // Lazy import so playwright's chromium launcher doesn't warm up until
  // a flow actually needs the browser.
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext();
  const page = await context.newPage();
  activeSession = { browser, page };
  return page;
}

/**
 * Close the current browser session and release chromium. Safe to call
 * when no session is active — no-op.
 */
export async function closeBrowserSession(): Promise<void> {
  if (!activeSession) return;
  const { browser } = activeSession;
  activeSession = null;
  try {
    await browser.close();
  } catch {
    // Already dead or mid-shutdown — swallow, we don't want to fail a
    // successful run on cleanup noise.
  }
}

// --- Locator helper ---------------------------------------------------

/**
 * Resolve a locator based on the three targeting strategies. Mirrors the
 * function-declaration shape so every tool that takes an element argument
 * can accept the same `{ selector?, role?, name?, text? }` shape.
 */
function locate(page: Page, args: Record<string, unknown>): import("playwright").Locator {
  const role = args.role as string | undefined;
  const name = args.name as string | undefined;
  const text = args.text as string | undefined;
  const selector = args.selector as string | undefined;
  if (role) return page.getByRole(role as Parameters<Page["getByRole"]>[0], name ? { name } : undefined);
  if (text) return page.getByText(text, { exact: false });
  if (selector) return page.locator(selector);
  throw new Error("Element-targeting tools require one of: role+name, text, or selector.");
}

const TARGET_PROPERTIES = {
  role: {
    type: Type.STRING,
    description: "ARIA role (button, link, textbox, heading, etc.) — preferred for robustness.",
  },
  name: {
    type: Type.STRING,
    description: "Accessible name when role is given (e.g. 'Submit', 'Search').",
  },
  text: {
    type: Type.STRING,
    description: "Alternative to role+name: any substring of the visible text.",
  },
  selector: {
    type: Type.STRING,
    description: "Fallback CSS/XPath selector when role/text can't uniquely target.",
  },
};

// --- Browser tools ----------------------------------------------------

const browserOpen: Tool = {
  declaration: {
    name: "browser_open",
    description:
      "Navigate to a URL. Launches chromium on first call. Returns { url, title, status }.",
    parameters: {
      type: Type.OBJECT,
      properties: { url: { type: Type.STRING } },
      required: ["url"],
    },
  },
  async invoke(args, ctx: ToolContext) {
    const page = await ctx.getBrowser();
    const url = String(args.url);
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return { url: page.url(), title: await page.title(), status: res?.status() ?? null };
  },
};

const browserClick: Tool = {
  declaration: {
    name: "browser_click",
    description:
      "Click an element. Target it via role+name (preferred), text substring, or selector fallback.",
    parameters: { type: Type.OBJECT, properties: TARGET_PROPERTIES },
  },
  async invoke(args, ctx: ToolContext) {
    const page = await ctx.getBrowser();
    await locate(page, args).first().click({ timeout: 10_000 });
    return { clicked: true, url: page.url() };
  },
};

const browserType: Tool = {
  declaration: {
    name: "browser_type",
    description:
      "Type text into an input. Clears existing value first. Target via role+name (e.g. role='textbox'), selector, or text.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ...TARGET_PROPERTIES,
        value: { type: Type.STRING, description: "Text to type into the element." },
      },
      required: ["value"],
    },
  },
  async invoke(args, ctx: ToolContext) {
    const page = await ctx.getBrowser();
    const value = String(args.value ?? "");
    await locate(page, args).first().fill(value, { timeout: 10_000 });
    return { typed: true, value };
  },
};

const browserWaitFor: Tool = {
  declaration: {
    name: "browser_wait_for",
    description:
      "Wait for an element to appear. Times out after 30s. Returns { matched: true } once visible.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ...TARGET_PROPERTIES,
        state: {
          type: Type.STRING,
          description: "attached | visible | hidden | detached. Defaults to visible.",
        },
      },
    },
  },
  async invoke(args, ctx: ToolContext) {
    const page = await ctx.getBrowser();
    const state = (args.state as "attached" | "visible" | "hidden" | "detached" | undefined) ?? "visible";
    await locate(page, args).first().waitFor({ state, timeout: 30_000 });
    return { matched: true, state };
  },
};

const browserExtractText: Tool = {
  declaration: {
    name: "browser_extract_text",
    description:
      "Return the visible text of an element (or the whole page body if no target given). Truncated to 32 KB.",
    parameters: { type: Type.OBJECT, properties: TARGET_PROPERTIES },
  },
  async invoke(args, ctx: ToolContext) {
    const page = await ctx.getBrowser();
    const hasTarget = args.role || args.text || args.selector;
    const el = hasTarget ? locate(page, args).first() : page.locator("body");
    const text = (await el.innerText({ timeout: 10_000 })) ?? "";
    const max = 32 * 1024;
    return {
      text: text.length > max ? text.slice(0, max) + "\n[... truncated ...]" : text,
      truncated: text.length > max,
    };
  },
};

const browserScreenshot: Tool = {
  declaration: {
    name: "browser_screenshot",
    description:
      "Capture a PNG of the current viewport, save it to the temp dir, return { path }. Useful for vision fallback / audit.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  async invoke(_args, ctx: ToolContext) {
    const page = await ctx.getBrowser();
    const outDir = path.join(os.tmpdir(), "flowmind-agent-screenshots");
    if (!fs.existsSync(outDir)) {
      await (await import("node:fs/promises")).mkdir(outDir, { recursive: true });
    }
    const file = path.join(outDir, `shot-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return { path: file };
  },
};

const browserClose: Tool = {
  declaration: {
    name: "browser_close",
    description:
      "Close the browser session. Automatically called at run end, but the agent can call it earlier to release resources.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  async invoke() {
    await closeBrowserSession();
    return { closed: true };
  },
};

export const BROWSER_TOOLS: Record<string, Tool> = Object.fromEntries(
  [
    browserOpen,
    browserClick,
    browserType,
    browserWaitFor,
    browserExtractText,
    browserScreenshot,
    browserClose,
  ].map((t) => [t.declaration.name, t])
);
