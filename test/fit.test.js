"use strict";

// Whole runs: the result is exactly as long as asked, the drop lands on its
// second, every seam is on a bar line and keeps the beat, the ending
// resolves on a beat, the voice is ducked and the loudness is right.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { decode } = require("../skills/musicfit/scripts/lib/audio");
const { analyze } = require("../skills/musicfit/scripts/lib/analyze");
const { fit } = require("../skills/musicfit/scripts/lib/fit");
const { fixture, outDir, matched } = require("./helpers");
const { writeWav } = require("./synth");

const CLI = path.resolve(__dirname, "../skills/musicfit/scripts/musicfit.js");
const RATE = 48000;
const defaults = { fps: 30, duck: 10, lufs: -14, end: "auto" };

function mono(stereo) {
  const out = new Float32Array(stereo.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (stereo[2 * i] + stereo[2 * i + 1]) / 2;
  return out;
}

// Where `piece` (a quarter second of the source) sits in `out` near `at`,
// as an offset in samples.
function offsetNear(out, at, src, from) {
  const w = RATE / 4;
  let best = -Infinity;
  let arg = 0;
  for (let lag = -480; lag <= 480; lag++) {
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let i = 0; i < w; i += 2) {
      const a = out[at + lag + i] || 0;
      const b = src[from + i];
      ab += a * b;
      aa += a * a;
      bb += b * b;
    }
    const c = ab / Math.sqrt(aa * bb + 1e-12);
    if (c > best) {
      best = c;
      arg = lag;
    }
  }
  return { lag: arg, match: best };
}

function rms(x, from, to) {
  let sum = 0;
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) sum += x[i] * x[i];
  return Math.sqrt(sum / Math.max(1, Math.round((to - from) * RATE)));
}

