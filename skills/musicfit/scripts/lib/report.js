"use strict";

// cues.json for tools (every time also as a frame number at --fps) and
// FIT.md for people and coding agents: what was done and where to listen.

const r3 = (x) => Math.round(x * 1000) / 1000;

// Frames from the time as written (to the millisecond), so a reader who
// multiplies a cue's time by the frame rate gets its frame.
function framer(fps) {
  return (t) => Math.round(r3(t) * fps);
}

// beats, bars and hits as whole frames at the frame rate, ascending and
// without repeats, and the same moments in seconds. This is the shape
// launch-film's check reads: { fps, beats, bars, hits, frames, bpm }.
function grid(frame, { beats, bars, hits }) {
  const frames = (times) => [...new Set(times.map(frame))].sort((x, y) => x - y);
  const seconds = (times) => [...new Set(times.map(r3))].sort((x, y) => x - y);
  return { frames: { beats: frames(beats), bars: frames(bars), hits: frames(hits) }, times: { beats: seconds(beats), bars: seconds(bars), hits: seconds(hits) } };
}

// What the fitted file holds, on its own timeline.
function cues({ version, track, analysis: a, plan: p, result: r, options, loudness, voice, video = null }) {
  const frame = framer(options.fps);
  const length = options.length;
  const downbeats = r.beats.filter((b) => b.downbeat).map((b) => b.time);
  // The first segment plays from the top: when its first bar comes later,
  // what comes before that bar in the track plays first. When even the
  // top of the track comes later, the file is silent until it does.
  const segments = r.segments.map((s, i) => {
    const from = i === 0 ? Math.max(0, -r.startSource) : s.outStart;
    return {
      from: r3(from),
      to: r3(Math.min(length, s.outEnd)),
      fromFrame: frame(from),
      toFrame: frame(Math.min(length, s.outEnd)),
      source: [r3(i === 0 ? Math.max(0, r.startSource) : s.srcStart), r3(s.srcEnd)],
      sourceBars: a.mode === "energy" ? null : [s.firstBar + 1, s.lastBar + 1],
    };
  });
  const seams = r.seams.map((s, i) => ({
    time: r3(s.out),
    frame: frame(s.out),
    kind: s.kind,
    bars: a.mode === "energy" ? null : s.bars,
    seconds: r3(Math.abs(s.to - s.from)),
    source: { from: r3(s.from), to: r3(s.to) },
    crossfade: [r3(s.crossfade[0]), r3(s.crossfade[1])],
    likeness: Math.round(s.likeness * 100) / 100,
    ending: p.tail.kind === "natural" && i === r.seams.length - 1 && r.segments[i + 1].firstBar === a.ending.bar,
  }));
  // Where the section starts of the track play in the fitted file.
  const sections = [];
  if (a.mode !== "energy") {
    for (const index of a.sections) {
      for (const s of r.segments) {
        if (index < s.firstBar || index > s.lastBar) continue;
        const t = s.outStart + (a.bars[index].start - s.srcStart);
        if (t >= 0 && t < length) sections.push({ time: r3(t), frame: frame(t), sourceBar: index + 1, drop: !!(a.drop && a.drop.bar === index) });
      }
    }
    sections.sort((x, y) => x.time - y.time);
  }
  const start = startKind(a, p, r);
  const end = { kind: p.tail.kind, time: r3(r.musicEnd), frame: frame(r.musicEnd), finalHit: null, fade: null };
  if (p.tail.kind === "natural") {
    const s = r.segments[r.segments.length - 1];
    const t = s.outStart + (a.ending.hit - s.srcStart);
    end.finalHit = { time: r3(t), frame: frame(t) };
  }
  if (r.fadeOut && !r.fadeOut.quiet) {
    end.fade = { from: r3(r.fadeOut.from), to: r3(r.fadeOut.to), fromFrame: frame(r.fadeOut.from), toFrame: frame(r.fadeOut.to) };
    // A fade ends on a beat unless a hit late in the file rings to its end.
    end.fade.onBeat = r.beats.some((b) => Math.abs(b.time - r.fadeOut.to) < 0.002);
  }
  // The accents an edit lands on: the drop where it was put, and the
  // track's own last hit when it ends on it.
  const hits = [];
  if (p.hit) hits.push(p.hit.out);
  if (end.finalHit) hits.push(end.finalHit.time);
  const { frames, times } = grid(frame, { beats: r.beats.map((b) => b.time), bars: downbeats, hits });

  return {
    musicfit: version,
    track,
    file: "fitted.wav",
    mix: voice ? "mix.wav" : null,
    fps: options.fps,
    frames: frame(length),
    bpm: a.tempo && a.mode !== "energy" ? Math.round(a.tempo.bpm * 100) / 100 : null,
    beats: frames.beats,
    bars: frames.bars,
    hits: frames.hits,
    times: { length: r3(length), ...times },
    length: r3(length),
    sampleRate: 48000,
    mode: a.mode,
    tempo: a.tempo && a.mode !== "energy" ? tempoOf(a) : null,
    confidence: confidenceOf(a),
    drop: p.hit
      ? { time: r3(p.hit.out), frame: frame(p.hit.out), source: r3(p.hit.src), sourceBar: a.mode === "energy" ? null : p.hit.bar + 1, found: a.drop.given ? "given" : a.drop.clear ? "drop" : "change" }
      : null,
    start: { ...start, firstBar: downbeats.length ? { time: r3(downbeats[0]), frame: frame(downbeats[0]) } : null, fadeIn: r3(r.fadeIn) },
    end,
    sections,
    segments,
    seams,
    voice: voice ? { file: voice.file, duck: voice.duck, spans: voice.spans.map(([f, t]) => ({ from: r3(f), to: r3(t), fromFrame: frame(f), toFrame: frame(t) })) } : null,
    // With --video: video.mp4, the video's picture with this sound under
    // it. sound is what became of the video's own sound: keep (each place
    // it plays set `over` dB louder than the music there, the music dipping
    // under a place only where its peaks leave no room for that; see setOver
    // in render.js for the limits), voice (set to the target where it
    // plays, the music dipping `duck` dB under its speech), drop (left out)
    // or none (it had none). With keep or voice and no spans it was only
    // turned down to the target, when it was louder. same says when the
    // video was the track or the voice, which play in its place; spans are
    // where it plays, each with keep saying how far over the music it came
    // out (null where no music plays) and how far the music dips under it
    // in video.mp4 (`dip`), both null with voice.
    video: video
      ? {
          file: "video.mp4",
          source: video.name,
          length: r3(video.seconds),
          fps: Math.round(video.fps * 1000) / 1000,
          frames: video.frames,
          steady: video.constant,
          picture: video.picture,
          sound: video.sound,
          same: video.same,
          duck: video.sound === "voice" ? video.duck : null,
          over: video.over === undefined ? null : video.over,
          spans: video.spans.map(([f, t], i) => ({ from: r3(f), to: r3(t), fromFrame: frame(f), toFrame: frame(t), over: video.places ? round1(video.places[i].over) : null, dip: video.places ? round1(video.places[i].dip) : null })),
          loudness: { target: options.lufs, integrated: round1(video.loudness.integrated), truePeak: round1(video.loudness.truePeak) },
        }
      : null,
    loudness: loudness
      ? { target: options.lufs, integrated: round1(loudness.after.integrated), truePeak: round1(loudness.after.truePeak), range: round1(loudness.after.range), limited: loudness.limited, mix: voice && voice.loudness ? { integrated: round1(voice.loudness.after.integrated), truePeak: round1(voice.loudness.after.truePeak) } : null }
      : null,
    source: sourceOf(a),
    warnings: [...a.warnings, ...p.warnings, ...(options.warnings || [])],
  };
}

