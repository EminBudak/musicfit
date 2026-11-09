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

test("a start with silence before the music maps each segment onto as much of the track", async () => {
  // Twenty seconds before the drop needs more than the bars before it, so
  // the file opens with silence and the intro comes round again.
  const { file } = fixture("house");
  const { cues, analysis } = await fit(file, { ...defaults, length: 30, hit: 20, out: outDir("silent-head") });
  assert.equal(cues.start.kind, "silence");
  const [first] = cues.segments;
  assert.ok(first.from > 0.1, `the track comes in at ${first.from}`);
  const bar = analysis.bars[first.sourceBars[0] - 1].start;
  assert.ok(Math.abs(first.from + bar - first.source[0] - cues.start.music) < 0.002, `its first bar at ${first.from + bar - first.source[0]}, not ${cues.start.music}`);
  for (const s of cues.segments.slice(0, -1)) assert.ok(Math.abs(s.to - s.from - (s.source[1] - s.source[0])) < 0.002, `${s.from} to ${s.to} plays ${s.source}`);
  assert.ok(!cues.warnings.some((w) => /times\. An earlier --hit/.test(w)), "playing the intro once more is no news");
});

test("a drop asked for far later than the track has music before it says how often that music repeats", async () => {
  const { file } = fixture("house");
  const { cues } = await fit(file, { ...defaults, length: 60, hit: 52, out: outDir("late-drop") });
  assert.equal(cues.drop.time, 52);
  assert.ok(cues.warnings.some((w) => /Only 15\.\d s of the track comes before its drop, so to land it at 52\.00 s some of those bars play [3-9] times/.test(w)), cues.warnings.join(" | "));
});

test("a target louder than the peaks allow stops short instead of clipping", async () => {
  const { file } = fixture("cinematic");
  const { cues } = await fit(file, { ...defaults, length: 30, lufs: -6, out: outDir("loud") });
  assert.ok(cues.loudness.truePeak <= -0.95, `true peak ${cues.loudness.truePeak}`);
  assert.ok(cues.loudness.limited);
});

// Nine seconds of noise at about -20 dBFS with a 6 ms click 6 dB over full
// scale at `at` seconds, the way a video's own sound can open on one.
function clickAt(at) {
  const n = 9 * 48000;
  const rnd = random(9);
  const L = Float32Array.from({ length: n }, () => (rnd() * 2 - 1) * 0.17);
  const from = Math.round(at * 48000);
  for (let i = 0; i < 0.006 * 48000; i++) L[from + i] = 2 * Math.sin((2 * Math.PI * 2000 * i) / 48000);
  return { L, R: Float32Array.from(L) };
}

test("a click in the first 5 ms is held under the true peak limit like any other, at the loudness asked for", async () => {
  const { normalize } = require("../skills/musicfit/scripts/lib/render");
  for (const ms of [0, 1, 2, 4, 6, 50]) {
    const { after } = await normalize(clickAt(ms / 1000), { lufs: -14 });
    assert.ok(Math.abs(after.integrated + 14) <= 0.2, `click at ${ms} ms: ${after.integrated} LUFS`);
    assert.ok(after.truePeak <= -1, `click at ${ms} ms: true peak ${after.truePeak} dBTP`);
  }
});

test("a peak the limiter cannot reach stops it lowering its ceiling, so everything else keeps its loudness", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, async () => {
  const { normalize } = require("../skills/musicfit/scripts/lib/render");
  const was = process.env.FFMPEG_PATH;
  // A meter that reads every true peak at +5 dBTP, however far it is limited.
  process.env.FFMPEG_PATH = path.join(__dirname, "fixtures", "unreachedpeak", "ffmpeg");
  try {
    const { after } = await normalize(clickAt(0.05), { lufs: -14 });
    assert.ok(Math.abs(after.integrated + 14) <= 1, `${after.integrated} LUFS`);
    assert.equal(after.truePeak, 5);
  } finally {
    if (was === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = was;
  }
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

test("a steady tone, which has no onsets for the tempo search to peak on, finishes: an analysis and a fit of it end in moments", () => {
  // The way people and assistants make a track to try a tool with.
  const tone = path.join(dir, "tone-440hz.wav");
  const made = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=10", "-c:a", "pcm_s16le", tone], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  // In a process of its own, with a limit: the search would never give the
  // thread back to a test's own timer.
  const run = (args) => spawnSync(process.execPath, [CLI, tone, ...args], { encoding: "utf8", timeout: 60000 });
  const read = run(["--analyze", "--out", outDir("tone-read")]);
  assert.equal(read.status, 0, `${read.signal} ${read.stderr}`);
  assert.match(read.stdout, /Read tone-440hz\.wav: 10\.00 s, no steady beat/);
  const fitted = run(["--length", "12", "--out", outDir("tone-fit")]);
  assert.equal(fitted.status, 0, `${fitted.signal} ${fitted.stderr}`);
  assert.match(fitted.stdout, /Fitted tone-440hz\.wav \(10\.00 s, no steady beat\) to 12\.00 s/);
});

test("a hit in the last half second is refused, since it would not be heard", () => {
  const run = spawnSync(process.execPath, [CLI, "any.mp3", "--length", "10", "--hit", "9.8"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /at least half a second after it/);
});


test("keep: a faint room tone the gain takes along, or a music peak at the ceiling far from a place, holds back no gain of it", async () => {
  const { setOver } = require("../skills/musicfit/scripts/lib/render");
  const RATE = 48000;
  const n = 6 * RATE;
  const rnd = random(13);
  // A soft tone for the music, with one click at -0.9 dBFS at 4 s, over
  // the ceiling the whole is held to and far from the place.
  const music = { L: new Float32Array(n), R: new Float32Array(n) };
  for (let i = 0; i < n; i++) music.L[i] = music.R[i] = 0.05 * Math.sin((2 * Math.PI * 220 * i) / RATE);
  for (let i = 0; i < 48; i++) music.L[4 * RATE + i] = music.R[4 * RATE + i] = 0.9 * Math.sin((Math.PI * i) / 48);
  // The video's own sound: a room tone 60 dB down all the way, and a quiet
  // burst from 1 s to 1.3 s.
  const own = { L: new Float32Array(n), R: new Float32Array(n) };
  for (let i = 0; i < n; i++) own.L[i] = own.R[i] = (rnd() * 2 - 1) * 0.001;
  for (let i = RATE; i < 1.3 * RATE; i++) own.L[i] = own.R[i] = (rnd() * 2 - 1) * 0.05;
  const [place] = await setOver(own, music, [[1, 1.3]], { lufs: -14, over: 3, most: 6, duck: 10 });
  // Raised to the target, far over the soft tone, without a dip: not held
  // down by the click 3 s away, nor silenced for it.
  assert.ok(place.gain > 5 && place.over > 3 && place.dip === 0, JSON.stringify({ gain: place.gain, over: place.over, dip: place.dip }));
});
