"use strict";

// What musicfit asks of ffmpeg works on ffmpeg 4.4 (Ubuntu 22.04's, which
// the hosted service runs) as on newer ones, and an ffmpeg that fails is
// named with the line that says why.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { reason } = require("../skills/musicfit/scripts/lib/audio");
const { fixture, outDir } = require("./helpers");

const CLI = path.resolve(__dirname, "../skills/musicfit/scripts/musicfit.js");
const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures");
const posix = { skip: process.platform === "win32" ? "the stand-ins are shell scripts" : false };

test("a fit and an analysis run on an ffmpeg that knows only info and verbose for framelog, as 4.4", posix, () => {
  const { file } = fixture("house");
  const vo = fixture("voice");
  const env = { ...process.env, FFMPEG_PATH: path.join(FIXTURES, "ffmpeg44", "ffmpeg") };
  const fit = spawnSync(process.execPath, [CLI, file, "--length", "12", "--hit", "8", "--voice", vo.file, "--out", outDir("ffmpeg44-fit")], { encoding: "utf8", env });
  assert.equal(fit.status, 0, fit.stderr);
  assert.ok(fs.existsSync(path.join(outDir("ffmpeg44-fit"), "mix.wav")));
  const read = spawnSync(process.execPath, [CLI, file, "--analyze", "--out", outDir("ffmpeg44-analysis")], { encoding: "utf8", env });
  assert.equal(read.status, 0, read.stderr);
});

test("an ffmpeg that refuses a value of the loudness meter is named with that line, not with how it gave up", posix, () => {
  // The real ffmpeg of this machine, given a framelog value no ffmpeg has.
  const { file } = fixture("house");
  const env = { ...process.env, FFMPEG_PATH: path.join(FIXTURES, "badframelog", "ffmpeg") };
  const run = spawnSync(process.execPath, [CLI, file, "--length", "12", "--out", outDir("bad-framelog")], { encoding: "utf8", env });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /musicfit: ffmpeg: Error (setting option|initializing filter|applying option).*ebur128/);
  assert.doesNotMatch(run.stderr, /Conversion failed|Error opening output files/);
});

test("the line that says why is found in what ffmpeg 4.4, 6.1 and 8 print", () => {
  const said = (name) => fs.readFileSync(path.join(FIXTURES, "stderr", `${name}.txt`), "utf8");
  const cases = {
    // Written in two parts, so the meter's settings in it are not read as a framelog value musicfit asks for.
    "framelog-4.4": "ffmpeg: Error initializing filter 'ebur128' with args 'peak=true:framelog" + "=bogus'",
    "framelog-6.1": "ffmpeg: Error applying option 'framelog' to filter 'ebur128': Invalid argument",
    "framelog-8.0": "ffmpeg: Error applying option 'framelog' to filter 'ebur128': Invalid argument",
    "no-folder-4.4": "ffmpeg: /nonexistent/dir/fitted.wav: No such file or directory",
    "no-folder-8.0": "ffmpeg: Error opening output /nonexistent/dir/fitted.wav: No such file or directory",
    "disk-full-4.4": "ffmpeg: Error writing trailer of /dev/full: No space left on device",
    "disk-full-8.0": "ffmpeg: Error writing trailer: No space left on device",
    "no-input-4.4": "ffmpeg: nothing.wav: No such file or directory",
    "no-input-8.0": "ffmpeg: Error opening input: No such file or directory",
    "encoder-4.4": "ffmpeg: Unknown encoder 'nosuchencoder'",
    "encoder-8.0": "ffmpeg: Unknown encoder 'nosuchencoder'",
  };
  for (const [name, line] of Object.entries(cases)) assert.equal(reason(said(name), 1), line, name);
  // A line with no word of an error, as a wrapper or a guard may print, and nothing at all.
  assert.equal(reason("fitted.wav: No space left on device\n", 1), "ffmpeg: fitted.wav: No space left on device");
  assert.equal(reason("kits ffmpeg: in/a%d.wav: an input named with % or ending in .y is not opened\n", 1), "kits ffmpeg: in/a%d.wav: an input named with % or ending in .y is not opened");
  assert.equal(reason("", 1), "ffmpeg exited with 1");
  // Stopped by a signal it caught, as Ctrl-C to the whole process group.
  assert.equal(reason("Exiting normally, received signal 2.\n", 255), "ffmpeg was stopped (signal 2)");
  assert.equal(reason("", null, "SIGKILL"), "ffmpeg was stopped (SIGKILL)");
  // At -v error a caught signal leaves no line at all, only the exit code
  // 255, which ffmpeg 7 and newer also give a refused operation, with a line.
  assert.equal(reason("", 255), "ffmpeg was stopped");
  assert.equal(reason("[out#0/wav @ 0x5970b98c6a00] Error opening output fitted.wav: Operation not permitted\n", 255), "ffmpeg: Error opening output fitted.wav: Operation not permitted");
});

test("fitted.wav and mix.wav say nothing of the ffmpeg that wrote them, so any ffmpeg writes the same bytes", async () => {
  const { fit } = require("../skills/musicfit/scripts/lib/fit");
  const { file } = fixture("house");
  const vo = fixture("voice");
  const out = outDir("bitexact");
  await fit(file, { fps: 30, duck: 10, lufs: -14, end: "auto", length: 12, voice: vo.file, out });
  for (const name of ["fitted.wav", "mix.wav"]) {
    const wav = fs.readFileSync(path.join(out, name));
    assert.equal(wav.toString("latin1", 0, 4), "RIFF");
    const chunks = [];
    for (let at = 12; at + 8 <= wav.length; ) {
      const id = wav.toString("latin1", at, at + 4);
      chunks.push(id);
      if (id === "data") break;
      at += 8 + wav.readUInt32LE(at + 4) + (wav.readUInt32LE(at + 4) % 2);
    }
    assert.deepEqual(chunks, ["fmt ", "data"], `${name} has ${chunks.join(", ")}`);
    assert.ok(!wav.subarray(0, 200).includes("Lavf"), `${name} names its ffmpeg`);
  }
});

// Every .js file of the kit, the tests and the tools included.
function sources(dir = ROOT) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name.startsWith("musicfit-")) continue;
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(at));
    else if (entry.name.endsWith(".js")) found.push(at);
  }
  return found;
}

test("the loudness meter is asked only for framelog values ffmpeg 4.4 has, in every .js file, comments too", () => {
  // The pattern MakersMCP-Api's ffmpeg check reads an installed kit with.
  const value = /framelog\s*=\s*(\w+)/g;
  const files = sources();
  assert.ok(files.some((f) => f.endsWith(path.join("lib", "audio.js"))));
  let asked = 0;
  for (const file of files) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(value)) {
      asked++;
      assert.ok(["info", "verbose"].includes(m[1]), `${path.relative(ROOT, file)} asks for framelog ${m[1]}`);
    }
  }
  assert.ok(asked > 0, "the meter is asked for no framelog value at all");
});

test("a stereo sound handed to ffmpeg a block at a time is the same sound as one interleaved copy of it", async () => {
  const { decode, measure, encodeWav } = require("../skills/musicfit/scripts/lib/audio");
  const whole = await decode(fixture("house").file);
  const n = whole.length / 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = whole[2 * i];
    R[i] = whole[2 * i + 1];
  }
  assert.deepEqual(await measure({ L, R }), await measure(whole));
  const [a, b] = [outDir("blocks.wav"), outDir("whole.wav")];
  await encodeWav({ L, R }, a);
  await encodeWav(whole, b);
  assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)));
});
