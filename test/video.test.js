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

test("--video writes video.mp4: the picture packet for packet, the fitted track lined up with it, its own sound kept 3 dB louder than the music in each place it plays, the music dipping under a place only as far as their peaks need and untouched elsewhere, at --lufs with the true peak at or under -1 dBTP", async () => {
  const video = film("film25", { sound: effects() });
  const out = at("film25-fit");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), ["FIT.md", "cues.json", "fitted.wav", "seams.png", "video.mp4"]);
  assert.match(run.stdout, /\n {2}Video {3}video\.mp4 is film25\.mp4 with the music and its own sound, that sound about 3 dB or more louder than the music where it plays \(2 places\)(?:, the music dipping [\d.]+(?: to [\d.]+)? dB under (?:both|one of them))?; -1[34](?:\.\d)? LUFS, true peak -[\d.]+ dBTP\n/);

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

  // fitted.wav is a plain fit's. In video.mp4 the music is lined up with
  // the picture, and each effect is about 3 dB louder than it where it
  // plays, the one on the hit too, as cues.json says of each: the music
  // dips under one only by as much as their peaks leave no room for, and
  // elsewhere the limiter takes nothing off it.
  assert.ok(fs.readFileSync(path.join(out, "fitted.wav")).equals(plain().wav), "fitted.wav dips under the effects");
  const music = mono(await decode(path.join(out, "fitted.wav")));
  const under = mono(await decode(path.join(out, "video.mp4")));
  assert.ok(Math.abs(lag(music, under, 4, 6)) <= 96, `video.mp4's sound is ${lag(music, under, 4, 6)} samples off`);
  const places = await placesOver(under, music, video, c.video.spans);
  places.forEach((p, i) => {
    assert.ok(c.video.spans[i].over >= 2.9, JSON.stringify(c.video.spans[i]));
    assert.ok(Math.abs(p.over - c.video.spans[i].over) <= AAC_NOISE, `the effect at ${c.video.spans[i].from} s is ${p.over.toFixed(1)} LU over the music, and cues.json says ${c.video.spans[i].over}`);
  });
  const gains = musicGains(under, music, mono(await decode(video)), c.video.spans);
  assert.ok(gains.spread <= 0.25, `the music away from the effects moves ${gains.spread.toFixed(2)} dB`);
  c.video.spans.forEach((span, i) => {
    assert.ok(span.dip >= 0 && span.dip <= 10, JSON.stringify(span));
    assert.ok(Math.abs(gains.under[i] + span.dip) <= 1, `the music is ${gains.under[i].toFixed(1)} dB down under the effect at ${span.from} s, and cues.json says it dips ${span.dip} dB`);
  });
  assert.deepEqual(c.warnings, []);
});

// The music's gain in video.mp4 against fitted.wav, by least squares
// against it and the video's own sound together: in windows of 0.2 s away
// from every place and its dip, how far those move from the first (a
// limiter taking the music down would move them), and under each place,
// how far it is down from them, in dB.
function musicGains(heard, music, own, spans) {
  const busy = (t) => spans.some((s) => t > s.from - 0.2 && t < s.to + 0.6);
  const away = [];
  for (let t = 0; t + 0.2 <= heard.length / RATE; t += 0.2) {
    const [a, b] = [Math.round(t * RATE), Math.round((t + 0.2) * RATE)];
    let mm = 0;
    for (let i = a; i < b; i++) mm += music[i] * music[i];
    if (busy(t) || busy(t + 0.2) || mm < 1e-3) continue;
    away.push(20 * Math.log10(parts(heard, music, own, a, b).music));
  }
  const level = away.reduce((sum, g) => sum + g, 0) / away.length;
  return {
    spread: Math.max(...away) - Math.min(...away),
    under: spans.map((s) => 20 * Math.log10(parts(heard, music, own, Math.round(s.from * RATE), Math.round(s.to * RATE)).music) - level),
  };
}

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
    assert.match(run.stderr, new RegExp(`musicfit: ${name}\\.mp4 has sound of its own for ${plays.source} of its 12\\.0 s, so say what becomes of it with --video-sound: keep for sound effects \\(they stay, 3 dB louder than the music where they play, and where their peaks leave no room for that the music dips under them, 10 dB at most\\), voice for speech \\(set to -14 LUFS where it plays, and the music dips 10 dB under it\\), or drop for music of its own \\(left out\\)\\n$`));
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
  // Where the video's own sound is silent, all of it is the music's.
  if (mm > 0 && !(oo > 1e-9 * mm)) return { music: hm / mm, own: 0 };
  if (!(mm > 0) || !(det > 1e-9 * mm * oo)) return { music: 0, own: oo > 0 ? ho / oo : 0 };
  return { music: (hm * oo - ho * mo) / det, own: (ho * mm - hm * mo) / det };
}

