// Browser cookies (permission category "cookies").
import { z } from "zod";
import { DESTRUCTIVE_IDEMPOTENT, inlineLength, READ_ONLY, readJsonInputFile, textResult, type ToolKit } from "../tool-kit.js";
import { checkSavePath, writeOutputFile } from "./media.js";

// "unspecified" is what chrome.cookies reports for cookies set without a
// SameSite attribute, so cookies_export output must round-trip through it.
const CookieSameSite = z
  .enum(["no_restriction", "lax", "strict", "unspecified"])
  .optional()
  .describe("SameSite attribute ('unspecified' = no attribute)");

/** One cookie as cookies_import takes it (cookies_export output is accepted as-is). */
const ImportCookie = z.object({
  name: z.string().describe("Cookie name"),
  value: z.string().describe("Cookie value"),
  url: z.string().optional().describe("URL the cookie belongs to (built from domain/path if omitted)"),
  domain: z.string().optional().describe("Cookie domain"),
  path: z.string().optional().describe("Cookie path (defaults to /)"),
  secure: z.boolean().optional().describe("Secure-only flag"),
  httpOnly: z.boolean().optional().describe("HTTP-only flag"),
  sameSite: CookieSameSite,
  expirationDate: z.number().positive().optional().describe("Unix timestamp (seconds) for cookie expiry"),
  hostOnly: z.boolean().optional().describe("From cookies_export: true = host-only cookie (no Domain attribute)"),
});

/**
 * The cookies in a cookies_export file: the export result ({count, cookies},
 * what savePath writes) or a bare array, each checked like the inline
 * parameter. Errors name the entry and the field, never a value.
 */
export function cookiesFromFile(parsed: unknown, param: string): z.infer<typeof ImportCookie>[] {
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { cookies?: unknown }).cookies)
      ? (parsed as { cookies: unknown[] }).cookies
      : null;
  if (!list) throw new Error(`${param} must hold a cookie array or a cookies_export result ({count, cookies})`);
  return list.map((c, i) => {
    const r = ImportCookie.safeParse(c);
    if (!r.success) {
      const issue = r.error.issues[0];
      throw new Error(`${param}: cookie ${i} is invalid (${issue?.path.join(".") || "entry"}: ${issue?.code ?? "invalid"})`);
    }
    return r.data;
  });
}

