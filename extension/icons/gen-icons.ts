import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

// Modernized Browser MCP Mark (v12):
// - Sleek layered glassmorphism (electric indigo back window + obsidian zinc front window)
// - Razor-sharp modern AI/automation cursor (electric cyan -> royal blue gradient with crisp white rim)
// - Crisp traffic dots & command pill
// - Multi-scale crisp rendering from 16px to 1024px
// Run: bun icons/gen-icons11.ts
const OUT = import.meta.dir;

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const td = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(td, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(new Uint8Array([...td, ...data])));
  return out;
}

type RGBA = [number, number, number, number];

// Signed distance functions for high-precision vector rendering
function sdRR(x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): number {
  const cx = (x0 + x1) * 0.5;
  const cy = (y0 + y1) * 0.5;
  const hw = (x1 - x0) * 0.5 - r;
  const hh = (y1 - y0) * 0.5 - r;
  const dx = Math.abs(x - cx) - hw;
  const dy = Math.abs(y - cy) - hh;
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  const od = Math.sqrt(ox * ox + oy * oy);
  const id = Math.min(Math.max(dx, dy), 0);
  return od + id - r;
}

function sdCircle(x: number, y: number, cx: number, cy: number, r: number): number {
  const dx = x - cx, dy = y - cy;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

function sdSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  const dx = pax - bax * h, dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy);
}

