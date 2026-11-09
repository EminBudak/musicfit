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
const { assemble, speech, BLIP, floorOf, duck, normalize, setOver, addDipped, cameOut, setWhere, scale, attackNear } = require("./render");
const { cues: makeCues, analysisCues, fitMarkdown, analysisMarkdown, heldAtCeiling } = require("./report");
const { seamsPng } = require("./draw");
const { claim, begin, sameFile, cuesAt, record } = require("./out");
const { blocks } = require("./breathe");
const version = require("./version");

async function split(interleaved) {
  const n = interleaved.length / 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  await blocks(0, n, (from, to) => {
    for (let i = from; i < to; i++) {
      L[i] = interleaved[2 * i];
      R[i] = interleaved[2 * i + 1];
    }
  });
  return { L, R };
}

// The track's name as a folder name: its letters and digits in any script,
// lower case, the rest as dashes, at most 60 of them. Accents come off
// Latin letters only (café, şarkı); in other scripts the marks on a letter
// are part of it, like the vowel signs of Hindi, Tamil or Thai and the й of
// Russian, so names that differ only in them keep folders of their own. A
// name cut short, or one with no letter or digit at all, ends in a short
// hash of the whole name, so two such tracks never share a folder.
function slug(file) {
  const name = path.basename(file).replace(/\.[^.]+$/, "").normalize("NFC");
  const hash = crypto.createHash("sha1").update(name).digest("hex").slice(0, 6);
  const plain = (text) => text.normalize("NFKD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1");
  const words = plain(plain(name).toLowerCase())
    .normalize("NFC")
    // Anything else is a dash, with any mark on it: a mark is kept only on
    // a letter or a digit.
    .replace(/(?:[^\p{L}\p{N}\p{M}]\p{M}*)+/gu, "-")
    .replace(/^\p{M}+/u, "")
    .replace(/^-+|-+$/g, "");
  if (!words) return `track-${hash}`;
  const chars = Array.from(words);
  if (chars.length <= 60) return words;
  return `${chars.slice(0, 53).join("").replace(/-+$/, "")}-${hash}`;
}

// Where a run saves: --out, else a folder named after the track. A fit and
// an analysis keep their own folders: the analysis folder ends in
// .analysis, and since slug() never keeps a dot, no fit's folder can have
// that name, whatever its track is called.
const outDir = (track, options) => options.out || (options.analyze ? `musicfit-${slug(track)}.analysis` : `musicfit-${slug(track)}`);

const seconds = (spans) => spans.reduce((sum, [from, to]) => sum + (to - from), 0);

// A name like https://example.com/track.mp3. musicfit reads files, each by
// its full path, so an address that is no file is refused before any work.
const ADDRESS = /^[a-z][a-z0-9+.-]*:\/\//i;

// Every input is looked at before any work, and one that is not there, is
// a folder or may not be read is refused by its name. ffmpeg 8 says "Error
// opening input: Permission denied" and names the file only on the line
// after it, one of the closing lines reason() in audio.js leaves out, so
// the run could not tell the track from the voice or the video.
function files(track, options) {
  if (typeof track !== "string" || !track) throw new Error("Give one track, for example: musicfit track.mp3 --length 30");
  const inputs = [track, options.voice, options.video].filter((name) => name !== undefined && name !== null);
  for (const name of inputs) {
    if (ADDRESS.test(name) && !fs.existsSync(name)) throw new Error(`Cannot read ${name}: musicfit reads files, not addresses, so download it first`);
  }
  const denied = (err) => err.code === "EACCES" || err.code === "EPERM";
  for (const name of inputs) {
    let stat;
    try {
      stat = fs.statSync(name);
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") throw new Error(`Cannot read ${name}: no such file`);
      if (denied(err)) throw new Error(`Cannot read ${name}: permission denied`);
      throw err;
    }
    if (stat.isDirectory()) throw new Error(`Cannot read ${name}: it is a folder`);
    try {
      fs.accessSync(name, fs.constants.R_OK);
    } catch (err) {
      if (denied(err)) throw new Error(`Cannot read ${name}: permission denied`);
      throw err;
    }
  }
}

