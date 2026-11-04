"use strict";

// ffmpeg does the decoding, the encoding and the loudness measurement.
// Samples travel through pipes as raw 32-bit floats, so nothing is written
// to disk but the final files.

const { spawn } = require("node:child_process");

const RATE = 48000;

function ffmpegPath() {
  return process.env.FFMPEG_PATH || "ffmpeg";
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
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      if (error.code === "ENOENT") reject(new Error("musicfit needs ffmpeg. Install it (brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg) or set FFMPEG_PATH to it."));
      else reject(error);
    });
    child.on("close", (code) => {
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === 0) resolve({ chunks: out, stderr });
      else {
        const why = stderr.trim().split("\n").filter(Boolean).pop() || `ffmpeg exited with ${code}`;
        reject(Object.assign(new Error(why), { stderr }));
      }
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
// interleaved floats at the given rate and channel count.
async function decode(file, { rate = RATE, channels = 2 } = {}) {
  try {
    const { chunks } = await run(["-v", "error", "-i", file, "-map", "0:a:0", "-vn", "-ac", String(channels), "-ar", String(rate), "-f", "f32le", "pipe:1"]);
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

// Writes interleaved stereo floats as a 24-bit WAV.
async function encodeWav(samples, file, { rate = RATE, channels = 2 } = {}) {
  await run(["-v", "error", "-f", "f32le", "-ar", String(rate), "-ac", String(channels), "-i", "pipe:0", "-c:a", "pcm_s24le", "-y", file], samples);
}

// EBU R128 loudness as ffmpeg's ebur128 meter reads it: integrated
// loudness (LUFS), true peak (dBTP, oversampled), loudness range (LU).
// Silence reads -Infinity. loudnorm measures the same way but upsamples
// everything to 192 kHz first, which is ten times slower.
async function measure(samples, { rate = RATE, channels = 2 } = {}) {
  const { stderr } = await run(["-v", "info", "-f", "f32le", "-ar", String(rate), "-ac", String(channels), "-i", "pipe:0", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"], samples);
  const summary = stderr.slice(stderr.lastIndexOf("Integrated loudness:"));
  const read = (label) => {
    const m = new RegExp(`${label}:\\s*(-?inf|-?[\\d.]+)`).exec(summary);
    if (!m) throw new Error("ffmpeg's ebur128 printed no measurement");
    return /inf/.test(m[1]) ? -Infinity : Number(m[1]);
  };
  const integrated = read("I");
  return { integrated: integrated <= -70 ? -Infinity : integrated, truePeak: read("Peak"), range: read("LRA") };
}

module.exports = { RATE, decode, encodeWav, measure };
