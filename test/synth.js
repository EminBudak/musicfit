"use strict";

// Music made in code for the tests and the demo tracks: drums, bass, chords,
// a lead and effects, laid out in sections with a known tempo, bar lines,
// drop and ending. No test depends on a recording of someone else's music.
//
// song(spec) returns the samples and the truth about them: every beat, the
// downbeats, where each section starts, the drop and the final hit.

const fs = require("node:fs");

const TAU = Math.PI * 2;

function random(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The audio EQ cookbook's biquad. The returned filter keeps its state when
// its frequency is moved with .set(freq).
function biquad(type, freq, q, rate) {
  let b0, b1, b2, a1, a2;
  const set = (f) => {
    const w = (TAU * Math.min(f, rate * 0.45)) / rate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    let b;
    if (type === "lowpass") b = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
    else if (type === "highpass") b = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
    else b = [alpha, 0, -alpha];
    const a0 = 1 + alpha;
    [b0, b1, b2, a1, a2] = [b[0] / a0, b[1] / a0, b[2] / a0, (-2 * cos) / a0, (1 - alpha) / a0];
  };
  set(freq);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const run = (x) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
  run.set = set;
  return run;
}

// A saw with its jumps smoothed (polyBLEP).
function saw(phase, inc) {
  let v = 2 * phase - 1;
  if (phase < inc) {
    const t = phase / inc;
    v -= t + t - t * t - 1;
  } else if (phase > 1 - inc) {
    const t = (phase - 1) / inc;
    v -= t * t + t + t + 1;
  }
  return v;
}

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

// ─── instruments: each renders one mono hit or note ─────────────────────────

const INSTRUMENTS = {
  kick(rate, { level = 1, decay = 0.3, tune = 1 }) {
    const out = new Float32Array(Math.round(rate * decay * 2.5));
    let phase = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / rate;
      phase += ((44 + 120 * Math.exp(-t * 30)) * tune) / rate;
      const click = t < 0.004 ? (1 - t / 0.004) * 0.5 * Math.sin(TAU * 1800 * t) : 0;
      out[i] = (Math.sin(TAU * phase) * Math.exp(-t / decay) * Math.min(1, t / 0.0015) + click) * level;
    }
    return out;
  },
  snare(rate, { level = 1, seed = 1 }) {
    const rnd = random(seed);
    const bp = biquad("bandpass", 3200, 0.6, rate);
    const out = new Float32Array(Math.round(rate * 0.32));
    for (let i = 0; i < out.length; i++) {
      const t = i / rate;
      const noise = bp(rnd() * 2 - 1) * 2.2 * Math.exp(-t / 0.11);
      const body = Math.sin(TAU * 190 * t) * Math.exp(-t / 0.05) * 0.7;
      out[i] = (noise + body) * Math.min(1, t / 0.001) * level;
    }
    return out;
  },
  clap(rate, { level = 1, seed = 2 }) {
    const rnd = random(seed);
    const bp = biquad("bandpass", 1300, 1.2, rate);
    const out = new Float32Array(Math.round(rate * 0.3));
    for (let i = 0; i < out.length; i++) {
      const t = i / rate;
      let env = Math.exp(-t / 0.09) * 0.6;
      for (const at of [0, 0.009, 0.018]) if (t >= at) env += Math.exp(-(t - at) / 0.005);
      out[i] = bp(rnd() * 2 - 1) * env * 2.4 * level;
    }
    return out;
  },
  hat(rate, { level = 1, open = false, seed = 3 }) {
    const rnd = random(seed);
    const hp = biquad("highpass", 7500, 0.8, rate);
    const decay = open ? 0.22 : 0.035;
    const out = new Float32Array(Math.round(rate * decay * 4));
    for (let i = 0; i < out.length; i++) {
      const t = i / rate;
      out[i] = hp(rnd() * 2 - 1) * Math.exp(-t / decay) * 0.9 * level;
    }
    return out;
  },
  crash(rate, { level = 1, seed = 4 }) {
    const rnd = random(seed);
    const hp = biquad("highpass", 4200, 0.7, rate);
    const out = new Float32Array(Math.round(rate * 2.8));
    for (let i = 0; i < out.length; i++) {
      const t = i / rate;
      out[i] = hp(rnd() * 2 - 1) * Math.exp(-t / 0.9) * Math.min(1, t / 0.003) * 0.8 * level;
    }
    return out;
  },
  tom(rate, { level = 1, tune = 1 }) {
    const out = new Float32Array(Math.round(rate * 0.6));
    let phase = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / rate;
      phase += ((95 + 40 * Math.exp(-t * 18)) * tune) / rate;
      out[i] = Math.sin(TAU * phase) * Math.exp(-t / 0.22) * Math.min(1, t / 0.002) * level;
    }
    return out;
  },
  boom(rate, { level = 1, seed = 5 }) {
    const rnd = random(seed);
    const lp = biquad("lowpass", 220, 0.7, rate);
    const out = new Float32Array(Math.round(rate * 4));
    let phase = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / rate;
      phase += (38 + 50 * Math.exp(-t * 6)) / rate;
      out[i] = (Math.sin(TAU * phase) * Math.exp(-t / 1.1) + lp(rnd() * 2 - 1) * Math.exp(-t / 0.25) * 2) * Math.min(1, t / 0.002) * level;
    }
    return out;
  },
  bass(rate, { note, dur, level = 1, cutoff = 420 }) {
    const lp = biquad("lowpass", cutoff, 0.9, rate);
    const lp2 = biquad("lowpass", cutoff * 1.4, 0.7, rate);
    const out = new Float32Array(Math.round(rate * (dur + 0.05)));
    const f = hz(note);
    let phase = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / rate;
      phase = (phase + f / rate) % 1;
      const env = Math.min(1, t / 0.004) * (0.75 + 0.25 * Math.exp(-t / 0.08)) * (t > dur ? Math.max(0, 1 - (t - dur) / 0.05) : 1);
      out[i] = lp2(lp(saw(phase, f / rate) * 0.7 + Math.sin(TAU * phase) * 0.6)) * env * level;
    }
    return out;
  },
  pad(rate, { notes, dur, level = 1, cutoff = 1400 }) {
    const out = new Float32Array(Math.round(rate * (dur + 0.6)));
    const lp = biquad("lowpass", cutoff, 0.7, rate);
    const voices = [];
    for (const note of notes) for (const cents of [-8, 0, 7]) voices.push({ f: hz(note) * 2 ** (cents / 1200), phase: (cents + 10) / 30 });
    for (let i = 0; i < out.length; i++) {
      const t = i / rate;
      let v = 0;
      for (const voice of voices) {
        voice.phase = (voice.phase + voice.f / rate) % 1;
        v += saw(voice.phase, voice.f / rate);
      }
      const env = Math.min(1, t / 0.3) * (t > dur ? Math.max(0, 1 - (t - dur) / 0.6) : 1);
      out[i] = lp(v / voices.length) * env * level;
    }
    return out;
  },
  pluck(rate, { note, level = 1, decay = 0.28 }) {
    const out = new Float32Array(Math.round(rate * decay * 3));
    const f = hz(note);
    let phase = 0;
    let y = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / rate;
      phase = (phase + f / rate) % 1;
      const cutoff = 600 + 4200 * Math.exp(-t / 0.06);
      const a = 1 - Math.exp((-TAU * cutoff) / rate);
      y += a * (saw(phase, f / rate) - y);
      out[i] = y * Math.exp(-t / decay) * Math.min(1, t / 0.002) * level;
    }
    return out;
  },
  piano(rate, { note, dur = 1, level = 1, seed = 6 }) {
    const rnd = random(seed + note);
    const out = new Float32Array(Math.round(rate * Math.min(3.5, dur + 1.2)));
    const f = hz(note);
    const partials = [];
    for (let h = 1; h <= 8; h++) {
      const fh = f * h * Math.sqrt(1 + 0.0004 * h * h);
      if (fh < rate * 0.45) partials.push({ fh, amp: 1 / h ** 1.3, decay: 1 / (0.9 + h * 0.5 + f / 400) });
    }
    for (let i = 0; i < out.length; i++) {
      const t = i / rate;
      let v = 0;
      for (const p of partials) v += Math.sin(TAU * p.fh * t) * p.amp * Math.exp(-t / p.decay);
      const hammer = t < 0.01 ? (rnd() * 2 - 1) * (1 - t / 0.01) * 0.3 : 0;
      const release = t > dur ? Math.max(0, 1 - (t - dur) / 0.25) : 1;
      out[i] = (v * 0.5 + hammer) * Math.min(1, t / 0.002) * release * level;
    }
    return out;
  },
  riser(rate, { dur, level = 1, seed = 7 }) {
    const rnd = random(seed);
    const out = new Float32Array(Math.round(rate * dur));
    const bp = biquad("bandpass", 400, 1.5, rate);
    for (let i = 0; i < out.length; i++) {
      const x = i / out.length;
      if (i % 64 === 0) bp.set(400 * 15 ** x);
      out[i] = bp(rnd() * 2 - 1) * x * x * 1.8 * level;
    }
    return out;
  },
  vinyl(rate, { dur, level = 1, seed = 8 }) {
    const rnd = random(seed);
    const lp = biquad("lowpass", 5000, 0.7, rate);
    const out = new Float32Array(Math.round(rate * dur));
    for (let i = 0; i < out.length; i++) {
      const pop = rnd() < 9 / rate ? (rnd() * 2 - 1) * 0.6 : 0;
      out[i] = lp(pop + (rnd() * 2 - 1) * 0.012) * level;
    }
    return out;
  },
};

