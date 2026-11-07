"use strict";

// Turns a plan into samples: segments of the source laid end to end, each
// seam a short crossfade just before the downbeat, the head and tail faded
// where they need it, the music ducked under a voice, and the loudness set.

const { RATE, measure } = require("./audio");

// Seams fade over 30 ms ending 12 ms before the downbeat, so the new bar's
// first hit plays whole and the old bar's next one never sounds. Without
// a beat, seams fade over a second, centred.
const CROSSFADE = 0.03;
const LEAD = 0.012;
const BLOCK_CROSSFADE = 1.0;

function mono(src, from, to) {
  const out = new Float32Array(Math.max(0, to - from));
  for (let i = from; i < to; i++) {
    if (i < 0 || i >= src.L.length) continue;
    out[i - from] = (src.L[i] + src.R[i]) / 2;
  }
  return out;
}

// Rises in loudness in 1 ms steps, for lining up the hits on both sides
// of a seam.
function onsets(x) {
  const step = RATE / 1000;
  const n = Math.floor(x.length / step);
  const env = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let i = k * step + 1; i < (k + 1) * step; i++) sum += (x[i] - x[i - 1]) ** 2;
    env[k] = Math.sqrt(sum / step);
  }
  const out = new Float64Array(n);
  for (let k = 2; k < n; k++) out[k] = Math.max(0, env[k] - env[k - 2]);
  return out;
}

// The start of the hit nearest `time` (seconds), within 30 ms before and
// 15 ms after it: the steepest rise of the 1 ms envelope. The beat tracker
// works in 10 ms frames and lands a few ms late on a sharp attack; a hit
// placed on a frame of video should start on it.
function attackNear(src, time) {
  const from = Math.round((time - 0.03) * RATE);
  const rise = onsets(mono(src, from, Math.round((time + 0.015) * RATE)));
  let best = 0;
  let at = -1;
  for (let k = 0; k < rise.length; k++) {
    if (rise[k] > best) {
      best = rise[k];
      at = k;
    }
  }
  const typical = rise.reduce((sum, v) => sum + v, 0) / Math.max(1, rise.length);
  // A soft entry has no clear attack; leave it where the beat was.
  if (at < 0 || best < 4 * typical) return time;
  // onsets() compares each millisecond with the one two before it.
  return (from + (at - 1) * (RATE / 1000)) / RATE;
}

// How far (in samples) bar B's hits sit from where bar A's next ones would
// have been, within 20 ms; 0 when the hits do not line up clearly.
function align(src, aEnd, bStart, window) {
  const pad = Math.round(0.02 * RATE);
  const span = Math.round(window * RATE);
  const before = Math.round(0.03 * RATE);
  const A = onsets(mono(src, aEnd - before, aEnd + span));
  const B = onsets(mono(src, bStart - before - pad, bStart + span + pad));
  const lag = Math.round(pad / (RATE / 1000));
  let best = 0;
  let bestValue = -Infinity;
  const values = [];
  for (let e = -lag; e <= lag; e++) {
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let k = 0; k < A.length; k++) {
      const v = B[k + lag + e] || 0;
      ab += A[k] * v;
      aa += A[k] * A[k];
      bb += v * v;
    }
    const c = aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
    values.push(c);
    if (c > bestValue) {
      bestValue = c;
      best = e;
    }
  }
  // A clear match only, and not at the edge of the search.
  if (bestValue < 0.5 || Math.abs(best) === lag) return 0;
  return Math.round(best * (RATE / 1000));
}

// How alike the two sides of a crossfade are, -1 to 1: sides that are the
// same music (a loop) fade at equal gain, different ones at equal power.
function correlation(src, a, b, length) {
  const x = mono(src, a, a + length);
  const y = mono(src, b, b + length);
  let xy = 0;
  let xx = 0;
  let yy = 0;
  for (let i = 0; i < length; i++) {
    xy += x[i] * y[i];
    xx += x[i] * x[i];
    yy += y[i] * y[i];
  }
  return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
}

function crossfadeGains(u, rho) {
  const a = Math.cos((Math.PI / 2) * u);
  const b = Math.sin((Math.PI / 2) * u);
  const norm = Math.sqrt(1 + Math.max(0, rho) * Math.sin(Math.PI * u));
  return [a / norm, b / norm];
}