function inPoly(poly: Array<[number, number]>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function mix(a: RGBA, b: RGBA, t: number): RGBA {
  const ct = Math.max(0, Math.min(1, t));
  return [
    a[0] + (b[0] - a[0]) * ct,
    a[1] + (b[1] - a[1]) * ct,
    a[2] + (b[2] - a[2]) * ct,
    a[3] + (b[3] - a[3]) * ct,
  ];
}

function blend(dst: Float32Array, o: number, src: RGBA) {
  const sa = src[3] / 255;
  if (sa <= 0) return;
  const da = dst[o + 3];
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return;
  dst[o] = (src[0] * sa + dst[o] * da * (1 - sa)) / outA;
  dst[o + 1] = (src[1] * sa + dst[o + 1] * da * (1 - sa)) / outA;
  dst[o + 2] = (src[2] * sa + dst[o + 2] * da * (1 - sa)) / outA;
  dst[o + 3] = outA;
}

function render(size: number, ss: number): Uint8Array {
  const W = size * ss;
  const img = new Float32Array(W * W * 4);
  const u = W / 128;

  // Back window: Modern electric Indigo/Violet Glass
  const b = { x0: 34 * u, y0: 14 * u, x1: 112 * u, y1: 86 * u, r: 14 * u };
  // Front window: Deep Obsidian/Zinc Glass
  const f = { x0: 16 * u, y0: 38 * u, x1: 96 * u, y1: 110 * u, r: 14 * u };

  // Cursor coordinates (precision angle)
  const ax = 64 * u, ay = 68 * u, cs = 29 * u;
  const curPoly: Array<[number, number]> = [
    [0.0, 0.0],
    [0.0, 0.78],
    [0.21, 0.59],
    [0.33, 0.86],
    [0.45, 0.81],
    [0.33, 0.54],
    [0.55, 0.54],
  ].map(([px, py]) => [ax + px * cs, ay + py * cs] as [number, number]);

  const isSmall = size <= 24;

  for (let y = 0; y < W; y++) {
    const py = y + 0.5;
    for (let x = 0; x < W; x++) {
      const px = x + 0.5;
      const o = (y * W + x) * 4;

      // 1. Back window subtle drop shadow
      const dBs = sdRR(px, py - 3 * u, b.x0, b.y0, b.x1, b.y1, b.r);
      if (dBs < 7 * u) {
        const a = Math.max(0, 1 - dBs / (7 * u)) * (isSmall ? 0.20 : 0.28);
        blend(img, o, [0, 0, 0, a * 255]);
      }

      // 2. Back window body
      const dB = sdRR(px, py, b.x0, b.y0, b.x1, b.y1, b.r);
      if (dB <= 0) {
        const t = (py - b.y0) / (b.y1 - b.y0);
        const col = mix([99, 102, 241, 255], [139, 92, 246, 255], t); // Indigo-500 -> Violet-500
        blend(img, o, col);

        // Header section of back window
        if (py < b.y0 + 17 * u) {
          blend(img, o, [79, 70, 229, 140]);
          for (let i = 0; i < 3; i++) {
            const dc = sdCircle(px, py, (44 + i * 7.5) * u, b.y0 + 8.5 * u, 2.2 * u);
            if (dc <= 0) blend(img, o, [224, 231, 255, 190]);
          }
          const dPillB = sdRR(px, py, 68 * u, b.y0 + 4 * u, 104 * u, b.y0 + 13 * u, 4.5 * u);
          if (dPillB <= 0) blend(img, o, [224, 231, 255, 50]);
        } else {
          // Content lines in back window
          const dl1 = sdRR(px, py, 44 * u, 33 * u, 96 * u, 37 * u, 2 * u);
          if (dl1 <= 0) blend(img, o, [224, 231, 255, 75]);
          const dl2 = sdRR(px, py, 44 * u, 43 * u, 82 * u, 47 * u, 2 * u);
          if (dl2 <= 0) blend(img, o, [224, 231, 255, 55]);
          const dAccent = sdRR(px, py, 90 * u, 53 * u, 104 * u, 71 * u, 3.5 * u);
          if (dAccent <= 0) blend(img, o, [56, 189, 248, 170]); // cyan accent
        }
      }
      // Back window border/glow
      if (dB > -1.2 * u && dB <= 0.8 * u) {
        const topAlpha = Math.max(0, 1 - (py - b.y0) / (7 * u));
        const bcol = mix([165, 180, 252, 130], [255, 255, 255, 220], topAlpha);
        blend(img, o, bcol);
      }

      // 3. Front window drop shadow
      const dFs = sdRR(px, py - 3.5 * u, f.x0, f.y0, f.x1, f.y1, f.r);
      if (dFs < 8 * u) {
        const a = Math.max(0, 1 - dFs / (8 * u)) * (isSmall ? 0.30 : 0.42);
        blend(img, o, [0, 0, 0, a * 255]);
      }

      // 4. Front window body
      const dF = sdRR(px, py, f.x0, f.y0, f.x1, f.y1, f.r);
      if (dF <= 0) {
        const t = (py - f.y0) / (f.y1 - f.y0);
        blend(img, o, mix([24, 24, 27, 255], [9, 9, 11, 255], t));

        // Ambient radial glow behind cursor
        const distToGlow = Math.sqrt((px - 68 * u) ** 2 + (py - 82 * u) ** 2);
        if (distToGlow < 32 * u) {
          const ga = (1 - distToGlow / (32 * u)) * 0.20;
          blend(img, o, [59, 130, 246, ga * 255]);
        }

        // Header section of front window
        const headerH = 20 * u;
        if (py < f.y0 + headerH) {
          blend(img, o, [16, 16, 20, 255]);
          if (py >= f.y0 + headerH - 1.2 * u) {
            blend(img, o, [39, 39, 42, 255]);
          }

          // Modern 3 traffic dots
          const dotColors: RGBA[] = [
            [244, 63, 94, 255],  // Rose
            [245, 158, 11, 255], // Amber
            [16, 185, 129, 255], // Emerald
          ];
          for (let i = 0; i < 3; i++) {
            const dc = sdCircle(px, py, (25 + i * 6.5) * u, f.y0 + 10 * u, 2.2 * u);
            if (dc <= 0) blend(img, o, dotColors[i]);
          }

          // URL / Command pill
          const dPill = sdRR(px, py, 45 * u, f.y0 + 4.5 * u, 88 * u, f.y0 + 15.5 * u, 4.5 * u);
          if (dPill <= 0) {
            blend(img, o, [30, 30, 36, 255]);
            const dLock = sdCircle(px, py, 51 * u, f.y0 + 10 * u, 1.4 * u);
            if (dLock <= 0) blend(img, o, [56, 189, 248, 220]);
            const dLine = sdRR(px, py, 56 * u, f.y0 + 8.5 * u, 80 * u, f.y0 + 11.5 * u, 1.2 * u);
            if (dLine <= 0) blend(img, o, [113, 113, 122, 180]);
          }
          if (dPill > -0.8 * u && dPill <= 0.4 * u) {
            blend(img, o, [45, 45, 55, 200]);
          }
        } else {
          // DevTools / MCP Automation Code Lines
          const dl1 = sdRR(px, py, 25 * u, 65 * u, 60 * u, 69 * u, 2 * u);
          if (dl1 <= 0) blend(img, o, [113, 113, 122, 160]);

          const dl2 = sdRR(px, py, 25 * u, 75 * u, 48 * u, 79 * u, 2 * u);
          if (dl2 <= 0) blend(img, o, [82, 82, 91, 140]);

          // Automation Command Button: ">_"
          const dBtn = sdRR(px, py, 25 * u, 88 * u, 56 * u, 99 * u, 4.5 * u);
          if (dBtn <= 0) {
            const bt = (py - 88 * u) / (11 * u);
            blend(img, o, mix([59, 130, 246, 255], [37, 99, 235, 255], bt));
            // Prompt ">"
            const dPrompt1 = sdSegment(px, py, 33 * u, 91 * u, 37 * u, 93.5 * u);
            const dPrompt2 = sdSegment(px, py, 37 * u, 93.5 * u, 33 * u, 96 * u);
            const dPrompt = Math.min(dPrompt1, dPrompt2);
            if (dPrompt < 1.1 * u) blend(img, o, [255, 255, 255, 240]);
            // Prompt "_"
            const dDash = sdSegment(px, py, 41 * u, 95.5 * u, 46 * u, 95.5 * u);
            if (dDash < 1.0 * u) blend(img, o, [255, 255, 255, 200]);
          }
          if (dBtn > -0.8 * u && dBtn <= 0.4 * u) {
            blend(img, o, [96, 165, 250, 180]);
          }
        }
      }

      // Front window border
      if (dF > -1.2 * u && dF <= 0.8 * u) {
        const topAlpha = Math.max(0, 1 - (py - f.y0) / (6 * u));
        const bcol = mix([63, 63, 70, 200], [255, 255, 255, 220], topAlpha);
        blend(img, o, bcol);
      }

      // 5. Modern Cursor (Hero Element)
      const shOx = 1.8 * u, shOy = 3.0 * u;
      if (inPoly(curPoly, px - shOx, py - shOy)) {
        blend(img, o, [0, 0, 0, 130]);
      } else {
        const shDist = 2.0 * u;
        for (const [sx, sy] of [[-shDist, 0], [shDist, 0], [0, -shDist], [0, shDist]]) {
          if (inPoly(curPoly, px - shOx + sx, py - shOy + sy)) {
            blend(img, o, [0, 0, 0, 45]);
            break;
          }
        }
      }

      // Cursor fill & crisp white border
      const isInsideCur = inPoly(curPoly, px, py);
      let isBorderCur = false;
      if (!isInsideCur) {
        const bw = isSmall ? 1.8 * u : 1.5 * u;
        for (const [bx, by] of [[-bw, 0], [bw, 0], [0, -bw], [0, bw], [-bw * 0.7, -bw * 0.7], [bw * 0.7, bw * 0.7]]) {
          if (inPoly(curPoly, px + bx, py + by)) {
            isBorderCur = true;
            break;
          }
        }
      }

      if (isBorderCur) {
        blend(img, o, [255, 255, 255, 255]);
      } else if (isInsideCur) {
        const tCur = (py - ay) / (cs * 0.86);
        const col1: RGBA = [56, 189, 248, 255]; // Cyan-400
        const col2: RGBA = [59, 130, 246, 255]; // Blue-500
        const col3: RGBA = [139, 92, 246, 255]; // Violet-500
        const curCol = tCur < 0.5 ? mix(col1, col2, tCur * 2) : mix(col2, col3, (tCur - 0.5) * 2);
        blend(img, o, curCol);

        // Specular tip highlight
        const distToTip = Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
        if (distToTip < 4.2 * u) {
          const ta = (1 - distToTip / (4.2 * u)) * 0.85;
          blend(img, o, [255, 255, 255, ta * 255]);
        }
      }
    }
  }

  // Downsample to output
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b2 = 0, a = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const o = ((y * ss + dy) * W + (x * ss + dx)) * 4;
          const alpha = img[o + 3];
          r += img[o] * alpha;
          g += img[o + 1] * alpha;
          b2 += img[o + 2] * alpha;
          a += alpha;
        }
      }
      const n = ss * ss;
      const o = (y * size + x) * 4;
      const avgA = a / n;
      if (avgA > 1e-4) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b2 / a);
        out[o + 3] = Math.round(Math.min(1, avgA) * 255);
      }
    }
  }

  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    raw.set(out.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
  return new Uint8Array([...sig, ...chunk("IHDR", ihdr), ...chunk("IDAT", idat), ...chunk("IEND", new Uint8Array(0))]);
}

mkdirSync(OUT, { recursive: true });
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  writeFileSync(`${OUT}/icon${s}.png`, render(s, s <= 256 ? 4 : 2));
  console.log("wrote icon" + s + ".png");
}
