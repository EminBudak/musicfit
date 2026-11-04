"use strict";

// Fixture tracks made by test/synth.js, written once per test file into a
// temporary folder, and small helpers to read results back.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { song, ambient, voice, writeWav } = require("./synth");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicfit-test-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

// Shorter cousins of the demo styles, so the tests run in seconds.
const SPECS = {
  house: {
    bpm: 124, key: 57, seed: 3, ending: "hit",
    sections: [
      { bars: 4, parts: ["padDark", "hats8", "kick4"] },
      { bars: 4, parts: ["padDark", "hats16", "snareRoll", "riser", "bassLong"] },
      { bars: 8, parts: ["kick4", "clap", "hats16", "openhat", "bassOff", "pad", "stabs", "lead", "crash"], drop: true },
      { bars: 4, parts: ["pad", "arp", "hats8"] },
      { bars: 4, parts: ["kick4", "clap", "hats16", "openhat", "bassOff", "pad", "stabs", "crash"] },
    ],
  },
  lofi: {
    bpm: 86, key: 50, seed: 5, swing: 0.16, humanize: 0.006, ending: "fade",
    chords: [[0, "min"], [5, "min"], [-2, "maj"], [3, "maj"]],
    sections: [
      { bars: 4, parts: ["rhodes", "vinyl", "hats8"] },
      { bars: 8, parts: ["rhodes", "kickBoom", "snare", "hats8", "bassLong", "vinyl"], drop: true },
      { bars: 8, parts: ["rhodes", "kickBoom", "snare", "hats16", "bass8", "lead", "vinyl"] },
    ],
  },
  cinematic: {
    bpm: 72, key: 50, seed: 7, ending: "hit",
    chords: [[0, "min"], [-4, "maj"], [-7, "maj"], [-2, "maj"]],
    sections: [
      { bars: 4, parts: ["piano8", "padDark"] },
      { bars: 4, parts: ["piano8", "padDark", "toms", "riser"] },
      { bars: 8, parts: ["piano8", "pad", "kickPop", "snare", "toms", "bassLong", "boom", "crash"], drop: true },
    ],
  },
  waltz: {
    bpm: 150, meter: 3, seed: 24, ending: "hit",
    sections: [{ bars: 8, parts: ["pianoChords"] }, { bars: 16, parts: ["kickWaltz", "snareWaltz", "pianoChords", "bassLong"], drop: true }],
  },
  // Eight bars of pads that swell in, no drums, then a groove.
  padIntro: {
    bpm: 118, seed: 31, ending: "hit",
    sections: [{ bars: 8, parts: ["padDark"] }, { bars: 12, parts: ["kickPop", "snare", "hats8", "bass8", "pad"], drop: true }],
  },
  drift: {
    bpm: 104, seed: 27, drift: 0.012, humanize: 0.008, ending: "fade",
    sections: [{ bars: 4, parts: ["pad", "hats8"] }, { bars: 12, parts: ["kickPop", "snare", "hats8", "bass8", "pad"], drop: true }],
  },
};

const made = new Map();

// Writes the named fixture (once) and returns { file, truth, seconds }.
function fixture(name) {
  if (made.has(name)) return made.get(name);
  const file = path.join(dir, `${name}.wav`);
  let result;
  if (name === "ambient") result = ambient(30, { seed: 11 });
  else if (name === "voice") result = voice(32, [[2, 6.5], [7.2, 11], [16, 22.5], [24, 27]]);
  else result = song(SPECS[name]);
  writeWav(file, result);
  const entry = { file, truth: result.truth, seconds: result.seconds };
  made.set(name, entry);
  return entry;
}

function outDir(name) {
  return path.join(dir, name);
}

// The share of `expected` times that have one of `found` within `within`
// seconds.
function matched(expected, found, within) {
  if (!expected.length) return 1;
  let hits = 0;
  for (const t of expected) if (found.some((f) => Math.abs(f - t) <= within)) hits++;
  return hits / expected.length;
}

module.exports = { fixture, outDir, matched, dir };