const sCurve = (u) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, u)));

// src: { L, R } at 48 kHz. Returns the fitted { L, R } and where things
// ended up: segments, seams (with their crossfades), the fades.
function assemble(src, p, a, { length, fade }) {
  const total = Math.round(length * RATE);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const energy = p.mode === "energy";
  const segs = p.segments.map((s) => ({ ...s, src0: Math.round(s.srcStart * RATE), src1: Math.round(s.srcEnd * RATE) }));

  // Line up each seam's hits, then lay the segments end to end again from
  // the one that holds the drop.
  const window = energy ? 0 : Math.min(a.tempo.beat, 0.4);
  for (let s = 1; s < segs.length; s++) {
    segs[s].shift = energy ? 0 : align(src, segs[s - 1].src1, segs[s].src0, window);
    segs[s].src0 += segs[s].shift;
  }
  const pin = p.pin;
  segs[pin].out0 = p.hit ? Math.round(p.hit.out * RATE) - (Math.round(p.hit.src * RATE) - segs[pin].src0) : Math.round(p.segments[0].outStart * RATE);
  for (let s = pin + 1; s < segs.length; s++) segs[s].out0 = segs[s - 1].out0 + (segs[s - 1].src1 - segs[s - 1].src0);
  for (let s = pin - 1; s >= 0; s--) segs[s].out0 = segs[s + 1].out0 - (segs[s].src1 - segs[s].src0);

  // Each segment plays from its first sample in the output (the start of
  // its crossfade, or the top of the file) to where the next one has
  // taken over (or the end).
  const xf = Math.round((energy ? BLOCK_CROSSFADE : CROSSFADE) * RATE);
  const lead = energy ? -Math.round(xf / 2) : Math.round(LEAD * RATE);
  const seams = [];
  for (let s = 1; s < segs.length; s++) {
    const switchAt = segs[s].out0 - lead;
    const offA = segs[s - 1].src0 - segs[s - 1].out0;
    const offB = segs[s].src0 - segs[s].out0;
    const rho = correlation(src, switchAt - xf + offA, switchAt - xf + offB, xf);
    seams.push({ at: segs[s].out0, fadeFrom: switchAt - xf, fadeTo: switchAt, rho, shift: segs[s].shift || 0 });
  }

  // The head: from the top, the first segment's source runs on backwards
  // into whatever comes before its first bar (a pickup, the bar before, or
  // silence before the music starts).
  const startSrc = segs[0].src0 - segs[0].out0;
  const audibleStart = Math.round(a.start.audible * RATE);
  let fadeIn = 0;
  if (startSrc > audibleStart + Math.round(0.02 * RATE)) {
    // Starting inside the music: a swell into the first full bar when it
    // is near, a short fade when the start is part way into a bar.
    fadeIn = segs[0].out0 > 0 ? Math.min(segs[0].out0, Math.round(0.5 * RATE)) : Math.round(0.12 * RATE);
  } else fadeIn = Math.round(0.003 * RATE);

  // The tail.
  let fadeOut = null;
  let musicEnd = total;
  const lastSeg = segs[segs.length - 1];
  if (p.tail.kind === "natural") {
    const hitAt = lastSeg.out0 + (Math.round(a.ending.hit * RATE) - lastSeg.src0);
    const naturalEnd = lastSeg.out0 + (lastSeg.src1 - lastSeg.src0);
    if (naturalEnd > total) {
      const room = total - hitAt;
      const f = Math.max(Math.round(0.3 * RATE), Math.min(Math.round(3 * RATE), Math.round(room * 0.6)));
      fadeOut = { from: Math.max(hitAt + Math.round(0.1 * RATE), total - f), to: total };
    } else {
      // The ring-out stops where the track went quiet; a tenth of a second
      // of fade keeps what is left of the reverb from ending in a click.
      musicEnd = naturalEnd;
      fadeOut = { from: Math.max(hitAt, naturalEnd - Math.round(0.1 * RATE)), to: naturalEnd, quiet: true };
    }
    lastSeg.src1 = lastSeg.src0 + (Math.min(total, naturalEnd) - lastSeg.out0);
  } else {
    // A fade that ends on a beat: the last beat before the end, reached
    // over a bar (or --fade seconds, in whole beats) from a beat.
    lastSeg.src1 = lastSeg.src0 + (total - lastSeg.out0);
    if (energy) {
      const f = Math.round(Math.min(fade || 2, length / 3) * RATE);
      // Never over the hit: a hit late in the file rings first.
      const hitAt = p.hit ? Math.round(p.hit.out * RATE) : -1;
      const from = p.hit ? Math.max(total - f, hitAt + Math.round(Math.min(RATE, (total - hitAt) * 0.4))) : total - f;
      fadeOut = { from, to: total };
    } else {
      const beats = outputBeats(segs, a, total).filter((b) => b.sample <= total - Math.round(0.01 * RATE));
      const endBeat = beats.length ? beats[beats.length - 1] : { sample: total, index: 0 };
      const beatLen = Math.round(a.tempo.beat * RATE);
      const want = fade !== undefined ? Math.max(1, Math.round(fade / a.tempo.beat)) : a.meter;
      let fromBeat = endBeat.sample - want * beatLen;
      const hitAt = p.hit ? Math.round(p.hit.out * RATE) : -1;
      const floor = p.hit ? hitAt + beatLen : Math.round(Math.min(0.5, length / 4) * RATE);
      while (fromBeat < floor && fromBeat + beatLen < endBeat.sample) fromBeat += beatLen;
      fadeOut = { from: Math.max(0, fromBeat), to: endBeat.sample };
      musicEnd = endBeat.sample;
      // A hit in the last beat or so: it rings on to the end of the file.
      if (p.hit && endBeat.sample < hitAt + beatLen) {
        fadeOut = { from: hitAt + Math.round((total - hitAt) * 0.4), to: total };
        musicEnd = total;
      }
    }
  }

  // Lay down the samples.
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    const into = s > 0 ? seams[s - 1] : null;
    const out = s < segs.length - 1 ? seams[s] : null;
    const first = s === 0 ? 0 : into.fadeFrom;
    const last = out ? out.fadeTo : Math.min(total, musicEnd);
    const off = seg.src0 - seg.out0;
    for (let t = Math.max(0, first); t < Math.min(total, last); t++) {
      let g = 1;
      if (into && t < into.fadeTo) g *= crossfadeGains((t - into.fadeFrom) / (into.fadeTo - into.fadeFrom), into.rho)[1];
      if (out && t >= out.fadeFrom) g *= crossfadeGains((t - out.fadeFrom) / (out.fadeTo - out.fadeFrom), out.rho)[0];
      if (s === 0 && t < fadeIn) g *= sCurve(t / fadeIn);
      if (fadeOut && t >= fadeOut.from) g *= t >= fadeOut.to ? 0 : 1 - sCurve((t - fadeOut.from) / (fadeOut.to - fadeOut.from));
      const i = t + off;
      if (i < 0 || i >= src.L.length || g === 0) continue;
      L[t] += src.L[i] * g;
      R[t] += src.R[i] * g;
    }
  }

  const placed = segs.map((s) => ({
    firstBar: s.firstBar,
    lastBar: s.lastBar,
    srcStart: s.src0 / RATE,
    srcEnd: s.src1 / RATE,
    outStart: s.out0 / RATE,
    outEnd: (s.out0 + (s.src1 - s.src0)) / RATE,
  }));
  return {
    L,
    R,
    segments: placed,
    seams: seams.map((x, i) => ({ ...p.seams[i], out: x.at / RATE, crossfade: [x.fadeFrom / RATE, x.fadeTo / RATE], shift: x.shift / RATE })),
    fadeIn: fadeIn / RATE,
    fadeOut: fadeOut ? { from: fadeOut.from / RATE, to: fadeOut.to / RATE, quiet: !!fadeOut.quiet } : null,
    musicEnd: musicEnd / RATE,
    head: segs[0].out0 / RATE,
    startSource: startSrc / RATE,
    beats: energy ? [] : outputBeats(segs, a, total).map((b) => ({ time: b.sample / RATE, downbeat: b.downbeat })),
  };
}