// ─── parts: what each part plays in one bar ─────────────────────────────────
// Each returns [beat position in the bar, instrument, options] triples.
// `bar` is the bar's index within its section, `of` the section's length,
// `chord` the bar's chord as MIDI notes.

const PARTS = {
  kick4: () => [0, 1, 2, 3].map((b) => [b, "kick", { level: 1 }]),
  kickPop: ({ bar }) => [[0, "kick", {}], [2, "kick", {}], ...(bar % 2 ? [[2.5, "kick", { level: 0.7 }]] : [])],
  kickBoom: ({ bar }) => [[0, "kick", { decay: 0.4 }], [1.5, "kick", { level: 0.8, decay: 0.4 }], ...(bar % 2 ? [[2.75, "kick", { level: 0.6, decay: 0.4 }]] : [])],
  kickTrap: () => [[0, "kick", { decay: 0.6 }], [1.75, "kick", { level: 0.8, decay: 0.5 }], [2.5, "kick", { level: 0.7, decay: 0.5 }]],
  kickTwoStep: () => [[0, "kick", {}], [2.5, "kick", { level: 0.9 }]],
  kickWaltz: () => [[0, "kick", {}]],
  snareWaltz: () => [[1, "snare", { level: 0.6 }], [2, "snare", { level: 0.6, seed: 9 }]],
  snare: () => [[1, "snare", {}], [3, "snare", { seed: 9 }]],
  clap: () => [[1, "clap", {}], [3, "clap", { seed: 10 }]],
  snareHalf: () => [[2, "snare", { level: 1.1 }]],
  hats8: () => Array.from({ length: 8 }, (_, i) => [i / 2, "hat", { level: i % 2 ? 0.45 : 0.7, seed: 20 + i }]),
  hats16: () => Array.from({ length: 16 }, (_, i) => [i / 4, "hat", { level: i % 4 === 0 ? 0.6 : i % 2 ? 0.25 : 0.4, seed: 40 + i }]),
  openhat: () => [0.5, 1.5, 2.5, 3.5].map((b, i) => [b, "hat", { open: true, level: 0.55, seed: 60 + i }]),
  clapOff: () => [0.5, 1.5, 2.5, 3.5].map((b, i) => [b, "clap", { level: 0.8, seed: 70 + i }]),
  // A crisp snare on 2 and 4 whose noise sits mostly above 4 kHz.
  snareBright: () => [1, 3].map((b, i) => [b, "hat", { open: true, level: 2.2, seed: 90 + i }]),
  // Three, three and two sixteenths, twice a bar.
  tresillo: () => [0, 0.75, 1.5, 2, 2.75, 3.5].map((b, i) => [b, "clap", { level: i % 3 ? 0.75 : 0.9, seed: 80 + i }]),
  snareRoll: ({ bar, of }) => {
    const step = bar < of / 2 ? 1 : bar < of - 1 ? 0.5 : 0.25;
    const events = [];
    for (let b = 0; b < 4; b += step) events.push([b, "snare", { level: 0.3 + 0.7 * ((bar + b / 4) / of), seed: 70 + Math.round(b * 4) }]);
    return events;
  },
  riser: ({ bar, of, beat }) => (bar === 0 ? [[0, "riser", { dur: of * 4 * beat, level: 0.5 }]] : []),
  crash: ({ bar }) => (bar === 0 ? [[0, "crash", {}]] : []),
  boom: ({ bar }) => (bar === 0 ? [[0, "boom", {}]] : []),
  toms: ({ bar, of }) => (bar >= of - 2 ? [0, 1, 1.5, 2, 2.5, 3, 3.25, 3.5, 3.75].map((b, i) => [b, "tom", { tune: 1.3 - i * 0.04, level: 0.6 + (bar === of - 1 ? 0.3 : 0) }]) : [[0, "tom", { level: 0.8 }], [2, "tom", { tune: 0.85, level: 0.7 }]]),
  bass8: ({ chord }) => Array.from({ length: 8 }, (_, i) => [i / 2, "bass", { note: chord[0] - 12, dur: 0.18, level: i % 2 ? 0.75 : 0.9 }]),
  bassOff: ({ chord }) => [0.5, 1.5, 2.5, 3.5].map((b) => [b, "bass", { note: chord[0] - 12, dur: 0.22 }]),
  bassLong: ({ chord, beat }) => [[0, "bass", { note: chord[0] - 12, dur: beat * 3.8, cutoff: 300 }]],
  pad: ({ chord, beat }) => [[0, "pad", { notes: chord, dur: beat * 4, level: 0.55 }]],
  padDark: ({ chord, beat }) => [[0, "pad", { notes: chord, dur: beat * 4, level: 0.5, cutoff: 700 }]],
  stabs: ({ chord }) => [0.5, 1.5, 2.5, 3.5].map((b) => [b, "pluck", { note: chord[1] + 12, level: 0.5 }]).concat([0.5, 1.5, 2.5, 3.5].map((b) => [b, "pluck", { note: chord[2] + 12, level: 0.45 }])),
  arp: ({ chord }) => Array.from({ length: 16 }, (_, i) => [i / 4, "pluck", { note: chord[i % 3] + 24 + (i % 8 >= 6 ? 12 : 0), level: 0.32, decay: 0.18 }]),
  piano8: ({ chord, beat }) => Array.from({ length: 8 }, (_, i) => [i / 2, "piano", { note: chord[[0, 2, 1, 2][i % 4]] + 12, dur: beat / 2, level: i % 2 ? 0.45 : 0.55 }]),
  pianoChords: ({ chord, beat }) => [0, 2].flatMap((b) => chord.map((note) => [b, "piano", { note, dur: beat * 2, level: 0.35 }])),
  rhodes: ({ chord, beat }) => [[0, chord], [2.5, chord]].flatMap(([b, notes]) => notes.map((note) => [b, "piano", { note: note + 12, dur: beat * 1.5, level: 0.32 }])),
  lead: ({ chord, bar }) => [[0, chord[2] + 24], [0.75, chord[1] + 24], [1.5, chord[0] + 24], [2.5, chord[2] + 24 + (bar % 2 ? 2 : 0)], [3, chord[1] + 24]].map(([b, note]) => [b, "pluck", { note, level: 0.4, decay: 0.35 }]),
  vinyl: ({ bar, of, beat }) => (bar === 0 ? [[0, "vinyl", { dur: of * 4 * beat + 1, level: 0.6 }]] : []),
};

