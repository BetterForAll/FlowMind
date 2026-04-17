import fs from "node:fs/promises";
import { GoogleGenAI, Type } from "@google/genai";
import type { Tool, ToolContext } from "./agent-types";
import { DESKTOP_TOOLS } from "./agent-desktop";

/**
 * Vision-locate tool — the fallback path when UI Automation can't reach
 * an element. The agent describes what it's looking for ("the blue
 * 'Continue' button"), this tool takes a fresh screenshot, hands it to
 * Gemini 2.5 Pro multimodal, and returns the centre coordinates of the
 * matching region. The agent then calls `mouse_click_at` with those
 * coordinates.
 *
 * This is the same model Anthropic Computer Use and OpenAI Operator use:
 * a screenshot + a description gets you a click target on apps that
 * expose nothing through accessibility (custom-drawn games, certain
 * Electron variants, image-only PDFs in viewers, etc.). Slower and
 * flakier than UIA but works on anything visible.
 *
 * Requires the desktop helper for the screenshot (Python's pyautogui).
 * The Gemini call itself is pure Node.
 */

const VISION_PROMPT = `You are a UI element locator. The user will give you a screenshot and a description of an element. Find the element and return its centre point as pixel coordinates relative to the top-left of the image.

Respond with a single JSON object:
{
  "found": true | false,
  "x": <integer pixel x, omit if not found>,
  "y": <integer pixel y, omit if not found>,
  "confidence": "high" | "medium" | "low",
  "reason": "<one short sentence — what you saw, or why you couldn't find it>"
}

Rules:
- Coordinates must be integers within the image bounds.
- Pick the centre of the matching element, not its top-left corner.
- If multiple candidates match, pick the most prominent one and say so in "reason".
- If nothing reasonably matches, set "found": false. Don't guess.

Return ONLY the JSON. No code fences, no commentary.`;

interface VisionResult {
  found: boolean;
  x?: number;
  y?: number;
  confidence?: "high" | "medium" | "low";
  reason?: string;
}

/**
 * Make a vision-locate tool bound to the given Gemini model. We accept
 * the model as a constructor arg so the executor can pass whichever
 * model the user has configured (vision needs a multimodal model — Pro
 * is the conservative default; Flash/Flash-Lite also support images).
 */
export function createVisionLocateTool(model: string): Tool {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY required for vision_locate.");
  }
  const genai = new GoogleGenAI({ apiKey });

  return {
    declaration: {
      name: "vision_locate",
      description:
        "Find an element on screen by visual description when UI Automation can't. Captures a screenshot, asks Gemini to locate the element, returns { found, x, y, confidence }. Pair with mouse_click_at to actually click. Use this only after UIA tools fail — it's slower and flakier than control_click.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          description: {
            type: Type.STRING,
            description:
              "Plain-English description of what to find. Be specific: 'the blue Continue button at the bottom-right' beats 'the button'.",
          },
        },
        required: ["description"],
      },
    },
    async invoke(args, ctx: ToolContext): Promise<Record<string, unknown>> {
      const description = String(args.description ?? "");
      if (!description) {
        throw new Error("vision_locate requires a 'description' argument.");
      }

      // Take a screenshot via the Python helper. We re-use the
      // desktop tool registry so we don't duplicate the rpc plumbing.
      const screenshotTool = DESKTOP_TOOLS.screen_screenshot;
      if (!screenshotTool) {
        throw new Error(
          "screen_screenshot tool unavailable — desktop helper not loaded."
        );
      }
      const shot = (await screenshotTool.invoke({}, ctx)) as {
        path: string;
        width: number;
        height: number;
      };

      const imageBytes = await fs.readFile(shot.path);
      const imageBase64 = imageBytes.toString("base64");

      const response = await genai.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              { text: VISION_PROMPT },
              {
                text: `\n\nElement to find: ${description}\nImage size: ${shot.width}x${shot.height}`,
              },
              { inlineData: { mimeType: "image/png", data: imageBase64 } },
            ],
          },
        ],
        config: { responseMimeType: "application/json" },
      });

      const raw = (response.text ?? "").trim();
      let parsed: VisionResult;
      try {
        const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
        parsed = JSON.parse(cleaned) as VisionResult;
      } catch (err) {
        throw new Error(
          `vision_locate returned non-JSON: ${err instanceof Error ? err.message : err}`
        );
      }

      // Bounds-check: a model that misjudges scale can return
      // coordinates outside the image, which would produce a click
      // off-screen. Treat that as not-found rather than executing.
      if (parsed.found && parsed.x != null && parsed.y != null) {
        const inBounds =
          parsed.x >= 0 &&
          parsed.x < shot.width &&
          parsed.y >= 0 &&
          parsed.y < shot.height;
        if (!inBounds) {
          return {
            found: false,
            reason: `Model returned out-of-bounds coordinates (${parsed.x},${parsed.y}) for ${shot.width}x${shot.height} screenshot.`,
            screenshotPath: shot.path,
          };
        }
      }

      return {
        ...parsed,
        screenshotPath: shot.path,
      };
    },
  };
}
