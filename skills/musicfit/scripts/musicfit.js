#!/usr/bin/env node
"use strict";

const { fit } = require("./lib/fit");
const version = require("./lib/version");

const USAGE = `Usage: musicfit <track> --length <time> [options]

Fits a music track to a video cut: makes it exactly --length long by
cutting or looping whole bars, lands its drop on --hit, ends it on a beat,
ducks it under a voice and sets its loudness. Writes fitted.wav, cues.json
(every beat, bar, seam and the hit, in seconds and frames), seams.png and
FIT.md (what was done and where to listen).

Options:
  --length <time>   how long the result is, e.g. 32, 32s, 960f or 1:05
  --hit <time>      where the drop lands in the result
  --drop <time>     where the drop is in the track (default: found)
  --fps <n>         frame rate for frame numbers, e.g. 30, 25, 29.97 (default: 30)
  --voice <file>    a voice track on the video's timeline; the music dips under it
  --duck <dB>       how far the music dips under the voice (default: 10)
  --lufs <n>        loudness target in LUFS (default: -14)
  --end <kind>      auto, natural (the track's own ending) or fade (default: auto)
  --fade <s>        length of the closing fade, in whole beats (default: a bar)
  --bpm <n>         the tempo, when the one found is half or double the real one
  --meter <n>       beats to a bar, 3 or 4 (default: found)
  --out <dir>       where to save (default: ./musicfit-<track name>)
  --analyze         only read the track: its beats, bars, drop and ending
  --json            print cues.json instead of a summary
  -h, --help        show this help
  -v, --version     show the version

Times are seconds unless they end in f (frames at --fps). The track can be
any file ffmpeg reads, a video's sound included. Needs Node 22 or newer and
ffmpeg 4.4 or newer; set FFMPEG_PATH to pick the ffmpeg.`;

const VALUED = new Set(["--length", "--hit", "--drop", "--fps", "--voice", "--duck", "--lufs", "--end", "--fade", "--bpm", "--meter", "--out"]);

function parseFps(value) {
  const m = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(value);
  const fps = m ? Number(m[1]) / (m[2] ? Number(m[2]) : 1) : NaN;
  if (!(fps >= 1 && fps <= 240)) throw new Error(`--fps takes a frame rate such as 30, 29.97 or 30000/1001, not ${value}`);
  return fps;
}

// Seconds from "32", "32.5s", "960f" (frames) or "1:05.5".
function parseTime(name, value, fps) {
  const text = String(value).trim();
  let t = NaN;
  let m;
  if ((m = /^(\d+(?:\.\d+)?)f$/i.exec(text))) t = Number(m[1]) / fps;
  else if ((m = /^(\d+(?:\.\d+)?)s?$/i.exec(text))) t = Number(m[1]);
  else if ((m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(text))) t = Number(m[1]) * 60 + Number(m[2]);
  if (!Number.isFinite(t)) throw new Error(`${name} takes a time such as 32, 32.5s, 960f or 1:05, not ${value}`);
  return t;
}

function parse(argv) {
  const raw = {};
  const flags = { help: false, version: false, analyze: false, json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (arg === "-h" || arg === "--help") flags.help = true;
    else if (arg === "-v" || arg === "--version") flags.version = true;
    else if (arg === "--analyze") flags.analyze = true;
    else if (arg === "--json") flags.json = true;
    else if (VALUED.has(name)) {
      const value = name !== arg ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || (name === arg && /^--[a-z]/.test(value))) throw new Error(`${name} needs a value`);
      raw[name.slice(2)] = value;
    } else if (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg)) throw new Error(`Unknown option: ${arg}`);
    else rest.push(arg);
  }
  if (flags.help || flags.version) return { ...flags };
  if (rest.length !== 1) throw new Error("Give one track, for example: musicfit track.mp3 --length 30");
  const fps = raw.fps !== undefined ? parseFps(raw.fps) : 30;
  const options = { ...flags, track: rest[0], fps, duck: 10, lufs: -14, end: "auto" };
  if (raw.length !== undefined) options.length = parseTime("--length", raw.length, fps);
  if (raw.hit !== undefined) options.hit = parseTime("--hit", raw.hit, fps);
  if (raw.drop !== undefined) options.drop = parseTime("--drop", raw.drop, fps);
  if (raw.fade !== undefined) options.fade = parseTime("--fade", raw.fade, fps);
  if (raw.voice !== undefined) options.voice = raw.voice;
  if (raw.out !== undefined) options.out = raw.out;
  if (raw.duck !== undefined) {
    options.duck = Math.abs(Number(raw.duck));
    if (!(options.duck >= 0 && options.duck <= 40)) throw new Error("--duck takes 0 to 40 dB");
  }
  if (raw.lufs !== undefined) {
    options.lufs = Number(raw.lufs);
    if (!(options.lufs >= -40 && options.lufs <= -5)) throw new Error("--lufs takes -40 to -5, for example -14 or -16");
  }
  if (raw.end !== undefined) {
    options.end = raw.end.toLowerCase();
    if (!["auto", "natural", "fade"].includes(options.end)) throw new Error("--end takes auto, natural or fade");
  }
  if (raw.bpm !== undefined) {
    options.bpm = Number(raw.bpm);
    if (!(options.bpm >= 40 && options.bpm <= 250)) throw new Error("--bpm takes 40 to 250");
  }
  if (raw.meter !== undefined) {
    options.meter = Number(String(raw.meter).split("/")[0]);
    if (![2, 3, 4, 6].includes(options.meter)) throw new Error("--meter takes 3 or 4 (also 2 or 6)");
  }
  if (!options.analyze) {
    if (options.length === undefined) throw new Error("Give --length, the length of your cut, or --analyze to only read the track");
    if (!(options.length >= 1 && options.length <= 3600)) throw new Error("--length takes 1 second to an hour");
    if (options.hit !== undefined && !(options.hit >= 0 && options.hit <= options.length)) throw new Error(`--hit has to fall inside --length (0 to ${options.length} s)`);
    if (options.hit !== undefined && options.hit > options.length - 0.5) throw new Error("--hit has to leave at least half a second after it, or the drop is not heard");
  }
  if (options.fade !== undefined && !(options.fade >= 0.1 && options.fade <= 30)) throw new Error("--fade takes 0.1 to 30 seconds");
  return options;
}