const QUALITIES = { maj: [0, 4, 7], min: [0, 3, 7] };

// ─── the song ───────────────────────────────────────────────────────────────

// spec: {
//   bpm, meter (4), rate (48000), seed,
//   key (MIDI root of the first chord, e.g. 57 for A),
//   chords: [[offset, "maj" | "min"], ...] one per bar, looping,
//   lead: seconds of silence before the music,
//   pickup: beats of music (the first section's parts) before the first downbeat,
//   swing: 0 to 0.33, how late off-beat eighths are, as a fraction of a beat,
//   humanize: seconds of random timing on every hit,
//   drift: how far the tempo wanders, e.g. 0.01 for 1%,
//   sections: [{ bars, parts: [...], drop: true }],
//   ending: "hit" (a final hit that rings out), "stop" (the same with a
//           fill inside the hit's beat), "fade" (fades over the last 4 bars)
//           or "cut" (stops dead mid-bar),
// }
function song(spec) {
  const rate = spec.rate || 48000;
  const meter = spec.meter || 4;
  const rnd = random(spec.seed || 1);
  const totalBars = spec.sections.reduce((n, s) => n + s.bars, 0);
  const pickup = spec.pickup || 0;
  const lead = spec.lead || 0;
  const beatsNeeded = pickup + totalBars * meter + meter + 1;

  // Beat times: a steady pulse, or one that wanders slowly.
  const beats = [];
  let t = lead;
  for (let i = 0; i < beatsNeeded; i++) {
    beats.push(t);
    const wander = spec.drift ? 1 + spec.drift * Math.sin((TAU * t) / 23 + 0.7) : 1;
    t += 60 / spec.bpm / wander;
  }
  const beatAt = (pos) => {
    const i = Math.floor(pos);
    return beats[i] + (pos - i) * (beats[i + 1] - beats[i]);
  };
  const swingPos = (pos) => {
    if (!spec.swing) return pos;
    const whole = Math.floor(pos);
    const frac = pos - whole;
    if (Math.abs(frac - 0.5) < 1e-6) return whole + 0.5 + spec.swing;
    if (Math.abs(frac - 0.25) < 1e-6) return whole + 0.25 + spec.swing / 2;
    if (Math.abs(frac - 0.75) < 1e-6) return whole + 0.75 + spec.swing / 2;
    return pos;
  };

  const hits = spec.ending === "hit" || spec.ending === "stop";
  const ringOut = hits ? 4.5 : 0;
  const endBeat = pickup + totalBars * meter;
  const cutAt = spec.ending === "cut" ? beatAt(endBeat - 1.37) : null;
  const seconds = (cutAt || beatAt(endBeat)) + ringOut + 0.05;
  const L = new Float32Array(Math.ceil(seconds * rate));
  const R = new Float32Array(L.length);
  const sendL = new Float32Array(L.length);
  const sendR = new Float32Array(L.length);

  const cache = new Map();
  const render = (name, options) => {
    const key = name + JSON.stringify(options);
    if (!cache.has(key)) cache.set(key, INSTRUMENTS[name](rate, options));
    return cache.get(key);
  };
  const PAN = { hat: 0.3, pluck: -0.25, piano: 0.15, tom: -0.3, clap: 0.05 };
  const SEND = { pad: 0.5, piano: 0.35, pluck: 0.4, snare: 0.25, clap: 0.3, crash: 0.3, boom: 0.4, tom: 0.25, riser: 0.3 };
  const GAIN = { kick: 0.9, snare: 0.5, clap: 0.45, hat: 0.22, crash: 0.25, tom: 0.5, boom: 0.8, bass: 0.45, pad: 0.22, pluck: 0.2, piano: 0.3, riser: 0.18, vinyl: 0.5 };
  const place = (time, name, options) => {
    const buf = render(name, options);
    const start = Math.round((time + (spec.humanize ? (rnd() * 2 - 1) * spec.humanize : 0)) * rate);
    const pan = PAN[name] || 0;
    const gain = GAIN[name] || 0.3;
    const [gl, gr] = [gain * Math.min(1, 1 - pan), gain * Math.min(1, 1 + pan)];
    const send = SEND[name] || 0;
    for (let i = 0; i < buf.length; i++) {
      const j = start + i;
      if (j < 0) continue;
      if (j >= L.length) break;
      L[j] += buf[i] * gl;
      R[j] += buf[i] * gr;
      if (send) {
        sendL[j] += buf[i] * gl * send;
        sendR[j] += buf[i] * gr * send;
      }
    }
  };

  const chords = (spec.chords || [[0, "min"], [-4, "maj"], [3, "maj"], [-2, "maj"]]).map(([offset, quality]) => QUALITIES[quality].map((i) => (spec.key || 57) + offset + i));
  const truth = { bpm: spec.bpm, meter, beats: [], downbeats: [], sections: [], drop: null, finalHit: null, ending: spec.ending || "hit", lead };
  const beatSeconds = 60 / spec.bpm;

  // The pickup plays the first section's last bar's parts, cut to its length.
  let barIndex = 0;
  if (pickup) {
    const first = spec.sections[0];
    for (const part of first.parts) {
      for (const [pos, name, options] of PARTS[part]({ bar: first.bars - 1, of: first.bars, chord: chords[chords.length - 1], beat: beatSeconds })) {
        if (pos >= meter - pickup) place(beatAt(swingPos(pos - (meter - pickup))), name, options);
      }
    }
  }
  let beatPos = pickup;
  for (const section of spec.sections) {
    truth.sections.push({ bar: barIndex, time: beatAt(beatPos), drop: !!section.drop });
    if (section.drop && truth.drop === null) truth.drop = beatAt(beatPos);
    for (let bar = 0; bar < section.bars; bar++) {
      const chord = chords[(barIndex + bar) % chords.length];
      for (const part of section.parts) {
        for (const [pos, name, options] of PARTS[part]({ bar, of: section.bars, chord, beat: beatSeconds })) {
          const time = beatAt(beatPos + swingPos(pos));
          if (cutAt !== null && time >= cutAt) continue;
          place(time, name, options);
        }
      }
      beatPos += meter;
    }
    barIndex += section.bars;
  }
  if (hits) {
    const time = beatAt(beatPos);
    truth.finalHit = time;
    place(time, "crash", {});
    place(time, "kick", { decay: 0.5 });
    place(time, "boom", { level: 0.5 });
    place(time, "pad", { notes: chords[0], dur: 2.2, level: 0.7 });
    place(time, "bass", { note: chords[0][0] - 12, dur: 1.6, cutoff: 300 });
    // The drummer plays on to the end of the beat: three sixteenths.
    if (spec.ending === "stop") [0.25, 0.5, 0.75].forEach((pos, i) => place(beatAt(beatPos + pos), "snare", { level: 0.9 - i * 0.15, seed: 30 + i }));
  }
  for (let i = 0; i < beats.length && beats[i] < (cutAt || beatAt(endBeat)) - 1e-6; i++) {
    if (i < pickup) continue;
    truth.beats.push(beats[i]);
    if ((i - pickup) % meter === 0) truth.downbeats.push(beats[i]);
  }
  if (hits) {
    truth.beats.push(truth.finalHit);
    truth.downbeats.push(truth.finalHit);
  }
  truth.pickupBeats = beats.slice(0, pickup);

  // A small stereo reverb on the send (Schroeder's four combs and two
  // allpasses a side).
  for (const [input, output, spread] of [[sendL, L, 0], [sendR, R, 23]]) {
    const combs = [1116, 1188, 1277, 1356].map((d) => ({ buf: new Float32Array(Math.round(((d + spread) * rate) / 44100)), i: 0, low: 0 }));
    const passes = [556, 441].map((d) => ({ buf: new Float32Array(Math.round(((d + spread) * rate) / 44100)), i: 0 }));
    for (let n = 0; n < input.length; n++) {
      const x = input[n] * 0.1;
      let y = 0;
      for (const c of combs) {
        const v = c.buf[c.i];
        c.low = v * 0.6 + c.low * 0.4;
        c.buf[c.i] = x + c.low * 0.84;
        c.i = (c.i + 1) % c.buf.length;
        y += v;
      }
      for (const a of passes) {
        const v = a.buf[a.i];
        a.buf[a.i] = y + v * 0.5;
        a.i = (a.i + 1) % a.buf.length;
        y = v - y;
      }
      output[n] += y * 0.6;
    }
  }

  if (spec.ending === "fade") {
    const from = beatAt(endBeat - 4 * meter);
    const to = beatAt(endBeat);
    for (let i = Math.round(from * rate); i < L.length; i++) {
      const g = Math.max(0, 1 - (i / rate - from) / (to - from)) ** 2;
      L[i] *= g;
      R[i] *= g;
    }
  }
  if (cutAt !== null) {
    // A dead stop, the way a model's track ends when it runs out of time.
    const n = Math.round(cutAt * rate);
    L.fill(0, n);
    R.fill(0, n);
  }

  // Peak at -1 dBFS.
  let peak = 0;
  for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const gain = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < L.length; i++) {
    L[i] *= gain;
    R[i] *= gain;
  }
  return { rate, L, R, seconds: L.length / rate, truth };
}