// The source's beats where they land in the output, the head's included.
function outputBeats(segs, a, total) {
  const out = [];
  const beats = a.beats || [];
  const phase = a.downbeatPhase || 0;
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    // A segment lined up at its seam can start a few ms after its first
    // beat; that beat still belongs to it.
    const from = s === 0 ? seg.src0 - seg.out0 : seg.src0 - Math.round(0.03 * RATE);
    for (let i = 0; i < beats.length; i++) {
      const at = Math.round(beats[i] * RATE);
      if (at < from - 2 || at >= seg.src1 - 2) continue;
      const sample = seg.out0 + (at - seg.src0);
      if (sample < 0 || sample > total) continue;
      out.push({ sample, index: i, downbeat: (i - phase) % a.meter === 0 });
    }
  }
  out.sort((x, y) => x.sample - y.sample);
  // A seam can leave two beats a few samples apart; keep one.
  return out.filter((b, i) => i === 0 || b.sample - out[i - 1].sample > RATE * 0.05);
}

// ─── the voice ─────────────────────────────────────────────────────────────

// The level of each 10 ms of a sound, in dB.
function levels(audio) {
  const hop = RATE / 100;
  const n = Math.floor(audio.L.length / hop);
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let i = k * hop; i < (k + 1) * hop; i++) sum += ((audio.L[i] + audio.R[i]) / 2) ** 2;
    out[k] = 10 * Math.log10(sum / hop + 1e-12);
  }
  return out;
}

