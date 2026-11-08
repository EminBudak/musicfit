#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const { fit, outDir } = require("./lib/fit");
const { underVideo } = require("./lib/report");
const { probe, fpsText } = require("./lib/video");
const { stopAll } = require("./lib/out");
const version = require("./lib/version");

const USAGE = `Usage: musicfit <track> --length <time> [options]

Fits a music track to a video cut: makes it exactly --length long by
cutting or looping whole bars, lands its drop on --hit, ends it on a beat,
ducks it under a voice and sets its loudness. Writes fitted.wav, cues.json
(every beat, bar, seam and the hit, in seconds and frames), seams.png and
FIT.md (what was done and where to listen), and with --video the video with
the result under it, video.mp4.

Options:
  --length <time>   how long the result is, e.g. 32, 32s, 960f or 1:05
  --hit <time>      where the drop lands in the result
  --drop <time>     where the drop is in the track (default: found)
  --fps <n>         frame rate for frame numbers, e.g. 30, 25, 29.97
                    (default: the video's with --video, else 30)
  --voice <file>    a voice track on the video's timeline; the music dips under it
  --duck <dB>       how far the music dips under the voice (default: 10)
  --video <file>    a video to lay the result under: also writes video.mp4,
                    the video's picture as it was with this sound under it.
                    The video has to be --length long, to a frame
  --video-sound <how>
                    what becomes of the video's own sound: keep (sound
                    effects: they stay, turned down to --lufs if they are
                    louder, and the music dips half of --duck under them),
                    voice (speech: set to --lufs, the music dips --duck under
                    it) or drop (music of its own: left out). Without it, a
                    video with more than a faint room tone of its own is
                    refused until you choose
  --lufs <n>        loudness target in LUFS (default: -14)
  --end <kind>      auto, natural (the track's own ending) or fade (default: auto)
  --fade <s>        length of the closing fade, in whole beats (default: a bar)
  --bpm <n>         the tempo, when the one found is half or double the real one
  --meter <n>       beats to a bar, 3 or 4 (default: found)
  --out <dir>       where to save (default: ./musicfit-<track name>, or
                    ./musicfit-<track name>.analysis with --analyze)
  --analyze         only read the track: its beats, bars, drop and ending
  --json            print cues.json instead of a summary
  -h, --help        show this help
  -v, --version     show the version

Times are seconds unless they end in f: frames at --fps, or with --video and
no --fps at the video's frame rate. The track can be any file ffmpeg reads,
a video's sound included. Needs Node 22 or newer and ffmpeg 4.4 or newer;
set FFMPEG_PATH to pick the ffmpeg.`;

const VALUED = new Set(["--length", "--hit", "--drop", "--fps", "--voice", "--duck", "--video", "--video-sound", "--lufs", "--end", "--fade", "--bpm", "--meter", "--out"]);

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
  // With --video and no --fps, frames count at the video's frame rate: a
  // time given in frames waits in `frames` until main() has read it.
  const later = raw.video !== undefined && raw.fps === undefined && !flags.analyze;
  const options = { ...flags, track: rest[0], fps: later ? undefined : fps, duck: 10, lufs: -14, end: "auto" };
  for (const name of ["length", "hit", "drop", "fade"]) {
    const value = raw[name];
    if (value === undefined) continue;
    if (later && /^\s*\d+(?:\.\d+)?f\s*$/i.test(value)) options.frames = { ...options.frames, [name]: value };
    else options[name] = parseTime(`--${name}`, value, fps);
  }
  if (raw.voice !== undefined) options.voice = raw.voice;
  if (raw["video-sound"] !== undefined) {
    options.videoSound = raw["video-sound"].toLowerCase();
    if (!["keep", "voice", "drop"].includes(options.videoSound)) throw new Error("--video-sound takes keep, voice or drop");
    if (raw.video === undefined) throw new Error("--video-sound goes with --video");
  }
  if (raw.video !== undefined) {
    if (flags.analyze) throw new Error("--video lays a fit under a video and --analyze only reads the track: give one of them");
    options.video = raw.video;
  }
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
  if (!options.analyze && raw.length === undefined) throw new Error("Give --length, the length of your cut, or --analyze to only read the track");
  if (!options.frames) check(options);
  return options;
}

