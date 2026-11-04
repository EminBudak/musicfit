"use strict";

// The signal processing musicfit needs, without a dependency: an FFT, a
// window, a mel filterbank, a chroma map, autocorrelation and a few small
// helpers on arrays.

const ffts = new Map();

// A radix-2 FFT of one size, run in place on separate real and imaginary
// arrays. Sizes are kept, since the same few are used thousands of times.
function fft(n) {
  if (ffts.has(n)) return ffts.get(n);
  if (n < 2 || n & (n - 1)) throw new Error(`FFT size ${n} is not a power of two`);
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const run = (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, w = 0; k < half; k++, w += step) {
          const a = start + k;
          const b = a + half;
          const tr = re[b] * cos[w] - im[b] * sin[w];
          const ti = re[b] * sin[w] + im[b] * cos[w];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  };
  ffts.set(n, run);
  return run;
}

// A periodic Hann window.
function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// Magnitude spectra of frames taken every `hop` samples, frame t centred on
// sample t * hop. Calls each(t, mags) with mags scaled so that a full-scale
// sine reads about 1 at its bin.
function stft(x, { size, hop, each }) {
  const run = fft(size);
  const win = hann(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const mags = new Float64Array(size / 2 + 1);
  const scale = 4 / size;
  const frames = Math.floor(x.length / hop) + 1;
  for (let t = 0; t < frames; t++) {
    const from = t * hop - size / 2;
    for (let i = 0; i < size; i++) {
      const j = from + i;
      re[i] = j >= 0 && j < x.length ? x[j] * win[i] : 0;
      im[i] = 0;
    }
    run(re, im);
    for (let k = 0; k <= size / 2; k++) mags[k] = Math.hypot(re[k], im[k]) * scale;
    each(t, mags);
  }
  return frames;
}

const hzToMel = (f) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m) => 700 * (10 ** (m / 2595) - 1);

// Triangular bands evenly spaced on the mel scale, each one's weights
// summing to 1, so a band reads as the mean magnitude across it.
function melBands(size, rate, count, low, high) {
  const edges = [];
  for (let i = 0; i < count + 2; i++) edges.push(melToHz(hzToMel(low) + ((hzToMel(high) - hzToMel(low)) * i) / (count + 1)));
  const binHz = rate / size;
  const bands = [];
  for (let b = 0; b < count; b++) {
    const [lo, mid, hi] = [edges[b], edges[b + 1], edges[b + 2]];
    let first = Math.max(0, Math.floor(lo / binHz));
    let last = Math.min(size / 2, Math.ceil(hi / binHz));
    const weights = [];
    for (let k = first; k <= last; k++) {
      const f = k * binHz;
      const w = f <= mid ? (f - lo) / (mid - lo) : (hi - f) / (hi - mid);
      weights.push(Math.max(0, w));
    }
    let sum = weights.reduce((a, w) => a + w, 0);
    // A band narrower than a bin still takes the bin it sits in.
    if (sum <= 0) {
      first = last = Math.min(size / 2, Math.round(mid / binHz));
      weights.length = 0;
      weights.push(1);
      sum = 1;
    }
    bands.push({ first, weights: Float64Array.from(weights, (w) => w / sum), centre: mid });
  }
  return bands;
}

function applyBands(bands, mags, out) {
  for (let b = 0; b < bands.length; b++) {
    const { first, weights } = bands[b];
    let sum = 0;
    for (let i = 0; i < weights.length; i++) sum += weights[i] * mags[first + i];
    out[b] = sum;
  }
  return out;
}

// Each bin between low and high Hz goes to its pitch class, weighted by how
// close it sits to the middle of a semitone.
function chromaMap(size, rate, low, high) {
  const binHz = rate / size;
  const bins = [];
  for (let k = Math.ceil(low / binHz); k <= Math.min(size / 2, Math.floor(high / binHz)); k++) {
    const pitch = 69 + 12 * Math.log2((k * binHz) / 440);
    const near = Math.round(pitch);
    const weight = Math.cos(Math.PI * (pitch - near)) ** 2;
    bins.push({ k, pc: ((near % 12) + 12) % 12, weight });
  }
  return bins;
}

function applyChroma(map, mags, out) {
  out.fill(0);
  for (const { k, pc, weight } of map) out[pc] += weight * mags[k] * mags[k];
  return out;
}

// Autocorrelation of x for lags 0..maxLag, each lag divided by how many
// products it sums and the whole by lag 0, so a perfectly periodic signal
// reads 1 at its period.
function autocorrelation(x, maxLag) {
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  let size = 2;
  while (size < 2 * n) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < n; i++) re[i] = x[i] - mean;
  const run = fft(size);
  run(re, im);
  for (let k = 0; k < size; k++) {
    re[k] = re[k] * re[k] + im[k] * im[k];
    im[k] = 0;
  }
  // The inverse transform of a real, even spectrum is the forward one
  // divided by the size.
  run(re, im);
  const out = new Float64Array(maxLag + 1);
  const zero = re[0] / size / n;
  for (let lag = 0; lag <= maxLag && lag < n; lag++) out[lag] = zero > 0 ? re[lag] / size / (n - lag) / zero : 0;
  return out;
}

// Linear interpolation into an array at a fractional index.
function at(arr, x) {
  if (x <= 0) return arr[0];
  const i = Math.floor(x);
  if (i >= arr.length - 1) return arr[arr.length - 1];
  const f = x - i;
  return arr[i] * (1 - f) + arr[i + 1] * f;
}

// The largest value within radius of index x, and where it is, refined
// with a parabola through the peak and its neighbours.
function peakNear(arr, x, radius) {
  const lo = Math.max(1, Math.round(x - radius));
  const hi = Math.min(arr.length - 2, Math.round(x + radius));
  let best = -Infinity;
  let where = Math.round(x);
  for (let i = lo; i <= hi; i++) {
    if (arr[i] > best) {
      best = arr[i];
      where = i;
    }
  }
  if (where <= 0 || where >= arr.length - 1) return { value: best, index: where };
  const [a, b, c] = [arr[where - 1], arr[where], arr[where + 1]];
  const den = a - 2 * b + c;
  const shift = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  return { value: b, index: where + shift };
}

function mean(arr, from = 0, to = arr.length) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += arr[i];
  return to > from ? sum / (to - from) : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))];
}

function std(arr) {
  const m = mean(arr);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += (arr[i] - m) ** 2;
  return Math.sqrt(sum / Math.max(1, arr.length));
}

// A moving average over 2 * radius + 1 values, shorter at the ends.
function smooth(arr, radius) {
  const out = new Float64Array(arr.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < Math.min(arr.length, radius); i++) {
    sum += arr[i];
    count++;
  }
  for (let i = 0; i < arr.length; i++) {
    if (i + radius < arr.length) {
      sum += arr[i + radius];
      count++;
    }
    if (i - radius - 1 >= 0) {
      sum -= arr[i - radius - 1];
      count--;
    }
    out[i] = sum / count;
  }
  return out;
}

const db = (power) => 10 * Math.log10(Math.max(power, 1e-12));

function cosine(a, b) {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

module.exports = { fft, hann, stft, melBands, applyBands, chromaMap, applyChroma, autocorrelation, at, peakNear, mean, median, percentile, std, smooth, db, cosine, distance };