const sec = (t) => `${t.toFixed(2)} s`;

function summary({ dir, cues: c }) {
  const lines = [];
  if (c.mode === "analysis") {
    lines.push(`Read ${c.track}: ${sec(c.length)}, ${c.tempo ? `${c.tempo.bpm} BPM, ${c.tempo.meter} beats to a bar, ${c.bars.length} bars` : "no steady beat"}`);
    if (c.source.drop !== null) lines.push(`  Drop    ${sec(c.source.drop)}${c.source.dropBar ? ` (bar ${c.source.dropBar})` : ""}`);
    lines.push(`  Ending  ${c.source.ending === "hit" ? `a last hit at ${sec(c.source.finalHit)}` : c.source.ending}`);
  } else {
    const tempo = c.tempo ? `${c.tempo.bpm} BPM, ${c.tempo.meter}/4` : "no steady beat";
    lines.push(`Fitted ${c.track} (${sec(c.source.duration)}, ${tempo}) to ${sec(c.length)} in ${dir}`);
    if (c.drop) lines.push(`  Hit     ${sec(c.drop.time)}, frame ${c.drop.frame}: ${c.drop.found === "given" ? "the moment given" : c.drop.found === "drop" ? "the drop" : "the biggest change"} at ${sec(c.drop.source)} in the track`);
    const seams = c.seams.map((s) => `${sec(s.time)} (${s.kind}${s.bars !== null ? ` ${s.bars} ${s.bars === 1 ? "bar" : "bars"}` : ""})`);
    lines.push(`  Seams   ${seams.length ? seams.join(", ") : "none"}`);
    let ending = `the track's own ending, last hit at ${sec(c.end.finalHit ? c.end.finalHit.time : c.end.time)}`;
    if (c.end.kind !== "natural") ending = c.end.fade.onBeat ? `a fade ending on the beat at ${sec(c.end.fade.to)}` : `a fade to the end from ${sec(c.end.fade.from)}`;
    lines.push(`  End     ${ending}`);
    if (c.loudness && c.loudness.integrated !== null) lines.push(`  Level   ${c.loudness.integrated} LUFS, true peak ${c.loudness.truePeak} dBTP${c.voice ? `; mix.wav ${c.loudness.mix.integrated} LUFS` : ""}`);
    else if (c.loudness) lines.push("  Level   silent");
  }
  for (const w of c.warnings) lines.push(`  Note    ${w}`);
  lines.push("", `Read ${dir}/FIT.md for ${c.mode === "analysis" ? "the details" : "where to listen"}.`);
  return lines.join("\n");
}

async function main() {
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`musicfit: ${err.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (options.help) return void process.stdout.write(`${USAGE}\n`);
  if (options.version) return void process.stdout.write(`${version}\n`);
  try {
    const result = await fit(options.track, { ...options, log: options.json ? () => {} : (line) => process.stderr.write(`${line}\n`) });
    process.stdout.write(options.json ? JSON.stringify(result.cues, null, 2) + "\n" : summary(result) + "\n");
  } catch (err) {
    if (options.json) process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
    process.stderr.write(`musicfit: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parse, parseTime, parseFps, summary };
