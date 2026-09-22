import fs from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

export type PreviewMode = "preview" | "full" | "none";

export interface ImageInfo {
  mimeType: "image/png" | "image/jpeg" | "application/octet-stream";
  width: number | null;
  height: number | null;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Identify an image and read its dimensions without decoding the pixels. */
export function inspectImage(buf: Buffer): ImageInfo {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_MAGIC)) {
    // IHDR is always the first chunk: width and height at bytes 16..24.
    return { mimeType: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // Walk JPEG segments to the first start-of-frame marker.
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mimeType: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return { mimeType: "image/jpeg", width: null, height: null };
  }
  return { mimeType: "application/octet-stream", width: null, height: null };
}

/**
 * Share of pixels that are not fully opaque. Codex can return RGBA images whose
 * alpha channel is mostly or entirely translucent even when no transparency was
 * asked for — such an image shows holes against some backgrounds, so callers
 * need to know before shipping it.
 */
export function measureTransparency(buf: Buffer): { hasAlpha: boolean; transparentPercent: number } {
  const info = inspectImage(buf);
  // PNG colour types 4 (grey+alpha) and 6 (RGBA) carry an alpha channel.
  if (info.mimeType !== "image/png" || (buf[25] !== 4 && buf[25] !== 6)) {
    return { hasAlpha: false, transparentPercent: 0 };
  }
  try {
    const png = PNG.sync.read(buf);
    const pixels = png.width * png.height;
    let translucent = 0;
    for (let i = 3; i < png.data.length; i += 4) if (png.data[i] < 250) translucent++;
    return { hasAlpha: true, transparentPercent: Math.round((1000 * translucent) / pixels) / 10 };
  } catch {
    return { hasAlpha: true, transparentPercent: 0 };
  }
}

/**
 * A downscaled JPEG the calling model can look at. The full-resolution PNG from
 * Codex is ~1 MB of base64 — enough to trip MCP output limits — while a 768 px
 * JPEG is a few dozen KB and plenty to judge composition and legibility.
 *
 * Transparency is drawn over a checkerboard, as image editors do. Flattening it
 * onto white would misrepresent the image: a translucent hole would read as a
 * white shape that is not actually there.
 */
export function makePreview(buf: Buffer, maxEdge: number): { mimeType: string; data: string } | null {
  let width: number;
  let height: number;
  let rgba: Buffer | Uint8Array;
  try {
    const info = inspectImage(buf);
    if (info.mimeType === "image/png") {
      const png = PNG.sync.read(buf);
      ({ width, height } = png);
      rgba = png.data;
    } else if (info.mimeType === "image/jpeg") {
      const decoded = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
      ({ width, height } = decoded);
      rgba = decoded.data;
    } else {
      return null;
    }
  } catch {
    return null;
  }

  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(w * h * 4);

  // Area-average downsample, compositing alpha over a 12 px checkerboard.
  const cell = 12;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      const backdrop = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 255 : 204;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * width + sx) * 4;
          const a = rgba[i + 3] / 255;
          r += rgba[i] * a + backdrop * (1 - a);
          g += rgba[i + 1] * a + backdrop * (1 - a);
          b += rgba[i + 2] * a + backdrop * (1 - a);
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }

  const encoded = jpeg.encode({ data: out, width: w, height: h }, 82);
  return { mimeType: "image/jpeg", data: Buffer.from(encoded.data).toString("base64") };
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "image";
}

/**
 * Decide where each generated image goes.
 *
 * `outputPath` may name a file (`.png`/`.jpg`) or a directory. Existing files are
 * never overwritten unless asked: a collision gets a numeric suffix instead, and
 * the caller is told the real path.
 */
export function planOutputPaths(opts: {
  outputPath?: string;
  workingDirectory: string;
  prompt: string;
  count: number;
  overwrite: boolean;
}): string[] {
  let dir: string;
  let stem: string;
  let ext = ".png";

  const target = opts.outputPath ? path.resolve(opts.workingDirectory, opts.outputPath) : null;
  // Codex produces PNG; the router can also transcode to JPEG. Any other
  // extension is treated as a directory name rather than silently mislabelled.
  const looksLikeFile = target && /\.(png|jpe?g)$/i.test(target);

  if (target && looksLikeFile) {
    dir = path.dirname(target);
    ext = path.extname(target);
    stem = path.basename(target, ext);
  } else {
    dir = target ?? path.join(opts.workingDirectory, "generated-images");
    stem = slugify(opts.prompt);
  }

  const paths: string[] = [];
  for (let n = 1; n <= opts.count; n++) {
    const base = opts.count === 1 ? stem : `${stem}-${n}`;
    let candidate = path.join(dir, `${base}${ext}`);
    if (!opts.overwrite) {
      let suffix = 2;
      while (fs.existsSync(candidate) || paths.includes(candidate)) {
        candidate = path.join(dir, `${base}-${suffix}${ext}`);
        suffix++;
      }
    }
    paths.push(candidate);
  }
  return paths;
}

/**
 * Write one generated image. Prefers the base64 payload Codex returns inline and
 * falls back to the copy Codex saved under ~/.codex/generated_images.
 *
 * Unless overwriting was asked for, the file is created exclusively: checking
 * for existence when paths are planned is not enough, because two generations
 * running at once can plan the same free name. A collision at write time gets
 * the next numeric suffix, and the path actually written is returned.
 */
export function writeGeneratedImage(
  destination: string,
  source: { base64?: string | null; savedPath?: string | null },
  opts: { overwrite?: boolean } = {},
): { buf: Buffer; path: string } {
  let buf: Buffer | null = null;
  if (source.base64) {
    buf = Buffer.from(source.base64.replace(/^data:[^,]+,/, ""), "base64");
  } else if (source.savedPath && fs.existsSync(source.savedPath)) {
    buf = fs.readFileSync(source.savedPath);
  }
  if (!buf || buf.length === 0) {
    throw new Error("Codex reported a finished image but returned no image data.");
  }
  if (/\.jpe?g$/i.test(destination) && inspectImage(buf).mimeType === "image/png") {
    const png = PNG.sync.read(buf);
    const flat = Buffer.alloc(png.width * png.height * 4);
    for (let i = 0; i < flat.length; i += 4) {
      const a = png.data[i + 3] / 255;
      flat[i] = png.data[i] * a + 255 * (1 - a);
      flat[i + 1] = png.data[i + 1] * a + 255 * (1 - a);
      flat[i + 2] = png.data[i + 2] * a + 255 * (1 - a);
      flat[i + 3] = 255;
    }
    buf = Buffer.from(jpeg.encode({ data: flat, width: png.width, height: png.height }, 92).data);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (opts.overwrite) {
    fs.writeFileSync(destination, buf);
    return { buf, path: destination };
  }
  const ext = path.extname(destination);
  const stem = destination.slice(0, destination.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? destination : `${stem}-${n}${ext}`;
    try {
      fs.writeFileSync(candidate, buf, { flag: "wx" });
      return { buf, path: candidate };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`Could not find a free file name next to ${destination}.`);
}
