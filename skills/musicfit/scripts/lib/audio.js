"use strict";

// ffmpeg does the decoding, the encoding and the loudness measurement.
// Samples travel through pipes as raw 32-bit floats, so nothing is written
// to disk but the final files. Every call here works with ffmpeg 4.4 (the
// one Ubuntu 22.04 has) and newer.

const path = require("node:path");
const { spawn } = require("node:child_process");

const RATE = 48000;

function ffmpegPath() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

// A file as ffmpeg is given it: by its full path, since ffmpeg takes a name
// whose part before a colon is all letters and digits (9:16.mp4) for a
// protocol, and never a full path.
const where = (file) => path.resolve(file);

// What ffmpeg prints once it has given up, after the line that says why:
// how it stopped, which says nothing of the cause. ffmpeg 4.4 ends with the
// first five, ffmpeg 7 and newer with the others.
const CLOSING = [
  /^Conversion failed!?$/,
  /^Error while processing the decoded data/,
  /^Failed to inject frame into filter network/,
  /^Error reinitializing filters!?$/,
  /^Exiting normally/,
  /^Error opening (input|output) files?\b/,
  /^Error selecting an encoder$/,
  /^Error closing file\b/,
  /^Error muxing a packet$/,
  /^Task finished with error code/,
  /^Terminating thread with return code/,
];
// The words of a line that says what went wrong.
const WRONG = /error|\b(invalid|unable|cannot|can't|could not|couldn't|failed|not found|no such|unknown|unrecognized|not supported|denied|no space|refused|not opened|is not|does not)\b/i;
// What ffmpeg says of its input and output on the way, for a run that names no error.
const INFO = /^(Input|Output) #\d|^Stream (mapping|#)|^Guessed Channel Layout|^Estimating duration|^Duration:|^Metadata:|^Press \[q\]|^(size|frame)=|^Summary:$/;

// Why ffmpeg failed, from what it printed: the last line that names an
// error once the closing lines and the indented ones (a summary, the
// streams) are left out, without the "[name @ 0x...]" that starts it; else
// the last line it printed that says something.
function reason(stderr, code, signal) {
  if (signal) return `ffmpeg was stopped (${signal})`;
  // ffmpeg stopped by a signal it caught, as Ctrl-C.
  const caught = /received signal (\d+)/.exec(stderr || "");
  if (caught) return `ffmpeg was stopped (signal ${caught[1]})`;
  const lines = String(stderr || "")
    .split(/\r?\n|\r/)
    .filter((line) => line.trim() && !/^\s/.test(line))
    .map((line) => line.replace(/^(\[[^\]]*\]\s*)+/, "").trim())
    .filter((line) => line && !CLOSING.some((closing) => closing.test(line)));
  const line = lines.filter((l) => WRONG.test(l)).pop() || lines.filter((l) => !INFO.test(l)).pop();
  if (!line) return `ffmpeg exited with ${code}`;
  return /ffmpeg/i.test(line) ? line : `ffmpeg: ${line}`;
}

// The ffmpeg processes running now, so a run that is stopped stops them
// too: a signal sent to node alone does not reach them.
const running = new Set();

function stopChildren() {
  for (const child of running) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Gone already.
    }
  }
  running.clear();
}

function run(args, input) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpegPath(), ["-hide_banner", ...(input ? [] : ["-nostdin"]), ...args], { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }
    running.add(child);
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      running.delete(child);
      if (error.code === "ENOENT") reject(new Error("musicfit needs ffmpeg. Install it (brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg) or set FFMPEG_PATH to it."));
      else reject(error);
    });
    child.on("close", (code, signal) => {
      running.delete(child);
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === 0) resolve({ chunks: out, stderr });
      else reject(Object.assign(new Error(reason(stderr, code, signal)), { stderr, signal }));
    });
    if (input) {
      // ffmpeg may stop reading early when it fails; the error that follows
      // tells why, the broken pipe does not.
      child.stdin.on("error", () => {});
      child.stdin.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
    }
  });
}

