"use strict";

// --video: what the video holds, read before any work; its own sound on its
// timeline; and the fitted sound laid under its picture, which is copied
// packet for packet and never encoded again. Every call goes through the
// same ffmpeg (FFMPEG_PATH), and none needs ffprobe.

const fs = require("node:fs");
const path = require("node:path");
const { RATE, run, decode, where } = require("./audio");

const num = (x, digits) => String(Number(x.toFixed(digits)));

// A frame rate as people write it: 25, 29.97, 23.976.
const fpsText = (fps) => num(fps, 3);

// The usual frame rates. A steady rate read from a timebase in whole
// milliseconds comes out a hair off (29.969 for 29.97): within a tenth of a
// percent of one of these, it is that one.
const RATES = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48000 / 1001, 48, 50, 60000 / 1001, 60, 100, 120000 / 1001, 120, 144, 240];
const nominal = (fps) => RATES.find((rate) => Math.abs(fps - rate) < rate * 0.001) || fps;

// The comment musicfit writes in video.mp4, so a video it made is known
// when it is given back as --video. It names no file: the video goes out
// to people, and the names of the files it was made from are the user's.
const mark = (version) => `musicfit ${version}: a fitted track laid under this picture`;
const MARK = /^musicfit \S+: a fitted track laid under this picture$/;

// What ffmpeg prints while it reads a file that is cut short or has a
// broken packet: a packet cut off at the end, an MP4's samples past the end
// of the file, a Matroska or WebM file that stops in the middle. Only its
// own lines are read for these, never the file's name or its tags.
const DAMAGED = [
  /^\[[^\]\n]+\] (?:Packet corrupt\b|File ended prematurely\b|stream \d+, offset 0x[0-9a-f]+: partial file\b|corrupt input packet in stream \d+)/m,
  // ffmpeg 4.4 starts this one with the file's name.
  /: corrupt input packet in stream \d+\s*$/m,
];

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
// and of its sound, and whether musicfit made it. One frame is copied into
// an MP4 too, into a pipe, to see that an MP4 holds the picture as it is.
// Refused with the reason when the video cannot be read, is cut short or
// damaged, has no picture or a still one, or holds a picture an MP4 cannot
// take without encoding it again.
async function probe(file) {
  const name = path.basename(file);
  const size = (fs.statSync(file, { throwIfNoEntry: false }) || {}).size;
  if (size === 0) throw new Error(`Cannot read ${file}: it is empty`);
  let crc;
  let said;
  try {
    const { chunks, stderr } = await run(["-v", "info", "-nostats", "-i", where(file), "-map", "0:V:0", "-c", "copy", "-f", "framecrc", "pipe:1"]);
    crc = Buffer.concat(chunks).toString("utf8");
    said = stderr;
  } catch (err) {
    const why = err.stderr || err.message;
    if (/No such file|does not exist/.test(why)) throw new Error(`Cannot read ${file}: no such file`);
    // An MP4 or a MOV that stops before its index, as one whose recording
    // or download was cut off; a file ffmpeg only guessed was one is not.
    if (/moov atom not found/.test(why) && !/detected only with low score/.test(why)) throw new Error(`Cannot read ${file}: it is cut short or damaged, so ffmpeg finds no index in it`);
    if (/Invalid data found|moov atom not found/.test(why)) throw new Error(`Cannot read ${file}: ffmpeg does not know this format`);
    if (/matches no streams/.test(why)) throw new Error(`${name} has no picture to lay the music under`);
    throw err;
  }

  const input = inputSection(said);
  const lines = input.split("\n");
  const pictureLine = lines.find((l) => /^\s*Stream #0:\d+.*: Video: /.test(l) && !/\(attached pic\)/.test(l)) || "";
  const soundLine = lines.find((l) => /^\s*Stream #0:\d+.*: Audio: /.test(l));
  const format = (/Input #0, ([^,\s]+)/.exec(input) || [])[1] || "";
  // The file's own tags come before its duration; the streams' after.
  const head = input.slice(0, Math.max(0, input.search(/^\s*Duration:/m)));
  const comment = (/^\s*comment\s*:\s?(.*)$/im.exec(head) || [])[1] || "";

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
  // What ffmpeg said as it read the packets, without the file's header,
  // where its name and its tags are.
  const reading = said.includes("Input #0") ? said.replace(input, "") : said;
  if (DAMAGED.some((line) => line.test(reading))) {
    const d = /^\s*Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/m.exec(input);
    const whole = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
    throw new Error(`Cannot read ${file}: it is cut short or damaged (ffmpeg could read ${frames} ${frames === 1 ? "frame" : "frames"}, ${(seconds - start).toFixed(2)} s${whole > seconds - start + 0.05 ? ` of the ${whole.toFixed(2)} s it says it holds` : ""})`);
  }
  if (frames <= 1 || /^(image2|image2pipe|\w+_pipe)$/.test(format) || !(seconds > start) || !step) throw new Error(`${name} is a still picture, not a video`);
  const constant = gaps.every((g) => Math.abs(g - step) <= Math.max(1, step * 0.01));

  try {
    await run(["-v", "error", "-i", where(file), "-map", "0:V:0", "-c", "copy", "-frames:v", "1", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+delay_moov", "pipe:1"]);
  } catch (err) {
    const tag = /Could not find tag for codec (\w+)/.exec(err.stderr || err.message);
    if (tag) throw new Error(`${name}'s picture is ${tag[1]}, which an MP4 cannot hold without encoding it again: give --video an H.264 or HEVC copy of it`);
    throw err;
  }

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
    made: MARK.test(comment.trim()),
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
  await run(["-v", "error", "-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", "pipe:0", "-c:a", "aac", "-b:a", "192k", "-y", where(file)], samples);
}

// The video's picture, copied packet for packet, over `sound` (an .m4a),
// copied too, in an MP4 that plays as it downloads. `comment` replaces the
// video's own comment tag, so a mark another tool left there (voiceoverfit
// marks its files so) is not carried over to a file it did not make. HEVC
// is tagged hvc1, the tag QuickTime, Safari and iOS play.
async function mux(file, sound, out, { picture, comment }) {
  const tag = picture === "hevc" ? ["-tag:v", "hvc1"] : [];
  await run(["-v", "error", "-i", where(file), "-i", where(sound), "-map", "0:V:0", "-map", "1:a:0", "-c", "copy", ...tag, "-metadata", `comment=${comment}`, "-movflags", "+faststart", "-y", where(out)]);
}

module.exports = { probe, fits, ownSound, encodeAac, mux, mark, fpsText };
