// Device emulation overrides via CDP (permission category "emulation").
// All of them share the extension's persistent "emulation" debugger holder:
// the debugger stays attached while any override is active, and the
// extension tears them down when the action is switched off in the popup or
// the bridge stays disconnected.
import { z } from "zod";
import { STATE_SET, TabId, textResult, type ToolKit } from "../tool-kit.js";

type DevicePreset = { width: number; height: number; deviceScaleFactor: number; mobile: boolean; touch: boolean };

// CSS-pixel viewports and device pixel ratios of common devices (as in the
// Chrome DevTools device list). Phones and tablets get mobile + touch.
export const DEVICE_PRESETS = {
  "iphone-se": { width: 375, height: 667, deviceScaleFactor: 2, mobile: true, touch: true },
  "iphone-15": { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true },
  "iphone-15-pro-max": { width: 430, height: 932, deviceScaleFactor: 3, mobile: true, touch: true },
  "pixel-8": { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true },
  "galaxy-s24": { width: 360, height: 780, deviceScaleFactor: 3, mobile: true, touch: true },
  "ipad-mini": { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true, touch: true },
  "ipad-pro-11": { width: 834, height: 1194, deviceScaleFactor: 2, mobile: true, touch: true },
  "laptop-1366": { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false, touch: false },
  "desktop-1080p": { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, touch: false },
  "desktop-1440p": { width: 2560, height: 1440, deviceScaleFactor: 1, mobile: false, touch: false },
} as const satisfies Record<string, DevicePreset>;

type DeviceName = keyof typeof DEVICE_PRESETS;
const DEVICE_NAMES = Object.keys(DEVICE_PRESETS) as [DeviceName, ...DeviceName[]];

/** Viewport payload: the preset's fields, overridden by every explicitly given one. */
export function viewportPayload(
  device: DeviceName | undefined,
  given: Partial<DevicePreset>
): Partial<DevicePreset> {
  const base: Partial<DevicePreset> = device ? { ...DEVICE_PRESETS[device] } : {};
  for (const [k, v] of Object.entries(given) as [keyof DevicePreset, DevicePreset[keyof DevicePreset] | undefined][]) {
    if (v !== undefined) (base as Record<string, unknown>)[k] = v;
  }
  return base;
}

/** Largest viewport side the extension accepts (bg2cInt bounds of emulation_viewport in extension/background.js). */
export const VIEWPORT_MAX_PX = 16384;
const ViewportSize = z.number().int().positive().max(VIEWPORT_MAX_PX);

