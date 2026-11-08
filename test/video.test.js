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

test("--video writes video.mp4: the picture packet for packet, the fitted track lined up with it, its own sound kept 3 dB louder than the music in each place it plays and the music never dipped, on the hit neither, at --lufs with the true peak at or under -1 dBTP", async () => {
  const video = film("film25", { sound: effects() });
  const out = at("film25-fit");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), ["FIT.md", "cues.json", "fitted.wav", "seams.png", "video.mp4"]);
  assert.match(run.stdout, /\n {2}Video {3}video\.mp4 is film25\.mp4 with the music and its own sound, that sound about 3 dB or more louder than the music where it plays \(2 places\); -1[34](?:\.\d)? LUFS, true peak -[\d.]+ dBTP\n/);

  const c = cuesOf(out);
  // Without --fps the frames count at the video's rate.
  assert.equal(c.fps, 25);
  assert.equal(c.frames, 300);
  assert.equal(c.drop.frame, 200);
  assert.deepEqual({ ...c.video, spans: c.video.spans.length, loudness: null }, { file: "video.mp4", source: "film25.mp4", length: 12, fps: 25, frames: 300, steady: true, picture: "mpeg4", sound: "keep", same: null, duck: null, over: 3, spans: 2, loudness: null });

  assert.deepEqual(packets(path.join(out, "video.mp4")), packets(video));
  const loudness = await measureFile(path.join(out, "video.mp4"));
  assert.ok(Math.abs(loudness.integrated + 14) <= 0.5, `${loudness.integrated} LUFS`);
  assert.ok(loudness.truePeak <= -1, `true peak ${loudness.truePeak} dBTP`);
  // The mark names no file: the track's and the video's names stay the user's.
  assert.match(said(path.join(out, "video.mp4")), /comment\s*: musicfit \S+: a fitted track laid under this picture\n/);
  // AAC at 256 kb/s, where its noise lifts a true peak by a few tenths at most.
  const rate = /Audio: aac \(LC\).*, (\d+) kb\/s/.exec(said(path.join(out, "video.mp4")));
  assert.ok(rate && Number(rate[1]) >= 230, rate && rate[0]);

  // With keep the music does not dip under the effects: fitted.wav is a
  // plain fit's, so the bar of the drop, where an effect plays on the hit,
  // keeps its weight. In video.mp4 the music is lined up with the picture,
  // and each effect is about 3 dB louder than it where it plays, the one on
  // the hit too, as cues.json says of each.
  assert.ok(fs.readFileSync(path.join(out, "fitted.wav")).equals(plain().wav), "the music dips under the effects");
  const music = mono(await decode(path.join(out, "fitted.wav")));
  const under = mono(await decode(path.join(out, "video.mp4")));
  assert.ok(Math.abs(lag(music, under, 4, 6)) <= 96, `video.mp4's sound is ${lag(music, under, 4, 6)} samples off`);
  const places = await placesOver(under, music, video, c.video.spans);
  places.forEach((p, i) => {
    assert.ok(p.over >= 2.3, `the effect at ${c.video.spans[i].from} s is ${p.over.toFixed(1)} LU over the music`);
    assert.ok(Math.abs(p.over - c.video.spans[i].over) <= AAC_NOISE, `the effect at ${c.video.spans[i].from} s is ${p.over.toFixed(1)} LU over the music, and cues.json says ${c.video.spans[i].over}`);
  });
  assert.deepEqual(c.warnings, []);
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

test("a video with sound of its own is refused until --video-sound says what becomes of it, however little of it plays", () => {
  const cases = [
    ["bed25", film("bed25", { sound: bed() }), /1[12]\.\d/],
    ["film25", film("film25", { sound: effects() }), /\d\.\d/],
    ["talk", film("talk", { sound: speech() }), /\d+\.\d/],
  ];
  for (const [name, video, plays] of cases) {
    const out = at(`${name}-ask`);
    const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--out", out]);
    assert.equal(run.status, 1, `${name}: ${run.stderr}`);
    assert.match(run.stderr, new RegExp(`musicfit: ${name}\\.mp4 has sound of its own for ${plays.source} of its 12\\.0 s, so say what becomes of it with --video-sound: keep for sound effects \\(they stay, at least 3 dB louder than the music where they play, or as near as the loudness and peak limits allow, and the music does not dip\\), voice for speech \\(set to -14 LUFS where it plays, and the music dips 10 dB under it\\), or drop for music of its own \\(left out\\)\\n$`));
    assert.doesNotMatch(run.stderr, /Reading house\.wav/);
    assert.ok(!fs.existsSync(out), `${name} made ${out}`);
  }
  const kept = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", film("bed25", { sound: bed() }), "--video-sound", "keep", "--out", at("bed-keep")]);
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /Note {4}bed25\.mp4's own sound plays for 1[12]\.\d of its 12\.0 s, along with the music\. If that sound is music of its own, --video-sound drop leaves it out\./);
});

