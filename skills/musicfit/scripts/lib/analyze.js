"use strict";

// Finds what fitting a track needs: its beats and bar lines and how sure
// they are, the drop, the sections, and how the track starts and ends.
// It works on a mono copy at 24 kHz, in frames of 10 ms.

const dsp = require("./dsp");

const RATE = 24000;
const HOP = 240;
const FPS = RATE / HOP;

// ─── frames ────────────────────────────────────────────────────────────────

// Log mel bands, onset strength (the rise of each band from the frame
// before, summed) in three ranges, and power per frame.
function frameFeatures(x) {
  const SIZE = 1024;
  const bands = dsp.melBands(SIZE, RATE, 40, 30, 11000);
  const nb = bands.length;
  const n = Math.floor(x.length / HOP) + 1;
  const mel = new Float32Array(n * nb);
  const tmp = new Float64Array(nb);
  dsp.stft(x, {
    size: SIZE,
    hop: HOP,
    each: (t, mags) => {
      dsp.applyBands(bands, mags, tmp);
      for (let b = 0; b < nb; b++) mel[t * nb + b] = Math.log1p(1000 * tmp[b]);
    },
  });
  const lowEnd = bands.findIndex((band) => band.centre >= 200);
  const highStart = bands.findIndex((band) => band.centre >= 3500);
  const odf = new Float64Array(n);
  const low = new Float64Array(n);
  const mid = new Float64Array(n);
  const high = new Float64Array(n);
  for (let t = 1; t < n; t++) {
    for (let b = 0; b < nb; b++) {
      // The highest of the band and its neighbours a frame before, so a
      // note that bends does not read as a new one.
      let prev = mel[(t - 1) * nb + b];
      if (b > 0) prev = Math.max(prev, mel[(t - 1) * nb + b - 1]);
      if (b < nb - 1) prev = Math.max(prev, mel[(t - 1) * nb + b + 1]);
      const rise = mel[t * nb + b] - prev;
      if (rise <= 0) continue;
      odf[t] += rise;
      if (b < lowEnd) low[t] += rise;
      else if (b < highStart) mid[t] += rise;
      else high[t] += rise;
    }
  }
  // Power over 40 ms around each frame, and below 200 Hz from the bands.
  const sq = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) sq[i + 1] = sq[i] + x[i] * x[i];
  const power = new Float64Array(n);
  const lowPower = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    const a = Math.max(0, t * HOP - 480);
    const b = Math.min(x.length, t * HOP + 480);
    power[t] = b > a ? (sq[b] - sq[a]) / (b - a) : 0;
    let e = 0;
    for (let k = 0; k < lowEnd; k++) e += Math.expm1(mel[t * nb + k]) ** 2;
    lowPower[t] = e / 1e6;
  }
  return { n, nb, mel, odf, low, mid, high, power, lowPower };
}

// Pitch-class energy every 50 ms, from 8192-sample windows.
function chromaFrames(x) {
  const SIZE = 8192;
  const STEP = 1200;
  const map = dsp.chromaMap(SIZE, RATE, 65, 4000);
  const n = Math.floor(x.length / STEP) + 1;
  const chroma = new Float32Array(n * 12);
  const tmp = new Float64Array(12);
  dsp.stft(x, {
    size: SIZE,
    hop: STEP,
    each: (t, mags) => {
      dsp.applyChroma(map, mags, tmp);
      let sum = 0;
      for (let k = 0; k < 12; k++) sum += tmp[k];
      for (let k = 0; k < 12; k++) chroma[t * 12 + k] = sum > 1e-9 ? tmp[k] / sum : 0;
    },
  });
  return { n, chroma, step: STEP / RATE };
}

// ─── tempo ─────────────────────────────────────────────────────────────────

// How strongly the onsets repeat every `bpm` beat, from the autocorrelation
// of the onset strength at one to four beats.
function comb(acf, bpm) {
  const lag = (60 * FPS) / bpm;
  let sum = 0;
  for (let k = 1; k <= 4; k++) sum += dsp.at(acf, Math.min(acf.length - 1, k * lag));
  return sum / 4;
}

// Listeners tap most music between about 80 and 160 BPM; a log-normal
// weight around 115 says how likely a tempo is before the music is heard.
const prior = (bpm) => Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.9) ** 2);

// Ellis's dynamic programming beat tracker (as in librosa): every frame
// gets the best chain of beats ending there, each step close to `period`.
function trackBeats(odf, period, from, to, tightness = 100) {
  const n = to - from;
  const sd = dsp.std(odf.subarray(from, to)) || 1;
  const radius = Math.ceil(period);
  const kernel = new Float64Array(2 * radius + 1);
  for (let i = -radius; i <= radius; i++) kernel[i + radius] = Math.exp(-0.5 * ((i * 32) / period) ** 2);
  const local = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = t + k;
      if (j >= 0 && j < n) sum += (odf[from + j] / sd) * kernel[k + radius];
    }
    local[t] = sum;
  }
  const lo = Math.max(1, Math.round(period / 2));
  const hi = Math.round(period * 2);
  const penalty = new Float64Array(hi + 1);
  for (let d = lo; d <= hi; d++) penalty[d] = -tightness * Math.log(d / period) ** 2;
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  let maxLocal = 0;
  for (let t = 0; t < n; t++) maxLocal = Math.max(maxLocal, local[t]);
  let started = false;
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let d = lo; d <= hi; d++) {
      const s = t - d >= 0 ? cum[t - d] + penalty[d] : penalty[d];
      if (s > best) {
        best = s;
        arg = t - d;
      }
    }
    cum[t] = local[t] + best;
    if (!started && local[t] < 0.01 * maxLocal) back[t] = -1;
    else {
      back[t] = arg >= 0 ? arg : -1;
      started = true;
    }
  }
  // The last beat: the last local maximum of the running score that is
  // well up among the others.
  const maxima = [];
  for (let t = 1; t < n - 1; t++) if (cum[t] > cum[t - 1] && cum[t] >= cum[t + 1]) maxima.push(t);
  const med = dsp.median(maxima.map((t) => cum[t]));
  let last = n - 1;
  for (let i = maxima.length - 1; i >= 0; i--) {
    if (cum[maxima[i]] * 2 > med) {
      last = maxima[i];
      break;
    }
  }
  const beats = [];
  for (let t = last; t >= 0; t = back[t]) beats.push(t);
  beats.reverse();
  // Beats in silence or a ring-out at either end are only guesses; drop
  // them (extend() puts steady ones back).
  const strength = beats.map((t, i) => (local[beats[Math.max(0, i - 1)]] + 2 * local[t] + local[beats[Math.min(beats.length - 1, i + 1)]]) / 4);
  const threshold = 0.2 * Math.sqrt(dsp.mean(strength.map((s) => s * s)));
  let a = 0;
  let b = beats.length - 1;
  while (a < b && strength[a] <= threshold) a++;
  while (b > a && strength[b] <= threshold) b--;
  return { beats: beats.slice(a, b + 1).map((t) => t + from), local };
}

