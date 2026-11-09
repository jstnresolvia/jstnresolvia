// Turns a photo into the ASCII art on the left of the card.
//
//   node scripts/portrait.mjs <image> [options]
//
//   --cols=64              characters per line
//   --crop=x,y,w,h         part of the image to use, in pixels
//   --keep=cx,cy,rx,ry,y   head ellipse plus everything below y (crop pixels);
//                          the rest is background and stays empty
//   --cutout=9             also empties background connected to the edges,
//                          stepping between neighbours closer than this
//   --clahe=6              local contrast, so a face keeps its features
//   --gamma=1.0  --invert  tone curve; bright pixels become dense characters
//
// Writes assets/portrait.txt, which build.mjs reads. Runs locally only (needs
// `sharp`); the GitHub Action never touches it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    // Borrow it from a project that already has it installed.
    const from = process.env.SHARP_FROM ?? path.resolve(root, '..', 'resolvia', 'resolvia');
    return createRequire(path.join(from, 'package.json'))('sharp');
  }
}

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
if (!input) {
  console.error('usage: node scripts/portrait.mjs <image> [--cols=64] [--crop=x,y,w,h] [--keep=cx,cy,rx,ry,y] [--cutout=9] [--clahe=6] [--gamma=1] [--invert]');
  process.exit(1);
}
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const nums = (name) => opt(name, null)?.split(',').map(Number) ?? null;
const cols = Number(opt('cols', 64));
const gamma = Number(opt('gamma', 1));
const cutout = Number(opt('cutout', 0));
const clahe = Number(opt('clahe', 0));
const invert = args.includes('--invert');
const crop = nums('crop');
const keep = nums('keep');

// A portrait cell is about twice as tall as wide (9px font, 10.5px line in build.mjs).
const CELL_ASPECT = 1.93;
const RAMP = ' .:-=+*#%@';

const sharp = await loadSharp();
let img = sharp(input).flatten({ background: '#000000' });
if (crop) img = img.extract({ left: crop[0], top: crop[1], width: crop[2], height: crop[3] });
const { data: rgb, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: w, height: h } = info;
const rows = Math.max(1, Math.round((cols * h) / w / CELL_ASPECT));

// ── background mask ─────────────────────────────────────────────────────────
const bg = new Uint8Array(w * h);
const stack = [];
const lumAt = (i) => 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
if (keep) {
  const [cx, cy, rx, ry, below] = keep;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (y < below && ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) { bg[y * w + x] = 1; stack.push(y * w + x); }
  }
}
if (cutout) {
  const near = (a, b) => Math.max(
    Math.abs(rgb[a * 3] - rgb[b * 3]), Math.abs(rgb[a * 3 + 1] - rgb[b * 3 + 1]), Math.abs(rgb[a * 3 + 2] - rgb[b * 3 + 2]),
  ) < cutout;
  const seed = (i) => { if (!bg[i] && lumAt(i) > 110) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) seed(x);
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i - x) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!bg[j] && near(i, j)) { bg[j] = 1; stack.push(j); }
    }
  }
}

// ── tone ────────────────────────────────────────────────────────────────────
let grey = Buffer.from(Array.from({ length: w * h }, (_, i) => Math.round(lumAt(i))));
if (clahe) {
  grey = await sharp(grey, { raw: { width: w, height: h, channels: 1 } })
    .clahe({ width: Math.round(w / clahe), height: Math.round(h / clahe), maxSlope: 3 })
    .extractChannel(0).raw().toBuffer();
}
// Stretch the person's tones only, so the empty background does not eat the range.
let lo = 255, hi = 0;
for (let i = 0; i < grey.length; i++) if (!bg[i]) { lo = Math.min(lo, grey[i]); hi = Math.max(hi, grey[i]); }
const span = Math.max(1, hi - lo);
for (let i = 0; i < grey.length; i++) grey[i] = bg[i] ? 0 : Math.round(((grey[i] - lo) / span) * 254) + 1;

const shrink = (buf) => sharp(buf, { raw: { width: w, height: h, channels: 1 } }).resize(cols, rows, { fit: 'fill' }).extractChannel(0).raw().toBuffer();
const tones = await shrink(grey);
const empty = await shrink(Buffer.from(bg.map((b) => b * 255)));

// ── characters ──────────────────────────────────────────────────────────────
const lines = [];
for (let y = 0; y < rows; y++) {
  let line = '';
  for (let x = 0; x < cols; x++) {
    const k = y * cols + x;
    if (empty[k] > 127) { line += ' '; continue; }
    let v = tones[k] / 255;
    if (invert) v = 1 - v;
    v = Math.pow(v, gamma);
    line += RAMP[Math.min(RAMP.length - 1, Math.floor(v * RAMP.length))];
  }
  lines.push(line.replace(/\s+$/, ''));
}
while (lines.length && !lines[0]) lines.shift();
while (lines.length && !lines[lines.length - 1]) lines.pop();

fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.writeFileSync(path.join(root, 'assets', 'portrait.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(`\n${cols}x${lines.length} -> assets/portrait.txt`);