// Notes at random times with no pulse at all, for the case where no beat
// can be found.
function ambient(seconds, { rate = 48000, seed = 11 } = {}) {
  const rnd = random(seed);
  const L = new Float32Array(Math.round(seconds * rate));
  const R = new Float32Array(L.length);
  const notes = [45, 52, 57, 59, 60, 64, 67, 69];
  for (let t = 0; t < seconds - 1; t += 1.3 + rnd() * 3.1) {
    const note = notes[Math.floor(rnd() * notes.length)];
    const dur = 2 + rnd() * 4;
    const buf = INSTRUMENTS.pad(rate, { notes: [note, note + 7], dur, level: 0.4, cutoff: 900 + rnd() * 900 });
    const pan = rnd() - 0.5;
    const start = Math.round(t * rate);
    for (let i = 0; i < buf.length && start + i < L.length; i++) {
      L[start + i] += buf[i] * (1 - pan) * 0.5;
      R[start + i] += buf[i] * (1 + pan) * 0.5;
    }
  }
  let peak = 0;
  for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  for (let i = 0; i < L.length; i++) {
    L[i] *= 0.7 / peak;
    R[i] *= 0.7 / peak;
  }
  return { rate, L, R, seconds, truth: { bpm: null } };
}

// A voice stand-in: bursts of a buzzy, vowel-like tone with gaps, at the
// given [from, to] spans.
function voice(seconds, spans, { rate = 48000, seed = 12 } = {}) {
  const rnd = random(seed);
  const out = new Float32Array(Math.round(seconds * rate));
  const formant = [biquad("bandpass", 700, 4, rate), biquad("bandpass", 1200, 5, rate)];
  let phase = 0;
  for (const [from, to] of spans) {
    for (let i = Math.round(from * rate); i < Math.min(out.length, Math.round(to * rate)); i++) {
      const t = i / rate;
      const syllable = 0.55 + 0.45 * Math.sin(TAU * 4.2 * t + rnd() * 0.05);
      phase = (phase + (130 + 15 * Math.sin(TAU * 0.7 * t)) / rate) % 1;
      const x = saw(phase, 130 / rate) + (rnd() * 2 - 1) * 0.05;
      const edge = Math.min(1, (t - from) / 0.03, (to - t) / 0.03);
      out[i] = (formant[0](x) + formant[1](x) * 0.7) * syllable * edge * 0.9;
    }
  }
  return { rate, L: out, R: out, seconds };
}

