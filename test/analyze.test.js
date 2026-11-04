"use strict";

// Reading tracks whose tempo, bar lines, drop and ending are known, since
// test/synth.js made them.

const assert = require("node:assert/strict");
const test = require("node:test");
const { decode } = require("../skills/musicfit/scripts/lib/audio");
const { analyze } = require("../skills/musicfit/scripts/lib/analyze");
const { fixture, matched } = require("./helpers");

async function read(name, options) {
  const { file, truth } = fixture(name);
  return { a: analyze(await decode(file, { rate: 24000, channels: 1 }), options), truth };
}

const bpmNear = (found, want, within = 0.005) => Math.abs(found / want - 1) <= within;

test("four on the floor at 124: the beats, the bar lines, the drop and the final hit", async () => {
  const { a, truth } = await read("house");
  assert.equal(a.mode, "bars");
  assert.ok(bpmNear(a.tempo.bpm, 124), `tempo ${a.tempo.bpm}`);
  assert.ok(a.tempo.steady);
  assert.ok(matched(truth.beats, a.beats, 0.03) >= 0.95);
  assert.ok(matched(truth.downbeats, a.bars.map((b) => b.start), 0.03) >= 0.95);
  assert.ok(Math.abs(a.drop.time - truth.drop) < 0.05, `drop at ${a.drop.time}, not ${truth.drop}`);
  assert.equal(a.ending.kind, "hit");
  assert.ok(Math.abs(a.ending.hit - truth.finalHit) < 0.05);
});

test("swung boom bap at 86 that fades out", async () => {
  const { a, truth } = await read("lofi");
  assert.ok(bpmNear(a.tempo.bpm, 86), `tempo ${a.tempo.bpm}`);
  assert.ok(matched(truth.downbeats, a.bars.map((b) => b.start), 0.035) >= 0.9);
  assert.equal(a.ending.kind, "fade");
  // The bars that fade out are not offered as material.
  assert.ok(a.ending.fadedFrom < a.bars.length);
});

test("a piano in eighths at 72 is read at 72 and its bars are found, not at the eighth notes", async () => {
  const { a, truth } = await read("cinematic");
  assert.ok(bpmNear(a.tempo.bpm, 72), `tempo ${a.tempo.bpm}`);
  assert.ok(matched(truth.downbeats, a.bars.map((b) => b.start), 0.03) >= 0.9);
  assert.ok(Math.abs(a.drop.time - truth.drop) < 0.05);
});

test("three beats to a bar is found, and so are its bar lines", async () => {
  const { a, truth } = await read("waltz");
  assert.equal(a.meter, 3);
  assert.ok(bpmNear(a.tempo.bpm, 150), `tempo ${a.tempo.bpm}`);
  assert.ok(matched(truth.downbeats, a.bars.map((b) => b.start), 0.03) >= 0.9);
});

test("bar lines run on through an intro with no drums, and the drop is the bar the groove starts", async () => {
  const { a, truth } = await read("padIntro");
  assert.ok(bpmNear(a.tempo.bpm, 118), `tempo ${a.tempo.bpm}`);
  assert.equal(a.start.firstBar, 0);
  assert.ok(matched(truth.downbeats, a.bars.map((b) => b.start), 0.03) >= 0.95);
  assert.ok(Math.abs(a.drop.time - truth.drop) < 0.05, `drop at ${a.drop.time}, not ${truth.drop}`);
});

test("a band that plays on to the end of the last beat and stops still ends on its own last hit", async () => {
  const { a, truth } = await read("stop");
  assert.equal(a.ending.kind, "hit");
  assert.ok(Math.abs(a.ending.hit - truth.finalHit) < 0.05, `last hit at ${a.ending.hit}, not ${truth.finalHit}`);
});

test("claps on every off-beat over a kick on every beat: the tempo is the kick's, and so are the beats", async () => {
  for (const [name, bpm] of [["offbeat", 120], ["offbeat118", 118]]) {
    const { a, truth } = await read(name);
    assert.ok(bpmNear(a.tempo.bpm, bpm), `${name}: tempo ${a.tempo.bpm}`);
    assert.ok(matched(truth.beats.filter((t) => t > 8), a.beats, 0.03) >= 0.95, `${name}: the beats are not on the kicks`);
  }
});

test("a steady tempo stays steady when a syncopated part pulls a few tracked beats off the grid", async () => {
  const { a, truth } = await read("tresillo");
  assert.ok(a.tempo.steady, a.warnings.join(" | "));
  assert.ok(bpmNear(a.tempo.bpm, 104), `tempo ${a.tempo.bpm}`);
  assert.ok(matched(truth.beats, a.beats, 0.02) >= 0.98, "the beats are not on the grid");
});

test("a wandering tempo is followed beat by beat, with a warning", async () => {
  const { a, truth } = await read("drift");
  assert.equal(a.tempo.steady, false);
  assert.ok(a.warnings.some((w) => /tempo wanders/.test(w)));
  assert.ok(matched(truth.downbeats, a.bars.map((b) => b.start), 0.04) >= 0.85);
});

test("with no pulse at all it falls back to cuts by energy, and says so", async () => {
  const { a } = await read("ambient");
  assert.equal(a.mode, "energy");
  assert.ok(a.warnings.some((w) => /energy instead of bar lines/.test(w)));
  assert.ok(a.bars.length > 10);
});

test("--bpm sets the tempo when the one found is half or double the real one", async () => {
  const { a } = await read("house", { bpm: 62 });
  assert.ok(bpmNear(a.tempo.bpm, 62, 0.01), `tempo ${a.tempo.bpm}`);
  // Bars at half the tempo are twice as long.
  assert.ok(Math.abs(a.tempo.bar - (4 * 60) / 62) < 0.05);
});

test("a tempo that could be half or double is named, and cuts then go in pairs of bars when it could be slower", async () => {
  const { a } = await read("waltz");
  const half = a.tempo.alternatives.find((x) => x.relation === "half");
  assert.ok(half, "the half tempo is listed");
  if (half.likelihood > 0.5) {
    assert.equal(a.mode, "phrases");
    assert.equal(a.unitBars, 2);
    assert.ok(a.warnings.some((w) => /could also be/.test(w)));
  } else assert.equal(a.unitBars, 1);
});
