"use strict";

// The whole run: decode, analyse, plan, assemble, duck, set the loudness,
// and write fitted.wav (and mix.wav, and with a video video.mp4), cues.json,
// seams.png and FIT.md, in a hidden folder that takes the place of the
// earlier files only once the run has ended well (see out.js).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { RATE, decode, encodeWav, measure, measureFile } = require("./audio");
const { probe, fits, ownSound, encodeAac, mux, mark, fpsText } = require("./video");
const { RATE: ANALYSIS_RATE } = require("./analyze");
const { analyzeInThread } = require("./thread");
const { plan } = require("./plan");
const { assemble, speech, floorOf, duck, normalize, interleave, scale, attackNear } = require("./render");
const { cues: makeCues, analysisCues, fitMarkdown, analysisMarkdown } = require("./report");
const { seamsPng } = require("./draw");
const { claim, begin, sameFile } = require("./out");
const version = require("./version");

function split(interleaved) {
  const n = interleaved.length / 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = interleaved[2 * i];
    R[i] = interleaved[2 * i + 1];
  }
  return { L, R };
}

// The track's name as a folder name: its letters and digits in any script,
// lower case and without accents, the rest as dashes, at most 60 of them.
// A name with no letter or digit at all gets a short hash of itself, so two
// such tracks still get folders of their own.
function slug(file) {
  const name = path.basename(file).replace(/\.[^.]+$/, "");
  const plain = (text) => text.normalize("NFKD").replace(/\p{M}+/gu, "");
  const words = plain(plain(name).toLowerCase())
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (!words) return `track-${crypto.createHash("sha1").update(name).digest("hex").slice(0, 6)}`;
  return Array.from(words).slice(0, 60).join("").replace(/-+$/, "");
}

const seconds = (spans) => spans.reduce((sum, [from, to]) => sum + (to - from), 0);

// options: { length, hit, drop, fps, voice, duck, video, videoSound, lufs,
// end, fade, bpm, meter, out, analyze, log }. Without fps, frames count at
// the video's frame rate with a video, and at 30 without one.
async function fit(track, options) {
  // A fit and an analysis of the same track keep their own folders.
  const dir = options.out || (options.analyze ? `musicfit-analysis-${slug(track)}` : `musicfit-${slug(track)}`);
  if (options.voice && !fs.existsSync(options.voice)) throw new Error(`Cannot read ${options.voice}: no such file`);
  if (options.video && !fs.existsSync(options.video)) throw new Error(`Cannot read ${options.video}: no such file`);
  const writes = options.analyze ? ["cues.json", "seams.png", "FIT.md"] : ["fitted.wav", ...(options.voice ? ["mix.wav"] : []), ...(options.video ? ["video.mp4"] : []), "cues.json", "seams.png", "FIT.md"];
  claim(dir, writes, [track, options.voice, options.video]);
  const run = begin(dir);
  try {
    const o = { ...options, warnings: [...(options.warnings || [])] };
    // The video is read before any work, so one that cannot take this fit
    // is refused first.
    const video = o.video && !o.analyze ? await readVideo(track, o) : null;
    if (o.fps === undefined) o.fps = 30;
    const result = await make(track, o, run, video);
    await run.commit();
    return { dir, ...result };
  } catch (err) {
    run.abort();
    throw err;
  }
}

