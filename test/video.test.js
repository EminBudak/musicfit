"use strict";

// --video: video.mp4 is the video's picture, packet for packet, with the
// fitted track under it, at the loudness asked for; the video's own sound
// is kept, dipped under or left out as asked; and a video that cannot take
// the fit is refused before any work.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { decode, measureFile } = require("../skills/musicfit/scripts/lib/audio");
const { voice, writeWav } = require("./synth");
const { fixture, dir } = require("./helpers");

const CLI = path.resolve(__dirname, "../skills/musicfit/scripts/musicfit.js");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const RATE = 48000;

const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
const at = (name) => path.join(dir, name);

function ffmpeg(args) {
  const run = spawnSync(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run;
}

function wav(name, seconds, fill) {
  const file = at(`${name}.wav`);
  if (!fs.existsSync(file)) {
    const L = new Float32Array(Math.round(seconds * RATE));
    fill(L);
    writeWav(file, { rate: RATE, L, R: L });
  }
  return file;
}

// Noise bursts, the way a film's sound effects come and go, in silence.
const effects = () =>
  wav("effects", 12, (x) => {
    let seed = 7;
    for (const [from, to] of [[2, 2.3], [8, 8.6]]) {
      for (let i = from * RATE; i < to * RATE; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        x[i] = (seed / 2147483648 - 0.5) * 0.6 * Math.min(1, (to * RATE - i) / (0.2 * RATE));
      }
    }
  });
// A tone all the way through, as a film with music of its own.
const bed = () => wav("bed", 12, (x) => x.forEach((_, i) => (x[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / RATE))));
const speech = () => {
  const file = at("speech.wav");
  if (!fs.existsSync(file)) writeWav(file, voice(12, [[2, 6.5], [7.2, 11]]));
  return file;
};

// A small test picture, 12 s by default, with `sound` (a file) as its AAC.
function film(name, { fps = 25, seconds = 12, sound = null, codec = ["-c:v", "mpeg4", "-q:v", "6"], ext = "mp4", filter = null } = {}) {
  const file = at(`${name}.${ext}`);
  if (fs.existsSync(file)) return file;
  const args = ["-f", "lavfi", "-i", `testsrc2=s=160x96:r=${fps}:d=${seconds}`];
  if (sound) args.push("-i", sound);
  args.push("-map", "0:v:0");
  if (filter) args.push(...filter);
  if (sound) args.push("-map", "1:a:0", "-c:a", "aac", "-b:a", "128k", "-t", String(seconds));
  ffmpeg([...args, ...codec, file]);
  return file;
}

const mono = (x) => {
  const out = new Float32Array(x.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (x[2 * i] + x[2 * i + 1]) / 2;
  return out;
};

function db(x, from, to) {
  let sum = 0;
  const a = Math.round(from * RATE);
  const b = Math.round(to * RATE);
  for (let i = a; i < b; i++) sum += x[i] * x[i];
  return 10 * Math.log10(sum / (b - a) + 1e-12);
}

// The lag (in samples) at which `y` best matches `x` over [from, to] s.
function lag(x, y, from, to, most = 960) {
  const a = Math.round(from * RATE);
  const b = Math.round(to * RATE);
  let best = -Infinity;
  let arg = 0;
  for (let d = -most; d <= most; d += 4) {
    let xy = 0;
    let yy = 0;
    for (let i = a; i < b; i += 3) {
      xy += x[i] * (y[i + d] || 0);
      yy += (y[i + d] || 0) ** 2;
    }
    const c = xy / Math.sqrt(yy + 1e-12);
    if (c > best) {
      best = c;
      arg = d;
    }
  }
  return arg;
}

// The picture's packets as framecrc lists them: size and checksum, in order.
function packets(file) {
  const run = ffmpeg(["-i", file, "-map", "0:V:0", "-c", "copy", "-f", "framecrc", "pipe:1"]);
  return run.stdout
    .split("\n")
    .filter((l) => /^\d/.test(l))
    .map((l) => l.split(",").slice(4, 6).join(",").trim());
}

const said = (file) => spawnSync(FFMPEG, ["-hide_banner", "-nostdin", "-i", file], { encoding: "utf8" }).stderr;
const cuesOf = (out) => JSON.parse(fs.readFileSync(path.join(out, "cues.json"), "utf8"));

// The plain fit every --video fit below is held against.
let plainFit = null;
function plain() {
  if (plainFit) return plainFit;
  const out = at("plain");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  plainFit = { out, wav: fs.readFileSync(path.join(out, "fitted.wav")) };
  return plainFit;
}

test("--video writes video.mp4: the picture packet for packet, the fitted track lined up with it, its own sound kept at its level, at --lufs with the true peak at or under -1 dBTP", async () => {
  const video = film("film25", { sound: effects() });
  const out = at("film25-fit");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), ["FIT.md", "cues.json", "fitted.wav", "seams.png", "video.mp4"]);
  assert.match(run.stdout, /\n {2}Video {3}video\.mp4 is film25\.mp4 with the music and its own sound at its own level; -1[34]\.\d LUFS, true peak -[\d.]+ dBTP\n/);

  const c = cuesOf(out);
  // Without --fps the frames count at the video's rate.
  assert.equal(c.fps, 25);
  assert.equal(c.frames, 300);
  assert.equal(c.drop.frame, 200);
  assert.deepEqual({ ...c.video, spans: c.video.spans.length, loudness: null }, { file: "video.mp4", source: "film25.mp4", length: 12, fps: 25, frames: 300, steady: true, picture: "mpeg4", sound: "keep", same: null, duck: null, spans: 2, loudness: null });

  assert.deepEqual(packets(path.join(out, "video.mp4")), packets(video));
  const level = await measureFile(path.join(out, "video.mp4"));
  assert.ok(Math.abs(level.integrated + 14) <= 0.5, `${level.integrated} LUFS`);
  assert.ok(level.truePeak <= -1, `true peak ${level.truePeak} dBTP`);
  // The mark names no file: the track's and the video's names stay the user's.
  assert.match(said(path.join(out, "video.mp4")), /comment\s*: musicfit \S+: a fitted track laid under this picture\n/);

  // With keep the music does not dip at all: fitted.wav is a plain fit's,
  // and in video.mp4 the bar after the hit, where an effect plays on the
  // hit, has the music at its level, lined up with fitted.wav.
  assert.ok(fs.readFileSync(path.join(out, "fitted.wav")).equals(plain().wav), "fitted.wav is not a plain fit's");
  const music = mono(await decode(path.join(out, "fitted.wav")));
  const under = mono(await decode(path.join(out, "video.mp4")));
  assert.ok(Math.abs(lag(music, under, 4, 6)) <= 96, `video.mp4's sound is ${lag(music, under, 4, 6)} samples off`);
  const bar = 60 / 124 * 4;
  const drop = db(under, 8.6, 8 + bar) - db(music, 8.6, 8 + bar);
  assert.ok(drop > -3, `the music in the bar after the hit is ${drop.toFixed(1)} dB down in video.mp4`);
});