test("shortened to 32 s with the drop on 27.5 s: exact length, the drop on time, seams on bar lines, the beat unbroken", async () => {
  const { file, truth } = fixture("house");
  const out = outDir("house-32");
  const { cues, analysis } = await fit(file, { ...defaults, length: 32, hit: 27.5, out });
  for (const name of ["fitted.wav", "cues.json", "seams.png", "FIT.md"]) assert.ok(fs.existsSync(path.join(out, name)), name);

  const fitted = mono(await decode(path.join(out, "fitted.wav")));
  assert.equal(fitted.length, 32 * RATE);

  // The drop of the track, heard at 27.5 s.
  const src = mono(await decode(file));
  const { lag, match } = offsetNear(fitted, Math.round(27.5 * RATE), src, Math.round(truth.drop * RATE));
  assert.ok(Math.abs(lag) <= RATE / 1000, `the drop is ${lag} samples off`);
  assert.ok(match > 0.9);
  assert.equal(cues.drop.frame, 825);
  assert.ok(cues.hits.includes(825));

  // Every seam leaves and lands on a bar line of the track, a whole number
  // of bars away.
  assert.ok(cues.seams.length >= 1);
  const starts = analysis.bars.map((b) => b.start);
  for (const seam of cues.seams) {
    assert.ok(starts.some((s) => Math.abs(s - seam.source.from) < 0.003), `seam leaves at ${seam.source.from}`);
    assert.ok(starts.some((s) => Math.abs(s - seam.source.to) < 0.003), `seam lands at ${seam.source.to}`);
    assert.ok(Number.isInteger(seam.bars));
    assert.equal(seam.frame, Math.round(seam.time * 30));
  }

  // Read again, the fitted track keeps one steady beat through its seams.
  const again = analyze(await decode(path.join(out, "fitted.wav"), { rate: 24000, channels: 1 }));
  const before = cues.end.fade ? cues.end.fade.from : cues.end.finalHit ? cues.end.finalHit.time : 32;
  const beats = cues.times.beats.filter((t) => t > 0.5 && t < before);
  assert.ok(matched(beats, again.beats, 0.015) >= 0.95);

  // Frames, bars and loudness.
  // The shape launch-film's check reads: whole frames, ascending, bars a
  // subset of beats, and the same moments in seconds under times.
  assert.equal(cues.fps, 30);
  assert.equal(cues.frames, 960);
  assert.ok(Math.abs(cues.bpm - 124) < 0.5);
  assert.equal(cues.beats.length, cues.times.beats.length);
  cues.beats.forEach((f, i) => {
    assert.ok(Number.isInteger(f));
    assert.equal(f, Math.round(cues.times.beats[i] * 30));
    if (i) assert.ok(f > cues.beats[i - 1]);
  });
  for (const f of cues.bars) assert.ok(cues.beats.includes(f), `bar ${f} is a beat`);
  for (const f of cues.hits) assert.ok(Number.isInteger(f) && f >= 0 && f <= cues.frames);
  assert.ok(Math.abs(cues.loudness.integrated + 14) <= 0.5, `loudness ${cues.loudness.integrated}`);
  assert.ok(cues.loudness.truePeak <= -0.95, `true peak ${cues.loudness.truePeak}`);

  const png = fs.readFileSync(path.join(out, "seams.png"));
  assert.ok(png.subarray(1, 4).equals(Buffer.from("PNG")));
  assert.equal(png.readUInt32BE(16), 1600);
  const md = fs.readFileSync(path.join(out, "FIT.md"), "utf8");
  assert.match(md, /## Where to listen/);
  assert.match(md, /\| 27\.50 s \| 825 \| hit \|/);
  assert.doesNotMatch(md, /[\u2013\u2014]/);
});

test("lengthened past the track by looping whole bars, with a fade that ends on a beat", async () => {
  const { file } = fixture("lofi");
  const { cues, analysis } = await fit(file, { ...defaults, length: 75, hit: 30, out: outDir("lofi-75") });
  const fitted = mono(await decode(path.join(outDir("lofi-75"), "fitted.wav")));
  assert.equal(fitted.length, 75 * RATE);
  assert.ok(cues.seams.some((s) => s.kind === "loop"));
  const bar = analysis.tempo.bar;
  for (const seam of cues.seams) assert.ok(Math.abs(Math.abs(seam.source.to - seam.source.from) / bar - seam.bars) < 0.05);
  assert.equal(cues.end.kind, "fade");
  // The fade ends on a beat, and after it there is silence.
  assert.ok(cues.times.beats.some((t) => Math.abs(t - cues.end.fade.to) < 0.002), "the fade ends on a beat");
  assert.ok(cues.end.fade.to - cues.end.fade.from >= analysis.tempo.beat * 0.99);
  if (75 - cues.end.fade.to > 0.05) assert.ok(rms(fitted, cues.end.fade.to + 0.01, 75) < 1e-4);
});

test("with no hit it opens as the track opens and ends on the track's own last hit", async () => {
  const { file } = fixture("house");
  const { cues } = await fit(file, { ...defaults, length: 40, out: outDir("house-40") });
  assert.equal(cues.start.kind, "top");
  assert.equal(cues.segments[0].sourceBars[0], 1);
  assert.equal(cues.end.kind, "natural");
  assert.ok(cues.end.finalHit.time < 40 - 1);
  assert.ok(cues.times.bars.some((t) => Math.abs(t - cues.end.finalHit.time) < 0.002), "the last hit is on a bar line");
  assert.ok(cues.hits.includes(cues.end.finalHit.frame));
});

test("a fit too short for the track's opening and its ending both can start later in the track, and FIT.md says where", async () => {
  // Ten seconds of a track whose own ending takes most of them: the fit is
  // its last bars.
  const { file } = fixture("offbeat");
  const out = outDir("offbeat-10");
  const { cues } = await fit(file, { ...defaults, length: 10, out });
  assert.equal(cues.start.kind, "later");
  const [from] = cues.segments[0].source;
  assert.ok(from > 1, `the fit starts ${from} s into the track`);
  const md = fs.readFileSync(path.join(out, "FIT.md"), "utf8");
  assert.ok(md.includes(`| 0.00 s | 0 | start | the music starts on bar ${cues.segments[0].sourceBars[0]} of the track (${from.toFixed(2)} s there), not at its top |`), md);
  assert.doesNotMatch(md, /as the track does/);
});

test("a short fit of a track whose first bar comes a moment in starts later too, and FIT.md names the bar; a fit with a hit keeps its swell", async () => {
  const x = await decode(fixture("offbeat").file, { rate: RATE, channels: 2 });
  // A moment of sound before its first bar, as the end of a bar a music
  // model cut off: 10 ms, then 300 ms.
  for (const [head, lead] of [[RATE / 100, "on"], [(RATE * 3) / 10, "0.30 s before"]]) {
    const L = new Float32Array(head + x.length / 2);
    const R = new Float32Array(head + x.length / 2);
    for (let i = 0; i < head; i++) L[i] = R[i] = 0.1 * Math.sin(i / 8);
    for (let i = 0; i < x.length / 2; i++) {
      L[head + i] = x[2 * i];
      R[head + i] = x[2 * i + 1];
    }
    const file = outDir(`offbeat-head-${head}.wav`);
    writeWav(file, { rate: RATE, L, R });
    const out = outDir(`offbeat-head-${head}`);
    const { cues } = await fit(file, { ...defaults, length: 10, out });
    assert.ok(Math.abs(cues.start.firstBar.time - head / RATE) < 0.005, `its first bar is at ${cues.start.firstBar.time} s`);
    assert.equal(cues.start.kind, "later");
    assert.ok(cues.segments[0].source[0] > 1, `the fit starts ${cues.segments[0].source[0]} s into the track`);
    const md = fs.readFileSync(path.join(out, "FIT.md"), "utf8");
    assert.ok(md.includes(`| 0.00 s | 0 | start | the music starts ${lead} bar ${cues.segments[0].sourceBars[0]} of the track (${cues.segments[0].source[0].toFixed(2)} s there), not at its top |`), md);
    assert.doesNotMatch(md, /fades in over/);
  }
  const { cues } = await fit(fixture("offbeat").file, { ...defaults, length: 10, hit: 0.5, out: outDir("offbeat-swell") });
  assert.equal(cues.start.kind, "swell");
});

test("ducked under a voice: the music dips about --duck dB where it speaks, and mix.wav has both", async () => {
  const { file } = fixture("house");
  const vo = fixture("voice");
  const plain = await fit(file, { ...defaults, length: 32, hit: 27.5, out: outDir("plain") });
  const { cues } = await fit(file, { ...defaults, length: 32, hit: 27.5, voice: vo.file, duck: 10, out: outDir("ducked") });
  assert.equal(cues.voice.spans.length, 4);
  assert.ok(Math.abs(cues.voice.spans[0].from - 2) < 0.05 && Math.abs(cues.voice.spans[0].to - 6.5) < 0.05);
  assert.ok(fs.existsSync(path.join(outDir("ducked"), "mix.wav")));
  const a = mono(await decode(path.join(outDir("plain"), "fitted.wav")));
  const b = mono(await decode(path.join(outDir("ducked"), "fitted.wav")));
  const under = 20 * Math.log10(rms(b, 3, 6) / rms(a, 3, 6));
  const clear = 20 * Math.log10(rms(b, 12.5, 15) / rms(a, 12.5, 15));
  assert.ok(Math.abs(under + 10) < 1.5, `ducked by ${under.toFixed(1)} dB`);
  assert.ok(Math.abs(clear) < 0.5, `between phrases ${clear.toFixed(1)} dB`);
  assert.equal(plain.cues.voice, null);
});

test("with no beat it still makes the exact length, with long crossfades", async () => {
  const { file } = fixture("ambient");
  const { cues } = await fit(file, { ...defaults, length: 50, out: outDir("ambient-50") });
  assert.equal(cues.mode, "energy");
  const fitted = await decode(path.join(outDir("ambient-50"), "fitted.wav"));
  assert.equal(fitted.length / 2, 50 * RATE);
  assert.ok(cues.seams.length >= 1);
  for (const seam of cues.seams) assert.ok(seam.crossfade[1] - seam.crossfade[0] > 0.9);
});

test("--analyze reads the track without fitting it, and --json prints cues.json", () => {
  const { file } = fixture("cinematic");
  const out = outDir("analysis");
  const run = spawnSync(process.execPath, [CLI, file, "--analyze", "--json", "--out", out], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const cues = JSON.parse(run.stdout);
  assert.equal(cues.mode, "analysis");
  assert.ok(Math.abs(cues.tempo.bpm - 72) < 0.5);
  assert.ok(cues.bars.length >= 15);
  assert.equal(cues.source.ending, "hit");
  assert.ok(!fs.existsSync(path.join(out, "fitted.wav")));
  assert.ok(fs.existsSync(path.join(out, "seams.png")));
});

test("the CLI prints a summary and writes to --out", () => {
  const { file } = fixture("cinematic");
  const out = outDir("cli");
  const run = spawnSync(process.execPath, [CLI, file, "--length", "960f", "--hit", "600f", "--fps", "30", "--out", out], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Fitted cinematic\.wav .* to 32\.00 s/);
  assert.match(run.stdout, /Hit {5}20\.00 s, frame 600/);
  const cues = JSON.parse(fs.readFileSync(path.join(out, "cues.json"), "utf8"));
  assert.equal(cues.frames, 960);
});
