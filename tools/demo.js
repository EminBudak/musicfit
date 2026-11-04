#!/usr/bin/env node
"use strict";

// Makes the three demo tracks (house at 124, swung lofi at 86 and a
// cinematic piece at 72, all synthesized by test/synth.js), fits each to a
// few cuts, and prints what came out. With --readme it also copies the
// house fit's seams.png to .github/assets/ for the README.
//
//   node tools/demo.js [out dir] [--readme]

const fs = require("node:fs");
const path = require("node:path");
const { song, voice, writeWav, STYLES } = require("../test/synth");
const { fit } = require("../skills/musicfit/scripts/lib/fit");

const args = process.argv.slice(2);
const out = path.resolve(args.find((a) => !a.startsWith("--")) || "musicfit-demo");
const readme = args.includes("--readme");

const RUNS = [
  { style: "house", name: "house-32-hit", options: { length: 32, hit: 27.5, voice: "vo" } },
  { style: "house", name: "house-150", options: { length: 150, hit: 60 } },
  { style: "lofi", name: "lofi-15", options: { length: 15 } },
  { style: "lofi", name: "lofi-75-hit", options: { length: 75, hit: 30 } },
  { style: "cinematic", name: "cinematic-45-hit", options: { length: 45, hit: 20 } },
  { style: "cinematic", name: "cinematic-120", options: { length: 120 } },
];

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const tracks = {};
  for (const style of Object.keys(STYLES)) {
    tracks[style] = path.join(out, `${style}.wav`);
    writeWav(tracks[style], song(STYLES[style]()));
  }
  const vo = path.join(out, "vo.wav");
  writeWav(vo, voice(32, [[2, 6.5], [7.2, 11], [16, 22.5], [24, 27]]));
  for (const run of RUNS) {
    const options = { fps: 30, duck: 10, lufs: -14, end: "auto", ...run.options, voice: run.options.voice ? vo : undefined, out: path.join(out, run.name) };
    const started = Date.now();
    const { cues } = await fit(tracks[run.style], options);
    const parts = cues.segments.map((s) => (s.sourceBars[0] === s.sourceBars[1] ? `${s.sourceBars[0]}` : `${s.sourceBars[0]}-${s.sourceBars[1]}`)).join(" | ");
    console.log(`${run.name.padEnd(17)} ${cues.tempo.bpm} BPM  bars ${parts}  seams ${cues.seams.length}  end ${cues.end.kind}  ${cues.loudness.integrated} LUFS  ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
  if (readme) {
    const target = path.resolve(__dirname, "../.github/assets/seams.png");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(out, "house-32-hit", "seams.png"), target);
    console.log(`Copied ${path.relative(process.cwd(), target)}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