// The pipe's chunks copied byte for byte into one array of floats, without
// joining them first: a long track would be held twice.
function floats(chunks) {
  const bytes = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(Math.floor(bytes / 4));
  const view = new Uint8Array(out.buffer);
  let at = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, view.length - at);
    if (take <= 0) break;
    view.set(chunk.subarray(0, take), at);
    at += take;
  }
  return out;
}

// The first audio stream of any file ffmpeg reads (a video's too), as
// interleaved floats at the given rate and channel count. With `from` it is
// read on the file's own timeline from that second on, for a video's own
// sound from its picture's first frame: cut where the sound starts before
// it, silence where the sound starts after it or has a gap, so a second
// into the sound is a second into the picture.
async function decode(file, { rate = RATE, channels = 2, from = null } = {}) {
  const timeline = from === null ? [] : ["-copyts"];
  const align = from === null ? [] : ["-af", `aresample=${rate}:async=1:first_pts=${Math.round(from * rate)}`];
  try {
    const { chunks } = await run(["-v", "error", ...timeline, "-i", where(file), "-map", "0:a:0", "-vn", ...align, "-ac", String(channels), "-ar", String(rate), "-f", "f32le", "pipe:1"]);
    const samples = floats(chunks);
    if (!samples.length) throw new Error(`${file} has no audio`);
    return samples;
  } catch (err) {
    // ffmpeg says why early and sums up last, so all it said is searched.
    const said = err.stderr || err.message;
    if (/matches no streams/.test(said)) throw new Error(`${file} has no audio stream`);
    if (/No such file|does not exist/.test(said)) throw new Error(`Cannot read ${file}: no such file`);
    if (/Invalid data found/.test(said)) throw new Error(`Cannot read ${file}: ffmpeg does not know this format`);
    throw err;
  }
}

// Writes interleaved stereo floats as a 24-bit WAV. bitexact leaves out the
// header's note of the ffmpeg that wrote it, so any ffmpeg writes the same
// bytes for the same sound.
async function encodeWav(samples, file, { rate = RATE, channels = 2 } = {}) {
  await run(["-v", "error", "-f", "f32le", "-ar", String(rate), "-ac", String(channels), "-i", "pipe:0", "-c:a", "pcm_s24le", "-fflags", "+bitexact", "-y", where(file)], samples);
}

// EBU R128 loudness as ffmpeg's ebur128 meter reads it: integrated
// loudness (LUFS), true peak (dBTP, oversampled), loudness range (LU).
// Silence reads -Infinity. loudnorm measures the same way but upsamples
// everything to 192 kHz first, which is ten times slower. framelog=verbose
// keeps the meter's line for every 100 ms out of what -v info prints;
// ffmpeg 4.4 has no quieter value, and the summary is the same.
const METER = "ebur128=peak=true:framelog=verbose";

function summary(stderr) {
  const said = stderr.slice(stderr.lastIndexOf("Integrated loudness:"));
  const read = (label) => {
    const m = new RegExp(`${label}:\\s*(-?inf|-?[\\d.]+)`).exec(said);
    if (!m) throw new Error("ffmpeg's ebur128 printed no measurement");
    return /inf/.test(m[1]) ? -Infinity : Number(m[1]);
  };
  const integrated = read("I");
  return { integrated: integrated <= -70 ? -Infinity : integrated, truePeak: read("Peak"), range: read("LRA") };
}

async function measure(samples, { rate = RATE, channels = 2 } = {}) {
  const { stderr } = await run(["-v", "info", "-nostats", "-f", "f32le", "-ar", String(rate), "-ac", String(channels), "-i", "pipe:0", "-af", METER, "-f", "null", "-"], samples);
  return summary(stderr);
}

// The same for the first sound of a file, as a player decodes it.
async function measureFile(file) {
  const { stderr } = await run(["-v", "info", "-nostats", "-i", where(file), "-map", "0:a:0", "-af", METER, "-f", "null", "-"]);
  return summary(stderr);
}

module.exports = { RATE, decode, encodeWav, measure, measureFile, run, reason, stopChildren, where };
