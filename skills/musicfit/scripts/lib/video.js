"use strict";

// --video: what the video holds, read before any work; its own sound on its
// timeline; and the fitted sound laid under its picture, which is copied
// packet for packet and never encoded again. Every call goes through the
// same ffmpeg (FFMPEG_PATH), and none needs ffprobe.

const fs = require("node:fs");
const path = require("node:path");
const { RATE, run, decode } = require("./audio");

const num = (x, digits) => String(Number(x.toFixed(digits)));

// A frame rate as people write it: 25, 29.97, 23.976.
const fpsText = (fps) => num(fps, 3);

// The usual frame rates. A steady rate read from a timebase in whole
// milliseconds comes out a hair off (29.969 for 29.97): within a tenth of a
// percent of one of these, it is that one.
const RATES = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48000 / 1001, 48, 50, 60000 / 1001, 60, 100, 120000 / 1001, 120, 144, 240];
const nominal = (fps) => RATES.find((rate) => Math.abs(fps - rate) < rate * 0.001) || fps;

// The comment musicfit writes in video.mp4, so a video it made is known
// when it is given back as --video.
const mark = (version, track, source) => `musicfit ${version}: ${track} laid under ${source}`;
const MARK = /^musicfit \S+: (.+) laid under (.+)$/;

// What ffmpeg says of the input: its lines from "Input #0" up to the first
// output.
function inputSection(said) {
  const from = Math.max(0, said.indexOf("Input #0"));
  const rest = said.slice(from);
  const to = rest.search(/^(Output #0|Stream mapping:)/m);
  return to < 0 ? rest : rest.slice(0, to);
}

// The video's picture as its packets give it: how long it is, its frames,
// its frame rate and whether that holds steady, the codec of its picture
// and of its sound, and the mark of musicfit when musicfit made it. With
// `scratch`, one frame is copied into an MP4 there too, to see that an MP4
// holds the picture as it is. Refused with the reason when the video
// cannot be read, has no picture or a still one, or holds a picture an MP4
// cannot take without encoding it again.
async function probe(file, { scratch = null } = {}) {
  const name = path.basename(file);
  let crc;
  let said;
  try {
    const args = ["-v", "info", "-nostats", "-i", file, "-map", "0:V:0", "-c", "copy", "-f", "framecrc", "pipe:1"];
    if (scratch) args.push("-map", "0:V:0", "-c", "copy", "-frames:v", "1", "-f", "mp4", "-y", scratch);
    const { chunks, stderr } = await run(args);
    crc = Buffer.concat(chunks).toString("utf8");
    said = stderr;
  } catch (err) {
    const why = err.stderr || err.message;
    if (/No such file|does not exist/.test(why)) throw new Error(`Cannot read ${file}: no such file`);
    if (/Invalid data found|moov atom not found/.test(why)) throw new Error(`Cannot read ${file}: ffmpeg does not know this format`);
    if (/matches no streams/.test(why)) throw new Error(`${name} has no picture to lay the music under`);
    const tag = /Could not find tag for codec (\w+)/.exec(why);
    if (tag) throw new Error(`${name}'s picture is ${tag[1]}, which an MP4 cannot hold without encoding it again: give --video an H.264 or HEVC copy of it`);
    throw err;
  } finally {
    if (scratch) fs.rmSync(scratch, { force: true });
  }

  const input = inputSection(said);
  const lines = input.split("\n");
  const pictureLine = lines.find((l) => /^\s*Stream #0:\d+.*: Video: /.test(l) && !/\(attached pic\)/.test(l)) || "";
  const soundLine = lines.find((l) => /^\s*Stream #0:\d+.*: Audio: /.test(l));
  const format = (/Input #0, ([^,\s]+)/.exec(input) || [])[1] || "";
  // The file's own tags come before its duration; the streams' after.
  const head = input.slice(0, Math.max(0, input.search(/^\s*Duration:/m)));
  const comment = (/^\s*comment\s*:\s?(.*)$/im.exec(head) || [])[1] || "";
  const made = MARK.exec(comment.trim());

  // framecrc lists each packet as: stream, dts, pts, duration, size, crc.
  const tb = /^#tb 0: (\d+)\/(\d+)/m.exec(crc);
  const unit = tb ? Number(tb[1]) / Number(tb[2]) : 0;
  let frames = 0;
  const packets = [];
  for (const line of crc.split("\n")) {
    if (!/^\d/.test(line)) continue;
    frames++;
    const [, dts, pts, duration] = line.split(",").map((s) => Number(s.trim()));
    const at = pts > -1e15 ? pts : dts > -1e15 ? dts : NaN;
    if (Number.isFinite(at)) packets.push({ at, duration });
  }
  // The step from frame to frame: the middle one of the gaps between their
  // times, else of their durations. The rate holds steady when every gap
  // is that step, give or take a tick of the timebase (a 29.97 fps video
  // in a millisecond timebase steps 33 and 34).
  const times = packets.map((p) => p.at).sort((a, b) => a - b);
  const gaps = times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0);
  const durations = packets.map((p) => p.duration).filter((d) => d > 0);
  const middle = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const step = gaps.length ? middle(gaps) : durations.length ? middle(durations) : 0;
  let first = Infinity;
  let last = -Infinity;
  for (const p of packets) {
    first = Math.min(first, p.at);
    last = Math.max(last, p.at + (p.duration > 0 ? p.duration : step));
  }
  const start = Number.isFinite(first) ? first * unit : 0;
  const seconds = Number.isFinite(last) ? last * unit : 0;
  if (frames <= 1 || /^(image2|image2pipe|\w+_pipe)$/.test(format) || !(seconds > start) || !step) throw new Error(`${name} is a still picture, not a video`);
  const constant = gaps.every((g) => Math.abs(g - step) <= Math.max(1, step * 0.01));

  // A steady rate from the first frame to the last, which a timebase in
  // whole milliseconds rounds no frame of; else frames over the time.
  const span = (times[times.length - 1] - times[0]) * unit;
  return {
    file,
    name,
    seconds,
    start,
    frames,
    fps: constant && span > 0 ? nominal((times.length - 1) / span) : frames / (seconds - start),
    constant,
    picture: (/: Video: (\w+)/.exec(pictureLine) || [])[1] || "unknown",
    sound: soundLine ? (/: Audio: (\w+)/.exec(soundLine) || [])[1] || "unknown" : null,
    made: made ? { track: made[1], source: made[2] } : null,
  };
}

// Refuses a video that is not `length` long to a frame of it: the sound
// is cut or padded to the picture only within that frame. `fps` is the
// rate frames count at here.
function fits(info, length, fps) {
  if (Math.abs(info.seconds - length) <= 1 / info.fps + 1e-6) return;
  let frames = "";
  // In frames too, when they mean one moment: a steady rate, from the top.
  if (info.constant && info.start < 0.5 / info.fps) frames = `, or ${info.frames}f${Math.abs(fps - info.fps) > info.fps * 0.0005 ? ` with --fps ${fpsText(info.fps)}` : ""}`;
  const counted = info.constant ? ` (${info.frames} frames at ${fpsText(info.fps)} fps)` : "";
  throw new Error(`${info.name} is ${info.seconds.toFixed(2)} s long${counted} and --length is ${length.toFixed(2)} s: give --length ${num(info.seconds, 3)}${frames}`);
}

// The video's own sound on its timeline, as { L, R } exactly `n` samples
// long, and how many seconds of it ran past that and were cut; null when
// it has none.
async function ownSound(file, n) {
  let x;
  try {
    x = await decode(file, { rate: RATE, channels: 2, timeline: true });
  } catch (err) {
    if (/has no audio/.test(err.message)) return null;
    throw err;
  }
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const have = Math.min(n, x.length / 2);
  for (let i = 0; i < have; i++) {
    L[i] = x[2 * i];
    R[i] = x[2 * i + 1];
  }
  return { L, R, over: Math.max(0, x.length / 2 - n) / RATE };
}

// The interleaved sound as AAC in an .m4a of its own, to be measured as a
// player hears it before the picture is copied over it once.
async function encodeAac(samples, file) {
  await run(["-v", "error", "-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", "pipe:0", "-c:a", "aac", "-b:a", "192k", "-y", file], samples);
}

// The video's picture, copied packet for packet, over `sound` (an .m4a),
// copied too, in an MP4 that plays as it downloads. `comment` replaces the
// video's own comment tag, so a mark another tool left there (voiceoverfit
// marks its files so) is not carried over to a file it did not make. HEVC
// is tagged hvc1, the tag QuickTime, Safari and iOS play.
async function mux(file, sound, out, { picture, comment }) {
  const tag = picture === "hevc" ? ["-tag:v", "hvc1"] : [];
  await run(["-v", "error", "-i", file, "-i", sound, "-map", "0:V:0", "-map", "1:a:0", "-c", "copy", ...tag, "-metadata", `comment=${comment}`, "-movflags", "+faststart", "-y", out]);
}

module.exports = { probe, fits, ownSound, encodeAac, mux, mark, fpsText };