test("--video-sound voice dips the music about --duck dB under the video's own sound, and drop leaves that sound out", async () => {
  const talk = film("talk", { sound: speech() });
  const out = at("talk-voice");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", talk, "--video-sound", "voice", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.equal(c.video.sound, "voice");
  assert.equal(c.video.duck, 10);
  assert.equal(c.video.spans.length, 2);
  assert.ok(Math.abs(c.video.spans[0].from - 2) < 0.1 && Math.abs(c.video.spans[1].to - 11) < 0.1, JSON.stringify(c.video.spans));
  const dipped = mono(await decode(path.join(out, "fitted.wav")));
  const music = mono(await decode(path.join(plain().out, "fitted.wav")));
  const dip = db(dipped, 3, 6) - db(music, 3, 6);
  assert.ok(Math.abs(dip + 10) < 1.5, `dipped ${dip.toFixed(1)} dB`);
  assert.match(fs.readFileSync(path.join(out, "FIT.md"), "utf8"), /The music dips 10 dB wherever talk\.mp4's own sound plays \(2 stretches\)/);

  const tone = film("bed25", { sound: bed() });
  const dropped = at("bed-drop");
  const left = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", tone, "--video-sound", "drop", "--out", dropped]);
  assert.equal(left.status, 0, left.stderr);
  assert.equal(cuesOf(dropped).video.sound, "drop");
  assert.ok(fs.readFileSync(path.join(dropped, "fitted.wav")).equals(plain().wav), "fitted.wav is not a plain fit's");
  // The tone is gone: what plays is the music, at its own shape.
  const heard = mono(await decode(path.join(dropped, "video.mp4")));
  let xy = 0;
  let xx = 0;
  let yy = 0;
  for (let i = 2 * RATE; i < 10 * RATE; i++) {
    xy += music[i] * heard[i];
    xx += music[i] ** 2;
    yy += heard[i] ** 2;
  }
  assert.ok(xy / Math.sqrt(xx * yy) > 0.95, `video.mp4's sound is not the music alone (${(xy / Math.sqrt(xx * yy)).toFixed(3)})`);
});

test("a video whose own sound plays nearly all the way through is refused until --video-sound says what becomes of it", () => {
  const tone = film("bed25", { sound: bed() });
  const out = at("bed-ask");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", tone, "--out", out]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /musicfit: bed25\.mp4 has sound of its own for 1[12]\.\d of its 12\.0 s, so say what becomes of it with --video-sound: keep plays it with the track, voice dips the track under it \(for speech\), drop leaves it out \(for music of its own\)\n$/);
  assert.doesNotMatch(run.stderr, /Reading house\.wav/);
  assert.ok(!fs.existsSync(out));
  const kept = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", tone, "--video-sound", "keep", "--out", out]);
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /Note {4}bed25\.mp4's own sound plays for 1[12]\.\d of its 12\.0 s, along with the music\. If that sound is music of its own, --video-sound drop leaves it out\./);
});

test("a faint room tone the video has is kept at its own level, never raised to --lufs", async () => {
  const hiss = wav("hiss", 12, (x) => {
    let seed = 3;
    for (let i = 0; i < x.length; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      x[i] = (seed / 2147483648 - 0.5) * 0.006;
    }
  });
  const out = at("hiss-fit");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", film("hiss", { sound: hiss }), "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(cuesOf(out).video.sound, "keep");
  // What plays is the music, barely changed: raised to -14 LUFS, the hiss
  // would be as loud as it.
  const music = mono(await decode(path.join(out, "fitted.wav")));
  const heard = mono(await decode(path.join(out, "video.mp4")));
  let xy = 0;
  let xx = 0;
  let yy = 0;
  for (let i = RATE; i < 11 * RATE; i++) {
    xy += music[i] * heard[i];
    xx += music[i] ** 2;
    yy += heard[i] ** 2;
  }
  assert.ok(xy / Math.sqrt(xx * yy) > 0.98, `the hiss was raised: ${(xy / Math.sqrt(xx * yy)).toFixed(3)}`);
});

test("a video with no sound of its own gets the music alone", () => {
  const out = at("mute-fit");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(cuesOf(out).video.sound, "none");
  assert.match(run.stdout, /Video {3}video\.mp4 is mute\.mp4 with the music \(it had no sound of its own\)/);
});

test("a video that cannot take the fit is refused before any work, and no folder is made", () => {
  const still = at("still.png");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x96", "-frames:v", "1", still]);
  const text = at("notes.txt");
  fs.writeFileSync(text, "not a video\n");
  const prores = film("prores", { seconds: 1, codec: ["-c:v", "prores_ks"], ext: "mov" });
  const empty = at("empty.mp4");
  fs.writeFileSync(empty, "");
  // Cut off part way, as a download that stopped: one whose index comes
  // first, and one whose index was to come at the end.
  const cut = (from, name) => {
    const bytes = fs.readFileSync(from);
    fs.writeFileSync(at(name), bytes.subarray(0, Math.floor(bytes.length * 0.4)));
    return at(name);
  };
  const headFirst = cut(film("film12fast", { codec: ["-c:v", "mpeg4", "-q:v", "6", "-movflags", "+faststart"] }), "cut-fast.mp4");
  const headLast = cut(film("film12", {}), "cut-last.mp4");
  const cases = [
    [fixture("house").file, /musicfit: house\.wav has no picture to lay the music under\n$/],
    [at("nothing.mp4"), /musicfit: Cannot read .*nothing\.mp4: no such file\n$/],
    [text, /musicfit: Cannot read .*notes\.txt: ffmpeg does not know this format\n$/],
    [still, /musicfit: still\.png is a still picture, not a video\n$/],
    [prores, /musicfit: prores\.mov's picture is prores, which an MP4 cannot hold without encoding it again: give --video an H\.264 or HEVC copy of it\n$/],
    [film("film14", { seconds: 14 }), /musicfit: film14\.mp4 is 14\.00 s long \(350 frames at 25 fps\) and --length is 12\.00 s: give --length 14, or 350f\n$/],
    [empty, /musicfit: Cannot read .*empty\.mp4: it is empty\n$/],
    [headFirst, /musicfit: Cannot read .*cut-fast\.mp4: it is cut short or damaged \(ffmpeg could read \d+ frames, \d\.\d\d s of the 12\.00 s it says it holds\)\n$/],
    [headLast, /musicfit: Cannot read .*cut-last\.mp4: it is cut short or damaged, so ffmpeg finds no index in it\n$/],
  ];
  for (const [video, message] of cases) {
    const out = at(`refused-${path.basename(video)}`);
    const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--out", out]);
    assert.equal(run.status, 1, `${video}: ${run.stderr}`);
    assert.match(run.stderr, message);
    assert.doesNotMatch(run.stderr, /Reading/);
    assert.ok(!fs.existsSync(out), `${video} made ${out}`);
  }
  assert.deepEqual(fs.readdirSync(dir).filter((e) => e.startsWith(".musicfit-")), []);
});

test("a video musicfit made is refused as --video while its sound would be laid in, and taken with --video-sound drop", () => {
  const out = at("remade");
  const source = film("film25", { sound: effects() });
  const first = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", source, "--video-sound", "keep", "--out", out]);
  assert.equal(first.status, 0, first.stderr);
  // A copy of it graded or trimmed elsewhere keeps the mark.
  const graded = at("graded.mp4");
  ffmpeg(["-i", path.join(out, "video.mp4"), "-c", "copy", graded]);
  for (const how of [[], ["--video-sound", "keep"], ["--video-sound", "voice"]]) {
    const again = cli([fixture("house").file, "--length", "12", "--hit", "6", "--video", graded, ...how, "--out", at("remade-again")]);
    assert.equal(again.status, 1, `${how}: ${again.stderr}`);
    assert.match(again.stderr, /musicfit: graded\.mp4 is a video musicfit made, so its own sound has a fitted track in it already: give --video the video it was made from, or --video-sound drop to leave that sound out\n$/);
  }
  const dropped = cli([fixture("house").file, "--length", "12", "--hit", "6", "--video", graded, "--video-sound", "drop", "--out", at("remade-drop")]);
  assert.equal(dropped.status, 0, dropped.stderr);
  assert.deepEqual(packets(path.join(at("remade-drop"), "video.mp4")), packets(source));
});

test("a video.mp4 musicfit did not write is refused, a run without --video leaves it alone, and one musicfit wrote goes with the next run", () => {
  const out = at("theirs");
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, "video.mp4"), "their video\n");
  const refused = cli([fixture("house").file, "--length", "12", "--video", film("mute"), "--out", out]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /musicfit: .*theirs\/video\.mp4 is not a file musicfit wrote, and this run would replace it: move it, or give another --out\n$/);
  assert.doesNotMatch(refused.stderr, /Reading/);
  const plainRun = cli([fixture("house").file, "--length", "12", "--out", out]);
  assert.equal(plainRun.status, 0, plainRun.stderr);
  assert.equal(fs.readFileSync(path.join(out, "video.mp4"), "utf8"), "their video\n");

  const ours = at("ours");
  assert.equal(cli([fixture("house").file, "--length", "12", "--video", film("mute"), "--out", ours]).status, 0);
  assert.ok(fs.existsSync(path.join(ours, "video.mp4")));
  const again = cli([fixture("house").file, "--length", "12", "--video", film("mute"), "--out", ours]);
  assert.equal(again.status, 0, again.stderr);
  const without = cli([fixture("house").file, "--length", "12", "--out", ours]);
  assert.equal(without.status, 0, without.stderr);
  assert.deepEqual(fs.readdirSync(ours).sort(), ["FIT.md", "cues.json", "fitted.wav", "seams.png"]);
});