// A sound as a loudness meter hears it: K-weighted, as ITU-R BS.1770 has it
// at 48 kHz, a shelf that lifts the highs and a high-pass under the bass.
function weighted(x) {
  const stages = [
    [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
    [1, -2, 1, -1.99004745483398, 0.99007225036621],
  ];
  let y = x;
  for (const [b0, b1, b2, a1, a2] of stages) {
    const z = new Float32Array(y.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = y[i];
      y2 = y1;
      y1 = v;
      z[i] = v;
    }
    y = z;
  }
  return y;
}

// How far a sound effect in video.mp4 can read from what cues.json says of
// it, in LU: the AAC encoding adds its own noise to a noise burst, which a
// meter reads as part of it, by up to a dB, more with ffmpeg 4.4's encoder
// than with 8's.
const AAC_NOISE = 1.2;

// How far the video's own sound is over the music in video.mp4 in each place
// it plays, in LU, and how loud it is there in LUFS, as a meter hears them:
// K-weighted, by their energy. The music's gain in video.mp4 over the place
// is found by least squares, against fitted.wav and the video's own sound
// together, as the two can move alike there (a thump on a kick drum); what
// is left of video.mp4 there once that music is taken out is the video's
// own sound, by its energy and not its waveform, as ffmpeg's fast AAC
// coder builds a noise-like sound effect anew rather than copying its
// waveform, which a meter reads the same. gain is how far each part was
// moved from fitted.wav and from the video.
async function placesOver(heard, music, video, spans) {
  const own = mono(await decode(video));
  const [h, m, o] = [weighted(heard), weighted(music), weighted(own)];
  return spans.map(({ from, to }) => {
    const a = Math.round(from * RATE);
    const b = Math.min(h.length, m.length, o.length, Math.round(to * RATE));
    const g = parts(heard, music, own, a, b).music;
    let mm = 0;
    let hh = 0;
    let oo = 0;
    for (let i = a; i < b; i++) {
      mm += m[i] * m[i];
      hh += h[i] * h[i];
      oo += o[i] * o[i];
    }
    const pm = g * g * mm;
    const po = Math.max(hh - pm, 1e-12 * hh);
    return { over: pm > 0 ? 10 * Math.log10(po / pm) : Infinity, level: -0.691 + 10 * Math.log10((2 * po) / (b - a)), gain: { music: g, own: Math.sqrt(po / oo) } };
  });
}

// video.mp4's sound split by least squares into the music (fitted.wav) and
// the video's own sound as it was in the video, over [a, b) or the whole:
// the gain each has in it. Where no music plays, all of it is the video's.
function parts(heard, music, own, a = 0, b = Math.min(heard.length, music.length, own.length)) {
  let mm = 0;
  let oo = 0;
  let mo = 0;
  let hm = 0;
  let ho = 0;
  for (let i = a; i < b; i++) {
    mm += music[i] * music[i];
    oo += own[i] * own[i];
    mo += music[i] * own[i];
    hm += heard[i] * music[i];
    ho += heard[i] * own[i];
  }
  const det = mm * oo - mo * mo;
  if (!(mm > 0) || !(det > 1e-9 * mm * oo)) return { music: 0, own: oo > 0 ? ho / oo : 0 };
  return { music: (hm * oo - ho * mo) / det, own: (ho * mm - hm * mo) / det };
}

test("--video-sound keep raises quiet sound effects, so each is about 3 dB louder than the music where it plays, and the music does not dip", async () => {
  // Noise bursts 30 dB quieter than effects() makes them.
  const quiet = wav("quiet-effects", 12, (x) => {
    let seed = 11;
    for (const [from, to] of [[2, 2.3], [8, 8.6]]) {
      for (let i = from * RATE; i < to * RATE; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        x[i] = (seed / 2147483648 - 0.5) * 0.02;
      }
    }
  });
  const video = film("quietfx", { sound: quiet });
  const out = at("quietfx-keep");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.equal(c.video.spans.length, 2);
  assert.ok(fs.readFileSync(path.join(out, "fitted.wav")).equals(plain().wav), "the music dips under the effects");
  const heard = mono(await decode(path.join(out, "video.mp4")));
  const music = mono(await decode(path.join(out, "fitted.wav")));
  for (const [i, p] of (await placesOver(heard, music, video, c.video.spans)).entries()) {
    assert.ok(Math.abs(p.over - 3) <= AAC_NOISE, `the effect at ${c.video.spans[i].from} s is ${p.over.toFixed(1)} LU over the music`);
    // In the video it was 30 dB under it.
    assert.ok(20 * Math.log10(Math.abs(p.gain.own / p.gain.music)) > 20, `the effect at ${c.video.spans[i].from} s was not raised`);
  }
});

test("equal sound effects before the drop, on the hit and over the ring-out each stand over the music where it plays, set by the music there, and the one it could not set 3 dB over is named", async () => {
  // A 20 s fit of house.wav with the hit at 8 s ends on the track's last
  // hit at 15.7 s, which rings out to 19.9 s: equal bursts at 3 s, 8 s and
  // 17.5 s, where the music reads about -14, -12 and -28 LUFS.
  const bursts = wav("bursts3", 20, (x) => {
    let seed = 5;
    for (const from of [3, 8, 17.5]) {
      for (let i = Math.round(from * RATE); i < Math.round((from + 0.4) * RATE); i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        x[i] = (seed / 2147483648 - 0.5) * 0.1;
      }
    }
  });
  const video = film("bursts3", { seconds: 20, sound: bursts });
  const out = at("bursts3-keep");
  const run = cli([fixture("house").file, "--length", "20", "--hit", "8", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.equal(c.end.kind, "natural");
  assert.deepEqual(c.video.spans.map((s) => Math.round(s.from)), [3, 8, 18]);
  const heard = mono(await decode(path.join(out, "video.mp4")));
  const music = mono(await decode(path.join(out, "fitted.wav")));
  const places = await placesOver(heard, music, video, c.video.spans);
  // Each place as cues.json says it came out, checked on its own span.
  places.forEach((p, i) => assert.ok(Math.abs(p.over - c.video.spans[i].over) <= AAC_NOISE, `${c.video.spans[i].from} s: ${p.over.toFixed(1)} LU over the music, and cues.json says ${c.video.spans[i].over}`));
  // Before the drop and on the hit about 3 dB over the music; over the
  // quiet ring-out far over it, at the target: never under the music.
  assert.ok(places[0].over >= 2.3 && places[1].over >= 0, places.map((p) => p.over.toFixed(1)).join(", "));
  assert.ok(places[2].over > 9, `over the ring-out ${places[2].over.toFixed(1)} LU over the music`);
  assert.ok(Math.abs(places[2].level + 14) <= 1.5, `over the ring-out at ${places[2].level.toFixed(1)} LUFS`);
  // Equal effects come out within the 6 dB a place may move between the
  // target and its most, not 10 dB apart.
  const levels = places.map((p) => p.level);
  assert.ok(Math.max(...levels) - Math.min(...levels) <= 6.5, levels.map((l) => l.toFixed(1)).join(", "));
  // A place set less than 3 dB over the music is named in a note, with how it came out.
  const held = c.video.spans.filter((s) => s.over < 2.5);
  for (const s of held) assert.match(run.stdout, new RegExp(`Note {4}bursts3\\.mp4's own sound is less than 3 dB louder than the music in ${held.length} of the 3 places it plays, at [^\\n]*${s.from.toFixed(2)} s \\(`));
  if (!held.length) assert.doesNotMatch(run.stdout, /less than 3 dB louder/);
  const alone = cli([fixture("house").file, "--length", "20", "--hit", "8", "--out", at("bursts3-plain")]);
  assert.equal(alone.status, 0, alone.stderr);
  assert.ok(fs.readFileSync(path.join(out, "fitted.wav")).equals(fs.readFileSync(path.join(at("bursts3-plain"), "fitted.wav"))), "the music dips under the effects");
});

test("a click in the first 5 ms of a video's own sound, where no music plays yet, is held under -1 dBTP like any other, and video.mp4 is at --lufs", async () => {
  // A 24 s fit of house.wav with the hit at 16.5 s is silent for its first
  // second, so the clicks there are set to the target, far louder than they
  // were, and their peaks are left to the limiter.
  const clicks = wav("clickhead", 24, (x) => {
    for (const from of [0, 0.4]) for (let i = 0; i < 0.001 * RATE; i++) x[Math.round(from * RATE) + i] = 0.5 * Math.sin((2 * Math.PI * 2000 * i) / RATE);
  });
  const video = film("clickhead", { seconds: 24, sound: clicks });
  const out = at("clickhead-keep");
  const run = cli([fixture("house").file, "--length", "24", "--hit", "16.5", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.equal(c.start.kind, "silence");
  assert.ok(c.video.spans[0].from < 0.01 && c.video.spans[0].over === null, JSON.stringify(c.video.spans));
  const loudness = await measureFile(path.join(out, "video.mp4"));
  assert.ok(Math.abs(loudness.integrated + 14) <= 0.5, `${loudness.integrated} LUFS`);
  assert.ok(loudness.truePeak <= -1, `true peak ${loudness.truePeak} dBTP`);
  assert.match(fs.readFileSync(path.join(out, "FIT.md"), "utf8"), /, the whole set to -14 LUFS, measured after the AAC encoding\./);
  assert.deepEqual(c.warnings, []);
});

test("a video whose only sounds are short clicks is asked about, keep sets the clicks over the music without dipping it, and voice finds no speech in them", async () => {
  const clicks = wav("clicks", 12, (x) => {
    for (const second of [3, 9]) {
      for (let i = 0; i < 0.03 * RATE; i++) x[second * RATE + i] = 0.5 * Math.sin((2 * Math.PI * 2000 * i) / RATE) * (1 - i / (0.03 * RATE));
    }
  });
  const video = film("clicks", { sound: clicks });
  const asked = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--out", at("clicks-ask")]);
  assert.equal(asked.status, 1, asked.stderr);
  assert.match(asked.stderr, /musicfit: clicks\.mp4 has sound of its own for 0\.\d\d of its 12\.0 s, so say what becomes of it with --video-sound/);
  const out = at("clicks-keep");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(cuesOf(out).video.spans.length, 2);
  assert.equal(cuesOf(out).video.over, 3);
  // Over the music, each click as far as its peak allows: one held under
  // 3 dB over it is named in a note.
  for (const span of cuesOf(out).video.spans) {
    assert.ok(span.over > 0, JSON.stringify(span));
    if (span.over < 2.5) assert.match(run.stdout, new RegExp(`Note {4}clicks\\.mp4's own sound is less than 3 dB louder than the music [^\\n]*at [^\\n]*${span.from.toFixed(2)} s \\(${span.over} dB over it\\)[^\\n]*nor so loud that its own peaks pass -1 dBFS\\.`));
  }
  assert.ok(fs.readFileSync(path.join(out, "fitted.wav")).equals(plain().wav), "the music dips under the clicks");
  const spoken = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--video-sound", "voice", "--out", at("clicks-voice")]);
  assert.equal(spoken.status, 0, spoken.stderr);
  assert.deepEqual(cuesOf(at("clicks-voice")).video.spans, []);
  assert.match(spoken.stdout, /Note {4}No speech was found in clicks\.mp4's own sound, so the music does not dip under it, and it is not raised: it is only turned down if it is louder than -14 LUFS\./);
});

// seams.png's pixels: musicfit writes 8-bit RGB rows, each filtered against
// the pixel to its left.
function pixels(file) {
  const png = fs.readFileSync(file);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const data = [];
  for (let at = 8; at < png.length; ) {
    const size = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") data.push(png.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  const raw = require("node:zlib").inflateSync(Buffer.concat(data));
  const stride = width * 3;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (stride + 1)], 1);
    for (let x = 0; x < stride; x++) px[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + (x >= 3 ? px[y * stride + x - 3] : 0)) & 0xff;
  }
  return { width, height, at: (x, y) => [...px.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)] };
}

test("seams.png marks where the music dips under the video's own sound with voice, and names it under the picture, and with keep, where it does not dip, has no such marks", () => {
  const kept = at("film25-png");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", film("film25", { sound: effects() }), "--video-sound", "keep", "--out", kept]);
  assert.equal(run.status, 0, run.stderr);
  const plainImage = pixels(path.join(kept, "seams.png"));
  const keptLegend = plainImage.height - 34 + 7;
  assert.ok(!Array.from({ length: 1000 }, (_, x) => plainImage.at(x, keptLegend)).some((p) => p.join() === "199,125,255"), "a legend mark for dips that are not there");
  const out = at("talk-png");
  const spoken = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", film("talk", { sound: speech() }), "--video-sound", "voice", "--out", out]);
  assert.equal(spoken.status, 0, spoken.stderr);
  const spans = cuesOf(out).video.spans;
  assert.equal(spans.length, 2);
  const image = pixels(path.join(out, "seams.png"));
  // The marks sit along the bottom of the strip of the fit, 128 pixels to
  // the second from x 32, in #c77dff over the dark panel.
  const marked = (x) => [534, 537].every((y) => image.at(x, y).every((v, i) => Math.abs(v - [173, 110, 221][i]) <= 8));
  for (const { from, to } of spans) assert.ok(marked(Math.round(32 + ((from + to) / 2) * 128)), `no mark at ${from} to ${to} s`);
  assert.ok(!marked(Math.round(32 + ((spans[0].to + spans[1].from) / 2) * 128)), "a mark where nothing plays");
  // The legend's mark for them, in the line under the picture.
  const legend = image.height - 34 + 7;
  assert.ok(Array.from({ length: 1000 }, (_, x) => image.at(x, legend)).some((p) => p.join() === "199,125,255"), "no legend mark");
});

test("seams.png titles a track named outside a to z by its letters without their marks, or as the track when it has letters the picture cannot draw, never with question marks", () => {
  const title = (name) => {
    const cwd = at(`title-${Buffer.from(name).toString("hex")}`);
    fs.mkdirSync(cwd, { recursive: true });
    fs.copyFileSync(fixture("house").file, path.join(cwd, name));
    const run = spawnSync(process.execPath, [CLI, name, "--analyze", "--out", "out"], { cwd, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const image = pixels(path.join(cwd, "out", "seams.png"));
    // The title's rows, drawn three pixels to a dot from y 24.
    return Array.from({ length: 26 }, (_, y) => Array.from({ length: image.width }, (_, x) => image.at(x, 22 + y).join()).join(" ")).join("\n");
  };
  assert.equal(title("Şarkı.wav"), title("SARKI.WAV"));
  assert.equal(title("трек 音楽.wav"), title("THE TRACK"));
  const { drawable } = require("../skills/musicfit/scripts/lib/draw");
  assert.equal(drawable("café_noir & co!.mp3"), "CAFE_NOIR & CO!.MP3");
  assert.equal(drawable("Smørrebrød straße.wav"), "SMORREBROD STRASSE.WAV");
  assert.equal(drawable("गाना.wav"), null);
});

test("a faint room tone the video has stays faint against the music, never raised to --lufs", async () => {
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

test("a video musicfit made is refused as --video while its sound would be laid in, naming the video it was made from when its cues.json is beside it, and taken with --video-sound drop", () => {
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
  // Given as it is, with the cues.json it came with beside it, the video it
  // was made from is named.
  const back = cli([fixture("house").file, "--length", "12", "--hit", "6", "--video", path.join(out, "video.mp4"), "--video-sound", "keep", "--out", at("remade-back")]);
  assert.equal(back.status, 1, back.stderr);
  assert.match(back.stderr, /musicfit: video\.mp4 is a video musicfit made, so its own sound has a fitted track in it already: give --video the video it was made from \(film25\.mp4, as the cues\.json beside it says\), or --video-sound drop to leave that sound out\n$/);
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
  const run = cli([fixture("house").file, "--length", "300f", "--hit", "200f", "--video", video, "--video-sound", "keep", "--out", out, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const c = JSON.parse(run.stdout);
  assert.deepEqual([c.fps, c.length, c.drop.time, c.video.file], [25, 12, 8, "video.mp4"]);

  const other = cli([fixture("house").file, "--length", "12", "--hit", "8", "--fps", "30", "--video", video, "--video-sound", "keep", "--out", at("fps30")]);
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, /Note {4}film25\.mp4 runs at 25 fps and --fps is 30, so the frames in cues\.json are not the video's: leave --fps out, or give --fps 25, to count them as the video does\./);

  // Every seventh frame left out and every fifth one 12 ms late, in a
  // timebase of milliseconds: frames come at no steady rate.
  const vfr = film("vfr", { fps: 30, filter: ["-vf", "select='not(eq(mod(n\\,7)\\,3))',settb=1/1000,setpts='PTS+if(eq(mod(N\\,5)\\,2)\\,12\\,0)'", "-vsync", "vfr", "-enc_time_base", "1/1000"] });
  const inFrames = cli([fixture("house").file, "--length", "360f", "--video", vfr, "--out", at("vfr-frames")]);
  assert.equal(inFrames.status, 1);
  assert.match(inFrames.stderr, /musicfit: vfr\.mp4 has no steady frame rate, so a time in frames does not name one moment of it: give --length in seconds, or give --fps\n$/);
  const long = cli([fixture("house").file, "--length", "13", "--video", vfr, "--out", at("vfr-long")]);
  assert.equal(long.status, 1);
  assert.match(long.stderr, /musicfit: vfr\.mp4 is 12\.00 s long and --length is 13\.00 s: give --length 12\n$/);
  const seconds = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", vfr, "--out", at("vfr-fit")]);
  assert.equal(seconds.status, 0, seconds.stderr);
  // 309 frames over the 12 s and the last one's length, which encoders
  // write a little differently: 25.75 on ffmpeg 8, 25.749 on 4.4.
  assert.match(seconds.stdout, /Note {4}vfr\.mp4 has no steady frame rate, so the frames in cues\.json count at its average, 25\.7[45]\d* fps\./);
});

test("frames left out of a steady rate are places in it: a recording that dropped frames, and a cut that keeps a frame from after its end, count at their rate", async () => {
  const { probe } = require("../skills/musicfit/scripts/lib/video");
  // Every seventh frame left out: the others stay on the 30 fps grid.
  const dropped = film("dropped", { fps: 30, filter: ["-vf", "select='not(eq(mod(n\\,7)\\,3))'", "-vsync", "vfr"] });
  const info = await probe(dropped);
  assert.deepEqual([info.constant, info.fps, info.frames, info.seconds], [true, 30, 360, 12]);
  const out = at("dropped-fit");
  const run = cli([fixture("house").file, "--length", "360f", "--hit", "240f", "--video", dropped, "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.deepEqual([c.fps, c.length, c.drop.time, c.video.fps, c.video.frames, c.video.steady], [30, 12, 8, 30, 360, true]);
  assert.doesNotMatch(run.stdout, /steady/);
  // As ffmpeg -ss 2.5 -t 6 -c copy can leave an H.264 cut: its last frame
  // comes three thirtieths after the one before, and the cut plays 6.1 s.
  const cut = film("tail-gap", { fps: 30, seconds: 6.1, filter: ["-vf", "select='not(between(n\\,180\\,181))'", "-vsync", "vfr"] });
  const tail = await probe(cut);
  assert.deepEqual([tail.constant, tail.fps, tail.frames, Number(tail.seconds.toFixed(3))], [true, 30, 183, 6.1]);
  const short = cli([fixture("house").file, "--length", "6", "--video", cut, "--out", at("tail-gap-6")]);
  assert.equal(short.status, 1);
  assert.match(short.stderr, /musicfit: tail-gap\.mp4 is 6\.10 s long \(183 frames at 30 fps\) and --length is 6\.00 s: give --length 6\.1, or 183f\n$/);
  const whole = cli([fixture("house").file, "--length", "183f", "--video", cut, "--out", at("tail-gap-fit")]);
  assert.equal(whole.status, 0, whole.stderr);
  assert.deepEqual(packets(path.join(at("tail-gap-fit"), "video.mp4")), packets(cut));
});

test("a 29.97 fps video counts at 29.97 and a 30 fps one at 30, even in a timebase of whole milliseconds", async () => {
  const { probe, fpsText } = require("../skills/musicfit/scripts/lib/video");
  for (const ext of ["mp4", "mkv"]) {
    const info = await probe(film(`ntsc-${ext}`, { fps: "30000/1001", ext }));
    assert.ok(info.constant, ext);
    assert.ok(Math.abs(info.fps - 30000 / 1001) < 1e-9, `${ext}: ${info.fps}`);
    assert.equal(fpsText(info.fps), "29.97");
  }
  // 30 fps in milliseconds steps 33, 33 and 34, which comes out 29.999.
  const thirty = await probe(film("thirty-mkv", { fps: 30, ext: "mkv" }));
  assert.ok(thirty.constant);
  assert.equal(thirty.fps, 30);
  // Copied into a finer timebase, it keeps those steps and is still steady.
  const copied = at("thirty-copied.mp4");
  ffmpeg(["-i", film("thirty-mkv", { fps: 30, ext: "mkv" }), "-c", "copy", copied]);
  const again = await probe(copied);
  assert.ok(again.constant);
  assert.equal(again.fps, 30);
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

test("the video's own sound is read on its timeline: a sound that starts a second after the picture is a second late in video.mp4 too", async () => {
  const late = at("late.mp4");
  if (!fs.existsSync(late)) ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-itsoffset", "1", "-i", speech(), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "mpeg4", "-q:v", "6", "-c:a", "aac", "-t", "12", late]);
  const out = at("late-fit");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", late, "--video-sound", "voice", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  // speech.wav speaks from 2 s: in this video, from 3 s.
  const spans = cuesOf(out).video.spans;
  assert.ok(Math.abs(spans[0].from - 3) < 0.15, JSON.stringify(spans));
});

test("an AAC that lifts the true peak over -1 dBTP is limited again and encoded again", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const state = at(`hotaac-${process.hrtime.bigint()}`);
  const out = at("hotaac-fit");
  const run = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", out], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join(__dirname, "fixtures", "hotaac", "ffmpeg"), MUSICFIT_TEST_STATE: state } });
  assert.equal(run.status, 0, run.stderr);
  // The stand-in read the first AAC at -0.4 dBTP: a second one was made.
  assert.equal(fs.readFileSync(state, "utf8").trim().split("\n").length, 2);
  const c = cuesOf(out);
  assert.ok(c.video.loudness.truePeak <= -1, `true peak ${c.video.loudness.truePeak} dBTP`);
  assert.deepEqual(c.warnings.filter((w) => /AAC/.test(w)), []);
});

test("of AAC encodings whose true peaks come out higher and lower each time, the lowest is the one video.mp4 keeps", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const state = at(`erratic-${process.hrtime.bigint()}`);
  const out = at("erratic-fit");
  const run = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", out], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join(__dirname, "fixtures", "erraticaac", "ffmpeg"), MUSICFIT_TEST_STATE: state, MUSICFIT_TEST_PEAKS: "-0.5 0.4 -0.8 -0.2" } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(state, "utf8").trim(), "4");
  const c = cuesOf(out);
  assert.equal(c.video.loudness.truePeak, -0.8);
  assert.deepEqual(c.warnings.filter((w) => /AAC/.test(w)), ["After the AAC encoding the true peak of video.mp4 is -0.8 dBTP, over -1 dBTP."]);
  // video.mp4 holds the third encoding's packets.
  const kept = ffmpeg(["-i", path.join(out, "video.mp4"), "-map", "0:a", "-c", "copy", "-f", "framecrc", "pipe:1"]).stdout.split("\n").filter((l) => /^\d/.test(l));
  assert.deepEqual(kept, fs.readFileSync(`${state}.3`, "utf8").split("\n").filter((l) => /^\d/.test(l)));
  assert.notDeepEqual(kept, fs.readFileSync(`${state}.4`, "utf8").split("\n").filter((l) => /^\d/.test(l)));
});

test("a loud fit's video.mp4 keeps its true peak under -1 dBTP, as twoloop, ffmpeg 8's default AAC coder, did not", async () => {
  // At -10 LUFS this track came out at +1.3 dBTP with twoloop, 2.3 dB over
  // what it was held to, after four encodings.
  const out = at("loud-lofi");
  const run = cli([fixture("lofi").file, "--length", "12", "--video", film("mute"), "--lufs", "-10", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const heard = await measureFile(path.join(out, "video.mp4"));
  assert.ok(heard.truePeak <= -1, `true peak ${heard.truePeak} dBTP`);
  assert.doesNotMatch(run.stdout, /true peak of video\.mp4 is/);
  // As loud as asked, or a note says how far short it stopped.
  const c = cuesOf(out);
  if (c.video.loudness.integrated < -10.5) assert.match(run.stdout, /Note {4}video\.mp4 is at -1\d\.\d LUFS after the AAC encoding, short of the -10 LUFS asked for/);
  assert.ok(c.video.loudness.integrated >= -11.5, `${c.video.loudness.integrated} LUFS`);
});

test("the sound of video.mp4 is encoded with ffmpeg's fast AAC coder on any ffmpeg, not with twoloop, ffmpeg 8's default, which lifts the true peak of a loud sound by 3 dB and more", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const state = at(`args-${process.hrtime.bigint()}`);
  const run = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", film("film25", { sound: effects() }), "--video-sound", "keep", "--out", at("args-fit")], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join(__dirname, "fixtures", "argslog", "ffmpeg"), MUSICFIT_TEST_STATE: state } });
  assert.equal(run.status, 0, run.stderr);
  const encodings = fs.readFileSync(state, "utf8").split("\n").filter((line) => / -c:a aac /.test(line));
  assert.ok(encodings.length >= 1, "no AAC was encoded");
  for (const line of encodings) assert.match(line, / -c:a aac -aac_coder fast -b:a 256k /);
});

test("an AAC encoding that came out quieter than the first lost its loudness to the limiting: the ceiling goes no lower, and video.mp4 keeps the loudness", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const state = at(`quieter-${process.hrtime.bigint()}`);
  const out = at("quieter-fit");
  const run = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", out], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join(__dirname, "fixtures", "erraticaac", "ffmpeg"), MUSICFIT_TEST_STATE: state, MUSICFIT_TEST_PEAKS: "-0.5 -1.4 -1.6 -1.8", MUSICFIT_TEST_LOUDNESS: "-14.0 -15.2 -16.0 -17.0" } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(state, "utf8").trim(), "2");
  const c = cuesOf(out);
  assert.deepEqual(c.video.loudness, { target: -14, integrated: -14, truePeak: -0.5 });
  assert.deepEqual(c.warnings.filter((w) => /AAC/.test(w)), ["After the AAC encoding the true peak of video.mp4 is -0.5 dBTP, over -1 dBTP."]);
  const kept = ffmpeg(["-i", path.join(out, "video.mp4"), "-map", "0:a", "-c", "copy", "-f", "framecrc", "pipe:1"]).stdout.split("\n").filter((l) => /^\d/.test(l));
  assert.deepEqual(kept, fs.readFileSync(`${state}.1`, "utf8").split("\n").filter((l) => /^\d/.test(l)));
});

test("a video.mp4 that stopped short of the loudness asked for says so, in the summary, in a note and in FIT.md", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const out = at("short-fit");
  const run = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", out], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join(__dirname, "fixtures", "erraticaac", "ffmpeg"), MUSICFIT_TEST_STATE: at(`short-${process.hrtime.bigint()}`), MUSICFIT_TEST_PEAKS: "-1.2", MUSICFIT_TEST_LOUDNESS: "-15.3" } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\n {2}Video {3}video\.mp4 is mute\.mp4 with the music \(it had no sound of its own\); -15\.3 LUFS, true peak -1\.2 dBTP\n/);
  assert.match(run.stdout, /\n {2}Note {4}video\.mp4 is at -15\.3 LUFS after the AAC encoding, short of the -14 LUFS asked for: any louder and its true peaks would pass -1 dBTP\.\n/);
  const md = fs.readFileSync(path.join(out, "FIT.md"), "utf8");
  assert.match(md, /into `video\.mp4`, with the music \(it had no sound of its own\), the whole raised toward -14 LUFS but stopped at -15\.3 LUFS, measured after the AAC encoding: any louder and its true peaks would pass -1 dBTP\./);
  assert.doesNotMatch(md, /the whole set to -14 LUFS/);
});

test("FIT.md says what plays under the picture in plain words, and never that the loudness stopped short when the music only dips", () => {
  const { fitMarkdown, underVideo } = require("../skills/musicfit/scripts/lib/report");
  const base = {
    length: 12, frames: 300, fps: 25, mix: null, tempo: null, drop: null, seams: [], segments: [{ from: 0, to: 12, source: [0, 12], sourceBars: null }],
    start: { kind: "top", firstBar: null, fadeIn: 0 }, end: { kind: "fade", time: 12, frame: 300, finalHit: null, fade: { from: 11, to: 12, fromFrame: 275, toFrame: 300, onBeat: false } },
    mode: "energy", warnings: [], loudness: { target: -14, integrated: -24, truePeak: -6.9, range: 3, limited: true },
  };
  const video = (fields) => ({ file: "video.mp4", source: "talk.mp4", length: 12, fps: 25, frames: 300, steady: true, picture: "h264", same: null, spans: [{ from: 2, to: 5, over: null }], loudness: { target: -14, integrated: -14, truePeak: -1.2 }, ...fields });
  const voice = { file: "vo.wav", duck: 10, spans: [{ from: 6, to: 8 }] };
  // keep: every place 3 dB over the music, one of two, none, and no music under any.
  const heard = [{ from: 2, to: 5, over: 3.1 }, { from: 7, to: 8, over: 12.4 }];
  const held = [{ from: 2, to: 5, over: 3.1 }, { from: 7, to: 8, over: -1.2 }];
  const keep = (spans) => video({ sound: "keep", duck: null, over: 3, spans });
  const words = (spans) => underVideo({ ...base, voice: null, video: keep(spans) });
  assert.equal(words(heard), "the music and its own sound, that sound about 3 dB or more louder than the music where it plays (2 places)");
  assert.equal(words(held), "the music and its own sound, that sound about 3 dB or more louder than the music in 1 of the 2 places it plays");
  assert.equal(words([held[1]]), "the music and its own sound, that sound less than 3 dB louder than the music where it plays (1 place)");
  assert.equal(words([{ from: 2, to: 5, over: null }]), "the music and its own sound, that sound set to -14 LUFS where it plays, as no music plays there");
  const cases = [
    { video: keep(heard) },
    { video: keep(held) },
    { video: keep([{ from: 2, to: 5, over: null }]) },
    { video: video({ sound: "keep", duck: null, over: null, spans: [] }) },
    { video: keep(held), voice },
    { video: video({ sound: "voice", duck: 10 }) },
    { video: video({ sound: "voice", duck: 10, spans: [] }) },
    { video: video({ sound: "voice", duck: 10 }), voice },
    { video: video({ sound: "drop", duck: null, spans: [] }) },
    { video: video({ sound: "drop", duck: null, spans: [] }), voice },
    { video: video({ sound: "none", duck: null, spans: [] }) },
    { video: video({ sound: "drop", same: "track", duck: null, spans: [] }) },
    { video: video({ sound: "drop", same: "voice", duck: null, spans: [] }), voice },
  ];
  for (const fields of cases) {
    const c = { ...base, voice: null, ...fields };
    const md = fitMarkdown(c, { trackName: "house.wav" });
    const words = underVideo(c);
    const label = `${c.video.sound}${c.video.same ? `/${c.video.same}` : ""}${c.voice ? " with a voice" : ""}${c.video.spans.length ? "" : " and no spans"}`;
    assert.ok(md.includes(`\`video.mp4\` is talk.mp4 with ${words}: its picture as it was`), label);
    assert.ok(md.includes(`into \`video.mp4\`, with ${words}, the whole set to -14 LUFS`), label);
    assert.doesNotMatch(md, /\b(\w+ \w+) \1\b/, label);
    const dips = Boolean(c.voice) || (c.video.duck !== null && c.video.spans.length > 0);
    // -24 LUFS is the music as a whole with its dips, not a loudness the limiter stopped at.
    if (dips) assert.doesNotMatch(md, /stopped at/, label);
    if (dips) assert.match(md, /at -24 LUFS as a whole, dips included, with true peaks/, label);
    // With keep the music does not dip under the video's own sound.
    if (c.video.sound === "keep" && !c.voice) assert.doesNotMatch(md, /dip/, label);
  }
  assert.match(fitMarkdown({ ...base, voice: null, video: null }, { trackName: "house.wav" }), /Loudness raised toward -14 LUFS but stopped at -24 LUFS/);
});

test("with --video-sound voice and no voice, FIT.md says the loudness was set where the video's own sound does not play", () => {
  const out = at("talk-voice");
  if (!fs.existsSync(path.join(out, "FIT.md"))) assert.equal(cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", film("talk", { sound: speech() }), "--video-sound", "voice", "--out", out]).status, 0);
  const md = fs.readFileSync(path.join(out, "FIT.md"), "utf8");
  assert.doesNotMatch(md, /stopped at/);
  assert.match(md, /Loudness set to -14 LUFS where talk\.mp4's own sound does not play/);
  assert.match(md, /with its own sound set to -14 LUFS where it plays, the music dipping 10 dB under it, the whole set to -14 LUFS/);
});

test("a track, a voice and a video named like 16:9 mix.wav or 9:16.mp4 are read as the files they are, not as a protocol", { skip: process.platform === "win32" ? "Windows names take no colon" : false }, () => {
  const cwd = at("colons");
  fs.mkdirSync(cwd, { recursive: true });
  fs.copyFileSync(fixture("house").file, path.join(cwd, "16:9 mix.wav"));
  fs.copyFileSync(speech(), path.join(cwd, "vo:take 2.wav"));
  fs.copyFileSync(film("film25", { sound: effects() }), path.join(cwd, "9:16.mp4"));
  const run = spawnSync(process.execPath, [CLI, "16:9 mix.wav", "--length", "12", "--hit", "8", "--voice", "vo:take 2.wav", "--video", "9:16.mp4", "--video-sound", "keep", "--out", "fit"], { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(fs.readdirSync(path.join(cwd, "fit")).sort(), ["FIT.md", "cues.json", "fitted.wav", "mix.wav", "seams.png", "video.mp4"]);
  assert.deepEqual(packets(path.join(cwd, "fit", "video.mp4")), packets(path.join(cwd, "9:16.mp4")));
});

test("a whole video whose name or tags hold the words ffmpeg prints for a damaged file is not taken for a damaged one", async () => {
  const { probe } = require("../skills/musicfit/scripts/lib/video");
  const named = at("partial file.mp4");
  fs.copyFileSync(film("mute"), named);
  const tagged = at("tagged.mp4");
  ffmpeg(["-i", film("mute"), "-c", "copy", "-metadata", "title=Packet corrupt input packet in stream 0", "-metadata", "comment=File ended prematurely", tagged]);
  // ffmpeg prints the tags again under the output it writes.
  const titled = at("titled.mp4");
  ffmpeg(["-i", film("mute"), "-c", "copy", "-metadata", "title=corrupt input packet in stream 0", "-metadata", "comment=A note that ends in: corrupt input packet in stream 0", "-metadata:s:v:0", "handler_name=x: corrupt input packet in stream 0", titled]);
  for (const file of [named, tagged, titled]) {
    const info = await probe(file);
    assert.deepEqual([info.seconds, info.frames], [12, 300], file);
  }
  const run = cli([fixture("house").file, "--length", "12", "--video", named, "--out", at("partial-file-fit")]);
  assert.equal(run.status, 0, run.stderr);
});

test("a picture that starts after the top of its file, as in a fragmented MP4 with B-frames, is measured from its first frame, and in video.mp4 it starts with the sound", async () => {
  const { probe } = require("../skills/musicfit/scripts/lib/video");
  // mpeg4 with B-frames, written in fragments with no edit list: the
  // picture starts a frame after the sound.
  const frag = film("frag-bframes", { sound: effects(), codec: ["-c:v", "mpeg4", "-q:v", "6", "-bf", "2", "-movflags", "frag_keyframe+empty_moov"] });
  const info = await probe(frag);
  assert.ok(info.start > 0.03, `the picture starts at ${info.start} s`);
  assert.deepEqual([info.seconds, info.frames, info.fps], [12, 300, 25]);
  for (const length of ["12", "300f"]) {
    const out = at(`frag-fit-${length}`);
    const run = cli([fixture("house").file, "--length", length, "--hit", "8", "--video", frag, "--video-sound", "keep", "--out", out]);
    assert.equal(run.status, 0, run.stderr);
    const c = cuesOf(out);
    assert.deepEqual([c.frames, c.video.frames, c.video.length], [300, 300, 12]);
    // Its own sound is read from the first frame: the effect at 2 s of the
    // file plays a frame earlier on the picture.
    assert.ok(Math.abs(c.video.spans[0].from - (2 - info.start)) < 0.05, JSON.stringify(c.video.spans));
    assert.deepEqual(packets(path.join(out, "video.mp4")), packets(frag));
    // In video.mp4 the first frame is at 0, and the sound lines up with it.
    const made = await probe(path.join(out, "video.mp4"));
    assert.ok(Math.abs(made.start) < 0.001, `video.mp4's picture starts at ${made.start} s`);
    const music = mono(await decode(path.join(out, "fitted.wav")));
    const under = mono(await decode(path.join(out, "video.mp4"), { from: made.start }));
    assert.ok(Math.abs(lag(music, under, 4, 6)) <= 96, `video.mp4's sound is ${lag(music, under, 4, 6)} samples off`);
  }
});

test("an MPEG-TS whose sound starts before its picture keeps that sound where it was against the picture", () => {
  const ts = at("early.ts");
  if (!fs.existsSync(ts)) ffmpeg(["-itsoffset", "0.5", "-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-i", speech(), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "mpeg4", "-q:v", "6", "-c:a", "aac", ts]);
  const out = at("early-ts-fit");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", ts, "--video-sound", "voice", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.equal(c.video.length, 12);
  // speech.wav speaks from 2 s, and its sound comes about half a second
  // before the picture: about 1.5 s into the picture.
  assert.ok(Math.abs(c.video.spans[0].from - 1.5) < 0.12, JSON.stringify(c.video.spans));
});

test("a video cut without encoding again, whose first shown frame needs frames from before the cut, is read from that frame, and video.mp4 shows it at 0", async () => {
  const { probe } = require("../skills/musicfit/scripts/lib/video");
  const whole = film("gop16", { seconds: 16, codec: ["-c:v", "mpeg4", "-q:v", "6", "-g", "50", "-bf", "2"] });
  const cut = at("gop-cut.mp4");
  ffmpeg(["-ss", "1.5", "-i", whole, "-t", "12", "-c", "copy", cut]);
  const info = await probe(cut);
  // The frames before the cut are in the file, flagged so no player shows them.
  const all = ffmpeg(["-i", cut, "-map", "0:V:0", "-c", "copy", "-f", "framecrc", "pipe:1"]).stdout.split("\n").filter((l) => /^\d/.test(l)).length;
  assert.ok(info.frames < all, `${info.frames} of ${all} packets counted`);
  assert.ok(Math.abs(info.start) < 0.001, `the picture starts at ${info.start} s`);
  const out = at("gop-cut-fit");
  const run = cli([fixture("house").file, "--length", String(Number(info.seconds.toFixed(3))), "--video", cut, "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const made = await probe(path.join(out, "video.mp4"));
  assert.ok(Math.abs(made.start) < 0.001, `video.mp4's first shown frame is at ${made.start} s`);
  const first = (file) => ffmpeg(["-i", file, "-map", "0:v:0", "-frames:v", "1", "-f", "framemd5", "pipe:1"]).stdout.split("\n").find((l) => /^\d/.test(l)).split(",").pop().trim();
  assert.equal(first(path.join(out, "video.mp4")), first(cut));
});
