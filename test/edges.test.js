"use strict";

// The corners: a hit at the very top or near the end, a start part way
// into a bar, a loud target, a fade asked for on a track with its own
// ending, a voice that says a few words over room tone, and silence.

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { fit } = require("../skills/musicfit/scripts/lib/fit");
const { voice, writeWav, random } = require("./synth");
const { fixture, outDir, dir } = require("./helpers");

const CLI = path.resolve(__dirname, "../skills/musicfit/scripts/musicfit.js");
const defaults = { fps: 30, duck: 10, lufs: -14, end: "auto" };

test("a hit on the very first frame", async () => {
  const { file } = fixture("house");
  const { cues } = await fit(file, { ...defaults, length: 12, hit: 0, out: outDir("hit-0") });
  assert.equal(cues.drop.frame, 0);
  assert.equal(cues.hits[0], 0);
});

test("a start part way into a bar keeps every cue on the grid", async () => {
  // The drop lands 0.9 s early, so the whole track plays with the top of
  // its first bar cut off, drop and ending in the first segment.
  const { file, truth, seconds } = fixture("house");
  const { cues } = await fit(file, { ...defaults, length: Math.floor(seconds - 1.5), hit: truth.drop - 0.9, out: outDir("mid-bar") });
  assert.equal(cues.start.kind, "mid-bar");
  assert.equal(cues.end.kind, "natural");
  const late = truth.finalHit - truth.drop;
  assert.ok(Math.abs(cues.end.finalHit.time - (cues.drop.time + late)) < 0.02, `last hit at ${cues.end.finalHit.time}`);
  assert.ok(cues.times.bars.some((t) => Math.abs(t - cues.end.finalHit.time) < 0.002), "the last hit is on a bar line");
  const drop = cues.sections.find((s) => s.drop);
  assert.ok(drop && Math.abs(drop.time - cues.drop.time) < 0.02, `the drop's section is at ${drop && drop.time}, the drop at ${cues.drop.time}`);
});

test("a target louder than the peaks allow stops short instead of clipping", async () => {
  const { file } = fixture("cinematic");
  const { cues } = await fit(file, { ...defaults, length: 30, lufs: -6, out: outDir("loud") });
  assert.ok(cues.loudness.truePeak <= -0.95, `true peak ${cues.loudness.truePeak}`);
  assert.ok(cues.loudness.limited);
});

test("--end fade leaves out the track's own last hit", async () => {
  const { file } = fixture("house");
  const { cues, analysis } = await fit(file, { ...defaults, length: 40, end: "fade", out: outDir("end-fade") });
  assert.equal(cues.end.kind, "fade");
  assert.deepEqual(cues.hits, []);
  for (const s of cues.segments) assert.ok(s.sourceBars[1] - 1 < analysis.ending.bar, `bars ${s.sourceBars} reach the ending`);
});

test("without a beat, a hit near the end still rings before the fade", async () => {
  const { file } = fixture("ambient");
  const { cues } = await fit(file, { ...defaults, length: 10, hit: 9.4, out: outDir("energy-late") });
  assert.ok(cues.end.fade.from > 9.4);
});

test("a few words over room tone duck only where they are spoken", async () => {
  const { file } = fixture("house");
  const words = voice(32, [[5, 5.7], [12, 12.7]]);
  const rnd = random(5);
  const L = Float32Array.from(words.L, (x) => x + (rnd() * 2 - 1) * 0.004);
  const vo = path.join(dir, "sparse-voice.wav");
  writeWav(vo, { rate: 48000, L, R: L });
  const { cues } = await fit(file, { ...defaults, length: 32, voice: vo, out: outDir("sparse") });
  assert.equal(cues.voice.spans.length, 2);
  for (const span of cues.voice.spans) assert.ok(span.to - span.from < 1.2);
});

test("a silent track is refused with a reason", () => {
  const silent = path.join(dir, "silent.wav");
  writeWav(silent, { rate: 48000, L: new Float32Array(48000 * 6), R: new Float32Array(48000 * 6) });
  const run = spawnSync(process.execPath, [CLI, silent, "--length", "5", "--drop", "2", "--out", outDir("silent")], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /The track is silent/);
  const read = spawnSync(process.execPath, [CLI, silent, "--analyze", "--out", outDir("silent")], { encoding: "utf8" });
  assert.equal(read.status, 0, read.stderr);
});

test("a hit in the last half second is refused, since it would not be heard", () => {
  const run = spawnSync(process.execPath, [CLI, "any.mp3", "--length", "10", "--hit", "9.8"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /at least half a second after it/);
});