test("the same sound is laid in once: a video that is the track, or the voice", () => {
  // A video whose own sound is the music.
  const music = at("music12.wav");
  ffmpeg(["-i", fixture("house").file, "-t", "12", music]);
  const clip = film("clip", { sound: music });
  const out = at("clip-fit");
  const run = cli([clip, "--length", "12", "--video", clip, "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual([cuesOf(out).video.sound, cuesOf(out).video.same], ["drop", "track"]);
  assert.match(run.stdout, /Note {4}clip\.mp4's own sound is the track, so it is not laid in a second time\./);

  const talk = film("talk", { sound: speech() });
  const both = at("talk-both");
  const voiced = cli([fixture("house").file, "--length", "12", "--hit", "8", "--voice", talk, "--video", talk, "--out", both]);
  assert.equal(voiced.status, 0, voiced.stderr);
  assert.deepEqual([cuesOf(both).video.sound, cuesOf(both).video.same], ["drop", "voice"]);
  assert.ok(fs.existsSync(path.join(both, "mix.wav")));
  assert.match(voiced.stdout, /Note {4}talk\.mp4's own sound is the voice given with --voice, so it is laid in once, as the voice\./);
});

test("frames count at the video's rate without --fps, another --fps is noted, and a rate that does not hold steady takes seconds only", () => {
  const video = film("film25", { sound: effects() });
  const out = at("frames25");
  const run = cli([fixture("house").file, "--length", "300f", "--hit", "200f", "--video", video, "--out", out, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const c = JSON.parse(run.stdout);
  assert.deepEqual([c.fps, c.length, c.drop.time, c.video.file], [25, 12, 8, "video.mp4"]);

  const other = cli([fixture("house").file, "--length", "12", "--hit", "8", "--fps", "30", "--video", video, "--out", at("fps30")]);
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, /Note {4}film25\.mp4 runs at 25 fps and --fps is 30, so the frames in cues\.json are not the video's: leave --fps out, or give --fps 25, to count them as the video does\./);

  // Every seventh frame left out, so frames last one or two thirtieths.
  const vfr = film("vfr", { fps: 30, filter: ["-vf", "select='not(eq(mod(n\\,7)\\,3))'", "-vsync", "vfr"] });
  const inFrames = cli([fixture("house").file, "--length", "360f", "--video", vfr, "--out", at("vfr-frames")]);
  assert.equal(inFrames.status, 1);
  assert.match(inFrames.stderr, /musicfit: vfr\.mp4 has no steady frame rate, so a time in frames does not name one moment of it: give --length in seconds, or give --fps\n$/);
  const long = cli([fixture("house").file, "--length", "13", "--video", vfr, "--out", at("vfr-long")]);
  assert.equal(long.status, 1);
  assert.match(long.stderr, /musicfit: vfr\.mp4 is 12\.00 s long and --length is 13\.00 s: give --length 12\n$/);
  const seconds = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", vfr, "--out", at("vfr-fit")]);
  assert.equal(seconds.status, 0, seconds.stderr);
  assert.match(seconds.stdout, /Note {4}vfr\.mp4 has no steady frame rate, so the frames in cues\.json count at its average, 25\.75 fps\./);
});

test("a 29.97 fps video counts at 29.97, even in a timebase of whole milliseconds", async () => {
  const { probe, fpsText } = require("../skills/musicfit/scripts/lib/video");
  for (const ext of ["mp4", "mkv"]) {
    const info = await probe(film(`ntsc-${ext}`, { fps: "30000/1001", ext }));
    assert.ok(info.constant, ext);
    assert.ok(Math.abs(info.fps - 30000 / 1001) < 1e-9, `${ext}: ${info.fps}`);
    assert.equal(fpsText(info.fps), "29.97");
  }
});

test("an HEVC picture is tagged hvc1 in video.mp4, so Apple's players take it", { skip: !/libx265/.test(spawnSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout) && "this ffmpeg has no HEVC encoder" }, () => {
  const hevc = film("hevc", { codec: ["-c:v", "libx265", "-x265-params", "log-level=none"], ext: "mkv" });
  assert.match(said(hevc), /Video: hevc/);
  const out = at("hevc-fit");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", hevc, "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(said(path.join(out, "video.mp4")), /Video: hevc \(Main\) \(hvc1 \//);
  assert.deepEqual(packets(path.join(out, "video.mp4")), packets(hevc));
});