// The rules for the times, once each is known in seconds.
function check(options) {
  if (!options.analyze) {
    if (!(options.length >= 1 && options.length <= 3600)) throw new Error("--length takes 1 second to an hour");
    if (options.hit !== undefined && !(options.hit >= 0 && options.hit <= options.length)) throw new Error(`--hit has to fall inside --length (0 to ${options.length} s)`);
    if (options.hit !== undefined && options.hit > options.length - 0.5) throw new Error("--hit has to leave at least half a second after it, or the drop is not heard");
  }
  if (options.fade !== undefined && !(options.fade >= 0.1 && options.fade <= 30)) throw new Error("--fade takes 0.1 to 30 seconds");
}

// Times given in frames with --video and no --fps, read at the video's
// frame rate. A rate that does not hold steady gives a frame no one time.
async function atVideoRate(options) {
  const picture = await probe(options.video);
  const names = Object.keys(options.frames).map((name) => `--${name}`);
  if (!picture.constant) throw new Error(`${picture.name} has no steady frame rate, so a time in frames does not name one moment of it: give ${names.join(" and ")} in seconds, or give --fps`);
  options.fps = Number(fpsText(picture.fps));
  for (const [name, value] of Object.entries(options.frames)) options[name] = parseTime(`--${name}`, value, options.fps);
  delete options.frames;
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
    if (c.video) lines.push(`  Video   video.mp4 is ${c.video.source} with ${underVideo(c)}; ${c.video.loudness.integrated} LUFS, true peak ${c.video.loudness.truePeak} dBTP`);
  }
  for (const w of c.warnings) lines.push(`  Note    ${w}`);
  lines.push("", `Read ${dir}/FIT.md for ${c.mode === "analysis" ? "the details" : "where to listen"}.`);
  return lines.join("\n");
}

// A run stopped with Ctrl-C or a signal stops its ffmpeg and removes what
// it had made, so the out folder is left as it was, says so, and ends by
// that signal. It says so too when its ffmpeg was stopped a moment before
// it, by the same Ctrl-C, and the run has just failed over that, and when
// it is stopped before it began, while it reads the video's frame rate. A
// second signal, like the copy makersmcp's supervisor passes on a moment
// after the one its process group got, finds the listener still there and
// changes nothing.
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", ...(process.platform === "win32" ? ["SIGBREAK"] : [])];
let stopping = false;
// The out folder of a run that has not begun yet.
let pending = null;

// Written at once: a pipe can be asynchronous, and the process ends next.
function say(fd, text) {
  try {
    fs.writeSync(fd, text);
  } catch {
    // Nobody is reading.
  }
}

function stopOnSignals(json) {
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      const stopped = stopAll();
      for (const said of stopped.length || !pending ? stopped : [`${pending} is as it was`]) {
        const message = `stopped, so ${said}`;
        if (json) say(1, JSON.stringify({ ok: false, error: message }) + "\n");
        say(2, `musicfit: ${message}\n`);
      }
      for (const name of SIGNALS) process.removeAllListeners(name);
      const code = 128 + os.constants.signals[signal];
      try {
        process.kill(process.pid, signal);
      } catch {
        // Windows cannot raise every signal.
        process.exit(code);
      }
      // Only reached where that signal does not end a process.
      setTimeout(() => process.exit(code), 100);
    });
  }
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
  stopOnSignals(options.json);
  const fail = (message, code) => {
    if (options.json) process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
    process.stderr.write(`musicfit: ${message}\n${code === 2 ? `\n${USAGE}\n` : ""}`);
    process.exit(code);
  };
  if (options.frames) {
    pending = outDir(options.track, options);
    try {
      await atVideoRate(options);
    } catch (err) {
      if (stopping) return;
      return fail(err.message, 1);
    }
    pending = null;
    try {
      check(options);
    } catch (err) {
      return fail(err.message, 2);
    }
  }
  try {
    const result = await fit(options.track, { ...options, log: options.json ? () => {} : (line) => process.stderr.write(`${line}\n`) });
    process.stdout.write(options.json ? JSON.stringify(result.cues, null, 2) + "\n" : summary(result) + "\n");
  } catch (err) {
    // When the whole process group is stopped, as with Ctrl-C, ffmpeg can
    // end before this process hears its own signal: an ffmpeg that a
    // signal stopped gives that signal a moment to come. A stopped run has
    // said so and ends by it.
    if (err.signal || /received signal \d+/.test(err.stderr || "")) await new Promise((resolve) => setTimeout(resolve, 1000));
    if (stopping) return;
    fail(err.message, 1);
  }
}

if (require.main === module) main();

module.exports = { parse, check, parseTime, parseFps, summary };