// options: { length, hit, drop, fps, voice, duck, video, videoSound, lufs,
// end, fade, bpm, meter, out, analyze, log }. Without fps, frames count at
// the video's frame rate with a video, and at 30 without one.
async function fit(track, options) {
  files(track, options);
  const dir = outDir(track, options);
  const writes = options.analyze ? ["cues.json", "seams.png", "FIT.md"] : ["fitted.wav", ...(options.voice ? ["mix.wav"] : []), ...(options.video ? ["video.mp4"] : []), "cues.json", "seams.png", "FIT.md"];
  claim(dir, writes, [track, options.voice, options.video]);
  const run = begin(dir);
  try {
    const o = { ...options, warnings: [...(options.warnings || [])] };
    // The video is read before any work, so one that cannot take this fit
    // is refused first.
    const video = o.video && !o.analyze ? await readVideo(track, o) : null;
    if (o.fps === undefined) o.fps = 30;
    const result = await make(track, o, run, video, writes);
    await run.commit();
    return { dir, ...result };
  } catch (err) {
    run.abort();
    throw run.explain(err);
  }
}

// What --video brings, read before any work: the picture, refused when it
// cannot take this fit, the rate frames count at, and what becomes of the
// video's own sound. That sound is read now when it is laid in, so a video
// with sound of its own, the shortest click included, is refused until
// --video-sound says what to do with it: musicfit cannot tell speech from
// sound effects or from music.
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
  // would play under the new one. The cues.json it came with, when it is
  // beside it, names the video it was made from.
  if (picture.made && sound !== "drop" && sound !== "none") {
    const from = madeFrom(o.video);
    throw new Error(`${picture.name} is a video musicfit made, so its own sound has a fitted track in it already: give --video the video it was made from${from ? ` (${from}, as the cues.json beside it says)` : ""}, or --video-sound drop to leave that sound out`);
  }
  const video = { picture, sound, same, own: null, spans: [] };
  if (sound === "drop" || sound === "none") return video;
  o.log && o.log(`Reading ${picture.name}'s own sound`);
  // Of several sound streams the first is read and laid in.
  if (picture.sounds > 1) o.warnings.push(`${picture.name} has ${picture.sounds} sound streams and only the first is read: what the others hold is not in video.mp4.`);
  // As long as the picture, so the sound under it is made in its place.
  const samples = Math.round(picture.seconds * RATE);
  const own = await ownSound(o.video, samples, picture.start);
  // Every sound in it that stands out, the shortest click included.
  const heard = own ? await speech(own, { shortest: 0 }) : [];
  // A sound that never goes quiet, like a music bed, plays all the way
  // through even where speech() hears no more than a steady floor.
  const playing = async (x, stands) => ((await floorOf(x)) > -40 ? o.length : seconds(stands));
  const plays = own ? await playing(own, heard) : 0;
  // Sound in a later stream, under a first with none to speak of, is the
  // video's own sound too, and would be left out: whatever --video-sound
  // says of it, keep and voice read only the first, so the run stops before
  // any work. With drop, none is read and the run never comes here.
  if (!(plays > 0)) {
    for (let k = 1; k < picture.sounds; k++) {
      let other = null;
      try {
        other = await ownSound(o.video, samples, picture.start, k);
      } catch (err) {
        // A stream ffmpeg cannot read is one musicfit cannot lay in anyway.
        if (err.stopped) throw err;
      }
      const later = other ? await playing(other, await speech(other, { shortest: 0 })) : 0;
      if (later > 0) throw new Error(`${picture.name} has ${picture.sounds} sound streams and musicfit reads only the first, which is silent or nearly so, while number ${k + 1} plays for ${later < 0.1 ? later.toFixed(2) : later.toFixed(1)} of its ${o.length.toFixed(1)} s: give --video a copy with that sound first, or --video-sound drop to go on without it`);
    }
  }
  if (!own) return { ...video, sound: "none" };
  if (sound === undefined && plays > 0) {
    throw new Error(`${picture.name} has sound of its own for ${plays < 0.1 ? plays.toFixed(2) : plays.toFixed(1)} of its ${o.length.toFixed(1)} s, so say what becomes of it with --video-sound: keep for sound effects (they stay, ${KEEP_OVER} dB louder than the music where they play, and where their peaks leave no room for that the music dips under them, ${num(o.duck)} dB at most), voice for speech (set to ${o.lufs} LUFS where it plays, and the music dips ${num(o.duck)} dB under it), or drop for music of its own (left out)`);
  }
  // Silence, or a faint room tone the music covers, is kept.
  sound = sound || "keep";
  // keep sets every sound that stands out over the music, voice dips the
  // music under the stretches long enough to be speech.
  const spans = sound === "voice" ? heard.filter(([a, b]) => b - a >= BLIP) : heard;
  if (own.over > 0.05) o.warnings.push(`${picture.name}'s own sound runs ${own.over.toFixed(2)} s past the end and was cut there.`);
  const dipped = seconds(spans);
  if (sound === "keep" && plays > 0.6 * o.length) o.warnings.push(`${picture.name}'s own sound plays for ${plays.toFixed(1)} of its ${o.length.toFixed(1)} s, along with the music. If that sound is music of its own, --video-sound drop leaves it out.`);
  if (sound === "voice" && dipped > 0.6 * o.length) o.warnings.push(`${picture.name}'s own sound plays for ${dipped.toFixed(1)} of its ${o.length.toFixed(1)} s, so the music stays dipped most of the way. If that sound is music of its own, --video-sound drop leaves it out.`);
  if (sound === "voice" && !spans.length) o.warnings.push(`No speech was found in ${picture.name}'s own sound, so the music does not dip under it, and it is not raised: it is only turned down if it is louder than ${o.lufs} LUFS.`);
  return { ...video, sound, own, spans };
}

