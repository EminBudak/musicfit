"use strict";

// --video: what the video holds, read before any work; its own sound on its
// timeline; and the fitted sound laid under its picture, which is copied
// packet for packet and never encoded again. Every call goes through the
// same ffmpeg (FFMPEG_PATH), and none needs ffprobe.
//
// The video is read on its own timestamps (-copyts), the same in every
// call: ffmpeg would otherwise start each call's streams at 0 by its own
// rule, which in an MPEG-TS or a fragmented MP4 moves the picture against
// the sound. Everything here counts from the picture's first frame, and in
// video.mp4 that frame and the sound both start at 0.

const fs = require("node:fs");
const path = require("node:path");
const { RATE, run, decode, where } = require("./audio");
const { blocks } = require("./breathe");

const num = (x, digits) => String(Number(x.toFixed(digits)));

// A frame rate as people write it: 25, 29.97, 23.976.
const fpsText = (fps) => num(fps, 3);

// The usual frame rates. A steady rate read from a timebase in whole
// milliseconds comes out a hair off (29.969 for 29.97, 29.999 for 30):
// within a tenth of a percent of one of these, it is the nearest of them.
const RATES = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48000 / 1001, 48, 50, 60000 / 1001, 60, 100, 120000 / 1001, 120, 144, 240];
function nominal(fps) {
  const near = RATES.filter((rate) => Math.abs(fps - rate) < rate * 0.001).sort((a, b) => Math.abs(fps - a) - Math.abs(fps - b));
  return near.length ? near[0] : fps;
}

// The comment musicfit writes in video.mp4, so a video it made is known
// when it is given back as --video. It names no file: the video goes out
// to people, and the names of the files it was made from are the user's.
const mark = (version) => `musicfit ${version}: a fitted track laid under this picture`;
const MARK = /^musicfit \S+: a fitted track laid under this picture$/;

