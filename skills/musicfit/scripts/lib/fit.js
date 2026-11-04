"use strict";

// The whole run: decode, analyse, plan, assemble, duck, set the loudness,
// and write fitted.wav (and mix.wav), cues.json, seams.png and FIT.md.

const fs = require("node:fs");
const path = require("node:path");
const { RATE, decode, encodeWav, measure } = require("./audio");
const { analyze, RATE: ANALYSIS_RATE } = require("./analyze");
const { plan } = require("./plan");
const { assemble, speech, duck, normalize, interleave, attackNear } = require("./render");
const { cues: makeCues, analysisCues, fitMarkdown, analysisMarkdown } = require("./report");
const { seamsPng } = require("./draw");
const version = require("./version");

function split(interleaved) {
  const n = interleaved.length / 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = interleaved[2 * i];
    R[i] = interleaved[2 * i + 1];
  }
  return { L, R };
}

function slug(file) {
  return (
    path
      .basename(file)
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "track"
  );
}

// The files musicfit writes; anything else in the folder is left alone.
const OUTPUTS = ["fitted.wav", "mix.wav", "cues.json", "seams.png", "FIT.md"];

function prepare(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of OUTPUTS) fs.rmSync(path.join(dir, name), { force: true });
}

// options: { length, hit, drop, fps, voice, duck, lufs, end, fade, bpm,
// meter, out, analyze, log }
async function fit(track, options) {
  const log = options.log || (() => {});
  const dir = options.out || `musicfit-${slug(track)}`;
  const trackName = path.basename(track);
  log(`Reading ${trackName}`);
  // The interleaved copy is let go as soon as it is split.
  const [source, mono] = await Promise.all([decode(track, { rate: RATE, channels: 2 }).then(split), decode(track, { rate: ANALYSIS_RATE, channels: 1 })]);
  const a = analyze(mono, { bpm: options.bpm, meter: options.meter, drop: options.drop });
  // A drop found on a bar line moves onto the start of its hit.
  if (a.drop && !a.drop.given && a.mode !== "energy") {
    const at = attackNear(source, a.drop.time);
    a.drop.offset += at - a.drop.time;
    a.drop.time = at;
  }
  if (a.tempo && a.mode !== "energy") log(`${a.tempo.bpm.toFixed(1)} BPM, ${a.meter} beats to a bar, ${a.bars.length} bars`);
  else log("No steady beat");

  if (options.analyze) {
    prepare(dir);
    const c = analysisCues({ version, track: trackName, analysis: a, options });
    fs.writeFileSync(path.join(dir, "cues.json"), JSON.stringify(c, null, 2) + "\n");
    fs.writeFileSync(path.join(dir, "FIT.md"), analysisMarkdown(c, { trackName }));
    fs.writeFileSync(path.join(dir, "seams.png"), seamsPng({ cues: { ...c, segments: [] }, source, fitted: null, rate: RATE, analysis: a }));
    return { dir, cues: c, analysis: a };
  }

  if (options.hit !== undefined && options.hit > options.length) throw new Error(`--hit ${options.hit} is past the end (--length ${options.length})`);
  const p = plan(a, { length: options.length, hit: options.hit, end: options.end, fade: options.fade });
  log(`Plan: ${p.segments.length} ${p.segments.length === 1 ? "part" : "parts"}, ${p.seams.length} ${p.seams.length === 1 ? "seam" : "seams"}`);
  const r = assemble(source, p, a, { length: options.length, fade: options.fade });
  const music = { L: r.L, R: r.R };
  const loudness = await normalize(music, { lufs: options.lufs });

  let voice = null;
  let mix = null;
  if (options.voice) {
    log(`Ducking under ${path.basename(options.voice)}`);
    const v = split(await decode(options.voice, { rate: RATE, channels: 2 }));
    const n = music.L.length;
    const spoken = { L: new Float32Array(n), R: new Float32Array(n) };
    spoken.L.set(v.L.subarray(0, n));
    spoken.R.set(v.R.subarray(0, n));
    const spans = speech(spoken);
    duck(music, spans, options.duck);
    await normalize(spoken, { lufs: options.lufs });
    mix = { L: new Float32Array(n), R: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
      mix.L[i] = music.L[i] + spoken.L[i];
      mix.R[i] = music.R[i] + spoken.R[i];
    }
    voice = { file: path.basename(options.voice), duck: options.duck, spans, loudness: await normalize(mix, { lufs: options.lufs }) };
    // The music now dips under the voice, so it reads quieter as a whole.
    loudness.after = await measure(interleave(music));
    if (v.L.length > n + RATE * 0.05) options.warnings = [...(options.warnings || []), `The voice runs ${(v.L.length / RATE - options.length).toFixed(2)} s past the end and was cut there.`];
    if (!spans.length) options.warnings = [...(options.warnings || []), "No speech was found in the voice track, so the music was not ducked."];
  }

  prepare(dir);
  await encodeWav(interleave(music), path.join(dir, "fitted.wav"));
  if (mix) await encodeWav(interleave(mix), path.join(dir, "mix.wav"));
  const c = makeCues({ version, track: trackName, analysis: a, plan: p, result: r, options, loudness, voice });
  fs.writeFileSync(path.join(dir, "cues.json"), JSON.stringify(c, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "FIT.md"), fitMarkdown(c, { trackName }));
  fs.writeFileSync(path.join(dir, "seams.png"), seamsPng({ cues: c, source, fitted: music, rate: RATE, analysis: a }));
  return { dir, cues: c, analysis: a, plan: p };
}

module.exports = { fit };