// The video a musicfit video.mp4 was made from, as the cues.json beside it
// says, when that cues.json is musicfit's, a file of its own, and lists it.
function madeFrom(file) {
  const c = cuesAt(path.join(path.dirname(file), "cues.json"));
  const v = c && c.video;
  return v && v.file === path.basename(file) && typeof v.source === "string" && v.source ? v.source : null;
}

// A number of decibels as written: 5, 7.5.
const num = (x) => String(Math.round(x * 10) / 10);

// How much louder than the music the video's own sound is where it plays
// with --video-sound keep, in dB (LU, as the meter reads it): enough to
// hear a sound effect over the music. And how much louder than the target
// a place of it may be at most. A place is also held, with the music, under
// the true peak the whole is held to, and where that leaves it less than
// KEEP_OVER dB over the music, the music dips under that place alone by as
// much, --duck at most (setOver in render.js).
const KEEP_OVER = 3;
const KEEP_MOST = 6;

// The note for places keep set less than KEEP_OVER dB over the music: the
// first few, each by its time and how it came out. With a voice --duck also
// deepens the dip under the voice, so raising it is no advice.
function heldPlaces(name, held, count, lufs, duck, voiced) {
  const said = held.slice(0, 4).map((p) => `${p.from.toFixed(2)} s (${p.over >= 0.05 ? `${num(p.over)} dB over it` : p.over > -0.05 ? "as loud as it" : `${num(-p.over)} dB under it`})`);
  if (held.length > 4) said.push(`${held.length - 4} more`);
  const list = said.length === 1 ? said[0] : `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}`;
  const where = held.length < count ? `in ${held.length} of the ${count} places it plays` : count === 1 ? "where it plays" : count === 2 ? "in both places it plays" : `in all ${count} places it plays`;
  const dips = duck > 0 ? `the music dips under it by ${num(duck)} dB at most, as --duck says` : "the music does not dip under it, as --duck is 0";
  return `${name}'s own sound is less than ${KEEP_OVER} dB louder than the music ${where}, at ${list}: a place is set no louder than ${num(lufs + KEEP_MOST)} LUFS, ${KEEP_MOST} dB over the target, nor than keeps its true peaks, with the music's, under -1 dBTP, and ${dips}.${voiced ? "" : " A larger --duck lets the music dip further there."}`;
}