// Moves each beat onto the onset peak next to it, when there is one.
function refineBeats(odf, beats) {
  const peaks = beats.map((b) => dsp.peakNear(odf, b, 3));
  const typical = dsp.median(peaks.map((p) => p.value));
  return beats.map((b, i) => (peaks[i].value >= 0.3 * typical ? peaks[i].index : b));
}

// A straight line through the beats when the tempo holds, since a quantized
// track is best described by one; otherwise each beat on a line through its
// neighbours. Returns frame positions and whether the tempo is steady.
function regularize(beats) {
  const n = beats.length;
  const fit = (idx) => {
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (const i of idx) {
      sx += i;
      sy += beats[i];
      sxx += i * i;
      sxy += i * beats[i];
    }
    const m = idx.length;
    const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx);
    return { slope, start: (sy - slope * sx) / m };
  };
  let idx = beats.map((_, i) => i);
  let line = fit(idx);
  for (let round = 0; round < 2; round++) {
    const keep = idx.filter((i) => Math.abs(beats[i] - (line.start + line.slope * i)) < 4);
    if (keep.length < n * 0.6 || keep.length < 8) break;
    idx = keep;
    line = fit(idx);
  }
  const residuals = beats.map((b, i) => b - (line.start + line.slope * i));
  const rms = Math.sqrt(dsp.mean(residuals.map((r) => r * r)));
  const inliers = idx.length / n;
  const local = beats.map((_, i) => {
    const near = [];
    for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) near.push(j);
    const f = fit(near);
    return f.start + f.slope * i;
  });
  const localRms = Math.sqrt(dsp.mean(beats.map((b, i) => (b - local[i]) ** 2)));
  // Onsets of different drums peak a frame or two apart, so beats scatter a
  // little around even a perfect grid. The tempo holds when a straight line
  // fits about as well as a line through each beat's neighbours.
  if (inliers > 0.8 && (rms < 1.5 || rms < localRms * 1.3 + 0.5)) return { frames: beats.map((_, i) => line.start + line.slope * i), steady: true, period: line.slope, spread: rms };
  // A few beats the tracker put on an off-beat or a fill pull that line
  // away, and so does a skipped beat. The straight grid that four beats in
  // five sit on (within two frames), searched by period and phase, is then
  // the tempo, and the strays go back onto it.
  const grid = steadyGrid(beats);
  if (grid) return grid;
  return { frames: local, steady: false, period: dsp.median(local.slice(1).map((b, i) => b - local[i])), spread: rms };
}

function steadyGrid(beats) {
  const n = beats.length;
  if (n < 8) return null;
  const step = dsp.median(beats.slice(1).map((b, i) => b - beats[i]));
  const near = (b, p, phase) => Math.abs(b - phase - Math.round((b - phase) / p) * p) <= 2;
  // On a long track 400 beats spread over it are enough to find the grid.
  const sample = n > 400 ? Array.from({ length: 400 }, (_, i) => beats[Math.floor((i * n) / 400)]) : beats;
  let best = { on: -1 };
  for (let p = step * 0.98; p <= step * 1.02; p += 0.005) {
    for (let phase = 0; phase < p; phase += 0.25) {
      let on = 0;
      for (const b of sample) if (near(b, p, phase)) on++;
      if (on > best.on) best = { on, p, phase };
    }
  }
  if (best.on < 0.8 * sample.length) return null;
  // Least squares over the beats on it, by their place on the grid.
  let sk = 0, sb = 0, skk = 0, skb = 0, m = 0;
  for (const b of beats) {
    if (!near(b, best.p, best.phase)) continue;
    const k = Math.round((b - best.phase) / best.p);
    sk += k;
    sb += b;
    skk += k * k;
    skb += k * b;
    m++;
  }
  const slope = (m * skb - sk * sb) / (m * skk - sk * sk);
  const start = (sb - slope * sk) / m;
  let spread = 0;
  for (const b of beats) if (near(b, best.p, best.phase)) spread += (b - start - Math.round((b - start) / slope) * slope) ** 2;
  const frames = [];
  for (let k = Math.round((beats[0] - start) / slope); k <= Math.round((beats[n - 1] - start) / slope); k++) frames.push(start + slope * k);
  return { frames, steady: true, period: slope, spread: Math.sqrt(spread / m) };
}

// Beats on either side of the tracked ones, at the local period, so quiet
// passages at the start or end still have bar lines.
function extend(frames, from, to) {
  const out = frames.slice();
  if (out.length < 2) return out;
  const head = out.length > 8 ? (out[8] - out[0]) / 8 : out[1] - out[0];
  while (out[0] - head >= from - head * 0.25) out.unshift(out[0] - head);
  const m = out.length;
  const tail = m > 8 ? (out[m - 1] - out[m - 9]) / 8 : out[m - 1] - out[m - 2];
  while (out[out.length - 1] + tail <= to + tail * 0.25) out.push(out[out.length - 1] + tail);
  return out;
}

