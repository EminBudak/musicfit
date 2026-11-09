"use strict";

// seams.png without a dependency: a small RGB canvas, a 5x7 pixel font and
// a PNG writer. The picture shows the track on top, the fitted result
// below, and which part of the track went where between them.

const zlib = require("node:zlib");
const { promisify } = require("node:util");
const { CHUNK, blocks } = require("./breathe");

// Compressed in the thread pool, not on the main thread, which has to stay
// free to hear a stop.
const deflate = promisify(zlib.deflate);

// ─── canvas ────────────────────────────────────────────────────────────────

function canvas(width, height, background) {
  const px = Buffer.alloc(width * height * 3);
  const [r, g, b] = rgb(background);
  for (let i = 0; i < width * height; i++) {
    px[i * 3] = r;
    px[i * 3 + 1] = g;
    px[i * 3 + 2] = b;
  }
  const blend = (x, y, color, alpha = 1) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    px[i] = Math.round(px[i] * (1 - alpha) + color[0] * alpha);
    px[i + 1] = Math.round(px[i + 1] * (1 - alpha) + color[1] * alpha);
    px[i + 2] = Math.round(px[i + 2] * (1 - alpha) + color[2] * alpha);
  };
  const c = {
    width,
    height,
    px,
    rect(x, y, w, h, color, alpha = 1) {
      const col = rgb(color);
      for (let yy = Math.max(0, Math.round(y)); yy < Math.min(height, Math.round(y + h)); yy++) {
        for (let xx = Math.max(0, Math.round(x)); xx < Math.min(width, Math.round(x + w)); xx++) blend(xx, yy, col, alpha);
      }
    },
    vline(x, y0, y1, color, alpha = 1) {
      c.rect(Math.round(x), y0, 1, y1 - y0, color, alpha);
    },
    // A four-sided shape with a flat top (y0, from xa0 to xa1) and a flat
    // bottom (y1, from xb0 to xb1).
    band(y0, xa0, xa1, y1, xb0, xb1, color, alpha) {
      const col = rgb(color);
      for (let y = Math.round(y0); y < Math.round(y1); y++) {
        const t = (y - y0) / (y1 - y0);
        const left = xa0 + (xb0 - xa0) * t;
        const right = xa1 + (xb1 - xa1) * t;
        for (let x = Math.max(0, Math.floor(left)); x < Math.min(width, Math.ceil(right)); x++) blend(x, y, col, alpha);
      }
    },
    text(x, y, string, color, scale = 2) {
      const col = rgb(color);
      let cx = Math.round(x);
      for (const ch of String(string).toUpperCase()) {
        const glyph = FONT[ch] || FONT["?"];
        for (let row = 0; row < 7; row++) {
          for (let k = 0; k < 5; k++) {
            if (glyph[row][k] !== "#") continue;
            for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) blend(cx + k * scale + dx, Math.round(y) + row * scale + dy, col, 1);
          }
        }
        cx += 6 * scale;
      }
      return cx;
    },
    textWidth: (string, scale = 2) => String(string).length * 6 * scale - scale,
  };
  return c;
}