// What --video brings, read before any work: the picture, refused when it
// cannot take this fit, the rate frames count at, and what becomes of the
// video's own sound. That sound is read now when it is laid in, so a video
// with sound of its own is refused until --video-sound says what to do
// with it: musicfit cannot tell speech from sound effects or from music.
async function readVideo(track, o) {
  const picture = await probe(o.video);
  const adopted = o.fps === undefined;
  if (adopted) o.fps = Number(picture.fps.toFixed(3));
  fits(picture, o.length, o.fps);
  if (adopted && !picture.constant) o.warnings.push(`${picture.name} has no steady frame rate, so the frames in cues.json count at its average, ${fpsText(o.fps)} fps.`);
  if (!adopted && Math.abs(picture.fps - o.fps) > picture.fps * 0.0005) o.warnings.push(`${picture.name} runs at ${fpsText(picture.fps)} fps and --fps is ${fpsText(o.fps)}, so the frames in cues.json are not the video's: leave --fps out, or give --fps ${fpsText(picture.fps)}, to count them as the video does.`);

  // The same sound is never laid in twice: when the video itself is given
  // as the track, or as the voice, its own sound is left out and the track
  // or the voice plays in its place.
  let sound = picture.sound ? o.videoSound : "none";
  let same = null;
  if (picture.sound && sameFile(track, o.video)) same = "track";
  else if (picture.sound && o.voice && sameFile(o.voice, o.video)) same = "voice";
  if (same) {
    sound = "drop";
    o.warnings.push(same === "track" ? `${picture.name}'s own sound is the track, so it is not laid in a second time.` : `${picture.name}'s own sound is the voice given with --voice, so it is laid in once, as the voice.`);
  }
  // A video musicfit made has a fitted track in its sound already, which
  // would play under the new one.
  if (picture.made && sound !== "drop" && sound !== "none") throw new Error(`${picture.name} is a video musicfit made, so its own sound has a fitted track in it already: give --video the video it was made from, or --video-sound drop to leave that sound out`);
  const video = { picture, sound, same, own: null, spans: [] };
  if (sound === "drop" || sound === "none") return video;
  o.log && o.log(`Reading ${picture.name}'s own sound`);
  const own = await ownSound(o.video, Math.round(o.length * RATE));
  if (!own) return { ...video, sound: "none" };
  const spans = speech(own);
  // A sound that never goes quiet, like a music bed, plays all the way
  // through even where speech() hears no more than a steady floor.
  const plays = floorOf(own) > -40 ? o.length : seconds(spans);
  if (sound === undefined && plays > 0) {
    throw new Error(`${picture.name} has sound of its own for ${plays.toFixed(1)} of its ${o.length.toFixed(1)} s, so say what becomes of it with --video-sound: keep for sound effects (they stay at their level, the music dips ${num(o.duck / 2)} dB under them), voice for speech (set to ${o.lufs} LUFS, the music dips ${num(o.duck)} dB under it), or drop for music of its own (left out)`);
  }
  // Silence, or a faint room tone the music covers, stays as it is.
  sound = sound || "keep";
  if (own.over > 0.05) o.warnings.push(`${picture.name}'s own sound runs ${own.over.toFixed(2)} s past the end and was cut there.`);
  const dipped = seconds(spans);
  if (sound === "keep" && plays > 0.6 * o.length) o.warnings.push(`${picture.name}'s own sound plays for ${plays.toFixed(1)} of its ${o.length.toFixed(1)} s, ${dipped > 0.6 * o.length ? `so the music stays ${num(o.duck / 2)} dB down most of the way` : "along with the music"}. If that sound is music of its own, --video-sound drop leaves it out.`);
  if (sound === "voice" && dipped > 0.6 * o.length) o.warnings.push(`${picture.name}'s own sound plays for ${dipped.toFixed(1)} of its ${o.length.toFixed(1)} s, so the music stays dipped most of the way. If that sound is music of its own, --video-sound drop leaves it out.`);
  if (sound === "voice" && !spans.length) o.warnings.push(`No speech was found in ${picture.name}'s own sound, so the music was not dipped.`);
  return { ...video, sound, own, spans };
}

// A number of decibels as written: 5, 7.5.
const num = (x) => String(Math.round(x * 10) / 10);

// AAC can lift a true peak over the -1 dBTP the sound was held to. So the
// sound is encoded on its own and measured as a player decodes it, and
// while its true peak is over, it is limited again at the same loudness
// with the ceiling lowered by as much and encoded again, four times at
// most. Returns the last measurement.
async function aac(sound, file, lufs) {
  let ceiling = -1;
  let m;
  for (let round = 0; round < 4; round++) {
    if (round) await normalize(sound, { lufs, peak: ceiling });
    await encodeAac(interleave(sound), file);
    m = await measureFile(file);
    if (!(m.truePeak > -1)) break;
    ceiling -= m.truePeak + 1 + 0.1;
  }
  return m;
}

