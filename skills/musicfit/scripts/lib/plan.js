"use strict";

// Plans the fitted track: which bars of the source play in which order so
// the result is exactly the asked length, the drop lands on the asked
// second, and the music starts and ends where a listener expects.
//
// The output is laid out as slots one bar long (half a second when there
// is no usable beat), lined up so a slot starts exactly where the drop
// lands. A dynamic programme fills the slots with source bars: playing on
// from one bar to the next costs nothing, any other step is a seam, and a
// seam costs more the less the bars on either side sound like the ones
// they replace and the more it breaks the track's four-bar phrases. It is
// the same search whether the track gets shorter (seams skip ahead) or
// longer (seams loop back).

const SEAM = 0.6;
// Starting later than the track does costs more than a seam: a fitted
// track should open the way the track opens unless the hit needs it not to.
const START = 2.5;

function plan(a, { length, hit, end = "auto", fade }) {
  const warnings = [];
  const bars = a.bars;
  const n = bars.length;
  const energy = a.mode === "energy";
  const unit = energy ? a.blockSeconds : medianLength(bars);
  const beat = energy ? null : a.tempo.beat;
  const m = a.unitBars || 1;
  const first = a.start.firstBar;
  const dist = a.distance;

  // Bars that can be played: not the half bar the track ends on, not bars
  // that fade out, not the ending's ring-out (only the ending slot may
  // hold the ending bar).
  const ending = a.ending;
  const natural = !energy && ending.kind === "hit" && end !== "fade";
  if (end === "natural" && !natural) warnings.push("The track has no ending of its own (a last hit that rings out), so it ends with a fade instead.");
  // A last hit and its ring-out are an ending, never bars to build on,
  // even when the result ends with a fade instead.
  const usable = new Uint8Array(n);
  const lastUsable = ending.kind === "hit" && !energy ? ending.bar : Math.min(n, ending.fadedFrom);
  for (let i = 0; i < lastUsable; i++) usable[i] = bars[i].partial ? 0 : 1;
  // Bars before the first one with music are silence.
  for (let i = 0; i < first; i++) usable[i] = 0;
  if (!usable.some(Boolean)) throw new Error(a.loud < -60 ? "The track is silent" : "The track has no whole bar of music to build on");

  // Where slot 0 starts in the output, and which slot the drop takes. With
  // a hit, the slots line up so one starts exactly where the drop lands,
  // and the head can go two ways: silence (or the track's pickup) until
  // the first full bar, or the bar before it playing from part way in. A
  // beat of silence sounds natural, more costs a little per second. Both
  // are tried, since one of them can save a seam.
  const drop = hit !== undefined ? a.drop : null;
  if (hit !== undefined && !drop) throw new Error("No drop found to land on --hit; pass --drop with the second in the track that should land there");
  const heads = [];
  if (drop) {
    const at = hit - drop.offset;
    const p = ((at % unit) + unit) % unit;
    const enough = energy ? 0.25 : Math.min(beat, 0.6);
    heads.push({ q: p, extra: Math.max(0, p - enough) * 1.5 });
    if (p > 0.05) heads.push({ q: p - unit, extra: 0.3 });
    for (const h of heads) h.dropSlot = Math.round((at - h.q) / unit);
    // A hit near the top leaves the drop bar no slot under one of them.
    for (let i = heads.length - 1; i >= 0; i--) if (heads[i].dropSlot < 0) heads.splice(i, 1);
  } else heads.push({ q: energy ? 0 : a.start.pickup, extra: 0, dropSlot: -1 });

  // The ending: the last slot holds the ending bar, as late as leaves its
  // hit at least two beats (or 1.2 s) to ring, or all of its ring-out when
  // that is shorter: a hit cut off at once sounds clipped. A bar earlier is
  // tried too, at a small cost, since it can save a seam that breaks the
  // track's phrases.
  let hitInBar = 0;
  let ringOut = 0;
  const endsFor = (head) => {
    if (!natural) return [];
    const room = Math.min(ringOut, Math.max(2 * beat, 1.2));
    const latest = Math.floor((length - room - hitInBar - head.q) / unit + 1e-9);
    return [[latest, 0], [latest - 1, 0.6]].filter(([slot]) => slot >= 1 && (!drop || slot > head.dropSlot)).map(([slot, extra]) => ({ slot, extra }));
  };
  if (natural) {
    hitInBar = ending.hit - bars[ending.bar].start;
    ringOut = ending.tailEnd - ending.hit;
  }
  if (natural && end === "natural" && !heads.some((h) => endsFor(h).length)) warnings.push("There is no room after the hit for the track's own ending, so it ends with a fade.");

  const sections = new Set(a.sections || []);
  // A seam from bar i to bar k sounds natural when bar k is like the bar
  // it replaces (i + 1), or bar i like the one k used to follow (k - 1):
  // then the step is one the track itself takes. The better of the two
  // counts most, the worse some. A difference counts more than in
  // proportion, so one seam between unlike bars costs more than a few
  // between bars that sound the same. Before a section's first bar, the
  // bar that would come before it in a loop is the end of its phrase.
  const unlike = (d) => d + d * d;
  const before = (k) => (k - 1 >= first && !sections.has(k) ? k - 1 : Math.min(n - 1, k + 4 * m - 1));
  // A build up to the drop leads nowhere else: leaving its last four bars
  // for anything but the drop (or a later bar of the build) drops the
  // tension they built. A build is a run of bars that grows louder or
  // fuller into the drop; a flat intro before it is no build and loops
  // like any other bars.
  const dropBar = a.drop && (a.drop.clear || a.drop.given) ? a.drop.bar : -1;
  const intensity = (i) => a.barFeatures[i].loud + 0.2 * a.barFeatures[i].fullness;
  const builds = !energy && dropBar >= first + 4 && intensity(dropBar - 1) - intensity(dropBar - 4) >= 2;
  const building = (i) => builds && i >= dropBar - 4 && i < dropBar;
  const jump = (i, k) => {
    const replaces = dist(i + 1 < n ? i + 1 : i, k);
    const follows = dist(i, before(k));
    let cost = SEAM + unlike(Math.min(replaces, follows)) + 0.25 * Math.min(3, Math.max(replaces, follows));
    if (building(i) && !(k > i && k <= dropBar)) cost += 1.5;
    if (!energy) {
      const d = (k - (i + 1)) / m;
      cost += d % 4 === 0 ? 0 : d % 2 === 0 ? 0.35 : 0.8;
      if (sections.has(k) && sections.has(i + 1)) cost -= 0.3;
      else if (sections.has(k) || sections.has(i + 1)) cost -= 0.1;
    }
    return cost;
  };

  // For each bar, the bars a seam into it may come from: on a long track
  // only the 48 cheapest, which keeps the search from growing with the
  // cube of its length.
  const KEEP = 48;
  const into = Array.from({ length: n }, (_, k) => {
    const all = [];
    for (let i = 0; i < n; i++) if (i !== k - 1) all.push([jump(i, k), i]);
    if (all.length > KEEP) all.sort((x, y) => x[0] - y[0]).length = KEEP;
    return all;
  });

  // The search: cost[j][b] is the cheapest way to have bar b in slot j.
  // Nothing from the drop on plays before the drop lands, so it is heard
  // first where it was asked for.
  const INF = Infinity;
  const search = (slots, endSlot, dropSlot) => {
    // The phrase grid: seams only where both sides are whole units of m
    // bars counted from the drop (or the first bar).
    const anchor = drop ? drop.bar : first;
    const anchorSlot = drop ? dropSlot : 0;
    const onGrid = (bar, slot) => m === 1 || (((bar - anchor - (slot - anchorSlot)) % m) + m) % m === 0;
    const seamAt = (slot) => m === 1 || (((slot - anchorSlot) % m) + m) % m === 0;
    const allowed = (j, b) => {
      if (endSlot >= 0 && j === endSlot) return b === ending.bar;
      if (drop && j === dropSlot) return b === drop.bar;
      if (drop && j < dropSlot && b >= drop.bar) return false;
      return usable[b] === 1 && onGrid(b, j);
    };
    const cost = Array.from({ length: slots }, () => new Float64Array(n).fill(INF));
    const from = Array.from({ length: slots }, () => new Int32Array(n).fill(-1));
    for (let b = 0; b < n; b++) {
      if (!allowed(0, b)) continue;
      // Starting later than the track does costs more than a seam, and
      // more when it starts inside a four-bar phrase.
      const into = (((b - first) % 4) + 4) % 4;
      cost[0][b] = b === first ? 0 : START + (into === 0 ? 0 : into === 2 ? 0.2 : 0.4) + 0.02 * Math.abs(b - first);
    }
    for (let j = 1; j < slots; j++) {
      const prev = cost[j - 1];
      const seamOk = seamAt(j);
      for (let k = 0; k < n; k++) {
        if (!allowed(j, k)) continue;
        let best = k > 0 && prev[k - 1] < INF ? prev[k - 1] : INF;
        let arg = best < INF ? k - 1 : -1;
        if (seamOk) {
          for (const [step, i] of into[k]) {
            if (prev[i] === INF) continue;
            const c = prev[i] + step;
            if (c < best) {
              best = c;
              arg = i;
            }
          }
        }
        cost[j][k] = best;
        from[j][k] = arg;
      }
    }
    let lastBar = -1;
    let total = INF;
    for (let b = 0; b < n; b++) {
      if (cost[slots - 1][b] < total) {
        total = cost[slots - 1][b];
        lastBar = b;
      }
    }
    if (lastBar < 0) return null;
    const path = new Array(slots);
    for (let j = slots - 1, b = lastBar; j >= 0; j--) {
      path[j] = b;
      b = from[j][b];
    }
    return { total, path };
  };

  let best = null;
  for (const head of heads) {
    const options = endsFor(head).map((e) => ({ slots: e.slot + 1, endSlot: e.slot, extra: e.extra }));
    if (!options.length) options.push({ slots: Math.max(1, Math.ceil((length - head.q) / unit - 1e-9)), endSlot: -1, extra: 0 });
    for (const o of options) {
      if (drop && head.dropSlot >= o.slots) continue;
      const found = search(o.slots, o.endSlot, head.dropSlot);
      if (!found) continue;
      const total = found.total + o.extra + head.extra;
      if (!best || total < best.score) best = { ...found, score: total, head, endSlot: o.endSlot };
    }
  }
  // When the ending of its own fits nowhere, a fade.
  if (!best) {
    for (const head of heads) {
      const slots = Math.max(1, Math.ceil((length - head.q) / unit - 1e-9));
      const found = drop && head.dropSlot >= slots ? null : search(slots, -1, head.dropSlot);
      if (found && (!best || found.total + head.extra < best.score)) best = { ...found, score: found.total + head.extra, head, endSlot: -1 };
    }
  }
  if (!best) throw new Error("No way to fit this track to that length with these settings");
  const { path, total } = best;
  const dropSlot = best.head.dropSlot;
  const slotTime = (j) => best.head.q + j * unit;
  const slots = path.length;
  const endsNaturally = best.endSlot >= 0;

  // Runs of bars that follow each other in the source become segments.
  const segments = [];
  for (let j = 0; j < slots; j++) {
    const b = path[j];
    const last = segments[segments.length - 1];
    if (last && b === last.lastBar + 1) {
      last.lastBar = b;
      last.srcEnd = bars[b].end;
    } else segments.push({ firstBar: b, lastBar: b, firstSlot: j, srcStart: bars[b].start, srcEnd: bars[b].end, outStart: slotTime(j) });
  }
  // Bars of a wandering tempo differ in length, so the segments are laid
  // end to end from the one with the drop (or the first), which keeps the
  // drop exactly on its second.
  const pin = drop ? segments.findIndex((s) => s.firstSlot <= dropSlot && dropSlot <= s.firstSlot + (s.lastBar - s.firstBar)) : 0;
  if (drop) segments[pin].outStart = hit - (drop.time - segments[pin].srcStart);
  for (let s = pin + 1; s < segments.length; s++) segments[s].outStart = segments[s - 1].outStart + (segments[s - 1].srcEnd - segments[s - 1].srcStart);
  for (let s = pin - 1; s >= 0; s--) segments[s].outStart = segments[s + 1].outStart - (segments[s].srcEnd - segments[s].srcStart);
  const seams = [];
  for (let s = 1; s < segments.length; s++) {
    const A = segments[s - 1];
    const B = segments[s];
    const skipped = B.firstBar - (A.lastBar + 1);
    seams.push({
      slot: B.firstSlot,
      out: B.outStart,
      from: A.srcEnd,
      to: B.srcStart,
      kind: skipped > 0 ? "cut" : "loop",
      bars: Math.abs(skipped),
      // 1 is two bars that sound the same, 0 is nothing alike.
      likeness: Math.max(0, 1 - Math.min(dist(A.lastBar + 1 < n ? A.lastBar + 1 : A.lastBar, B.firstBar), dist(A.lastBar, before(B.firstBar))) / 1.5),
    });
  }

  const tail = {};
  if (endsNaturally) {
    const lastSeg = segments[segments.length - 1];
    tail.kind = "natural";
    tail.hit = lastSeg.outStart + (ending.hit - lastSeg.srcStart);
    tail.ringOut = ringOut;
    lastSeg.srcEnd = ending.tailEnd;
  } else {
    tail.kind = "fade";
    tail.fade = fade;
  }
  return {
    mode: a.mode,
    unit,
    unitBars: m,
    segments,
    seams,
    tail,
    hit: drop ? { out: hit, src: drop.time, bar: drop.bar, slot: dropSlot } : null,
    pin,
    cost: total,
    warnings,
  };
}

function medianLength(bars) {
  const lengths = bars.filter((b) => !b.partial).map((b) => b.end - b.start).sort((x, y) => x - y);
  return lengths[lengths.length >> 1];
}

module.exports = { plan };