// How loud a sound is at its quietest: its quietest tenth, in dB. A room
// tone sits far down; a music bed or a tone that never stops does not.
function floorOf(audio) {
  const sorted = levels(audio).sort();
  return sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : -Infinity;
}

// Where the voice speaks: frames of 10 ms more than 20 dB below its loudest
// count as quiet, and so does anything within 10 dB of the room tone (the
// quietest tenth), so a few words over a long hiss are found too. Pauses
// under 0.6 s are bridged, blips under 0.12 s dropped. Returns [from, to]
// spans in seconds.
function speech(voice) {
  const level = levels(voice);
  const n = level.length;
  const sorted = Float64Array.from(level).sort();
  const loud = sorted[Math.floor(sorted.length * 0.995)];
  const room = sorted[Math.floor(sorted.length * 0.1)];
  const threshold = Math.max(-55, loud - 20, room + 10);
  const spans = [];
  let open = -1;
  for (let k = 0; k <= n; k++) {
    const on = k < n && level[k] > threshold;
    if (on && open < 0) open = k;
    if (!on && open >= 0) {
      spans.push([open / 100, k / 100]);
      open = -1;
    }
  }
  const bridged = [];
  for (const span of spans) {
    const last = bridged[bridged.length - 1];
    if (last && span[0] - last[1] < 0.6) last[1] = span[1];
    else bridged.push([...span]);
  }
  return bridged.filter(([a, b]) => b - a >= 0.12);
}

// Lowers the music by `depth` dB wherever the voice speaks, starting 0.15 s
// before it and coming back over 0.5 s after it stops.
function duck(music, spans, depth) {
  const floor = 10 ** (-depth / 20);
  const gain = new Float32Array(music.L.length).fill(1);
  const attack = Math.round(0.15 * RATE);
  const release = Math.round(0.5 * RATE);
  for (const [from, to] of spans) {
    const a = Math.round(from * RATE);
    const b = Math.round(to * RATE);
    for (let i = Math.max(0, a - attack); i < Math.min(gain.length, b + release); i++) {
      let g = floor;
      if (i < a) g = 1 - (1 - floor) * sCurve((i - (a - attack)) / attack);
      else if (i >= b) g = floor + (1 - floor) * sCurve((i - b) / release);
      if (g < gain[i]) gain[i] = g;
    }
  }
  for (let i = 0; i < gain.length; i++) {
    music.L[i] *= gain[i];
    music.R[i] *= gain[i];
  }
}

// ─── loudness ──────────────────────────────────────────────────────────────

function interleave({ L, R }) {
  const out = new Float32Array(L.length * 2);
  for (let i = 0; i < L.length; i++) {
    out[2 * i] = L[i];
    out[2 * i + 1] = R[i];
  }
  return out;
}

function scale({ L, R }, gain) {
  for (let i = 0; i < L.length; i++) {
    L[i] *= gain;
    R[i] *= gain;
  }
}