// The run's work, its files written with run.file(name).
async function make(track, options, run, video) {
  const log = options.log || (() => {});
  const trackName = path.basename(track);
  log(`Reading ${trackName}`);
  // The interleaved copy is let go as soon as it is split.
  const [source, mono] = await Promise.all([decode(track, { rate: RATE, channels: 2 }).then(split), decode(track, { rate: ANALYSIS_RATE, channels: 1 })]);
  const a = await analyzeInThread(mono, { bpm: options.bpm, meter: options.meter, drop: options.drop });
  // A drop found on a bar line moves onto the start of its hit.
  if (a.drop && !a.drop.given && a.mode !== "energy") {
    const at = attackNear(source, a.drop.time);
    a.drop.offset += at - a.drop.time;
    a.drop.time = at;
  }
  if (a.tempo && a.mode !== "energy") log(`${a.tempo.bpm.toFixed(1)} BPM, ${a.meter} beats to a bar, ${a.bars.length} bars`);
  else log("No steady beat");

  if (options.analyze) {
    const c = analysisCues({ version, track: trackName, analysis: a, options });
    fs.writeFileSync(run.file("cues.json"), JSON.stringify(c, null, 2) + "\n");
    fs.writeFileSync(run.file("FIT.md"), analysisMarkdown(c, { trackName }));
    fs.writeFileSync(run.file("seams.png"), seamsPng({ cues: { ...c, segments: [] }, source, fitted: null, rate: RATE, analysis: a }));
    return { cues: c, analysis: a };
  }

  if (options.hit !== undefined && options.hit > options.length) throw new Error(`--hit ${options.hit} is past the end (--length ${options.length})`);
  const p = plan(a, { length: options.length, hit: options.hit, end: options.end, fade: options.fade });
  log(`Plan: ${p.segments.length} ${p.segments.length === 1 ? "part" : "parts"}, ${p.seams.length} ${p.seams.length === 1 ? "seam" : "seams"}`);
  const r = assemble(source, p, a, { length: options.length, fade: options.fade });
  const music = { L: r.L, R: r.R };
  const n = music.L.length;
  const loudness = await normalize(music, { lufs: options.lufs });

  let spoken = null;
  let spans = [];
  let v = null;
  if (options.voice) {
    log(`Ducking under ${path.basename(options.voice)}`);
    // The voice that is the video's own sound is read on its timeline.
    v = split(await decode(options.voice, { rate: RATE, channels: 2, timeline: Boolean(video && video.same === "voice") }));
    spoken = { L: new Float32Array(n), R: new Float32Array(n) };
    spoken.L.set(v.L.subarray(0, n));
    spoken.R.set(v.R.subarray(0, n));
    spans = speech(spoken);
  }
  // The music dips --duck dB under the voice and under the video's own
  // sound with --video-sound voice, and half as far under that sound with
  // keep, so sound effects stay clear over it. Where two of them sound at
  // once it dips as far as under the deeper one.
  const depth = video && video.sound === "voice" ? options.duck : video && video.sound === "keep" ? options.duck / 2 : null;
  const dips = [...spans, ...(depth === null ? [] : video.spans.map(([from, to]) => [from, to, depth]))];
  if (options.voice || dips.length) duck(music, dips, options.duck);

  let voice = null;
  let mix = null;
  if (options.voice) {
    await normalize(spoken, { lufs: options.lufs });
    mix = { L: new Float32Array(n), R: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
      mix.L[i] = music.L[i] + spoken.L[i];
      mix.R[i] = music.R[i] + spoken.R[i];
    }
    voice = { file: path.basename(options.voice), duck: options.duck, spans, loudness: await normalize(mix, { lufs: options.lufs }) };
    if (v.L.length > n + RATE * 0.05) options.warnings.push(`The voice runs ${(v.L.length / RATE - options.length).toFixed(2)} s past the end and was cut there.`);
    if (!spans.length) options.warnings.push("No speech was found in the voice track, so the music was not ducked.");
  }
  // The music now dips, so it reads quieter as a whole.
  if (options.voice || dips.length) loudness.after = await measure(interleave(music));

  let laid = null;
  if (video) {
    const { picture, own } = video;
    log(`Laying it under ${picture.name}`);
    // What plays under the picture, cut or padded to it: the music as it
    // dips, the voice, and the video's own sound. With keep that sound
    // stays at its own level, only lowered when it is louder than the
    // target, so a faint room tone is never raised; with voice it is set
    // to the target like a voice.
    const total = Math.round(picture.seconds * RATE);
    const under = { L: new Float32Array(total), R: new Float32Array(total) };
    const add = (x) => {
      for (let i = 0; i < Math.min(total, x.L.length); i++) {
        under.L[i] += x.L[i];
        under.R[i] += x.R[i];
      }
    };
    add(music);
    if (spoken) add(spoken);
    if (own) {
      if (video.sound === "voice" && video.spans.length) await normalize(own, { lufs: options.lufs });
      else {
        const level = await measure(interleave(own));
        if (level.integrated > options.lufs) scale(own, 10 ** ((options.lufs - level.integrated) / 20));
      }
      add(own);
    }
    await normalize(under, { lufs: options.lufs });
    const m4a = run.scratch("sound.m4a");
    const level = await aac(under, m4a, options.lufs);
    await mux(options.video, m4a, run.file("video.mp4"), { picture: picture.picture, comment: mark(version) });
    laid = { ...picture, sound: video.sound, same: video.same, duck: depth, spans: video.spans, loudness: level };
    if (level.truePeak > -1) options.warnings.push(`After the AAC encoding the true peak of video.mp4 is ${level.truePeak.toFixed(1)} dBTP, over -1 dBTP.`);
  }

  await encodeWav(interleave(music), run.file("fitted.wav"));
  if (mix) await encodeWav(interleave(mix), run.file("mix.wav"));
  const c = makeCues({ version, track: trackName, analysis: a, plan: p, result: r, options, loudness, voice, video: laid });
  fs.writeFileSync(run.file("cues.json"), JSON.stringify(c, null, 2) + "\n");
  fs.writeFileSync(run.file("FIT.md"), fitMarkdown(c, { trackName }));
  fs.writeFileSync(run.file("seams.png"), seamsPng({ cues: c, source, fitted: music, rate: RATE, analysis: a }));
  return { cues: c, analysis: a, plan: p };
}

module.exports = { fit, slug };