function rgb(hex) {
  const v = parseInt(hex.replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// ─── font ──────────────────────────────────────────────────────────────────

const GLYPHS = `
A .###. #...# #...# ##### #...# #...# #...#
B ####. #...# #...# ####. #...# #...# ####.
C .###. #...# #.... #.... #.... #...# .###.
D ####. #...# #...# #...# #...# #...# ####.
E ##### #.... #.... ####. #.... #.... #####
F ##### #.... #.... ####. #.... #.... #....
G .###. #...# #.... #.### #...# #...# .####
H #...# #...# #...# ##### #...# #...# #...#
I .###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.
J ..### ...#. ...#. ...#. ...#. #..#. .##..
K #...# #..#. #.#.. ##... #.#.. #..#. #...#
L #.... #.... #.... #.... #.... #.... #####
M #...# ##.## #.#.# #.#.# #...# #...# #...#
N #...# #...# ##..# #.#.# #..## #...# #...#
O .###. #...# #...# #...# #...# #...# .###.
P ####. #...# #...# ####. #.... #.... #....
Q .###. #...# #...# #...# #.#.# #..#. .##.#
R ####. #...# #...# ####. #.#.. #..#. #...#
S .#### #.... #.... .###. ....# ....# ####.
T ##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..
U #...# #...# #...# #...# #...# #...# .###.
V #...# #...# #...# #...# #...# .#.#. ..#..
W #...# #...# #...# #.#.# #.#.# #.#.# .#.#.
X #...# #...# .#.#. ..#.. .#.#. #...# #...#
Y #...# #...# .#.#. ..#.. ..#.. ..#.. ..#..
Z ##### ....# ...#. ..#.. .#... #.... #####
0 .###. #...# #..## #.#.# ##..# #...# .###.
1 ..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.
2 .###. #...# ....# ...#. ..#.. .#... #####
3 ##### ...#. ..#.. ...#. ....# #...# .###.
4 ...#. ..##. .#.#. #..#. ##### ...#. ...#.
5 ##### #.... ####. ....# ....# #...# .###.
6 ..##. .#... #.... ####. #...# #...# .###.
7 ##### ....# ...#. ..#.. .#... .#... .#...
8 .###. #...# #...# .###. #...# #...# .###.
9 .###. #...# #...# .#### ....# ...#. .##..
. ..... ..... ..... ..... ..... .##.. .##..
: ..... .##.. .##.. ..... .##.. .##.. .....
- ..... ..... ..... ##### ..... ..... .....
+ ..... ..#.. ..#.. ##### ..#.. ..#.. .....
/ ..... ....# ...#. ..#.. .#... #.... .....
( ...#. ..#.. .#... .#... .#... ..#.. ...#.
) .#... ..#.. ...#. ...#. ...#. ..#.. .#...
% ##... ##..# ...#. ..#.. .#... #..## ...##
, ..... ..... ..... ..... .##.. ..#.. .#...
= ..... ..... ##### ..... ##### ..... .....
> .#... ..#.. ...#. ....# ...#. ..#.. .#...
< ...#. ..#.. .#... #.... .#... ..#.. ...#.
' ..#.. ..#.. .#... ..... ..... ..... .....
? .###. #...# ....# ...#. ..#.. ..... ..#..
_ ..... ..... ..... ..... ..... ..... #####
! ..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..
& .##.. #..#. #.#.. .#... #.#.# #..#. .##.#
# .#.#. .#.#. ##### .#.#. ##### .#.#. .#.#.
@ .###. #...# #.### #.#.# #.### #.... .###.
[ .###. .#... .#... .#... .#... .#... .###.
] .###. ...#. ...#. ...#. ...#. ...#. .###.
* ..... ..#.. #.#.# .###. #.#.# ..#.. .....
; ..... .##.. .##.. ..... .##.. ..#.. .#...
" .#.#. .#.#. .#.#. ..... ..... ..... .....
~ ..... ..... .#... #.#.# ...#. ..... .....
$ ..#.. .#### #.#.. .###. ..#.# ####. ..#..
| ..#.. ..#.. ..#.. ..#.. ..#.. ..#.. ..#..
{ ...## ..#.. ..#.. .#... ..#.. ..#.. ...##
} ##... ..#.. ..#.. ...#. ..#.. ..#.. ##...
^ ..#.. .#.#. #...# ..... ..... ..... .....
\` .#... ..#.. ..... ..... ..... ..... .....
\\ ..... #.... .#... ..#.. ...#. ....# .....
`;

const FONT = { " ": Array(7).fill(".....") };
for (const line of GLYPHS.trim().split("\n")) {
  const [ch, ...rows] = line.split(" ");
  FONT[ch] = rows;
}

// Latin letters the font draws as others, which no mark comes off of, and
// the punctuation names often have, drawn in its plain form: dashes,
// curly quotes, a times sign, a middle dot.
const FOLD = {
  "Ø": "O", "Æ": "AE", "Œ": "OE", "Ł": "L", "Đ": "D", "Ð": "D", "Þ": "TH", "Ħ": "H", "Ŧ": "T", "Ŋ": "N", "Ŀ": "L", "ẞ": "SS",
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-", "‘": "'", "’": "'", "‚": ",", "′": "'", "“": '"', "”": '"', "„": '"', "″": '"',
  "×": "X", "·": ".", "•": ".", "«": "<", "»": ">", "‹": "<", "›": ">",
};

// A name as the font draws it: in capitals, Latin letters without their
// marks (ş as S, ø as O), and the signs it has no shape for left out (an
// emoji, a note); null when it has a letter or a digit the font has no
// shape for, as a name in Cyrillic or Chinese, or nothing but signs before
// its extension once those are left out. Such a name is drawn as the
// track rather than as question marks.
function drawable(text) {
  const plain = String(text).toUpperCase().normalize("NFKD").replace(/\p{M}/gu, "");
  const folded = Array.from(plain, (ch) => FOLD[ch] || ch);
  if (folded.some((ch) => !FONT[ch] && /[\p{L}\p{N}]/u.test(ch))) return null;
  const all = folded.join("");
  const kept = folded
    .filter((ch) => FONT[ch])
    .join("")
    .replace(/ {2,}/g, " ")
    .replace(/ (\.[A-Z0-9]+)$/, "$1")
    .trim();
  if (kept !== all && !/[A-Z0-9]/.test(kept.replace(/\.[A-Z0-9]+$/, ""))) return null;
  return kept;
}

// ─── PNG ───────────────────────────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// 8-bit RGB, each row filtered against the pixel to its left.
async function png(c, text = {}) {
  const { width, height, px } = c;
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 1;
    for (let x = 0; x < stride; x++) {
      const v = px[y * stride + x];
      const left = x >= 3 ? px[y * stride + x - 3] : 0;
      raw[y * (stride + 1) + 1 + x] = (v - left) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const notes = Object.entries(text).map(([k, v]) => chunk("tEXt", Buffer.from(`${k}\0${v}`, "latin1")));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), ...notes, chunk("IDAT", await deflate(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ─── seams.png ─────────────────────────────────────────────────────────────

const INK = {
  ground: "#111114",
  panel: "#18181d",
  text: "#f4f1ea",
  dim: "#8b8a93",
  grid: "#2b2b33",
  wave: "#d9d5cb",
  seam: "#ff6a3d",
  hit: "#ff6a3d",
  voice: "#4cc9f0",
  own: "#c77dff",
};
const SEGMENT = ["#7b6cff", "#2ec4b6", "#ffbe0b", "#f15bb5", "#9ef01a", "#4cc9f0"];

// Peaks of a stereo signal in `columns` columns over [from, to) seconds,
// in groups of columns that hold about a block of samples each.
async function peaks(L, R, rate, from, to, columns) {
  const out = [];
  const group = Math.max(1, Math.floor(CHUNK / Math.max(1, ((to - from) * rate) / columns)));
  await blocks(0, columns, (first, last) => {
    for (let x = first; x < last; x++) {
      const a = Math.max(0, Math.floor((from + ((to - from) * x) / columns) * rate));
      const b = Math.min(L.length, Math.floor((from + ((to - from) * (x + 1)) / columns) * rate));
      let hi = 0;
      for (let i = a; i < b; i++) hi = Math.max(hi, Math.abs(L[i]), Math.abs(R[i]));
      out.push(hi);
    }
  }, group);
  return out;
}

function ruler(c, x0, width, y, seconds, scale) {
  const step = seconds > 240 ? 30 : seconds > 120 ? 20 : seconds > 50 ? 10 : 5;
  for (let t = 0; t <= seconds + 1e-6; t += 1) {
    const x = x0 + t * scale;
    const major = Math.round(t) % step === 0;
    if (seconds > 120 && !major && Math.round(t) % 5 !== 0) continue;
    c.vline(x, y, y + (major ? 7 : 3), INK.dim);
    if (major) c.text(x - c.textWidth(`${t}`, 1) / 2, y + 10, `${t}`, INK.dim, 1);
  }
}

// The words under the picture of a fit: a mark for each kind of line or
// span drawn on it, then what the colors mean.
const NOTE = "COLORS MATCH EACH PART OF THE TRACK TO WHERE IT PLAYS";

function legendOf(cues) {
  const marks = [[INK.seam, "SEAM"], ["#ffffff", "HIT"]];
  if (cues.voice) marks.push([INK.voice, "VOICE (MUSIC DUCKED)"]);
  if (ownSpans(cues).length) marks.push([INK.own, "VIDEO'S OWN SOUND (MUSIC DIPPED)"]);
  return marks;
}

// Where the music dips under the video's own sound, with --video-sound
// voice.
const ownSpans = (cues) => (cues.video && cues.video.duck !== null && cues.video.spans) || [];

// cues: what report.cues() returns; source, fitted: { L, R } at `rate`.
async function seamsPng({ cues, source, fitted, rate, analysis }) {
  const W = 1600;
  const pad = 32;
  const inner = W - pad * 2;
  const stripH = 150;
  const topY = 96;
  const mapH = 110;
  const fitY = topY + stripH + 34 + mapH;
  // The note goes on a line of its own when the marks leave it no room.
  const marks = cues.mode === "analysis" ? [] : legendOf(cues);
  const width = (text) => String(text).length * 12 - 2;
  const wrap = marks.reduce((x, [, label]) => x + 26 + width(label) + 30, pad) + width(NOTE) > W - pad;
  const H = fitY + stripH + 34 + 64 + (wrap ? 22 : 0);
  const c = canvas(W, H, INK.ground);

  const srcSeconds = source.L.length / rate;
  const outSeconds = cues.length;
  const sx = inner / srcSeconds;
  const ox = inner / outSeconds;
  // The track by its name when the font can draw it, else as the track.
  const track = drawable(cues.track) || "THE TRACK";
  const title = cues.mode === "analysis" ? `MUSICFIT  ${track}` : `MUSICFIT  ${track} TO ${outSeconds.toFixed(2)} S`;
  c.text(pad, 24, title.slice(0, 120), INK.text, 3);
  const tempo = cues.tempo ? `${cues.tempo.bpm.toFixed(1)} BPM  ${cues.tempo.meter}/4  ${cues.mode === "phrases" ? "CUTS IN PAIRS OF BARS" : cues.mode === "energy" ? "NO STEADY BEAT: LONG CROSSFADES" : cues.mode === "analysis" ? "" : "CUTS ON BAR LINES"}` : "NO STEADY BEAT: LONG CROSSFADES";
  c.text(pad, 60, tempo, INK.dim, 2);

  // The track, with the parts that were used in their segment's color.
  const drawStrip = async (y, seconds, scale, L, R, color, label) => {
    c.rect(pad, y, inner, stripH, INK.panel);
    const mid = y + stripH / 2;
    const p = await peaks(L, R, rate, 0, seconds, inner);
    const top = Math.max(1e-6, ...p);
    for (let x = 0; x < inner; x++) {
      const h = Math.max(1, Math.round((p[x] / top) * (stripH / 2 - 8)));
      c.rect(pad + x, mid - h, 1, h * 2, color(x / scale), 0.9);
    }
    c.text(pad + 8, y + 8, label, INK.text, 2);
  };
  const segments = cues.segments || [];
  const segColor = (i) => SEGMENT[i % SEGMENT.length];
  const srcColor = (t) => {
    const i = segments.findIndex((s) => t >= s.source[0] && t < s.source[1]);
    return i >= 0 ? segColor(i) : "#5a5862";
  };
  await drawStrip(topY, srcSeconds, sx, source.L, source.R, cues.mode === "analysis" ? () => INK.wave : srcColor, "TRACK");
  // Bar lines of the track, faint, and every fourth stronger.
  (analysis.bars || []).forEach((bar, i) => {
    if (bar.start < 0 || bar.start > srcSeconds) return;
    c.vline(pad + bar.start * sx, topY + 30, topY + stripH, INK.grid, i % 4 === 0 ? 0.9 : 0.45);
  });
  if (cues.source.drop !== null && cues.source.drop !== undefined) {
    const x = pad + cues.source.drop * sx;
    c.vline(x, topY, topY + stripH, INK.hit);
    c.vline(x + 1, topY, topY + stripH, INK.hit);
    const label = `DROP ${cues.source.drop.toFixed(2)}`;
    c.text(Math.min(pad + inner - c.textWidth(label) - 6, x + 6), topY + stripH - 22, label, INK.hit, 2);
  }
  ruler(c, pad, inner, topY + stripH + 4, srcSeconds, sx);
  if (cues.mode === "analysis") {
    c.text(pad, topY + stripH + 40, "BAR LINES ARE THE GREY LINES, EVERY FOURTH STRONGER. SECONDS UNDER THE STRIP.", INK.dim, 2);
    return png(c, { Software: "musicfit" });
  }

  // Which part of the track went where.
  const mapY = topY + stripH + 30;
  segments.forEach((s, i) => {
    const a0 = pad + s.source[0] * sx;
    const a1 = pad + s.source[1] * sx;
    const b0 = pad + Math.max(0, s.from) * ox;
    const b1 = pad + Math.min(outSeconds, s.to) * ox;
    c.band(mapY, a0, Math.max(a0 + 1, a1), mapY + mapH, b0, Math.max(b0 + 1, b1), segColor(i), 0.28);
  });

  // The fitted track.
  const fitColor = (t) => {
    const i = segments.findIndex((s, k) => t >= s.from && (t < s.to || k === segments.length - 1));
    return i >= 0 ? segColor(i) : INK.wave;
  };
  await drawStrip(fitY, outSeconds, ox, fitted.L, fitted.R, fitColor, "FIT");
  cues.times.bars.forEach((t, i) => c.vline(pad + t * ox, fitY + 30, fitY + stripH, INK.grid, i % 4 === 0 ? 0.9 : 0.45));
  // Voice spans along the bottom of the strip, and above them where the
  // music dips under the video's own sound.
  for (const span of (cues.voice && cues.voice.spans) || []) c.rect(pad + span.from * ox, fitY + stripH - 6, (span.to - span.from) * ox, 6, INK.voice, 0.85);
  const ownY = fitY + stripH - (cues.voice ? 12 : 6);
  for (const span of ownSpans(cues)) c.rect(pad + span.from * ox, ownY, Math.max(1, (span.to - span.from) * ox), 6, INK.own, 0.85);
  // The closing fade, darker towards its end.
  if (cues.end && cues.end.fade) {
    const { from, to } = cues.end.fade;
    for (let x = Math.round(pad + from * ox); x < pad + inner; x++) {
      const t = (x - pad) / ox;
      const depth = t >= to ? 0.75 : ((t - from) / (to - from)) * 0.75;
      c.rect(x, fitY, 1, stripH, INK.ground, depth);
    }
    c.text(Math.min(pad + from * ox + 6, pad + inner - c.textWidth("FADE") - 6), fitY + stripH - 24, "FADE", INK.text, 2);
  }
  (cues.seams || []).forEach((seam, i) => {
    const x = pad + seam.time * ox;
    c.vline(x, fitY - 6, fitY + stripH, INK.seam);
    c.vline(x + 1, fitY - 6, fitY + stripH, INK.seam);
    // The number above the strip, where no waveform hides it.
    c.rect(x + 3, fitY - 22, c.textWidth(`${i + 1}`) + 6, 16, INK.ground);
    c.text(x + 6, fitY - 20, `${i + 1}`, INK.seam, 2);
  });
  if (cues.drop) {
    const x = pad + cues.drop.time * ox;
    for (let k = -1; k <= 1; k++) c.vline(x + k, fitY - 10, fitY + stripH + 4, "#ffffff");
    const label = `HIT ${cues.drop.time.toFixed(2)} S  F${cues.drop.frame}`;
    const lx = Math.min(pad + inner - c.textWidth(label) - 4, Math.max(pad, x - c.textWidth(label) / 2));
    c.text(lx, fitY - 30, label, INK.text, 2);
  }
  ruler(c, pad, inner, fitY + stripH + 4, outSeconds, ox);

  // The legend.
  let lx = pad;
  const ly = H - 34 - (wrap ? 22 : 0);
  for (const [color, label] of marks) {
    c.rect(lx, ly + 3, 18, 8, color);
    lx = c.text(lx + 26, ly, label, INK.text, 2) + 30;
  }
  if (wrap) c.text(pad, ly + 22, NOTE, INK.dim, 2);
  else c.text(lx, ly, NOTE, INK.dim, 2);
  return png(c, { Software: "musicfit" });
}

module.exports = { seamsPng, drawable };