// AAC can lift a true peak over the -1 dBTP the sound was held to, and by
// another amount each time the sound is encoded. So the sound is encoded on
// its own and measured as a player decodes it, and while its true peak is
// over, it is limited again at the same loudness with the ceiling lowered
// by as much and encoded again, four times at most. An encoding that comes
// out more than half a LU quieter than the first lost loudness to that
// limiting, so the ceiling is lowered no further. Of the encodings that
// kept their loudness, the one with the lowest true peak is kept, as
// `file`. Returns its measurement.
//
// Without the limiter (keep) the whole is turned down instead, which costs
// loudness: by what the first encoding was over, then by a little more each
// round, as the next encoding can land anywhere. Going by the last encoding
// alone, a peak the encoder lifted by chance took 3 LU off a fit whose first
// encoding was 0.3 dB over. So this costs what the first encoding was over
// and half a LU more at most, and the first encoding at -1 dBTP or under is
// kept, else the first of all, which a note says is over.
const NUDGE = 0.2;
async function aac(sound, file, lufs, { limit = true } = {}) {
  let ceiling = -1;
  let best = null;
  let first = null;
  for (let round = 0; round < 4; round++) {
    if (round && limit) await normalize(sound, { lufs, peak: ceiling });
    else if (round) await scale(sound, 10 ** (-(round === 1 ? first.truePeak + 1 + 0.1 : NUDGE) / 20));
    const at = `${file}.${round}.m4a`;
    await encodeAac(sound, at);
    const m = await measureFile(at);
    first = first || m;
    const kept = !limit || !(m.integrated < first.integrated - 0.5);
    if (!best || (limit ? kept && m.truePeak < best.m.truePeak : m.truePeak <= -1)) best = { at, m };
    if (!kept || !(m.truePeak > -1)) break;
    ceiling -= m.truePeak + 1 + 0.1;
  }
  fs.renameSync(best.at, file);
  return best.m;
}

// Sets a sound to `lufs` with one gain, or as near as keeps its true peak
// at -1 dBTP: the limiter takes nothing off it.
async function setLevel(audio, lufs) {
  const was = await measure(audio);
  if (!Number.isFinite(was.integrated)) return;
  await scale(audio, 10 ** (Math.min(lufs - was.integrated, -1 - was.truePeak) / 20));
}

// The note for the earlier run's files that a run which ends well removes,
// as it does not write them again: a fit's sound or video, when an
// analysis, or a fit without a voice or a video, is given its folder.
function removedNote(names, dir) {
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const none = names.length === 1 ? "does not write one" : names.length === 2 ? "writes neither" : "writes none of them";
  return `This run removed the earlier fit's ${list} from ${dir}, as it ${none}.`;
}