// What ffmpeg prints while it reads a file that is cut short or has a
// broken packet: a packet cut off at the end, an MP4's samples past the end
// of the file, a Matroska or WebM file that stops in the middle. Only its
// own lines are read for these, never the file's name or its tags (see
// probe()).
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
    const { chunks, stderr } = await run(["-v", "info", "-nostats", "-copyts", "-i", where(file), "-map", "0:V:0", "-c", "copy", "-f", "framecrc", "pipe:1"]);
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

  // framecrc lists each packet as: stream, dts, pts, duration, size, crc,
  // and its flags when they are more than a key frame's. A packet flagged
  // to be dropped (0x4) is never shown: an MP4 cut without encoding again
  // keeps the frames before the cut that its first shown frame needs, and
  // an edit list hides them.
  const tb = /^#tb 0: (\d+)\/(\d+)/m.exec(crc);
  const unit = tb ? Number(tb[1]) / Number(tb[2]) : 0;
  let frames = 0;
  const packets = [];
  for (const line of crc.split("\n")) {
    if (!/^\d/.test(line)) continue;
    const fields = line.split(",").map((s) => s.trim());
    const flags = fields.map((f) => /^F=0x([0-9a-f]+)$/i.exec(f)).find(Boolean);
    if (flags && parseInt(flags[1], 16) & 4) continue;
    frames++;
    const [, dts, pts, duration] = fields.map(Number);
    const at = pts > -1e15 ? pts : dts > -1e15 ? dts : NaN;
    if (Number.isFinite(at)) packets.push({ at, duration });
  }
  // The step from frame to frame: the middle one of the gaps between their
  // times, else of their durations.
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
  // Where the picture starts on the video's timeline, and how long it is
  // from its first frame.
  const start = Number.isFinite(first) ? first * unit : 0;
  const seconds = Number.isFinite(last) ? (last - first) * unit : 0;
  // What ffmpeg itself said as it read the packets. Its own lines start at
  // the left edge; the tags it prints of the file, under the input and again
  // under the output, are indented, and the header that names the file is
  // left out.
  const reading = (said.includes("Input #0") ? said.replace(input, "") : said)
    .split("\n")
    .filter((line) => !/^\s/.test(line))
    .join("\n");
  if (DAMAGED.some((line) => line.test(reading))) {
    const d = /^\s*Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/m.exec(input);
    const whole = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
    throw new Error(`Cannot read ${file}: it is cut short or damaged (ffmpeg could read ${frames} ${frames === 1 ? "frame" : "frames"}, ${seconds.toFixed(2)} s${whole > seconds + 0.05 ? ` of the ${whole.toFixed(2)} s it says it holds` : ""})`);
  }
  if (frames <= 1 || /^(image2|image2pipe|\w+_pipe)$/.test(format) || !(seconds > 0) || !step) throw new Error(`${name} is a still picture, not a video`);
  // The rate holds steady when every gap is a whole number of steps, give
  // or take a tick of the timebase or a millisecond (a 29.97 fps video in a
  // millisecond timebase steps 33 and 34, and keeps those steps when it is
  // copied into a finer one). A gap of two steps or more is frames left
  // out, the one before it shown for longer: a recording that dropped
  // frames, or a cut made without encoding again that keeps a frame from
  // after the cut. Its frames still count at the rate, empty places
  // included. A step is measured as the mean of the gaps of one step.
  const tolerance = Math.max(1, step * 0.01, 0.0011 / unit);
  const single = gaps.filter((g) => Math.abs(g - step) <= tolerance);
  const period = single.length ? single.reduce((sum, g) => sum + g, 0) / single.length : step;
  const steps = gaps.map((g) => Math.round(g / period));
  const constant = gaps.every((g, i) => steps[i] >= 1 && Math.abs(g - steps[i] * period) <= tolerance);
  const places = steps.reduce((sum, k) => sum + k, 0);

  try {
    await run(["-v", "error", "-i", where(file), "-map", "0:V:0", "-c", "copy", "-frames:v", "1", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+delay_moov", "pipe:1"]);
  } catch (err) {
    const tag = /Could not find tag for codec (\w+)/.exec(err.stderr || err.message);
    if (tag) throw new Error(`${name}'s picture is ${tag[1]}, which an MP4 cannot hold without encoding it again: give --video an H.264 or HEVC copy of it`);
    throw err;
  }

  // A steady rate from the first frame to the last, which a timebase in
  // whole milliseconds rounds no frame of; else frames over the time. At a
  // steady rate the frames are the places from the first to the last.
  const span = (times[times.length - 1] - times[0]) * unit;
  return {
    file,
    name,
    seconds,
    start,
    frames: constant && span > 0 ? places + 1 : frames,
    fps: constant && span > 0 ? nominal(places / span) : frames / seconds,
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
  // In frames too, when they mean one moment: at a steady rate.
  if (info.constant) frames = `, or ${info.frames}f${Math.abs(fps - info.fps) > info.fps * 0.0005 ? ` with --fps ${fpsText(info.fps)}` : ""}`;
  const counted = info.constant ? ` (${info.frames} frames at ${fpsText(info.fps)} fps)` : "";
  throw new Error(`${info.name} is ${info.seconds.toFixed(2)} s long${counted} and --length is ${length.toFixed(2)} s: give --length ${num(info.seconds, 3)}${frames}`);
}

// The video's own sound on its timeline from `start`, where its picture
// starts, as { L, R } exactly `n` samples long, and how many seconds of it
// ran past that and were cut; null when it has none.
async function ownSound(file, n, start) {
  let x;
  try {
    x = await decode(file, { rate: RATE, channels: 2, from: start });
  } catch (err) {
    if (/has no audio/.test(err.message)) return null;
    throw err;
  }
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  await blocks(0, Math.min(n, x.length / 2), (from, to) => {
    for (let i = from; i < to; i++) {
      L[i] = x[2 * i];
      R[i] = x[2 * i + 1];
    }
  });
  return { L, R, over: Math.max(0, x.length / 2 - n) / RATE };
}

// The sound as AAC in an .m4a of its own, to be measured as a player hears
// it before the picture is copied over it once. At 256 kb/s: at 192 the
// encoder's noise around a sharp sound lifted the true peak by up to 1.1 dB
// in the study's films, and by another amount each time the sound was
// encoded again, up to 2.4 dB, so a sound limited further could come out
// higher; at 256 it lifted it by half a dB at most but once, by 1 dB. With
// ffmpeg's fast coder, the default of ffmpeg 4.4, on every ffmpeg: twoloop,
// the default of ffmpeg 7 and newer and there in 4.4 too, lifted the true
// peak of a loud fit held to -1 dBTP to +3.3 dBTP on both, and limiting it
// again to take that off took loudness with it. Both versions know the
// coder by this name.
async function encodeAac(samples, file) {
  await run(["-v", "error", "-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", "pipe:0", "-c:a", "aac", "-aac_coder", "fast", "-b:a", "256k", "-y", where(file)], samples);
}

// The video's picture, copied packet for packet, over `sound` (an .m4a),
// copied too, in an MP4 that plays as it downloads. The picture is moved
// by `start`, so its first frame is at 0 with the sound. `comment` replaces
// the video's own comment tag, so a mark another tool left there
// (voiceoverfit marks its files so) is not carried over to a file it did
// not make. HEVC is tagged hvc1, the tag QuickTime, Safari and iOS play.
async function mux(file, sound, out, { picture, comment, start }) {
  const tag = picture === "hevc" ? ["-tag:v", "hvc1"] : [];
  await run(["-v", "error", "-copyts", "-itsoffset", (-start).toFixed(6), "-i", where(file), "-i", where(sound), "-map", "0:V:0", "-map", "1:a:0", "-c", "copy", ...tag, "-metadata", `comment=${comment}`, "-movflags", "+faststart", "-y", where(out)]);
  // Read back, every packet of it, before the run may put it in place: an
  // MP4 whose index did not get written is no video, whatever ffmpeg said.
  let why = null;
  try {
    const { stderr } = await run(["-v", "error", "-i", where(out), "-map", "0", "-c", "copy", "-f", "null", "-"]);
    if (DAMAGED.some((line) => line.test(stderr))) why = "it is cut short";
  } catch (err) {
    if (err.signal || /received signal \d+/.test(err.stderr || "")) throw err;
    why = err.message.replace(/^ffmpeg: /, "").split(`${where(out)}: `).join("");
  }
  if (why) throw new Error(`The video.mp4 this run wrote cannot be read back (${why}), so it was not put in place`);
}

module.exports = { probe, fits, ownSound, encodeAac, mux, mark, fpsText };
