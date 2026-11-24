// Small assertions shared by the integration tests.

import { expect } from "bun:test";
import type { McpHandle } from "./ext-mcp.js";

/**
 * Calls a tool that must fail and returns the error text: an isError result
 * (tool error, refused input) or a thrown protocol error (McpError) both count.
 */
export async function toolError(m: McpHandle, name: string, args: Record<string, unknown> = {}): Promise<string> {
  let r;
  try {
    r = await m.call(name, args);
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
  expect(r.isError).toBe(true);
  return r.text;
}