test("--video-sound keep raises quiet sound effects, so each is about 3 dB louder than the music where it plays, and fitted.wav stays as a plain fit's", async () => {
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
  assert.ok(fs.readFileSync(path.join(out, "fitted.wav")).equals(plain().wav), "fitted.wav dips under the effects");
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

test("an impact on the drop, whose peaks stand 11 dB over its loudness, comes out 3 dB over the music there, the music dipping under it alone by as much as is missing, --duck at most, and the limiter takes nothing off the music", async () => {
  // A 70 Hz thump and a crack, both dying away over 0.6 s, on the hit: the
  // loudest stretch of the fit.
  const boom = wav("boom", 12, (x) => {
    let seed = 23;
    for (let i = 0; i < 0.6 * RATE; i++) {
      const t = i / RATE;
      seed = (seed * 1103515245 + 12345) % 2147483648;
      x[8 * RATE + i] = 0.3 * Math.exp(-t / 0.12) * Math.sin(2 * Math.PI * 70 * t) + 0.08 * Math.exp(-t / 0.05) * (seed / 2147483648 - 0.5);
    }
  });
  const video = film("boom", { sound: boom });
  const out = at("boom-keep");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.equal(c.video.spans.length, 1);
  const heard = mono(await decode(path.join(out, "video.mp4")));
  const music = mono(await decode(path.join(out, "fitted.wav")));
  const [place] = await placesOver(heard, music, video, c.video.spans);
  // Held to its peak at -1 dBFS it stayed 1.4 LU under the music; left to
  // the limiter, the music around it went 4 dB down and more.
  const [span] = c.video.spans;
  assert.ok(span.over >= 2.9 && span.dip > 0 && span.dip <= 10, JSON.stringify(span));
  assert.ok(place.over >= 3 - AAC_NOISE, `the impact is ${place.over.toFixed(1)} LU over the music`);
  const gains = musicGains(heard, music, mono(await decode(video)), c.video.spans);
  assert.ok(gains.spread <= 0.25, `the music away from the impact moves ${gains.spread.toFixed(2)} dB`);
  assert.ok(Math.abs(gains.under[0] + span.dip) <= 1, `the music is ${gains.under[0].toFixed(1)} dB down under the impact, and cues.json says it dips ${span.dip} dB`);
  assert.deepEqual(c.warnings, []);
  // With --duck 2 the music dips 2 dB at most, which leaves the impact
  // short of 3 dB over it, and a note says so.
  const short = at("boom-keep-duck2");
  const run2 = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--video-sound", "keep", "--duck", "2", "--out", short]);
  assert.equal(run2.status, 0, run2.stderr);
  const [held] = cuesOf(short).video.spans;
  assert.ok(held.dip === 2 && held.over < 2.5, JSON.stringify(held));
  assert.match(run2.stdout, new RegExp(`Note {4}boom\\.mp4's own sound is less than 3 dB louder than the music where it plays, at 8\\.00 s \\([^)]*\\): a place is set no louder than -8 LUFS, 6 dB over the target, nor than keeps its true peaks, with the music's, under -1 dBTP, and the music dips under it by 2 dB at most, as --duck says\\. A larger --duck lets the music dip further there\\.\\n`));
});

// The level of [from, to] s of a K-weighted sound, in LUFS, and its energy
// on that scale.
function windowEnergy(x, from, to) {
  const a = Math.round(from * RATE);
  const b = Math.min(x.length, Math.round(to * RATE));
  let sum = 0;
  for (let i = a; i < b; i++) sum += x[i] * x[i];
  return (2 * sum) / (b - a);
}
const lufsOf = (energy) => -0.691 + 10 * Math.log10(energy + 1e-12);

test("--video-sound keep with a voice keeps every place, where the voice speaks over it too: measured in video.mp4 against a drop run each is there at about the target, and the music dips for none of them under the voice", async () => {
  // The first burst before the voice starts, the other two while it speaks.
  const fx = wav("fxvoice", 12, (x) => {
    let seed = 17;
    for (const [from, to] of [[0.6, 0.9], [3, 3.3], [8, 8.6]]) {
      for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        x[i] = (seed / 2147483648 - 0.5) * 0.6;
      }
    }
  });
  const video = film("fxvoice", { sound: fx });
  const fit = (how) => {
    const out = at(`fxvoice-${how}`);
    const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--voice", speech(), "--video", video, "--video-sound", how, "--out", out]);
    assert.equal(run.status, 0, run.stderr);
    return { out, run };
  };
  const kept = fit("keep");
  const dropped = fit("drop");
  const c = cuesOf(kept.out);
  assert.deepEqual(c.video.spans.map((s) => Math.round(s.from)), [1, 3, 8]);
  const voiced = c.voice.spans;
  const fitmd = fs.readFileSync(path.join(kept.out, "FIT.md"), "utf8");
  for (const said of [kept.run.stdout, fitmd]) assert.doesNotMatch(said, /Infinity|NaN/);
  assert.doesNotMatch(kept.run.stdout, /less than 3 dB louder/);
  const k = weighted(mono(await decode(path.join(kept.out, "video.mp4"))));
  const d = weighted(mono(await decode(path.join(dropped.out, "video.mp4"))));
  for (const s of c.video.spans) {
    const label = `the place at ${s.from} s: ${JSON.stringify(s)}`;
    // Every figure is a number, and the place is over the music there.
    assert.ok(Number.isFinite(s.over) && Number.isFinite(s.dip), label);
    assert.ok(s.over >= 2.5, label);
    // Where the voice speaks the music has dipped under it already.
    if (voiced.some((v) => v.from <= s.from && s.to <= v.to)) assert.equal(s.dip, 0, label);
    const [ek, ed] = [windowEnergy(k, s.from, s.to), windowEnergy(d, s.from, s.to)];
    assert.ok(lufsOf(ek) >= lufsOf(ed) + 1, `${label}: ${lufsOf(ek).toFixed(1)} LUFS with keep and ${lufsOf(ed).toFixed(1)} with drop`);
    // What keep adds to that stretch is the place, as a meter reads it.
    const alone = lufsOf(ek - ed);
    assert.ok(alone >= -19 && alone <= -9, `${label}: the place alone reads ${alone.toFixed(1)} LUFS`);
  }
  // Away from the places the music and the voice play as with drop.
  for (const [from, to] of [[1.6, 2.6], [4.3, 6.4], [9.4, 11]]) {
    const [lk, ld] = [lufsOf(windowEnergy(k, from, to)), lufsOf(windowEnergy(d, from, to))];
    assert.ok(Math.abs(lk - ld) <= 1, `${from} to ${to} s: ${lk.toFixed(1)} LUFS with keep and ${ld.toFixed(1)} with drop`);
  }
  // The whole is at the target, its true peak held, by the limiter.
  const whole = await measureFile(path.join(kept.out, "video.mp4"));
  assert.ok(Math.abs(whole.integrated + 14) <= 0.5, `${whole.integrated} LUFS`);
  assert.ok(whole.truePeak <= -1, `true peak ${whole.truePeak} dBTP`);
  assert.deepEqual(c.warnings, []);
});

test("a place keep leaves short with a voice given is named without the advice of a larger --duck, which would deepen the dip under the voice too", () => {
  const boom = wav("boom-voice", 12, (x) => {
    for (let i = 0; i < 0.6 * RATE; i++) {
      const t = i / RATE;
      x[8 * RATE + i] = 0.3 * Math.exp(-t / 0.12) * Math.sin(2 * Math.PI * 70 * t);
    }
  });
  const video = film("boom-voice", { sound: boom });
  // A voice that has ended before the impact, so the music is at its full level there.
  const early = at("early-speech.wav");
  if (!fs.existsSync(early)) writeWav(early, voice(12, [[2, 5]]));
  const out = at("boom-voice-keep");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--voice", early, "--video", video, "--video-sound", "keep", "--duck", "2", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const [span] = cuesOf(out).video.spans;
  assert.ok(span.dip === 2 && span.over < 2.5, JSON.stringify(span));
  assert.match(run.stdout, /Note {4}boom-voice\.mp4's own sound is less than 3 dB louder than the music where it plays, at 8\.00 s \([^)]*\): a place is set no louder than -8 LUFS, 6 dB over the target, nor than keeps its true peaks, with the music's, under -1 dBTP, and the music dips under it by 2 dB at most, as --duck says\.\n/);
  assert.doesNotMatch(run.stdout, /A larger --duck/);
});

test("a voice at the ceiling holds no place of keep back, a place is never set to nothing, and one that came out with no figure counts as under the music", async () => {
  const { setOver, cameOut } = require("../skills/musicfit/scripts/lib/render");
  const n = 4 * RATE;
  const fill = (f) => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = f(i);
    return { L: x, R: x.slice() };
  };
  let seed = 3;
  const own = fill((i) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return i >= RATE && i < 1.4 * RATE ? (seed / 2147483648 - 0.5) * 0.4 : 0;
  });
  const music = fill((i) => 0.1 * Math.sin((2 * Math.PI * 110 * i) / RATE));
  // A voice whose peaks stand at -1 dBFS in every millisecond of the place.
  const also = fill((i) => 0.891 * Math.sign(Math.sin((2 * Math.PI * 200 * i) / RATE)));
  const [place] = await setOver(own, music, [[1, 1.4]], { lufs: -14, over: 3, most: 6, duck: 10, also });
  assert.ok(Number.isFinite(place.gain) && place.gain > -20, `its gain is ${place.gain} dB`);
  assert.ok(Number.isFinite(place.over) && place.over >= 2.5, `it is ${place.over} dB over the music`);
  assert.equal(place.dip, 0);
  // The whole as make() adds it, read back: the place's samples are let go, and its figure is unchanged.
  const whole = { L: own.L.slice(), R: own.R.slice() };
  for (let i = 0; i < n; i++) {
    whole.L[i] += music.L[i] + also.L[i];
    whole.R[i] += music.R[i] + also.R[i];
  }
  const before = place.over;
  await cameOut([place], whole, music);
  assert.ok(Math.abs(place.over - before) <= 0.2, `set ${before} dB over the music, and read ${place.over} dB`);
  assert.deepEqual(Object.keys(place).filter((key) => key === "own" || key === "also"), []);
  // A figure that is no number is under the music, and null stays null.
  const none = { a: 0, b: 100, over: -Infinity, dip: 10, own: { L: new Float32Array(100), R: new Float32Array(100) }, also: null };
  const silent = { a: 0, b: 100, over: null, dip: 0, own: { L: new Float32Array(100), R: new Float32Array(100) }, also: null };
  await cameOut([none, silent], whole, music);
  assert.equal(none.over, -70);
  assert.equal(silent.over, null);
});