export function registerCookieTools(kit: ToolKit): void {
  kit.define({
    name: "cookies_list",
    title: "List cookies",
    description: "List cookies filtered by domain, url, or name",
    category: "cookies",
    inputSchema: {
      domain: z.string().optional().describe("Domain filter"),
      url: z.string().optional().describe("URL filter (e.g. https://example.com)"),
      name: z.string().optional().describe("Cookie name filter"),
    },
    annotations: READ_ONLY,
    capHint: 'narrow it with domain, url or name, or write every cookie to a file of your choice with cookies_export {"savePath": "<absolute .json path>"}',
    handler: async ({ domain, url, name }, ctx) => {
      const r = await ctx.send("cookies_list", { domain, url, name });
      return textResult(r);
    },
  });

  kit.define({
    name: "cookies_get",
    title: "Get cookie",
    description: "Get a specific cookie by URL and name",
    category: "cookies",
    inputSchema: {
      url: z.string().describe("URL of the cookie (e.g. https://example.com)"),
      name: z.string().describe("Name of the cookie"),
    },
    annotations: READ_ONLY,
    handler: async ({ url, name }, ctx) => {
      const r = await ctx.send("cookies_get", { url, name });
      return textResult(r);
    },
  });

  kit.define({
    name: "cookies_set",
    title: "Set cookie",
    description: "Set or update a browser cookie",
    category: "cookies",
    inputSchema: {
      name: z.string().describe("Cookie name"),
      value: z.string().describe("Cookie value"),
      url: z.string().describe("URL the cookie belongs to (e.g. https://example.com)"),
      domain: z.string().optional().describe("Cookie domain"),
      path: z.string().optional().describe("Cookie path (defaults to /)"),
      secure: z.boolean().optional().describe("Whether the cookie is secure-only"),
      httpOnly: z.boolean().optional().describe("Whether the cookie is HTTP-only"),
      sameSite: CookieSameSite,
      expirationDate: z.number().positive().optional().describe("Unix timestamp (seconds) for cookie expiry; omit for a session cookie"),
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async (args, ctx) => {
      const r = await ctx.send("cookies_set", args);
      return textResult(r);
    },
  });

  kit.define({
    name: "cookies_delete",
    title: "Delete cookie",
    description: "Delete a specific cookie by URL and name",
    category: "cookies",
    inputSchema: {
      url: z.string().describe("URL of the cookie (e.g. https://example.com)"),
      name: z.string().describe("Name of the cookie to remove"),
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async ({ url, name }, ctx) => {
      const r = await ctx.send("cookies_delete", { url, name });
      return textResult(r);
    },
  });

  kit.define({
    name: "cookies_clear",
    title: "Clear cookies",
    description: "Delete all cookies for a domain or URL (irreversible). Clearing every cookie in the browser requires an explicit all:true.",
    category: "cookies",
    inputSchema: {
      domain: z.string().optional().describe("Domain to clear cookies for"),
      url: z.string().optional().describe("URL to clear cookies for"),
      all: z.boolean().optional().describe("true: delete EVERY cookie of every site (only when no domain/url is given)"),
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async ({ domain, url, all }, ctx) => {
      const d = domain?.trim() || undefined;
      const u = url?.trim() || undefined;
      // An empty (or misspelled, hence stripped) filter must never mean "everything".
      if (!d && !u && all !== true) {
        throw new Error("cookies_clear needs a domain or url filter; pass all:true to delete every cookie in the browser");
      }
      const r = await ctx.send("cookies_clear", d || u ? { domain: d, url: u } : { all: true });
      return textResult(r);
    },
  });

  kit.define({
    name: "cookies_export",
    title: "Export cookies",
    description:
      "Export all cookies for a domain or URL as a portable JSON array ({count, cookies}). With savePath the complete export is written to that .json file " +
      "and only the count is returned (import it with cookies_import {filePath}); without it the export is returned inline, and one too large for the output cap " +
      "is refused (never cut): pass savePath then.",
    category: "cookies",
    inputSchema: {
      domain: z.string().optional().describe("Domain to export cookies from"),
      url: z.string().optional().describe("URL to export cookies from"),
      savePath: z
        .string()
        .optional()
        .describe("Absolute .json path to write the complete export to (it holds cookie values: keep it private). An existing file is only replaced with overwrite:true."),
      overwrite: z.boolean().optional().describe("Replace an existing file at savePath (default false)"),
    },
    // The browser is only read, but savePath writes a file (overwrite:true replaces one).
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async ({ domain, url, savePath, overwrite }, ctx) => {
      const target = savePath ? checkSavePath(savePath, [".json"], overwrite === true) : null;
      const r = await ctx.send<{ count?: number; cookies?: unknown[] }>("cookies_export", { domain, url });
      if (target) {
        if (!Array.isArray(r?.cookies)) return textResult(r);
        const data = Buffer.from(JSON.stringify(r), "utf8");
        writeOutputFile(target.file, data, target.overwrite, 0o600);
        return textResult({ ok: true, savedTo: target.file, sizeBytes: data.length, count: r.cookies.length, importWith: 'cookies_import {"filePath": savedTo}' });
      }
      const out = textResult(r);
      const size = inlineLength(out);
      if (size > kit.maxOutputChars) {
        throw new Error(
          `cookies_export: the export has ${size} chars, more than the ${kit.maxOutputChars}-char output cap. Cookie values are neither cut nor written to disk ` +
            'behind your back: call cookies_export again with savePath (an absolute .json path), then import it with cookies_import {"filePath": ...}, or narrow it with domain / url.'
        );
      }
      return out;
    },
  });

  kit.define({
    name: "cookies_import",
    title: "Import cookies",
    description: "Import cookies into the browser: an array of cookie objects, or filePath of a cookies_export file written with savePath (exactly one of the two).",
    category: "cookies",
    inputSchema: {
      cookies: z.array(ImportCookie).optional().describe("Array of cookie objects to set (cookies_export output is accepted as-is)"),
      filePath: z.string().optional().describe("Absolute path of a .json file written by cookies_export with savePath (or holding a cookie array)"),
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async ({ cookies, filePath }, ctx) => {
      if ((cookies === undefined) === (filePath === undefined)) {
        throw new Error("cookies_import needs exactly one of cookies (an array) or filePath (a cookies_export file saved with savePath)");
      }
      const list = filePath !== undefined ? cookiesFromFile(readJsonInputFile(filePath, "filePath"), "filePath") : cookies;
      const r = await ctx.send("cookies_import", { cookies: list });
      return textResult(r);
    },
  });
}