// The track as it is, on its own timeline: for --analyze.
function analysisCues({ version, track, analysis: a, options }) {
  const frame = framer(options.fps);
  const phase = a.downbeatPhase || 0;
  const beats = (a.beats || []).filter((t) => t >= 0);
  const bars = a.mode === "energy" ? [] : (a.beats || []).filter((t, i) => i >= phase && (i - phase) % a.meter === 0 && t >= 0);
  const hits = [];
  if (a.drop) hits.push(a.drop.time);
  if (a.ending && a.ending.kind === "hit") hits.push(a.ending.hit);
  const { frames, times } = grid(frame, { beats, bars, hits });
  return {
    musicfit: version,
    track,
    fps: options.fps,
    frames: frame(a.duration),
    bpm: a.tempo && a.mode !== "energy" ? Math.round(a.tempo.bpm * 100) / 100 : null,
    beats: frames.beats,
    bars: frames.bars,
    hits: frames.hits,
    times: { length: r3(a.duration), ...times },
    length: r3(a.duration),
    mode: "analysis",
    cuts: a.mode,
    tempo: a.tempo && a.mode !== "energy" ? tempoOf(a) : null,
    confidence: confidenceOf(a),
    sections: a.mode === "energy" ? [] : a.sections.map((i) => ({ time: r3(Math.max(0, a.bars[i].start)), frame: frame(Math.max(0, a.bars[i].start)), bar: i + 1 })),
    source: sourceOf(a),
    warnings: [...a.warnings, ...(options.warnings || [])],
  };
}