// For one tempo: beats, how strong they are, and how much the kick (low)
// and the snare or clap (above 200 Hz) take turns on them: a backbeat says
// this is the level people clap to. It is judged sixteen beats at a time,
// since intros and breaks often have no drums at all.
function level(feat, bpm, from, to) {
  const period = (60 * FPS) / bpm;
  let { beats } = trackBeats(feat.odf, period, from, to);
  if (beats.length < 8) return null;
  const strength = (arr, b) => dsp.peakNear(arr, b, 3).value;
  // Claps or hats on every off-beat, louder than the kick under them, pull
  // the tracker half a beat over. The kick is where people tap, so when
  // the kicks all fall between the beats found, the beats move onto them.
  const kickRatio = (bs) => dsp.mean(bs.slice(1).map((b, i) => strength(feat.low, (b + bs[i]) / 2))) / Math.max(1e-9, dsp.mean(bs.map((b) => strength(feat.low, b))));
  if (kickRatio(beats) > 1.5) {
    const between = beats.slice(1).map((b, i) => Math.round((b + beats[i]) / 2));
    if (kickRatio(between) < 0.8) beats = between;
  }
  const full = beats.map((b) => strength(feat.odf, b));
  const on = dsp.mean(full);
  const typical = dsp.median(full);
  const low = beats.map((b) => strength(feat.low, b));
  const upper = beats.map((b) => strength(feat.mid, b) + strength(feat.high, b));
  const high = beats.map((b) => strength(feat.high, b));
  const turns = [];
  const turnOf = (s) => (s[0] - s[1]) / (s[0] + s[1] + 1e-9);
  for (let w = 0; w + 16 <= beats.length || (w === 0 && beats.length >= 8); w += 8) {
    const end = Math.min(beats.length, w + 16);
    const sums = { low: [0, 0], upper: [0, 0], high: [0, 0] };
    for (let i = w; i < end; i++) {
      sums.low[i % 2] += low[i];
      sums.upper[i % 2] += upper[i];
      sums.high[i % 2] += high[i];
    }
    const lowTurn = turnOf(sums.low);
    // A snare or clap shows best above 3.5 kHz: lower down, chords and the
    // kick's click can fill the beats it leaves out and hide its turns.
    const upTurn = [turnOf(sums.upper), turnOf(sums.high)].reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
    // Kick on one parity and snare on the other, or a kick on every beat
    // with a snare or clap on every other one. Kick and snare both stronger
    // on the same parity is a beat and its off-beat, not a backbeat.
    // Beats that land on nothing every other time are a wrong tempo, not
    // a backbeat.
    let empty = 0;
    for (let i = w; i < end; i++) if (full[i] < 0.15 * typical) empty++;
    let turn = 0;
    if (empty <= 0.35 * (end - w)) {
      if (lowTurn * upTurn < 0) turn = Math.min(Math.abs(lowTurn), Math.abs(upTurn)) * 2 + (Math.abs(lowTurn) + Math.abs(upTurn)) / 2;
      else if (Math.abs(lowTurn) < 0.15) turn = Math.max(0, Math.abs(upTurn) - 0.15);
    }
    turns.push(turn);
    if (end === beats.length) break;
  }
  // A kick as strong between these beats as on them means the pulse is
  // faster than this.
  const lowBetween = dsp.mean(beats.slice(1).map((b, i) => strength(feat.low, (b + beats[i]) / 2)));
  const kickBetween = lowBetween / Math.max(1e-9, dsp.mean(low));
  // How far the steps between beats stray from the period: a tempo the
  // music does not have makes the tracker hop between kicks and claps.
  const stray = dsp.median(beats.slice(1).map((b, i) => Math.abs(b - beats[i] - period))) / period;
  return { bpm, beats, on, backbeat: dsp.percentile(turns, 75), kickBetween, stray };
}

// The tempo: the period the onsets repeat at most strongly, then which of
// its doublings and halvings (or, for three beats to a bar, its thirds) is
// the beat, weighed by how likely each tempo is, a backbeat, how strong the
// onsets on the beats are, and a kick between them.
function estimateTempo(feat, from, to, { bpm: forced } = {}) {
  const odf = feat.odf.subarray(from, to);
  const base = dsp.smooth(odf, 50);
  const env = Float64Array.from(odf, (v, i) => Math.max(0, v - base[i]));
  const acf = dsp.autocorrelation(env, 1000);
  if (forced) {
    const chosen = level(feat, forced, from, to);
    return { chosen, acf, pulse: comb(acf, forced), alternatives: [], family: forced };
  }
  let best = { bpm: 120, value: -Infinity };
  for (let bpm = 40; bpm <= 240; bpm += 0.1) {
    const value = comb(acf, bpm);
    if (value > best.value) best = { bpm, value };
  }
  // Refine to a hundredth of a beat per minute, around where the search
  // found it: where the curve has no peak, as a steady tone has none, a
  // bound that moved with the best would climb without end.
  const around = best.bpm;
  for (let bpm = around - 0.1; bpm <= around + 0.1; bpm += 0.01) {
    const value = comb(acf, bpm);
    if (value > best.value) best = { bpm, value };
  }
  // The strongest period is the beat, or a bar, or a run of even notes:
  // the beat is a whole fraction or multiple of it.
  const ratios = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 3 / 2, 2, 3, 4, 6];
  const candidates = ratios.map((r) => ({ bpm: best.bpm * r, odd: r === 1 / 3 || r === 2 / 3 || r === 3 / 2 || r === 3 || r === 6, offBeats: r === 1 / 3 || r === 2 / 3 })).filter((c) => c.bpm >= 50 && c.bpm <= 210);
  const levels = candidates.map((c) => Object.assign(level(feat, c.bpm, from, to) || {}, c)).filter((lv) => lv.beats);
  if (!levels.length) return { chosen: null, acf, pulse: best.value, alternatives: [], family: best.bpm };
  const meanOdf = dsp.mean(odf) || 1;
  for (const lv of levels) {
    // A tempo two thirds (or a third) of the strongest period puts every
    // other beat halfway between two of its pulses, on an off-beat, and a
    // kick then a hat taking turns reads as a backbeat that is not there.
    // Beats that hop instead of keeping a pulse show one too.
    const backbeat = lv.offBeats || lv.stray > 0.05 ? 0 : lv.backbeat;
    lv.score = Math.log(prior(lv.bpm)) + 1.6 * backbeat + 0.4 * Math.log(Math.max(lv.on, 1e-9) / meanOdf) - 1.5 * Math.max(0, lv.kickBetween - 0.6);
    // Such a tempo has to be clearly better.
    if (lv.odd) lv.score -= 0.3;
  }
  levels.sort((a, b) => b.score - a.score);
  const chosen = levels[0];
  const relation = (lv) => {
    const ratio = lv.bpm / chosen.bpm;
    const named = [[0.25, "quarter"], [1 / 3, "third"], [0.5, "half"], [2 / 3, "two thirds"], [1.5, "one and a half times"], [2, "double"], [3, "triple"], [4, "quadruple"]];
    const hit = named.find(([r]) => Math.abs(ratio / r - 1) < 0.02);
    return hit ? hit[1] : ratio < 1 ? "slower" : "faster";
  };
  const alternatives = levels.slice(1).map((lv) => ({
    bpm: lv.bpm,
    relation: relation(lv),
    // 1 means as likely as the chosen tempo, 0 means not at all.
    likelihood: Math.exp(lv.score - chosen.score),
  }));
  return { chosen, acf, pulse: comb(acf, chosen.bpm), alternatives, family: best.bpm };
}