export function registerEmulationTools(kit: ToolKit): void {
  kit.define({
    name: "emulation_geolocation",
    title: "Spoof geolocation",
    description: "Spoof geolocation for a tab via CDP (attaches the debugger while active).",
    category: "emulation",
    inputSchema: {
      latitude: z.number().min(-90).max(90).describe("Latitude in degrees"),
      longitude: z.number().min(-180).max(180).describe("Longitude in degrees"),
      accuracy: z.number().nonnegative().optional().describe("Accuracy in meters (default 50)"),
      tabId: TabId,
    },
    annotations: STATE_SET,
    handler: async (args, ctx) => {
      const { tabId, ...payload } = args;
      const r = await ctx.send("emulation_geolocation", payload, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "emulation_geolocation_clear",
    title: "Clear geolocation override",
    description: "Remove the geolocation override (detaches the debugger when idle).",
    category: "emulation",
    inputSchema: { tabId: TabId },
    annotations: STATE_SET,
    handler: async ({ tabId }, ctx) => {
      const r = await ctx.send("emulation_geolocation_clear", {}, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "emulation_viewport",
    title: "Emulate device viewport",
    description:
      "Emulate a device screen for a tab via CDP: viewport size in CSS px, device pixel ratio, mobile mode and touch input. " +
      `device picks a preset (${DEVICE_NAMES.join(", ")}); explicit fields override it. ` +
      "The user agent is not changed. reset:true removes the override. Stays active (debugger attached) until reset or emulation_reset.",
    category: "emulation",
    inputSchema: {
      device: z.enum(DEVICE_NAMES).optional().describe("Device preset that fills width/height/deviceScaleFactor/mobile/touch"),
      width: ViewportSize.optional().describe(`Viewport width in CSS px (1..${VIEWPORT_MAX_PX}; required without device)`),
      height: ViewportSize.optional().describe(`Viewport height in CSS px (1..${VIEWPORT_MAX_PX}; required without device)`),
      deviceScaleFactor: z.number().min(0).max(10).optional().describe("Device pixel ratio (0 = keep the screen's own; default 0)"),
      mobile: z.boolean().optional().describe("Mobile mode: meta viewport, overlay scrollbars, text autosizing (default false)"),
      touch: z.boolean().optional().describe("Emulate a touch screen (touch events, pointer: coarse)"),
      reset: z.boolean().optional().describe("true: remove the viewport override (other fields are ignored)"),
      tabId: TabId,
    },
    annotations: STATE_SET,
    handler: async ({ device, width, height, deviceScaleFactor, mobile, touch, reset, tabId }, ctx) => {
      if (reset) {
        const r = await ctx.send("emulation_viewport", { reset: true }, tabId);
        return textResult(r);
      }
      const payload = viewportPayload(device, { width, height, deviceScaleFactor, mobile, touch });
      if (payload.width === undefined || payload.height === undefined) {
        throw new Error("emulation_viewport needs width and height, a device preset, or reset:true");
      }
      const r = await ctx.send("emulation_viewport", payload, tabId);
      return textResult(device && r && typeof r === "object" ? { device, ...(r as Record<string, unknown>) } : r);
    },
  });

  kit.define({
    name: "emulation_media",
    title: "Emulate media features",
    description:
      "Emulate CSS media features for a tab via CDP: prefers-color-scheme, prefers-reduced-motion, forced-colors, and the print/screen media type " +
      "(e.g. check dark mode or print styles). reset:true removes the media emulation. The result's applied field shows what is in effect.",
    category: "emulation",
    inputSchema: {
      colorScheme: z.enum(["light", "dark", "no-preference"]).optional().describe("prefers-color-scheme"),
      reducedMotion: z.enum(["reduce", "no-preference"]).optional().describe("prefers-reduced-motion"),
      forcedColors: z.enum(["active", "none"]).optional().describe("forced-colors (high contrast)"),
      media: z.enum(["screen", "print"]).optional().describe("CSS media type"),
      reset: z.boolean().optional().describe("true: remove the media emulation (other fields are ignored)"),
      tabId: TabId,
    },
    annotations: STATE_SET,
    handler: async ({ colorScheme, reducedMotion, forcedColors, media, reset, tabId }, ctx) => {
      if (!reset && colorScheme === undefined && reducedMotion === undefined && forcedColors === undefined && media === undefined) {
        throw new Error("emulation_media needs at least one of colorScheme, reducedMotion, forcedColors, media, or reset:true");
      }
      const payload = reset ? { reset: true } : { colorScheme, reducedMotion, forcedColors, media };
      const r = await ctx.send("emulation_media", payload, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "emulation_cpu",
    title: "Throttle CPU",
    description:
      "Slow down the tab's CPU via CDP by a factor (4 = mid-range phone, 6 = low-end phone, max 20); rate 1 turns throttling off. " +
      "Useful with perf_web_vitals or perf_trace_start.",
    category: "emulation",
    inputSchema: {
      rate: z.number().min(1).max(20).describe("Slowdown factor: 1 = off, 4 = 4x slower ..."),
      tabId: TabId,
    },
    annotations: STATE_SET,
    handler: async ({ rate, tabId }, ctx) => {
      const r = await ctx.send("emulation_cpu", { rate }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "emulation_reset",
    title: "Reset emulation",
    description:
      "Clear every emulation override on a tab (viewport, media features, CPU throttling, geolocation) and release the debugger. Returns the cleared kinds.",
    category: "emulation",
    inputSchema: { tabId: TabId },
    annotations: STATE_SET,
    handler: async ({ tabId }, ctx) => {
      const r = await ctx.send("emulation_reset", {}, tabId);
      return textResult(r);
    },
  });
}
