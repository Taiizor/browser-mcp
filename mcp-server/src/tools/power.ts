// Arbitrary code and raw CDP access (permission category "power").
import { z } from "zod";
import { errMessage, POWER, TabId, textResult, type ToolKit } from "../tool-kit.js";
import { checkUploadPaths, uploadGuardOptions } from "../upload-guard.js";

type CdpEvalResult = {
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: unknown;
  };
};

/**
 * CDP commands that hand local files to the page, by lower-case method name,
 * with the path of their file list inside params: they get dom_upload's path
 * guard. (Chrome matches method names case-sensitively; the lower-case match
 * here just means no spelling slips past the guard.)
 */
const CDP_FILE_PARAMS: Readonly<Record<string, readonly string[]>> = {
  "dom.setfileinputfiles": ["files"],
  "input.dispatchdragevent": ["data", "files"],
};

/**
 * cdp_send params with every file list of a file-handing method checked by
 * checkUploadPaths and replaced by the canonical paths; other methods come
 * back unchanged. Throws UploadRefusedError (or a shape error) otherwise.
 */
export function guardCdpFileParams(method: string, params: Record<string, unknown>): Record<string, unknown> {
  const name = method.trim().toLowerCase();
  // Target.sendMessageToTarget (deprecated, still in CDP) carries a whole
  // command as a JSON string: check the nested command with the same rules.
  if (name === "target.sendmessagetotarget") return guardNestedCdpMessage(method, params);
  const where = CDP_FILE_PARAMS[name];
  if (!where) return params;
  const parentKeys = where.slice(0, -1);
  const key = where[where.length - 1];
  let parent: unknown = params;
  for (const k of parentKeys) parent = (parent as Record<string, unknown> | undefined)?.[k];
  if (!parent || typeof parent !== "object" || !(key in parent)) return params;
  const files = (parent as Record<string, unknown>)[key];
  const field = `params.${where.join(".")}`;
  if (!Array.isArray(files)) throw new Error(`cdp_send ${method}: ${field} must be an array of absolute file paths`);
  const checked = checkUploadPaths(files as string[], { ...uploadGuardOptions(), tool: `cdp_send ${method}` });
  // Rebuild the path to the list without mutating the caller's object.
  const rebuild = (obj: Record<string, unknown>, depth: number): Record<string, unknown> =>
    depth === parentKeys.length
      ? { ...obj, [key]: checked }
      : { ...obj, [parentKeys[depth]]: rebuild(obj[parentKeys[depth]] as Record<string, unknown>, depth + 1) };
  return rebuild(params, 0);
}

function guardNestedCdpMessage(method: string, params: Record<string, unknown>): Record<string, unknown> {
  const message = params.message;
  if (typeof message !== "string") return params;
  let inner: unknown;
  try {
    inner = JSON.parse(message);
  } catch {
    return params; // Chrome refuses an unparsable message as well.
  }
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return params;
  const cmd = inner as Record<string, unknown>;
  if (typeof cmd.method !== "string") return params;
  const innerParams = cmd.params && typeof cmd.params === "object" && !Array.isArray(cmd.params) ? (cmd.params as Record<string, unknown>) : {};
  const checked = guardCdpFileParams(cmd.method, innerParams);
  if (checked === innerParams) return params;
  return { ...params, message: JSON.stringify({ ...cmd, params: checked }) };
}

export function registerPowerTools(kit: ToolKit): void {
  kit.define({
    name: "js_evaluate",
    title: "Run JavaScript",
    description: "Run JavaScript in the page via CDP (bypasses page CSP). Supports `return` statements and top-level await (with awaitPromise). Values must be JSON-serializable.",
    category: "power",
    inputSchema: {
      expression: z.string().describe("JS to run: bare expression (2+2) or statements with return. Top-level await needs awaitPromise:true."),
      tabId: TabId,
      awaitPromise: z.boolean().optional().describe("Await promises/top-level await before returning"),
    },
    annotations: POWER,
    handler: async ({ expression, tabId, awaitPromise }, ctx) => {
      try {
        const r = await ctx.send(
          "js_evaluate",
          { expression, awaitPromise },
          tabId
        );
        return textResult(r);
      } catch (e) {
        // Old extensions (<0.3.4) evaluated via content-script new Function,
        // blocked by the extension CSP (no 'unsafe-eval'), or answered with the
        // "handled via CDP" stub: in both cases the code never ran. Fallback
        // keeps them working: Runtime.evaluate over the debugger (unaffected by CSP).
        // An error raised by the user's code itself ("Page JS error: ...", even
        // one that mentions CSP) means it may already have run: never re-run it.
        const msg = errMessage(e);
        if (/^\s*Page JS error/i.test(msg) || !/Content Security Policy|unsafe-eval|Evaluating a string|handled via CDP/i.test(msg)) {
          throw e;
        }
        const cdp = (method: string, params: Record<string, unknown>) =>
          ctx.send<CdpEvalResult>("cdp_send", { method, params }, tabId, 30000);
        // Pick bare vs function-body semantics BEFORE running anything, with a
        // side-effect-free compile check, so the code executes exactly once.
        // (`return` / top-level await only compile inside the async wrapper.)
        let wrap = false;
        try {
          const compiled = await cdp("Runtime.compileScript", { expression, sourceURL: "", persistScript: false });
          wrap = !!compiled?.result?.exceptionDetails;
        } catch {
          wrap = false;
        }
        const out = await cdp("Runtime.evaluate", {
          expression: wrap ? `(async () => { ${expression} })()` : expression,
          awaitPromise: wrap ? true : (awaitPromise ?? false),
          returnByValue: true,
          includeCommandLineAPI: true,
        });
        if (out?.result?.exceptionDetails) {
          throw new Error(`Page JS error: ${JSON.stringify(out.result.exceptionDetails).slice(0, 500)}`);
        }
        const inner = out?.result?.result;
        return textResult({ value: inner?.value, via: "cdp-fallback" });
      }
    },
  });

  kit.define({
    name: "cdp_send",
    title: "Raw CDP command",
    description:
      "Send a raw CDP command to the tab (power tool). Prefer a typed tool when one exists; tab-scoped domains only. " +
      "File lists of DOM.setFileInputFiles (files) and Input.dispatchDragEvent (data.files) pass dom_upload's path rules.",
    category: "power",
    inputSchema: {
      method: z.string().describe("E.g. Network.enable, Page.printToPDF, Runtime.evaluate"),
      params: z.record(z.string(), z.unknown()).optional().describe("Method params object (default {})"),
      tabId: TabId,
    },
    annotations: POWER,
    handler: async ({ method, params, tabId }, ctx) => {
      // Same guard as dom_upload, before anything reaches the browser; the
      // canonical (realpath) paths are sent so no symlink is followed later.
      const checked = guardCdpFileParams(method, params ?? {});
      const r = await ctx.send("cdp_send", { method, params: checked }, tabId, 30000);
      return textResult(r);
    },
  });
}