// The run's work, its files written with run.file(name). A long fit holds a
// few arrays of samples as long as it, so each is let go, or written and
// let go, as soon as it has served. `writes` are the names it writes, so
// the reports can name the earlier run's files it removes.
async function make(track, options, run, video, writes) {
  // Looked at once the work is done, just before the reports are written.
  const removes = () => {
    const gone = run.removes(writes);
    if (gone.length) options.warnings.push(removedNote(gone, run.dir));
  };
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
    removes();
    const c = analysisCues({ version, track: trackName, analysis: a, options });
    fs.writeFileSync(run.file("FIT.md"), analysisMarkdown(c, { trackName }));
    fs.writeFileSync(run.file("seams.png"), await seamsPng({ cues: { ...c, segments: [] }, source, fitted: null, rate: RATE, analysis: a }));
    await record(run, c);
    return { cues: c, analysis: a };
  }

  if (options.hit !== undefined && options.hit > options.length) throw new Error(`--hit ${options.hit} is past the end (--length ${options.length})`);
  const p = plan(a, { length: options.length, hit: options.hit, end: options.end, fade: options.fade });
  log(`Plan: ${p.segments.length} ${p.segments.length === 1 ? "part" : "parts"}, ${p.seams.length} ${p.seams.length === 1 ? "seam" : "seams"}`);
  const r = await assemble(source, p, a, { length: options.length, fade: options.fade });
  const music = { L: r.L, R: r.R };
  const n = music.L.length;
  const loudness = await normalize(music, { lufs: options.lufs });

  let spoken = null;
  let spans = [];
  let voiced = 0;
  if (options.voice) {
    log(`Ducking under ${path.basename(options.voice)}`);
    // The voice that is the video's own sound is read on its timeline.
    let v = await split(await decode(options.voice, { rate: RATE, channels: 2, from: video && video.same === "voice" ? video.picture.start : null }));
    spoken = { L: new Float32Array(n), R: new Float32Array(n) };
    spoken.L.set(v.L.subarray(0, n));
    spoken.R.set(v.R.subarray(0, n));
    voiced = v.L.length;
    v = null;
    spans = await speech(spoken);
  }
  // The music dips --duck dB under the voice, and under the video's own
  // sound with --video-sound voice. With keep it does not dip: that sound
  // is set over it instead, below, so the drop keeps its weight.
  const depth = video && video.sound === "voice" ? options.duck : null;
  const dips = [...spans, ...(depth === null ? [] : video.spans.map(([from, to]) => [from, to, depth]))];
  if (options.voice || dips.length) await duck(music, dips, options.duck);

  let voice = null;
  if (options.voice) {
    await normalize(spoken, { lufs: options.lufs });
    let mix = { L: new Float32Array(n), R: new Float32Array(n) };
    await blocks(0, n, (from, to) => {
      for (let i = from; i < to; i++) {
        mix.L[i] = music.L[i] + spoken.L[i];
        mix.R[i] = music.R[i] + spoken.R[i];
      }
    });
    voice = { file: path.basename(options.voice), duck: options.duck, spans, loudness: await normalize(mix, { lufs: options.lufs }) };
    await encodeWav(mix, run.file("mix.wav"));
    mix = null;
    if (voiced > n + RATE * 0.05) options.warnings.push(`The voice runs ${(voiced / RATE - options.length).toFixed(2)} s past the end and was cut there.`);
    if (!spans.length) options.warnings.push("No speech was found in the voice track, so the music was not ducked.");
  }
  // The music now dips, so as a whole it reads off the target: quieter,
  // or louder when the meter's gate leaves the dipped stretches out.
  if (options.voice || dips.length) loudness.after = await measure(music);

  let laid = null;
  if (video) {
    const { picture } = video;
    log(`Laying it under ${picture.name}`);
    // What plays under the picture, cut or padded to it: the music as it
    // dips, the voice, and the video's own sound. With voice, that sound is
    // set to the target where it plays, as a voice is, and the music dips
    // under it. With keep, each place it plays is set KEEP_OVER dB louder
    // than the music there, between the target and KEEP_MOST dB over it,
    // and no louder than keeps its true peaks, with the music's, under the
    // ceiling, raising quiet sound effects and turning loud ones down; where
    // that leaves a place short of KEEP_OVER dB over the music, the music
    // dips under it alone by as much, --duck at most (setOver in
    // render.js), and elsewhere plays on at its level. A sound with nothing
    // in it that stands out, a faint room tone, is only turned down, to the
    // target when it is louder, so it stays faint against the music. Then
    // the whole is set to the target, which moves them all by the same
    // amount. The video's own sound, read as long as the picture, is where
    // the rest is added in.
    const total = Math.round(picture.seconds * RATE);
    let under = video.own;
    video.own = null;
    let places = null;
    if (under) {
      if (video.sound === "keep" && video.spans.length) places = await setOver(under, music, video.spans, { lufs: options.lufs, over: KEEP_OVER, most: KEEP_MOST, duck: options.duck, also: spoken });
      else if (video.spans.length) await setWhere(under, video.spans, options.lufs);
      else {
        const level = await measure(under);
        if (level.integrated > options.lufs) await scale(under, 10 ** ((options.lufs - level.integrated) / 20));
      }
    } else under = { L: new Float32Array(total), R: new Float32Array(total) };
    const add = (x) =>
      blocks(0, Math.min(total, x.L.length), (from, to) => {
        for (let i = from; i < to; i++) {
          under.L[i] += x.L[i];
          under.R[i] += x.R[i];
        }
      });
    if (places) await addDipped(under, music, places);
    else await add(music);
    // With keep the places and the music are held under the ceiling as they
    // are set, so the whole is set without the limiter, which would take
    // the music down around them; where the music dips under them it can
    // read a little under the target. A voice stands at the ceiling by
    // itself, so with one the sum passes it wherever a place meets the
    // voice, and only the limiter can hold that without turning all the
    // rest down.
    const limited = !places || Boolean(spoken);
    if (spoken) await add(spoken);
    spoken = null;
    if (limited) await normalize(under, { lufs: options.lufs });
    else await setLevel(under, options.lufs);
    if (places) await cameOut(places, under, music);
    const m4a = run.scratch("sound.m4a");
    const level = await aac(under, m4a, options.lufs, { limit: limited });
    under = null;
    await mux(options.video, m4a, run.file("video.mp4"), { picture: picture.picture, comment: mark(version), start: picture.start });
    laid = { ...picture, sound: video.sound, same: video.same, duck: depth, over: places ? KEEP_OVER : null, spans: video.spans, places, loudness: level };
    // The places keep could not set KEEP_OVER dB over the music, said as
    // they came out.
    const held = (places || []).filter((p) => p.over !== null && Math.round(p.over * 10) / 10 < KEEP_OVER - 0.5);
    if (held.length) options.warnings.push(heldPlaces(picture.name, held, places.length, options.lufs, options.duck, Boolean(options.voice)));
    if (level.truePeak > -1) options.warnings.push(`After the AAC encoding the true peak of video.mp4 is ${level.truePeak.toFixed(1)} dBTP, over -1 dBTP.`);
    // Short of the target: for its true peaks only when they stand at
    // -1 dBTP or just under it; else both numbers, and no reason.
    if (Number.isFinite(level.integrated) && level.integrated < options.lufs - 0.5) options.warnings.push(`video.mp4 is at ${level.integrated.toFixed(1)} LUFS after the AAC encoding, short of the ${options.lufs} LUFS asked for${heldAtCeiling(level.truePeak) ? ": any louder and its true peaks would pass -1 dBTP" : `, with true peaks at ${level.truePeak.toFixed(1)} dBTP`}.`);
  }

  await encodeWav(music, run.file("fitted.wav"));
  removes();
  const c = makeCues({ version, track: trackName, analysis: a, plan: p, result: r, options, loudness, voice, video: laid });
  fs.writeFileSync(run.file("FIT.md"), fitMarkdown(c, { trackName }));
  fs.writeFileSync(run.file("seams.png"), await seamsPng({ cues: c, source, fitted: music, rate: RATE, analysis: a }));
  await record(run, c);
  return { cues: c, analysis: a, plan: p };
}

module.exports = { fit, files, slug, outDir };