function tempoOf(a) {
  return {
    bpm: Math.round(a.tempo.bpm * 100) / 100,
    meter: a.meter,
    beat: r3(a.tempo.beat),
    bar: r3(a.tempo.bar),
    steady: a.tempo.steady,
    alternatives: a.tempo.alternatives.filter((x) => x.likelihood >= 0.05).map((x) => ({ bpm: Math.round(x.bpm * 100) / 100, relation: x.relation, likelihood: Math.round(x.likelihood * 100) / 100 })),
  };
}

function confidenceOf(a) {
  const c = a.confidence || { beat: 0, octave: 0, downbeat: 0 };
  return { beat: Math.round(c.beat * 100) / 100, tempo: Math.round(c.octave * 100) / 100, downbeat: Math.round(c.downbeat * 100) / 100 };
}

function sourceOf(a) {
  return {
    duration: r3(a.duration),
    drop: a.drop ? r3(a.drop.time) : null,
    dropBar: a.drop && a.mode !== "energy" ? a.drop.bar + 1 : null,
    dropCandidates: a.drop ? a.drop.candidates.map((c) => r3(c.time)) : [],
    ending: a.ending ? a.ending.kind : "none",
    finalHit: a.ending && a.ending.kind === "hit" ? r3(a.ending.hit) : null,
    sections: a.mode === "energy" ? [] : (a.sections || []).map((i) => r3(Math.max(0, a.bars[i].start))),
  };
}

const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

// Whether true peaks are why a loudness stopped short of its target: they
// stand at the -1 dBTP it is held to, or within half a dB under it. Further
// under, there was room for more, and over it they were not held at all.
const heldAtCeiling = (truePeak) => truePeak !== null && truePeak <= -1 && truePeak >= -1.5;

// How the fitted file opens: on its first bar at the top (top), as the
// track does, or later in the track (later), as a fit too short for the
// track's opening and its ending both can, on its first bar or just before
// it; after silence or the track's own lead in (silence, pickup); with the
// end of the bar before fading in, to land a hit (swell); or part way into a
// bar (mid-bar).
function startKind(a, p, r) {
  const head = r.head;
  const first = p.segments[0].firstBar;
  if (head < -0.005) return { kind: "mid-bar", music: 0 };
  if (head <= 0.005) return { kind: r.startSource > a.start.audible + 0.02 ? "later" : "top", music: 0 };
  if (first === a.start.firstBar) {
    if (a.start.pickup > 0.05) return { kind: "pickup", music: r3(Math.max(0, head - a.start.pickup)) };
    return { kind: "silence", music: r3(head) };
  }
  // Only a hit moves the first bar for a reason of its own. Without one a
  // later first bar is a fit too short for the track's opening.
  return { kind: p.hit ? "swell" : "later", music: 0 };
}