// Three beats to a bar or four. Two things have to agree on three: the
// beat-by-beat accents of a bar line (a kick, a change of chord or of
// loudness), and the onsets, repeating after three and six beats more than
// after four and eight. Even notes repeat after any number of beats, and an
// arpeggio of three notes after three, so four stays unless both say three.
function findMeter(acf, period, bf) {
  const n = bf.full.length;
  const hc = new Float64Array(n);
  for (let i = 1; i < n; i++) hc[i] = 1 - dsp.cosine(bf.chroma[i - 1], bf.chroma[i]);
  const change = new Float64Array(n);
  for (let i = 2; i < n - 2; i++) change[i] = Math.abs((bf.loud[i] + bf.loud[i + 1]) / 2 - (bf.loud[i - 2] + bf.loud[i - 1]) / 2);
  const [zl, zh, zc] = [zscore(bf.low), zscore(hc), zscore(change)];
  const accent = Float64Array.from({ length: n }, (_, i) => zl[i] + 1.2 * zh[i] + 0.6 * Math.max(0, zc[i]));
  const a = dsp.autocorrelation(accent, 8);
  const at = (k) => (k * period < acf.length - 1 ? dsp.at(acf, k * period) : 0);
  const accents = { three: a[3] + a[6], four: a[4] + a[8] };
  const onsets = { three: at(3) + at(6), four: at(4) + at(8) };
  const three = accents.three > accents.four + 0.1 && onsets.three > onsets.four;
  const maybe = !three && accents.three > accents.four - 0.05 && onsets.three > onsets.four - 0.05;
  return { meter: three ? 3 : 4, maybe };
}

// ─── bars ──────────────────────────────────────────────────────────────────

function beatFeatures(feat, chroma, beats) {
  const n = beats.length;
  const strength = (arr, b) => dsp.peakNear(arr, Math.max(1, Math.min(arr.length - 2, b)), 3).value;
  const out = { low: new Float64Array(n), mid: new Float64Array(n), full: new Float64Array(n), loud: new Float64Array(n), lowLoud: new Float64Array(n), chroma: [], timbre: [] };
  const nb = feat.nb;
  for (let i = 0; i < n; i++) {
    const a = beats[i];
    const b = i + 1 < n ? beats[i + 1] : beats[i] + (beats[i] - beats[Math.max(0, i - 1)] || 50);
    out.low[i] = strength(feat.low, a);
    out.mid[i] = strength(feat.mid, a);
    out.full[i] = strength(feat.odf, a);
    const f0 = Math.max(0, Math.round(a));
    const f1 = Math.min(feat.n, Math.max(f0 + 1, Math.round(b)));
    out.loud[i] = dsp.db(dsp.mean(feat.power, f0, f1));
    out.lowLoud[i] = dsp.db(dsp.mean(feat.lowPower, f0, f1));
    // Timbre: the mean log mel spectrum's cosine transform, without its
    // first term (loudness).
    const melMean = new Float64Array(nb);
    for (let t = f0; t < f1; t++) for (let k = 0; k < nb; k++) melMean[k] += feat.mel[t * nb + k] / (f1 - f0);
    const timbre = new Float64Array(12);
    for (let c = 1; c <= 12; c++) {
      let sum = 0;
      for (let k = 0; k < nb; k++) sum += melMean[k] * Math.cos((Math.PI * c * (k + 0.5)) / nb);
      timbre[c - 1] = sum / nb;
    }
    out.timbre.push(timbre);
    const c0 = Math.max(0, Math.floor(a / FPS / chroma.step));
    const c1 = Math.min(chroma.n, Math.max(c0 + 1, Math.ceil(b / FPS / chroma.step)));
    const vec = new Float64Array(12);
    for (let t = c0; t < c1; t++) for (let k = 0; k < 12; k++) vec[k] += chroma.chroma[t * 12 + k];
    out.chroma.push(vec);
  }
  return out;
}

const zscore = (arr) => {
  const m = dsp.mean(arr);
  const s = dsp.std(arr) || 1;
  return Float64Array.from(arr, (v) => (v - m) / s);
};