// 16-bit PCM WAV, stereo.
function writeWav(file, { rate, L, R }) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write("WAVEfmt ", 8, "latin1");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "latin1");
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

// The styles the tests and the demo use.
const STYLES = {
  // Four on the floor at 124 with an eight-bar build, a drop and a final hit.
  house: (o = {}) => ({
    bpm: 124, key: 57, seed: 3, ending: "hit",
    sections: [
      { bars: 8, parts: ["padDark", "hats8", "kick4"] },
      { bars: 8, parts: ["padDark", "hats16", "snareRoll", "riser", "bassLong"] },
      { bars: 16, parts: ["kick4", "clap", "hats16", "openhat", "bassOff", "pad", "stabs", "lead", "crash"], drop: true },
      { bars: 8, parts: ["pad", "arp", "hats8"] },
      { bars: 8, parts: ["kick4", "clap", "hats16", "openhat", "bassOff", "pad", "stabs", "crash"] },
    ],
    ...o,
  }),
  // Swung boom bap at 86 with dusty chords, ending in a fade.
  lofi: (o = {}) => ({
    bpm: 86, key: 50, seed: 5, swing: 0.16, humanize: 0.006, ending: "fade",
    chords: [[0, "min"], [5, "min"], [-2, "maj"], [3, "maj"]],
    sections: [
      { bars: 4, parts: ["rhodes", "vinyl", "hats8"] },
      { bars: 8, parts: ["rhodes", "kickBoom", "snare", "hats8", "bassLong", "vinyl"] },
      { bars: 8, parts: ["rhodes", "kickBoom", "snare", "hats16", "bass8", "lead", "vinyl"], drop: true },
      { bars: 8, parts: ["rhodes", "kickBoom", "snare", "hats8", "bassLong", "vinyl"] },
    ],
    ...o,
  }),
  // A piano ostinato in eighths at 72 that toms join, then a big hit with
  // full drums, and a last boom that rings out.
  cinematic: (o = {}) => ({
    bpm: 72, key: 50, seed: 7, ending: "hit",
    chords: [[0, "min"], [-4, "maj"], [-7, "maj"], [-2, "maj"]],
    sections: [
      { bars: 4, parts: ["piano8", "padDark"] },
      { bars: 4, parts: ["piano8", "padDark", "toms", "riser"] },
      { bars: 8, parts: ["piano8", "pad", "kickPop", "snare", "toms", "bassLong", "boom", "crash"], drop: true },
      { bars: 4, parts: ["pianoChords", "padDark"] },
    ],
    ...o,
  }),
};

module.exports = { song, ambient, voice, writeWav, STYLES, random };