// Peaks between samples, as a 4x oversampled meter sees them: each gap
// between two samples is filled at its quarter points with a windowed sinc
// over 16 neighbours.
const TAPS = 8;
const PHASES = [0.25, 0.5, 0.75].map((frac) => {
  const k = new Float64Array(2 * TAPS);
  for (let j = 0; j < 2 * TAPS; j++) {
    const x = j - (TAPS - 1) - frac;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (TAPS + 0.5));
    k[j] = sinc * w;
  }
  return k;
});

function truePeaks(x) {
  const n = x.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let peak = Math.abs(x[i]);
    if (i >= TAPS - 1 && i + TAPS < n) {
      for (const k of PHASES) {
        let v = 0;
        for (let j = 0; j < 2 * TAPS; j++) v += k[j] * x[i - (TAPS - 1) + j];
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
    }
    out[i] = peak;
  }
  return out;
}

// A look-ahead limiter that keeps true peaks under `ceiling` (linear). The
// gain each sample needs is the lowest needed within the next 5 ms, then
// averaged over 5 ms, so it glides down before a peak and is low enough on
// it; it comes back over about 80 ms. No step is ever a jump, so it adds no
// click.
function limit({ L, R }, ceiling) {
  const n = L.length;
  const ahead = Math.round(0.005 * RATE);
  const pl = truePeaks(L);
  const pr = truePeaks(R);
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const peak = Math.max(pl[i], pr[i]);
    need[i] = peak > ceiling ? ceiling / peak : 1;
  }
  // The lowest need within [i, i + ahead], with a deque of minima.
  const lowest = new Float32Array(n);
  const deque = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && need[deque[tail - 1]] >= need[i]) tail--;
    deque[tail++] = i;
    while (deque[head] > i + ahead) head++;
    lowest[i] = need[deque[head]];
  }
  // Averaged over [i - ahead, i]: every value in that window covers sample
  // i, so the average is never above what sample i needs.
  const release = 1 - Math.exp(-1 / (0.08 * RATE));
  let sum = 0;
  let g = 1;
  for (let i = 0; i < n; i++) {
    sum += lowest[i];
    if (i > ahead) sum -= lowest[i - ahead - 1];
    const smooth = (sum + Math.max(0, ahead - i)) / (ahead + 1);
    g = smooth < g ? smooth : g + (smooth - g) * release;
    L[i] *= g;
    R[i] *= g;
  }
}

// Brings audio to `lufs` integrated with true peaks at or below `peak`
// dBTP, as ffmpeg's EBU R128 meter reads them: one gain, and the limiter
// only when that gain would push peaks over. A target too loud to reach
// under the peak limit is left short of it rather than clipped.
async function normalize(audio, { lufs, peak = -1 }) {
  const before = await measure(interleave(audio));
  if (!Number.isFinite(before.integrated)) return { before, after: before, gain: 0, limited: false };
  const gain = lufs - before.integrated;
  scale(audio, 10 ** (gain / 20));
  let after = { ...before, integrated: lufs, truePeak: before.truePeak + gain };
  if (after.truePeak <= peak) return { before, after: await measure(interleave(audio)), gain, limited: false };
  let ceiling = peak - 0.3;
  let raised = true;
  for (let round = 0; round < 4; round++) {
    limit(audio, 10 ** (ceiling / 20));
    after = await measure(interleave(audio));
    raised = false;
    if (after.truePeak > peak) {
      ceiling -= after.truePeak - peak + 0.1;
      continue;
    }
    // Limiting takes a little loudness off; give it back, then hold the
    // peaks again on the next round.
    const more = lufs - after.integrated;
    if (more <= 0.1) break;
    scale(audio, 10 ** (more / 20));
    raised = true;
  }
  // The last word is always the limiter's.
  for (let round = 0; round < 3 && (raised || after.truePeak > peak); round++) {
    if (after.truePeak > peak) ceiling -= after.truePeak - peak + 0.2;
    limit(audio, 10 ** (ceiling / 20));
    after = await measure(interleave(audio));
    raised = false;
  }
  return { before, after, gain, limited: true };
}

module.exports = { assemble, speech, floorOf, duck, normalize, interleave, scale, attackNear };