// Which beat of each bar is the one: the kick, a change of chord and a
// change of loudness point at it, a snare or clap points away from it.
function findDownbeats(bf, meter, hint) {
  const n = bf.full.length;
  const hc = new Float64Array(n);
  for (let i = 1; i < n; i++) hc[i] = 1 - dsp.cosine(bf.chroma[i - 1], bf.chroma[i]);
  const change = new Float64Array(n);
  for (let i = 2; i < n - 2; i++) change[i] = Math.abs((bf.loud[i] + bf.loud[i + 1]) / 2 - (bf.loud[i - 2] + bf.loud[i - 1]) / 2);
  const [zl, zm, zh, zf, zc] = [zscore(bf.low), zscore(bf.mid), zscore(hc), zscore(bf.full), zscore(change)];
  const score = Float64Array.from({ length: n }, (_, i) => zl[i] - 0.6 * zm[i] + 1.2 * zh[i] + 0.4 * zf[i] + 0.6 * Math.max(0, zc[i]));
  const phaseScores = (from, to) => {
    const sums = new Float64Array(meter);
    const counts = new Float64Array(meter);
    for (let i = from; i < to; i++) {
      sums[i % meter] += score[i];
      counts[i % meter]++;
    }
    return Array.from(sums, (s, k) => (counts[k] ? s / counts[k] : -Infinity));
  };
  const all = phaseScores(0, n);
  if (hint !== undefined && hint !== null) all[((hint % meter) + meter) % meter] += 1.5;
  const order = all.map((s, k) => [s, k]).sort((a, b) => b[0] - a[0]);
  const phase = order[0][1];
  // How many stretches of eight bars agree on it.
  let agree = 0;
  let windows = 0;
  for (let from = 0; from + meter * 8 <= n; from += meter * 4) {
    const local = phaseScores(from, from + meter * 8);
    const top = local.indexOf(Math.max(...local));
    windows++;
    if (top === phase) agree++;
  }
  const margin = order.length > 1 ? order[0][0] - order[1][0] : 1;
  return { phase, margin, agreement: windows ? agree / windows : 1 };
}

function barFeatures(feat, bf, beats, bars, meter) {
  const out = [];
  // The first sound after silence reads as a huge onset; capped, it does
  // not make the first bar look unlike every other.
  const cap = dsp.percentile(Array.from(bf.full), 90);
  for (const bar of bars) {
    const idx = [];
    for (let i = bar.beat; i < bar.beat + meter && i < beats.length; i++) idx.push(i);
    const chroma = new Float64Array(12);
    const timbre = new Float64Array(12);
    for (const i of idx) {
      for (let k = 0; k < 12; k++) {
        chroma[k] += bf.chroma[i][k];
        timbre[k] += bf.timbre[i][k] / idx.length;
      }
    }
    const f0 = Math.max(0, Math.round(bar.start * FPS));
    const f1 = Math.min(feat.n, Math.max(f0 + 1, Math.round(bar.end * FPS)));
    // Onsets at sixteen points of the bar, between its beats.
    const rhythm = new Float64Array(meter * 4);
    for (let k = 0; k < meter * 4; k++) {
      const b = bar.beat + k / 4;
      const i = Math.floor(b);
      const next = i + 1 < beats.length ? beats[i + 1] : beats[i] + (beats[i] - beats[i - 1]);
      const frame = beats[Math.min(i, beats.length - 1)] + (b - i) * (next - beats[Math.min(i, beats.length - 1)]);
      rhythm[k] = Math.min(cap, dsp.peakNear(feat.odf, Math.max(1, Math.min(feat.n - 2, frame)), 2).value);
    }
    // The mean log mel band, as decibels of the bands' geometric mean: it
    // rises as more of the spectrum fills.
    let fullness = 0;
    for (let t = f0; t < f1; t++) for (let k = 0; k < feat.nb; k++) fullness += feat.mel[t * feat.nb + k];
    fullness = (8.69 * fullness) / ((f1 - f0) * feat.nb);
    out.push({
      chroma,
      timbre,
      rhythm,
      fullness,
      loud: dsp.db(dsp.mean(feat.power, f0, f1)),
      low: dsp.db(dsp.mean(feat.lowPower, f0, f1)),
    });
  }
  return out;
}

// How different two bars sound: harmony, timbre, loudness and rhythm, each
// scaled by how much bars of this track differ in it.
function barDistance(features) {
  const n = features.length;
  const parts = ["chroma", "timbre", "loud", "rhythm"];
  const raw = (a, b, part) => {
    if (part === "chroma") return 1 - dsp.cosine(a.chroma, b.chroma);
    if (part === "rhythm") return 1 - dsp.cosine(a.rhythm, b.rhythm);
    if (part === "timbre") return dsp.distance(a.timbre, b.timbre);
    return Math.abs(a.loud - b.loud) / 6;
  };
  const scale = {};
  // Bars of a loop differ by next to nothing, which would make any small
  // difference look huge; these floors are differences a listener barely
  // notices (a chord sharing notes, a hat moved, a decibel and a half).
  const floor = { chroma: 0.15, rhythm: 0.08, timbre: 0.15, loud: 0.25 };
  for (const part of parts) {
    const values = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j += Math.max(1, Math.floor(n / 40))) values.push(raw(features[i], features[j], part));
    scale[part] = Math.max(floor[part], dsp.median(values));
  }
  const weight = { chroma: 0.35, timbre: 0.3, loud: 0.15, rhythm: 0.2 };
  const cache = new Map();
  return (i, j) => {
    if (i === j) return 0;
    if (i < 0 || j < 0 || i >= n || j >= n) return 2;
    const key = i < j ? i * n + j : j * n + i;
    if (cache.has(key)) return cache.get(key);
    let d = 0;
    for (const part of parts) d += weight[part] * Math.min(6, raw(features[i], features[j], part) / scale[part]);
    cache.set(key, d);
    return d;
  };
}

// Where sections change: bars whose four bars before and four after sound
// unlike each other and like themselves.
function novelty(dist, n, size = 4) {
  const out = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a0 = Math.max(0, i - size);
    const b1 = Math.min(n, i + size);
    let cross = 0;
    let crossN = 0;
    let within = 0;
    let withinN = 0;
    for (let a = a0; a < i; a++) {
      for (let b = i; b < b1; b++) {
        cross += dist(a, b);
        crossN++;
      }
      for (let a2 = a + 1; a2 < i; a2++) {
        within += dist(a, a2);
        withinN++;
      }
    }
    for (let b = i; b < b1; b++) {
      for (let b2 = b + 1; b2 < b1; b2++) {
        within += dist(b, b2);
        withinN++;
      }
    }
    out[i] = (crossN ? cross / crossN : 0) - (withinN ? within / withinN : 0);
  }
  return out;
}