// ─── FIT.md ────────────────────────────────────────────────────────────────

const sec = (t) => `${t.toFixed(2)} s`;

function fitMarkdown(c, { trackName }) {
  const lines = [];
  lines.push(`# ${trackName} fitted to ${sec(c.length)}`, "");
  // The music dips under a voice, or under the video's own sound.
  const dips = Boolean(c.video && c.video.duck !== null && c.video.spans.length);
  const level = c.loudness && c.loudness.integrated !== null ? `, at ${c.loudness.integrated} LUFS${c.voice || dips ? " as a whole, dips included," : ""} with true peaks at ${c.loudness.truePeak} dBTP` : c.loudness ? ", silent" : "";
  lines.push(`\`fitted.wav\` is ${sec(c.length)} long (${c.frames} frames at ${c.fps} fps), 48 kHz stereo${level}.${c.mix ? " `mix.wav` is the same music with the voice over it, the whole at the target loudness." : ""}`, "");
  if (c.video) {
    const v = c.video;
    const level = v.loudness.integrated !== null ? `, the whole at ${v.loudness.integrated} LUFS with true peaks at ${v.loudness.truePeak} dBTP after the AAC encoding` : "";
    const frames = v.steady ? `${v.frames} frames at ${v.fps} fps` : `${v.frames} frames, ${v.fps} fps on average`;
    lines.push(`\`video.mp4\` is ${v.source} with ${underVideo(c)}: its picture as it was (${v.picture}, ${frames}, ${sec(v.length)})${level}.`, "");
  }
  if (c.tempo) {
    const meter = c.tempo.meter === 3 ? "three beats to a bar" : `${c.tempo.meter} beats to a bar`;
    const how = c.mode === "phrases" ? " Cuts are made in pairs of bars, because the tempo might be half of that." : "";
    lines.push(`The track is ${c.tempo.bpm} BPM with ${meter}${c.tempo.steady ? ", and the tempo holds steady" : ", and the tempo wanders a little"}.${how}`);
  } else lines.push("The track has no steady beat, so its parts are joined with one-second crossfades where they sound alike.");
  if (c.drop) {
    const what = c.drop.found === "given" ? "The moment you gave" : c.drop.found === "drop" ? "Its drop" : "Its biggest change (no clear drop was found)";
    lines.push(`${what}, at ${sec(c.drop.source)} in the track${c.drop.sourceBar ? ` (bar ${c.drop.sourceBar})` : ""}, lands at ${sec(c.drop.time)}, frame ${c.drop.frame}.`);
  }
  lines.push("");

  lines.push("## Where to listen", "", "| Time | Frame | What | Why |", "| --- | --- | --- | --- |");
  const rows = [{ time: 0, frame: 0, what: "start", why: startText(c) }];
  c.seams.forEach((s, i) => {
    const amount = s.bars !== null ? `${s.bars} ${s.bars === 1 ? "bar" : "bars"}` : sec(s.seconds);
    const how = s.kind === "cut" ? `${amount} of the track skipped (${sec(s.source.from)} to ${sec(s.source.to)} there)` : `back ${amount}, so ${s.bars !== null ? "they play" : "that part plays"} again (${sec(s.source.from)} back to ${sec(s.source.to)} there)`;
    const like = s.ending ? "it goes into the track's own ending" : s.likeness >= 0.7 ? "the bars on either side sound alike" : s.likeness >= 0.45 ? "the two sides differ a little" : "the two sides sound different, listen closely";
    rows.push({ time: s.time, frame: s.frame, what: `seam ${i + 1}, ${s.kind}`, why: `${how}; ${like}` });
  });
  if (c.drop) rows.push({ time: c.drop.time, frame: c.drop.frame, what: "hit", why: `${c.drop.found === "given" ? "the moment you gave" : c.drop.found === "drop" ? "the drop" : "the biggest change"} lands here` });
  const endAt = c.end.finalHit || (c.end.fade ? { time: c.end.fade.from, frame: c.end.fade.fromFrame } : { time: c.end.time, frame: c.end.frame });
  rows.push({ time: endAt.time, frame: endAt.frame, what: "end", why: endText(c) });
  rows.sort((x, y) => x.time - y.time);
  for (const row of rows) lines.push(`| ${sec(row.time)} | ${row.frame} | ${row.what} | ${row.why} |`);
  lines.push("");

  lines.push("## What was done", "");
  c.segments.forEach((s, i) => {
    const bars = s.sourceBars ? (s.sourceBars[0] === s.sourceBars[1] ? `bar ${s.sourceBars[0]}` : `bars ${s.sourceBars[0]} to ${s.sourceBars[1]}`) : "a stretch";
    lines.push(`${i + 1}. ${sec(s.from)} to ${sec(s.to)} plays ${bars} of the track (${sec(s.source[0])} to ${sec(s.source[1])} there).`);
  });
  const stretches = (n) => `${n} ${n === 1 ? "stretch" : "stretches"}`;
  if (c.voice || dips) {
    const own = `${c.video ? c.video.source : ""}'s own sound plays`;
    let what;
    if (!dips) what = `${c.voice.duck} dB wherever the voice speaks (${stretches(c.voice.spans.length)})`;
    else if (!c.voice) what = `${c.video.duck} dB wherever ${own} (${stretches(c.video.spans.length)})`;
    else if (c.voice.duck === c.video.duck) what = `${c.voice.duck} dB wherever the voice speaks or ${own} (${stretches(c.voice.spans.length + c.video.spans.length)})`;
    else what = `${c.voice.duck} dB wherever the voice speaks (${stretches(c.voice.spans.length)}) and ${c.video.duck} dB wherever ${own} (${stretches(c.video.spans.length)})`;
    lines.push(`${c.segments.length + 1}. The music dips ${what}, starting 0.15 s before each and coming back over 0.5 s after.`);
  }
  if (c.loudness && c.loudness.integrated !== null) {
    const step = c.segments.length + (c.voice || dips ? 2 : 1);
    // A music that dips reads off the target as a whole, so only one that
    // does not dip is said to have stopped short of it.
    const short = !c.voice && !dips && c.loudness.integrated < c.loudness.target - 0.5;
    const how = c.loudness.limited ? `, with a limiter holding the true peaks at ${c.loudness.truePeak} dBTP` : " with one gain change";
    const where = c.voice && dips ? ` where nobody speaks and ${c.video.source}'s own sound does not play` : c.voice ? " where nobody speaks" : dips ? ` where ${c.video.source}'s own sound does not play` : "";
    // Stopped for the peaks only when they are held there.
    if (short) lines.push(`${step}. Loudness raised toward ${c.loudness.target} LUFS but stopped at ${c.loudness.integrated} LUFS${how}${heldAtCeiling(c.loudness.truePeak) ? ": any louder and the peaks would pass -1 dBTP" : ""}.`);
    else lines.push(`${step}. Loudness set to ${c.loudness.target} LUFS${where}${how}.`);
  }
  if (c.video) {
    const step = c.segments.length + (c.voice || dips ? 1 : 0) + (c.loudness && c.loudness.integrated !== null ? 1 : 0) + 1;
    // The level it was set to, or where it stopped short of the target.
    const { target, integrated, truePeak } = c.video.loudness;
    const held = heldAtCeiling(truePeak);
    const level = integrated !== null && integrated < target - 0.5 ? `the whole raised toward ${target} LUFS but stopped at ${integrated} LUFS${held ? "" : ` with true peaks at ${truePeak} dBTP`}, measured after the AAC encoding${held ? ": any louder and its true peaks would pass -1 dBTP" : ""}` : `the whole set to ${target} LUFS, measured after the AAC encoding`;
    lines.push(`${step}. ${c.video.source}'s picture copied packet for packet into \`video.mp4\`, with ${underVideo(c)}, ${level}.`);
  }
  lines.push("");

  if (c.warnings.length) {
    lines.push("## Warnings", "");
    for (const w of c.warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  lines.push("## Using it", "");
  if (c.video) lines.push(`\`video.mp4\` is ${c.video.source} with this sound under it, to watch and hand over as it is.`, "");
  lines.push(`\`cues.json\` has every beat and bar of \`fitted.wav\` as a frame at ${c.fps} fps (\`beats\`, \`bars\`), the frames of the hits (\`hits\`), the same in seconds under \`times\`, and the seams and the fade, for cutting the video on the music.`);
  return lines.join("\n") + "\n";
}

// What plays under the picture in video.mp4, said of the video, as in
// "video.mp4 is film.mp4 with ...".
function underVideo(c) {
  const v = c.video;
  const voice = c.voice ? " and the voice" : "";
  const places = (n) => `${n} ${n === 1 ? "place" : "places"}`;
  if (v.same === "voice") return "the music and the voice, which is its own sound, laid in once";
  if (v.same === "track") return "the music fitted from its own sound, in place of that sound";
  // The music, the voice when there is one, and the video's own sound.
  const all = c.voice ? "the music, the voice and its own sound" : "the music and its own sound";
  const set = `set to ${v.loudness.target} LUFS where it plays`;
  if (v.sound === "keep" && !v.spans.length) return all;
  // keep: that sound over the music in every place it plays or in those
  // where it came out so (a note names the others), each within half a dB
  // of KEEP_OVER or further over, and where the music dips under them.
  const heard = v.spans.filter((s) => s.over !== null && s.over !== undefined);
  const clear = v.spans.length - heard.filter((s) => s.over < v.over - 0.5).length;
  let over = `${set}, as no music plays there`;
  if (heard.length && clear === v.spans.length) over = `about ${v.over} dB or more louder than the music where it plays (${places(v.spans.length)})`;
  else if (heard.length && clear) over = `about ${v.over} dB or more louder than the music in ${clear} of the ${v.spans.length} places it plays`;
  else if (heard.length) over = `less than ${v.over} dB louder than the music where it plays (${places(v.spans.length)})`;
  over += dipsUnder(v);
  if (v.sound === "keep" && c.voice) return `${all}, the music dipping ${c.voice.duck} dB under the voice and its own sound ${over}`;
  if (v.sound === "keep") return `${all}, that sound ${over}`;
  if (v.sound === "voice" && !v.spans.length) return `${all}, which had no speech for the music to dip under`;
  if (v.sound === "voice") return `its own sound ${set}${voice}, the music dipping ${v.duck} dB under ${c.voice ? "both" : "it"}`;
  if (v.sound === "drop") return `the music${voice} in place of its own sound`;
  return `the music${voice} (it had no sound of its own)`;
}

// How far the music dips under the places of keep, said after them: "the
// music dipping 1.1 to 7.7 dB under 3 of them".
function dipsUnder(v) {
  const dipped = v.spans.filter((s) => s.dip >= 0.05);
  if (!dipped.length) return "";
  const dbs = dipped.map((s) => s.dip);
  const [lo, hi] = [Math.min(...dbs), Math.max(...dbs)];
  const which = v.spans.length === 1 ? "it" : dipped.length === 1 ? "one of them" : dipped.length < v.spans.length ? `${dipped.length} of them` : dipped.length === 2 ? "both" : `all ${dipped.length}`;
  return `, the music dipping ${lo === hi ? hi : `${lo} to ${hi}`} dB under ${which}`;
}

function startText(c) {
  const s = c.start;
  const first = s.firstBar ? `${sec(s.firstBar.time)}` : "";
  if (s.kind === "top") return "the music starts at the top, as the track does";
  if (s.kind === "later") {
    const bars = c.segments[0].sourceBars;
    const at = sec(c.segments[0].source[0]);
    // A head of a few milliseconds is on the bar, as near as anyone hears.
    const lead = s.firstBar && s.firstBar.time > 0.02 ? `${sec(s.firstBar.time)} before` : "on";
    return `the music starts ${bars ? `${lead} bar ${bars[0]} of the track (${at} there)` : `${at} into the track`}, not at its top`;
  }
  if (s.kind === "silence") return `silence, then the music comes in on its first bar at ${first}`;
  if (s.kind === "pickup") return `the track's own lead in, with the first bar at ${first}`;
  if (s.kind === "swell") return `the end of the bar before fades in over ${sec(s.fadeIn)}, into the first full bar at ${first}`;
  return `the music starts part way into a bar with a ${sec(s.fadeIn)} fade in; the first full bar is at ${first}`;
}

function endText(c) {
  const e = c.end;
  // Silence left after the music has ended, said where it ends.
  const silent = (ended) => (c.length - ended > 0.01 ? `; the last ${sec(c.length - ended)} are silent` : "");
  if (e.kind === "natural") {
    const faded = e.fade ? `, faded over its last ${sec(e.fade.to - e.fade.from)}` : ", ringing out on its own";
    return `the track's own ending: its last hit at ${sec(e.finalHit.time)} (frame ${e.finalHit.frame})${faded}${silent(e.time)}`;
  }
  if (c.mode === "energy" || !e.fade.onBeat) return `a ${sec(e.fade.to - e.fade.from)} fade to the end`;
  return `a fade from the beat at ${sec(e.fade.from)} that ends on the beat at ${sec(e.fade.to)} (frame ${e.fade.toFrame})${silent(e.fade.to)}`;
}

function analysisMarkdown(c, { trackName }) {
  const lines = [`# ${trackName}`, ""];
  if (c.tempo) lines.push(`${c.tempo.bpm} BPM with ${c.tempo.meter} beats to a bar${c.tempo.steady ? ", steady" : ", wandering a little"}. ${c.bars.length} bars over ${sec(c.length)}.`);
  else lines.push(`No steady beat over ${sec(c.length)}.`);
  if (c.source.drop !== null) lines.push(`The drop is at ${sec(c.source.drop)}${c.source.dropBar ? ` (bar ${c.source.dropBar})` : ""}. Other candidates: ${c.source.dropCandidates.filter((t) => t !== c.source.drop).map(sec).join(", ") || "none"}.`);
  lines.push(`It ends ${c.source.ending === "hit" ? `on a last hit at ${sec(c.source.finalHit)} that rings out` : c.source.ending === "fade" ? "with a fade out" : c.source.ending === "cut" ? "abruptly, cut off" : "quietly"}.`);
  if (c.sections.length) lines.push(`Sections start at ${c.sections.map((s) => sec(s.time)).join(", ")}.`);
  lines.push("");
  if (c.warnings.length) {
    lines.push("## Warnings", "");
    for (const w of c.warnings) lines.push(`- ${w}`);
    lines.push("");
  }
  lines.push("`cues.json` has every beat and bar of the track as a frame number, and in seconds under `times`. Fit the track with `--length`, and `--hit` to land the drop on a second.");
  return lines.join("\n") + "\n";
}

module.exports = { cues, analysisCues, fitMarkdown, analysisMarkdown, underVideo, heldAtCeiling };