test("a sound effect that runs to the end of a video a little longer than --length, within a frame, is kept like any other", async () => {
  const fx = wav("fxend", 12, (x) => {
    let seed = 13;
    for (const [from, to] of [[2, 2.3], [11.5, 12]]) {
      for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        x[i] = (seed / 2147483648 - 0.5) * 0.3;
      }
    }
  });
  const video = film("fxend", { sound: fx });
  const out = at("fxend-keep");
  const run = cli([fixture("house").file, "--length", "11.98", "--hit", "8", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.equal(c.video.spans.length, 2);
  const heard = weighted(mono(await decode(path.join(out, "video.mp4"))));
  const last = c.video.spans[1];
  assert.doesNotMatch(run.stdout, /Infinity|NaN|-120/);
  // As loud as a place at the target can be, where almost no music plays.
  const level = lufsOf(windowEnergy(heard, last.from, 11.95));
  assert.ok(Math.abs(level + 14) <= 3, `the last place reads ${level.toFixed(1)} LUFS`);
  const whole = await measureFile(path.join(out, "video.mp4"));
  assert.ok(Number.isFinite(whole.integrated) && whole.integrated > -16, `${whole.integrated} LUFS`);
});

test("the same sound effect inside the closing fade and just after the music has ended comes out about as loud, the one in the fade not pushed down with the music there", async () => {
  // Where the fade runs in this fit, read from a fit without the video:
  // from 11.6 s to the last beat before the end, 13.5 s.
  const plainOut = at("fadeend-plain");
  assert.equal(cli([fixture("house").file, "--length", "14", "--end", "fade", "--out", plainOut]).status, 0);
  const { fade } = cuesOf(plainOut).end;
  const inside = fade.from + 0.45 * (fade.to - fade.from);
  const after = fade.to + 0.1;
  assert.ok(after + 0.35 <= 14 && after - inside >= 0.85, JSON.stringify(fade));
  // A 0.25 s tone at -12 dBFS at both.
  const tones = wav("fadeend", 14, (x) => {
    for (const from of [inside, after]) {
      for (let i = 0; i < 0.25 * RATE; i++) x[Math.round(from * RATE) + i] = 0.25 * Math.sin((2 * Math.PI * 800 * i) / RATE);
    }
  });
  const video = film("fadeend", { seconds: 14, sound: tones });
  const out = at("fadeend-keep");
  const run = cli([fixture("house").file, "--length", "14", "--end", "fade", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.equal(c.video.spans.length, 2);
  assert.equal(c.video.spans[1].over, null);
  const heard = mono(await decode(path.join(out, "video.mp4")));
  const music = mono(await decode(path.join(out, "fitted.wav")));
  const [inFade, afterFade] = await placesOver(heard, music, video, c.video.spans);
  // Over the music in the fade and over none after it, both at about the
  // target, never one far under the other.
  assert.ok(inFade.over >= 2.5, `in the fade ${inFade.over.toFixed(1)} LU over the music`);
  assert.ok(Math.abs(inFade.level - afterFade.level) <= 3, `in the fade ${inFade.level.toFixed(1)} LUFS, after it ${afterFade.level.toFixed(1)} LUFS`);
  for (const p of [inFade, afterFade]) assert.ok(Math.abs(p.level + 14) <= 3, `${p.level.toFixed(1)} LUFS`);
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

test("a video whose only sounds are short clicks is asked about, keep sets the clicks over the music with fitted.wav as it was, and voice finds no speech in them", async () => {
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
  // Over the music, each click as far as its peaks, the music's and a dip
  // of 10 dB at most allow: one held under 3 dB over it is named in a note.
  for (const span of cuesOf(out).video.spans) {
    assert.ok(span.over > 0, JSON.stringify(span));
    if (span.over < 2.5) assert.match(run.stdout, new RegExp(`Note {4}clicks\\.mp4's own sound is less than 3 dB louder than the music [^\\n]*at [^\\n]*${span.from.toFixed(2)} s \\(${span.over} dB over it\\)[^\\n]*nor than keeps its true peaks, with the music's, under -1 dBTP, and the music dips under it by 10 dB at most, as --duck says\\.`));
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

test("seams.png marks where the music dips under the video's own sound with voice, and names it under the picture, and with keep, whose dips are in video.mp4 only, has no such marks", () => {
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
  // The punctuation of a downloaded song's name, in its plain form.
  assert.equal(title("Don’t Stop – Live.wav"), title("DON'T STOP - LIVE.WAV"));
  const { drawable } = require("../skills/musicfit/scripts/lib/draw");
  assert.equal(drawable("café_noir & co!.mp3"), "CAFE_NOIR & CO!.MP3");
  assert.equal(drawable("Smørrebrød straße.wav"), "SMORREBROD STRASSE.WAV");
  assert.equal(drawable("गाना.wav"), null);
  assert.equal(drawable("Artist — Title.mp3"), "ARTIST - TITLE.MP3");
  assert.equal(drawable("“Quoted” ‘and’ wait….wav"), "\"QUOTED\" 'AND' WAIT....WAV");
  assert.equal(drawable("über·song×2.wav"), "UBER.SONGX2.WAV");
  // A sign it has no shape for is left out; a name of nothing else, or with
  // letters of another script, is the track.
  assert.equal(drawable("Song ♪ Live ✨.mp3"), "SONG LIVE.MP3");
  assert.equal(drawable("♪♪.mp3"), null);
  assert.equal(drawable("Песня Song.mp3"), null);
  assert.equal(drawable("___.wav"), "___.WAV");
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

test("an MP4 cut short inside its index is said to be, wherever in the index it stops, and one that lacks only the end of its index goes through", () => {
  const whole = film("film12", {});
  const bytes = fs.readFileSync(whole);
  // The top-level boxes, to find the index, which comes last in this file.
  let moov = 0;
  while (bytes.toString("latin1", moov + 4, moov + 8) !== "moov") moov += bytes.readUInt32BE(moov);
  const inside = (tag, past) => bytes.indexOf(tag, moov, "latin1") + past;
  const cuts = [
    // Before anything of it is read: no stream is listed.
    ["just inside", moov + 10, "streams"],
    // A stream ffmpeg knows nothing of yet.
    ["in tkhd", inside("tkhd", 20), "streams"],
    // A picture known only by its handler: ffmpeg 4.4 will not copy it, ffmpeg 8 copies no frame of it.
    ["in hdlr", inside("hdlr", 30), "frames"],
    // Past that, ffmpeg gives up on the header.
    ["in stsd", inside("stsd", 12), "index"],
    ["in stts", inside("stts", 6), "index"],
    ["in stsz", inside("stsz", 20), "index"],
  ];
  for (const [where, size, what] of cuts) {
    const video = at(`cut-index ${where}.mp4`);
    fs.writeFileSync(video, bytes.subarray(0, size));
    const out = at(`refused-index-${where}`);
    const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--out", out]);
    assert.equal(run.status, 1, `${where}: ${run.stderr}`);
    assert.equal(run.stderr, `musicfit: Cannot read ${video}: it is cut short or damaged, so ffmpeg finds no ${what} in it\n`, where);
    assert.ok(!fs.existsSync(out), where);
  }
  // ffmpeg has all it needs: the last bytes are the file's tags.
  const nearly = at("cut-index tags.mp4");
  fs.writeFileSync(nearly, bytes.subarray(0, bytes.length - 8));
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", nearly, "--out", at("index-tags-fit")]);
  assert.equal(run.status, 0, run.stderr);
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
  assert.match(refused.stderr, /musicfit: .*theirs\/video\.mp4 is a file no musicfit cues\.json there lists, and this run would replace it: move it, or give another --out\n$/);
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
  // Short of the target and over -1 dBTP: both said, and no peak given as
  // the reason it stopped.
  const over = at("short-over-fit");
  const hot = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", over], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join(__dirname, "fixtures", "erraticaac", "ffmpeg"), MUSICFIT_TEST_STATE: at(`short-over-${process.hrtime.bigint()}`), MUSICFIT_TEST_PEAKS: "0.2 0.3 0.4 0.5", MUSICFIT_TEST_LOUDNESS: "-15.3 -15.3 -15.3 -15.3" } });
  assert.equal(hot.status, 0, hot.stderr);
  assert.match(hot.stdout, /\n {2}Note {4}After the AAC encoding the true peak of video\.mp4 is 0\.2 dBTP, over -1 dBTP\.\n {2}Note {4}video\.mp4 is at -15\.3 LUFS after the AAC encoding, short of the -14 LUFS asked for, with true peaks at 0\.2 dBTP\.\n/);
  const hotMd = fs.readFileSync(path.join(over, "FIT.md"), "utf8");
  assert.match(hotMd, /the whole raised toward -14 LUFS but stopped at -15\.3 LUFS with true peaks at 0\.2 dBTP, measured after the AAC encoding\./);
  assert.doesNotMatch(hotMd, /would pass -1 dBTP/);
  // Short of the target with true peaks well under -1 dBTP: there was room,
  // so the peaks are not the reason, and both numbers are said.
  const under = at("short-under-fit");
  const low = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", under], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join(__dirname, "fixtures", "erraticaac", "ffmpeg"), MUSICFIT_TEST_STATE: at(`short-under-${process.hrtime.bigint()}`), MUSICFIT_TEST_PEAKS: "-3.9", MUSICFIT_TEST_LOUDNESS: "-15.3" } });
  assert.equal(low.status, 0, low.stderr);
  assert.match(low.stdout, /\n {2}Note {4}video\.mp4 is at -15\.3 LUFS after the AAC encoding, short of the -14 LUFS asked for, with true peaks at -3\.9 dBTP\.\n/);
  assert.doesNotMatch(low.stdout, /would pass -1 dBTP/);
  const lowMd = fs.readFileSync(path.join(under, "FIT.md"), "utf8");
  assert.match(lowMd, /the whole raised toward -14 LUFS but stopped at -15\.3 LUFS with true peaks at -3\.9 dBTP, measured after the AAC encoding\./);
  assert.doesNotMatch(lowMd, /would pass -1 dBTP/);
});

test("true peaks are the reason a loudness stopped short only at -1 dBTP or within half a dB under it", () => {
  const { heldAtCeiling } = require("../skills/musicfit/scripts/lib/report");
  for (const peak of [-1, -1.1, -1.5]) assert.equal(heldAtCeiling(peak), true, peak);
  for (const peak of [-0.9, 0.2, -1.6, -3.9, null]) assert.equal(heldAtCeiling(peak), false, peak);
});

// A fit under a film with sound effects kept, through the stand-in that reads
// the true peaks listed and the loudness each encoding really has.
function erraticKeep(name, peaks) {
  const state = at(`${name}-${process.hrtime.bigint()}`);
  const out = at(name);
  const run = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", film("film25", { sound: effects() }), "--video-sound", "keep", "--out", out], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join(__dirname, "fixtures", "erraticaac", "ffmpeg"), MUSICFIT_TEST_STATE: state, MUSICFIT_TEST_PEAKS: peaks, MUSICFIT_TEST_LOUDNESS: "real" } });
  assert.equal(run.status, 0, run.stderr);
  const readings = fs.readFileSync(`${state}.loudness`, "utf8").trim().split("\n").map(Number);
  return { c: cuesOf(out), out, run, state, readings };
}

test("with keep, a peak the encoder lifted by chance costs the first encoding's excess and half a LU at most: the sound is not turned down by what one encoding overshot", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  // The first encoding is 0.3 dB over, the next 2.7 dB, the next under -1 dBTP.
  const { c, readings } = erraticKeep("erratic-keep", "-0.7 1.7 -1.2");
  assert.equal(readings.length, 3);
  assert.ok(readings[0] - readings[2] <= 0.3 + 0.5 + 0.15, `the three encodings read ${readings.join(", ")} LUFS`);
  assert.equal(c.video.loudness.truePeak, -1.2);
  assert.equal(c.video.loudness.integrated, readings[2]);
  assert.deepEqual(c.warnings.filter((w) => /over -1 dBTP/.test(w)), []);
});

test("with keep, when no encoding comes in at -1 dBTP or under, video.mp4 keeps the first, the loudest, and a note says it is over", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const { c, out, state, readings } = erraticKeep("erratic-keep-over", "-0.7 1.7 0.9 -0.8");
  assert.equal(readings.length, 4);
  assert.equal(c.video.loudness.truePeak, -0.7);
  assert.equal(c.video.loudness.integrated, readings[0]);
  assert.deepEqual(c.warnings.filter((w) => /over -1 dBTP/.test(w)), ["After the AAC encoding the true peak of video.mp4 is -0.7 dBTP, over -1 dBTP."]);
  const kept = ffmpeg(["-i", path.join(out, "video.mp4"), "-map", "0:a", "-c", "copy", "-f", "framecrc", "pipe:1"]).stdout.split("\n").filter((l) => /^\d/.test(l));
  assert.deepEqual(kept, fs.readFileSync(`${state}.1`, "utf8").split("\n").filter((l) => /^\d/.test(l)));
});

// A film with two sound streams, as `sounds` (files) in order.
function filmSounds(name, sounds) {
  const file = at(`${name}.mp4`);
  if (!fs.existsSync(file)) ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", ...sounds.flatMap((s) => ["-i", s]), "-map", "0:v:0", ...sounds.flatMap((_, k) => ["-map", `${k + 1}:a:0`]), "-c:v", "mpeg4", "-q:v", "6", "-c:a", "aac", "-b:a", "128k", "-t", "12", file]);
  return file;
}

const silence = () => wav("silence", 12, () => {});

test("a video with more than one sound stream: sound in a later one under a silent first is refused with keep and voice too, drop goes on without it, and a run that goes on says only the first is read", () => {
  const { file } = fixture("house");
  const twoStreams = filmSounds("two-streams", [silence(), speech()]);
  // Nothing to hear in the first, a voice in the second: refused before any
  // work, as keep and voice would read only the silent first stream.
  const out = at("two-streams-fit");
  for (const how of [[], ["--video-sound", "keep"], ["--video-sound", "voice"]]) {
    const refused = cli([file, "--length", "12", "--video", twoStreams, ...how, "--out", out]);
    assert.equal(refused.status, 1, `${how}: ${refused.stderr}`);
    assert.match(refused.stderr, /musicfit: two-streams\.mp4 has 2 sound streams and musicfit reads only the first, which is silent or nearly so, while number 2 plays for \d+\.\d of its 12\.0 s: give --video a copy with that sound first, or --video-sound drop to go on without it\n$/);
    assert.ok(!fs.existsSync(out));
  }
  // Left out on purpose: no stream is read, so nothing is said of them.
  const dropped = cli([file, "--length", "12", "--video", twoStreams, "--video-sound", "drop", "--out", at("two-streams-drop")]);
  assert.equal(dropped.status, 0, dropped.stderr);
  assert.doesNotMatch(dropped.stdout, /sound streams/);
  // Sound in the first: asked as for any video, and with no sound in the
  // others none of them is refused for it.
  const firstSounds = filmSounds("first-sounds", [speech(), silence()]);
  const inFirst = cli([file, "--length", "12", "--video", firstSounds, "--out", at("first-sounds-fit")]);
  assert.equal(inFirst.status, 1);
  assert.match(inFirst.stderr, /first-sounds\.mp4 has sound of its own for \d+\.\d of its 12\.0 s, so say what becomes of it with --video-sound/);
  // The user chose: a note says what is not in video.mp4, in all three places.
  const note = "first-sounds.mp4 has 2 sound streams and only the first is read: what the others hold is not in video.mp4.";
  const kept = cli([file, "--length", "12", "--video", firstSounds, "--video-sound", "keep", "--out", out]);
  assert.equal(kept.status, 0, kept.stderr);
  assert.ok(kept.stdout.includes(`\n  Note    ${note}\n`), kept.stdout);
  assert.ok(cuesOf(out).warnings.includes(note));
  assert.ok(fs.readFileSync(path.join(out, "FIT.md"), "utf8").includes(`\n- ${note}\n`));
  // video.mp4 holds one sound stream, and its picture.
  const listed = spawnSync(FFMPEG, ["-hide_banner", "-nostdin", "-i", path.join(out, "video.mp4")], { encoding: "utf8" }).stderr;
  assert.equal(listed.match(/Stream #0:\d+.*: Audio: /g).length, 1);
  const quiet = cli([file, "--length", "12", "--video", filmSounds("all-silent", [silence(), silence()]), "--out", at("all-silent-fit")]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.match(quiet.stdout, /Note {4}all-silent\.mp4 has 2 sound streams and only the first is read/);
});

test("subtitle streams, which video.mp4 does not hold, are named in a note, whatever becomes of the video's own sound", () => {
  const { file } = fixture("house");
  const words = at("words.srt");
  fs.writeFileSync(words, "1\n00:00:01,000 --> 00:00:03,000\nHello there\n\n2\n00:00:05,000 --> 00:00:07,000\nAnd again\n");
  const subtitled = (name, streams) => {
    const made = at(`${name}.mp4`);
    if (!fs.existsSync(made)) ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", ...Array(streams).fill(["-i", words]).flat(), "-map", "0:v:0", ...Array.from({ length: streams }, (_, k) => ["-map", `${k + 1}:s:0`]).flat(), "-c:v", "mpeg4", "-q:v", "6", "-c:s", "mov_text", "-t", "12", made]);
    return made;
  };
  const one = subtitled("subtitled", 1);
  const note = "subtitled.mp4 has a subtitle stream, which is not in video.mp4.";
  for (const how of [[], ["--video-sound", "drop"]]) {
    const out = at(`subtitled-fit-${how.length}`);
    const run = cli([file, "--length", "12", "--hit", "8", "--video", one, ...how, "--out", out]);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes(`\n  Note    ${note}\n`), run.stdout);
    assert.ok(cuesOf(out).warnings.includes(note));
    assert.ok(fs.readFileSync(path.join(out, "FIT.md"), "utf8").includes(`\n- ${note}\n`));
    assert.doesNotMatch(said(path.join(out, "video.mp4")), /: Subtitle: /);
  }
  const two = cli([file, "--length", "12", "--hit", "8", "--video", subtitled("subtitled-twice", 2), "--out", at("subtitled-twice-fit")]);
  assert.equal(two.status, 0, two.stderr);
  assert.ok(two.stdout.includes("\n  Note    subtitled-twice.mp4 has 2 subtitle streams, which are not in video.mp4.\n"), two.stdout);
  // A video with none has nothing to say about them.
  assert.doesNotMatch(cli([file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", at("no-words-fit")]).stdout, /subtitle/);
});

test("the run's own files are read by their names from their own folder, so an out folder with a % in its name, which the hosted ffmpeg refuses as an input, ends well; a relative FFMPEG_PATH still finds that ffmpeg", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, async () => {
  const { file } = fixture("house");
  const repo = path.resolve(__dirname, "..");
  // There already, so the run's hidden folder is inside it.
  const out = at("yüzde 100% fit");
  fs.mkdirSync(out);
  const run = spawnSync(process.execPath, [CLI, file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", out], { cwd: repo, encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join("test", "fixtures", "nopercent", "ffmpeg") } });
  assert.equal(run.status, 0, run.stderr);
  const heard = await measureFile(path.join(out, "video.mp4"));
  assert.ok(Number.isFinite(heard.integrated), "video.mp4 has no sound");
});

// A stand-in for ffmpeg in `folder`, which runs the real one.
function standIn(folder) {
  const real = process.env.FFMPEG_PATH ? path.resolve(process.env.FFMPEG_PATH) : spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "ffmpeg"), `#!/bin/sh\nexec "${real}" "$@"\n`, { mode: 0o755 });
}

// A folder whose X/link leads to Y/real, so that X/link/../bin is Y/bin to
// the system, where the stand-in for ffmpeg is, and by its letters X/bin,
// which is not there.
function throughLink(name) {
  const root = at(name);
  fs.mkdirSync(path.join(root, "X"), { recursive: true });
  fs.mkdirSync(path.join(root, "Y", "real"), { recursive: true });
  fs.symlinkSync(path.join("..", "Y", "real"), path.join(root, "X", "link"));
  standIn(path.join(root, "Y", "bin"));
  return root;
}

test("an ffmpeg found through a relative entry of PATH is found by every call, also those that run in the out folder", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const { file } = fixture("house");
  // A folder PATH names from where musicfit starts.
  standIn(at("relative-bin"));
  const { FFMPEG_PATH, ...rest } = process.env;
  const run = spawnSync(process.execPath, [CLI, file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", at("relative-path-fit")], { cwd: dir, encoding: "utf8", env: { ...rest, PATH: `no-such-folder${path.delimiter}relative-bin` } });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fs.existsSync(at("relative-path-fit/video.mp4")));
});

test("an entry of PATH that goes through a link and up again keeps naming its folder for the calls that run in the out folder, absolute or relative", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const { file } = fixture("house");
  const root = throughLink("path-through-link");
  const { FFMPEG_PATH, ...rest } = process.env;
  for (const [kind, entry] of [["absolute", `${root}/X/link/../bin`], ["relative", "X/link/../bin"]]) {
    const out = at(`path-through-link-${kind}`);
    const run = spawnSync(process.execPath, [CLI, file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", out], { cwd: root, encoding: "utf8", env: { ...rest, PATH: entry } });
    assert.equal(run.status, 0, `${kind}: ${run.stderr}`);
    assert.ok(fs.existsSync(path.join(out, "video.mp4")), kind);
  }
});

test("off Windows a variable named path before PATH changes nothing, as the system reads only PATH", { skip: process.platform === "win32" ? "Windows has one variable for both names" : false }, () => {
  const { file } = fixture("house");
  standIn(at("lower-path-bin"));
  const { FFMPEG_PATH, PATH, ...rest } = process.env;
  const run = spawnSync(process.execPath, [CLI, file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", at("lower-path-fit")], { cwd: dir, encoding: "utf8", env: { path: "/no-such-folder", ...rest, PATH: "lower-path-bin" } });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fs.existsSync(at("lower-path-fit/video.mp4")));
});

test("a call run in another folder gets PATH with each relative entry put after the folder musicfit started in, and every absolute one as it was", { skip: process.platform === "win32" ? "this reads the POSIX rules" : false }, () => {
  const { fromHere } = require("../skills/musicfit/scripts/lib/audio");
  const here = process.cwd();
  const saved = process.env.PATH;
  try {
    process.env.PATH = `/opt/link/../bin::rel:./dot:a/link/../up:"/quoted"`;
    assert.equal(fromHere().PATH, `/opt/link/../bin:${here}:${here}/rel:${here}/dot:${here}/a/link/../up:${here}/"/quoted"`);
    delete process.env.PATH;
    assert.equal(fromHere(), process.env, "no PATH is no PATH");
  } finally {
    process.env.PATH = saved;
  }
});

test("on Windows a PATH entry in quotes is read without them, one with a ; inside them stays whole, an empty one is passed over, and the variable is found in any case", () => {
  const { fromHere } = require("../skills/musicfit/scripts/lib/audio");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const saved = process.env.PATH;
  const left = [`"C:\\Program Files\\ffmpeg\\bin"`, "D:\\tools", "", `'E:\\a;b'`, `"F:\\c;d"`, "\\\\server\\share\\bin"];
  try {
    delete process.env.PATH;
    process.env.Path = [...left, "rel", `"in quotes"`].join(";");
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    assert.equal(fromHere().Path, [...left, path.resolve("rel"), path.resolve("in quotes")].join(";"));
    delete process.env.Path;
    assert.equal(fromHere(), process.env, "no PATH is no PATH");
  } finally {
    Object.defineProperty(process, "platform", platform);
    delete process.env.Path;
    process.env.PATH = saved;
  }
});

test("FFMPEG_PATH, a track, a voice and a video named through a link and up again are found where the system finds them", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const root = throughLink("named-through-link");
  fs.copyFileSync(fixture("house").file, path.join(root, "Y", "track.wav"));
  fs.copyFileSync(speech(), path.join(root, "Y", "voice.wav"));
  fs.copyFileSync(film("mute"), path.join(root, "Y", "film.mp4"));
  const { FFMPEG_PATH, ...rest } = process.env;
  for (const [kind, up] of [["relative", "X/link/.."], ["absolute", `${root}/X/link/..`]]) {
    const out = at(`named-through-link-${kind}`);
    const run = spawnSync(process.execPath, [CLI, `${up}/track.wav`, "--length", "12", "--hit", "8", "--voice", `${up}/voice.wav`, "--video", `${up}/film.mp4`, "--out", out], { cwd: root, encoding: "utf8", env: { ...rest, FFMPEG_PATH: `${up}/bin/ffmpeg` } });
    assert.equal(run.status, 0, `${kind}: ${run.stderr}`);
    assert.ok(fs.existsSync(path.join(out, "video.mp4")), kind);
  }
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
  const stopped = (truePeak) => fitMarkdown({ ...base, voice: null, video: null, loudness: { ...base.loudness, integrated: -15.3, truePeak } }, { trackName: "house.wav" });
  assert.match(stopped(-1.2), /Loudness raised toward -14 LUFS but stopped at -15\.3 LUFS, with a limiter holding the true peaks at -1\.2 dBTP: any louder and the peaks would pass -1 dBTP\./);
  // A true peak the limiter did not hold under -1 dBTP, or one well under
  // it with room to spare, is no reason it stopped.
  for (const peak of [0.4, -6.9]) {
    assert.ok(stopped(peak).includes(`Loudness raised toward -14 LUFS but stopped at -15.3 LUFS, with a limiter holding the true peaks at ${peak} dBTP.`), String(peak));
    assert.doesNotMatch(stopped(peak), /would pass -1 dBTP/);
  }
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

test("a video or an out folder whose name holds a line of ffmpeg's words for a file it could not finish is not taken for one", { skip: process.platform === "win32" ? "Windows names take no line break" : false }, () => {
  const cwd = at("trailer-names");
  fs.mkdirSync(cwd, { recursive: true });
  const odd = "odd\nError writing trailer";
  fs.copyFileSync(film("film25", { sound: effects() }), path.join(cwd, `${odd}.mp4`));
  // The out folder is there already, so the run's own files are read in it.
  fs.mkdirSync(path.join(cwd, odd));
  const run = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", `${odd}.mp4`, "--video-sound", "keep", "--out", odd], { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(fs.readdirSync(path.join(cwd, odd)).sort(), ["FIT.md", "cues.json", "fitted.wav", "seams.png", "video.mp4"]);
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