function sectionStarts(nov, n) {
  const values = Array.from(nov).slice(1);
  const threshold = dsp.median(values) + 1.2 * dsp.median(values.map((v) => Math.abs(v - dsp.median(values))));
  const peaks = [];
  for (let i = 1; i < n; i++) {
    if (nov[i] > threshold && nov[i] >= (nov[i - 1] || 0) && nov[i] >= (nov[i + 1] || 0)) peaks.push(i);
  }
  // Keep the strongest of peaks closer than four bars.
  peaks.sort((a, b) => nov[b] - nov[a]);
  const kept = [];
  for (const p of peaks) if (kept.every((k) => Math.abs(k - p) >= 4)) kept.push(p);
  return [0, ...kept.sort((a, b) => a - b)];
}

// ─── the whole track ───────────────────────────────────────────────────────

function audibleRange(feat) {
  const dbs = Array.from(feat.power, dsp.db);
  const loud = dsp.percentile(dbs, 95);
  const floor = Math.max(-70, loud - 45);
  let start = 0;
  while (start < feat.n - 1 && dbs[start] < floor) start++;
  let end = feat.n - 1;
  while (end > start && dbs[end] < floor) end--;
  return { start, end, loud, dbs };
}

// options: { bpm, meter, drop } where drop is in seconds.
function analyze(x, options = {}) {
  const feat = frameFeatures(x);
  const chroma = chromaFrames(x);
  const duration = x.length / RATE;
  const audible = audibleRange(feat);
  const warnings = [];
  const result = { duration, meter: options.meter || 4, warnings, audible: { start: audible.start / FPS, end: audible.end / FPS }, loud: audible.loud };

  const span = audible.end - audible.start;
  const tempo = span > 4 * FPS ? estimateTempo(feat, audible.start, audible.end + 1, options) : { chosen: null, pulse: 0, alternatives: [] };
  if (!tempo.chosen) {
    result.tempo = null;
    result.confidence = { beat: 0, octave: 0, downbeat: 0 };
    if (audible.loud < -60) warnings.push("The track is silent.");
    else warnings.push(span > 4 * FPS ? "No steady beat found, so the cuts follow the music's energy instead of bar lines." : "The track is too short to find a beat in.");
    return finishEnergy(result, feat, chroma, audible, options);
  }

  // Beats at the chosen tempo, moved onto their onsets, made regular, and
  // extended over quiet passages at either end.
  const reg = regularize(refineBeats(feat.odf, tempo.chosen.beats));
  const frames = extend(reg.frames, audible.start, audible.end);
  const beats = frames.map((f) => f / FPS);
  const bpm = (60 * FPS) / reg.period;
  const scale = bpm / tempo.chosen.bpm;

  // How sure the beat is: how much the onsets repeat at the beat, and how
  // much stronger they are on the beats than between them.
  const bf = beatFeatures(feat, chroma, frames);
  const found = findMeter(tempo.acf, reg.period, bf);
  const meter = options.meter || found.meter;
  result.meter = meter;
  const between = frames.slice(1).map((f, i) => dsp.peakNear(feat.odf, (f + frames[i]) / 2, 2).value);
  const contrast = dsp.mean(bf.full) / Math.max(1e-9, dsp.mean(Float64Array.from(between)) * 0.5 + dsp.mean(feat.odf.subarray(audible.start, audible.end)) * 0.5);
  const beatConfidence = Math.max(0, Math.min(1, (tempo.pulse - 0.05) / 0.25)) * 0.5 + Math.max(0, Math.min(1, (contrast - 1) / 1.5)) * 0.5;
  const octave = tempo.alternatives.filter((a) => a.relation === "half" || a.relation === "double");
  const octaveDoubt = Math.max(0, ...octave.map((a) => a.likelihood));

  // Bar lines. A drop given by the user is a downbeat by definition.
  let hint = null;
  if (options.drop !== undefined) {
    const at = options.drop * FPS;
    let nearest = 0;
    for (let i = 1; i < frames.length; i++) if (Math.abs(frames[i] - at) < Math.abs(frames[nearest] - at)) nearest = i;
    hint = nearest;
  }
  const down = findDownbeats(bf, meter, hint);
  const bars = [];
  for (let b = down.phase; b + meter < beats.length; b += meter) bars.push({ start: beats[b], end: beats[b + meter], beat: b });
  // The bar that is still sounding when the track ends.
  if (bars.length && down.phase + bars.length * meter < beats.length) {
    const b = down.phase + bars.length * meter;
    bars.push({ start: beats[b], end: beats[b] + (reg.period / FPS) * meter, beat: b, partial: true });
  }
  result.tempo = {
    bpm,
    beat: 60 / bpm,
    bar: (60 / bpm) * meter,
    steady: reg.steady,
    spread: reg.spread / FPS,
    alternatives: tempo.alternatives.map((a) => ({ bpm: a.bpm * scale, relation: a.relation, likelihood: a.likelihood })),
  };
  result.confidence = {
    beat: beatConfidence,
    octave: 1 - octaveDoubt,
    downbeat: Math.max(0, Math.min(1, down.margin / 0.8)) * 0.5 + down.agreement * 0.5,
  };
  if (bars.length < 3) {
    warnings.push("The track is too short for whole bars, so the cuts follow its energy.");
    return finishEnergy(result, feat, chroma, audible, options);
  }

  const features = barFeatures(feat, bf, frames, bars, meter);
  const dist = barDistance(features);
  const nov = novelty(dist, bars.length);
  result.beats = beats;
  result.downbeatPhase = down.phase;
  result.bars = bars;
  result.barFeatures = features;
  result.distance = dist;
  result.novelty = nov;
  result.sections = sectionStarts(nov, bars.length);

  // With no usable beat, what it might have been is beside the point.
  if (beatConfidence < 0.3) {
    warnings.push("The beat is weak, so the cuts follow the music's energy instead of bar lines.");
    return finishEnergy(result, feat, chroma, audible, options);
  }
  if (!reg.steady) warnings.push(`The tempo wanders (beats stray ${Math.round((reg.spread / FPS) * 1000)} ms from a steady pulse), so the bar lines follow it beat by beat.`);
  if (meter === 3 && !options.meter) warnings.push("The bars have three beats, not four. If the cuts sound off, run again with --meter 4.");
  if (meter === 4 && !options.meter && found.maybe) warnings.push("The bars may have three beats, not four. If the cuts sound off, run again with --meter 3.");
  if (octaveDoubt > 0.5) {
    const alt = octave.find((a) => a.likelihood === octaveDoubt);
    warnings.push(`The tempo could also be ${(alt.bpm * scale).toFixed(1)} BPM (${alt.relation} of ${bpm.toFixed(1)}). ${alt.relation === "half" ? "Cuts are made in pairs of bars, which is safe either way." : "A bar at that tempo is half of one of these, so cuts stay on its bar lines too."} If you know the tempo, pass --bpm.`);
  }
  if (result.confidence.downbeat < 0.45) warnings.push("Where each bar starts is not clear, so a cut can land a beat or two off the bar line. Listen to the seams.");

  // Cut in pairs of bars when the slower tempo is a real possibility: a
  // bar at the slower tempo is two of these.
  const half = octave.find((a) => a.relation === "half");
  result.mode = half && half.likelihood > 0.5 ? "phrases" : "bars";
  result.unitBars = result.mode === "phrases" ? 2 : 1;

  findStartEnd(result, feat, audible);
  findDrop(result, feat, options);
  return result;
}

// The drop: the first time the track reaches its fullest after a quieter
// stretch, on a phrase line (every four bars) when it can be. Fullness is
// loudness and how much of the spectrum is busy, since adding hats, a lead
// and a crash barely moves the level.
function findDrop(result, feat, options) {
  const { bars, barFeatures: features, novelty: nov } = result;
  const n = bars.length;
  if (options.drop !== undefined) {
    let nearest = 0;
    for (let i = 1; i < n; i++) if (Math.abs(bars[i].start - options.drop) < Math.abs(bars[nearest].start - options.drop)) nearest = i;
    // Within a quarter beat of a bar line, the drop is that bar line;
    // otherwise the time is taken as given, inside its bar.
    const near = Math.abs(bars[nearest].start - options.drop) <= result.tempo.beat * 0.25;
    let bar = nearest;
    if (!near) {
      bar = bars.findIndex((b) => b.start <= options.drop && options.drop < b.end);
      if (bar < 0) bar = nearest;
    }
    const offset = near ? 0 : options.drop - bars[bar].start;
    result.drop = { bar, time: bars[bar].start + offset, offset, given: true, clear: true, candidates: [] };
    return;
  }
  // The music before the ending: a final hit and its bar are not a drop.
  const last = result.ending.kind === "hit" ? result.ending.bar : Math.min(n, result.ending.fadedFrom);
  const full = features.map((f) => f.loud + 0.2 * f.fullness);
  const span = (i) => dsp.mean(Float64Array.from(full.slice(i, Math.max(i + 1, Math.min(i + 4, last)))));
  let top = -Infinity;
  for (let i = 0; i < last; i++) top = Math.max(top, span(i));
  const onset = bars.map((b) => dsp.peakNear(feat.odf, Math.max(1, b.start * FPS), 3).value);
  const impact = zscore(onset);
  const novZ = zscore(nov);
  const first = result.start.firstBar;
  const candidates = [];
  for (let i = first + 2; i < last - 1; i++) {
    if (bars[i].partial) continue;
    const rise = span(i) - dsp.median(full.slice(Math.max(first, i - 4), i));
    const level = span(i) - top;
    const phrase = (i - first) % 4 === 0 ? 2 : (i - first) % 2 === 0 ? 1 : 0;
    const score = rise / 3 + Math.max(0, novZ[i]) + 0.5 * Math.max(0, impact[i]) + 0.5 * phrase + level / 2;
    candidates.push({ bar: i, time: bars[i].start, rise, level, phrase, score });
  }
  if (!candidates.length) {
    result.drop = null;
    return;
  }
  // A clear drop is a change point: inside the loud part that follows it,
  // the four bars before a bar already include some of it, and the rise
  // seen there shrinks.
  const riseNear = (c) => Math.max(...candidates.filter((o) => Math.abs(o.bar - c.bar) <= 2).map((o) => o.rise));
  const clear = candidates.filter((c) => c.rise >= 3 && c.level >= -1.5 && c.rise >= 0.75 * riseNear(c));
  let pick;
  if (clear.length) {
    const best = Math.max(...clear.map((c) => c.phrase));
    pick = clear.find((c) => c.phrase === best);
  } else pick = candidates.reduce((a, c) => (c.score > a.score ? c : a));
  const others = candidates.filter((c) => c !== pick).sort((a, b) => b.score - a.score);
  const listed = [pick];
  for (const c of others) if (listed.length < 3 && listed.every((p) => Math.abs(p.bar - c.bar) >= 4)) listed.push(c);
  result.drop = { bar: pick.bar, time: pick.time, offset: 0, given: false, clear: clear.includes(pick), rise: pick.rise, candidates: listed.map((c) => ({ bar: c.bar, time: c.time, rise: c.rise })) };
}

// How the track starts (a pickup before the first bar line?) and ends: on
// a final hit that rings out, with a fade, or cut off.
function findStartEnd(result, feat, audible) {
  const { bars, beats } = result;
  // The first bar is the one the music starts in, when it starts early in
  // it (a pad that swells in reaches the meter a little late); music that
  // starts later in a bar is a pickup into the next.
  const start = audible.start / FPS;
  let firstBar = bars.findIndex((b) => b.start <= start && start < b.end);
  if (firstBar < 0) firstBar = 0;
  else if (start - bars[firstBar].start > 0.2 * (bars[firstBar].end - bars[firstBar].start)) firstBar = Math.min(bars.length - 1, firstBar + 1);
  result.start = { audible: start, firstBar, pickup: Math.max(0, bars[firstBar].start - start) };

  const dbs = audible.dbs;
  const end = audible.end;
  const typical = dsp.median(bars.map((b) => dsp.peakNear(feat.odf, Math.max(1, b.start * FPS), 3).value));
  // The last strong onset on a beat, and what follows it.
  let hitBeat = -1;
  for (let i = beats.length - 1; i >= 0; i--) {
    const f = beats[i] * FPS;
    if (f > end) continue;
    if (dsp.peakNear(feat.odf, Math.max(1, f), 3).value >= 0.5 * typical) {
      hitBeat = i;
      break;
    }
  }
  const ending = { kind: "none", audibleEnd: end / FPS, fadedFrom: bars.length };
  if (hitBeat >= 0) {
    const hitFrame = Math.round(beats[hitBeat] * FPS);
    // Notes inside the hit's own beat (the end of a fill, an off-beat on
    // the last chord) still belong to the hit; after that, nothing.
    const nextBeat = hitBeat + 1 < beats.length ? Math.round(beats[hitBeat + 1] * FPS) - 3 : hitFrame + 15;
    let after = 0;
    for (let f = Math.max(hitFrame + 15, nextBeat); f <= end; f++) after = Math.max(after, feat.odf[f]);
    const tail = (end - hitFrame) / FPS;
    const atHit = dsp.mean(Float64Array.from(dbs.slice(hitFrame, hitFrame + 10)));
    const atEnd = dsp.mean(Float64Array.from(dbs.slice(Math.max(hitFrame, end - 20), end + 1)));
    if (tail >= 0.6 && after < 0.3 * typical && atHit - atEnd >= 10) {
      // The bar the hit falls in: the hit is its first beat as a rule.
      let bar = bars.findIndex((b) => b.start <= beats[hitBeat] + 0.01 && beats[hitBeat] < b.end - 0.01);
      if (bar < 0) bar = bars.length - 1;
      ending.kind = "hit";
      ending.hit = beats[hitBeat];
      ending.bar = bar;
      ending.tailEnd = Math.min(result.duration, end / FPS + 0.15);
    }
  }
  if (ending.kind === "none") {
    const barLoud = (b) => dsp.db(dsp.mean(feat.power, Math.round(b.start * FPS), Math.max(Math.round(b.start * FPS) + 1, Math.round(b.end * FPS))));
    const lastBars = bars.filter((b) => b.end <= end / FPS + 0.01);
    const loud = lastBars.map(barLoud);
    const main = dsp.percentile(loud, 75);
    const lastLoud = dsp.mean(Float64Array.from(dbs.slice(Math.max(0, end - 15), end + 1)));
    if (loud.length >= 4 && loud[loud.length - 1] < main - 8 && loud[loud.length - 2] < loud[loud.length - 4]) ending.kind = "fade";
    else if (lastLoud > audible.loud - 12) ending.kind = "cut";
    // Bars that are fading out are not music to build on.
    if (ending.kind === "fade") {
      let i = bars.length - 1;
      while (i > 0 && barLoud(bars[i]) < main - 5) i--;
      ending.fadedFrom = i + 1;
    }
  }
  result.ending = ending;
}

// No usable beat: cut in half-second blocks where the music sounds alike,
// with long crossfades.
function finishEnergy(result, feat, chroma, audible, options) {
  const block = 0.5;
  const from = audible.start / FPS;
  const to = audible.end / FPS;
  const blocks = [];
  for (let t = from; t + block <= to + 1e-6; t += block) blocks.push({ start: t, end: t + block, beat: -1 });
  // Features over two seconds around each block, so a crossfade's both
  // sides are judged by what is heard across it.
  const feats = blocks.map((b) => {
    const f0 = Math.max(0, Math.round((b.start - 0.75) * FPS));
    const f1 = Math.min(feat.n, Math.round((b.end + 0.75) * FPS));
    const nb = feat.nb;
    const melMean = new Float64Array(nb);
    for (let t = f0; t < f1; t++) for (let k = 0; k < nb; k++) melMean[k] += feat.mel[t * nb + k] / Math.max(1, f1 - f0);
    const timbre = new Float64Array(12);
    for (let c = 1; c <= 12; c++) {
      let sum = 0;
      for (let k = 0; k < nb; k++) sum += melMean[k] * Math.cos((Math.PI * c * (k + 0.5)) / nb);
      timbre[c - 1] = sum / nb;
    }
    const c0 = Math.max(0, Math.floor((b.start - 0.75) / chroma.step));
    const c1 = Math.min(chroma.n, Math.ceil((b.end + 0.75) / chroma.step));
    const vec = new Float64Array(12);
    for (let t = c0; t < c1; t++) for (let k = 0; k < 12; k++) vec[k] += chroma.chroma[t * 12 + k];
    return { chroma: vec, timbre, rhythm: new Float64Array(4).fill(1), loud: dsp.db(dsp.mean(feat.power, f0, f1)), low: dsp.db(dsp.mean(feat.lowPower, f0, f1)) };
  });
  result.mode = "energy";
  result.bars = blocks;
  result.barFeatures = feats;
  result.distance = barDistance(feats);
  result.novelty = new Float64Array(blocks.length);
  result.sections = [0];
  result.unitBars = 1;
  result.blockSeconds = block;
  result.beats = [];
  if (!blocks.length) result.drop = null;
  else if (options.drop !== undefined) {
    const bar = Math.max(0, Math.min(blocks.length - 1, Math.floor((options.drop - from) / block)));
    result.drop = { bar, time: options.drop, offset: options.drop - blocks[bar].start, given: true, clear: true, candidates: [] };
  } else {
    // The biggest rise in loudness over two seconds.
    let best = null;
    for (let i = 4; i < blocks.length - 4; i++) {
      const before = (feats[i - 4].loud + feats[i - 2].loud) / 2;
      const after = (feats[i].loud + feats[i + 2].loud) / 2;
      const rise = after - before;
      if (!best || rise > best.rise) best = { bar: i, time: blocks[i].start, rise };
    }
    result.drop = best ? { ...best, offset: 0, given: false, clear: best.rise >= 4, candidates: [best] } : null;
  }
  result.start = { audible: from, firstBar: 0, pickup: 0 };
  result.ending = { kind: "none", audibleEnd: to };
  const tail = Array.from(audible.dbs.slice(Math.max(0, audible.end - 15), audible.end + 1));
  if (dsp.mean(Float64Array.from(tail)) > audible.loud - 12) result.ending.kind = "cut";
  result.ending.fadedFrom = blocks.length;
  return result;
}

module.exports = { analyze, RATE, barDistance };
