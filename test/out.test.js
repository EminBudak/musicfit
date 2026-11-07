"use strict";

// What a run leaves in its folder: a run that fails, is refused or is
// stopped leaves the earlier files as they were and adds nothing; a run
// that ends well leaves exactly its own files.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");
const { writeWav } = require("./synth");
const { fixture, outDir, dir } = require("./helpers");
const out = require("../skills/musicfit/scripts/lib/out");

const CLI = path.resolve(__dirname, "../skills/musicfit/scripts/musicfit.js");
const FIXTURES = path.join(__dirname, "fixtures");
const posix = { skip: process.platform === "win32" ? "the stand-ins are shell scripts" : false };

const cli = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

// Every entry of a folder, hidden ones too, with a hash of each file.
function snapshot(folder) {
  const out = {};
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const at = path.join(folder, entry.name);
    out[entry.name] = entry.isDirectory() ? snapshot(at) : crypto.createHash("md5").update(fs.readFileSync(at)).digest("hex");
  }
  return out;
}

// A good fit with a voice: the five files a run writes.
function goodFit(name) {
  const { file } = fixture("house");
  const out = outDir(name);
  const run = cli([file, "--length", "12", "--hit", "8", "--voice", fixture("voice").file, "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(Object.keys(snapshot(out)).sort(), ["FIT.md", "cues.json", "fitted.wav", "mix.wav", "seams.png"]);
  return out;
}

test("a run that fails at its end leaves the earlier files as they were and adds nothing", posix, () => {
  const out = goodFit("fails-late");
  const before = snapshot(out);
  const { file } = fixture("house");
  // A longer fit, so every file would differ, whose last write fails.
  const run = cli([file, "--length", "14", "--voice", fixture("voice").file, "--out", out], { FFMPEG_PATH: path.join(FIXTURES, "failmix", "ffmpeg") });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /musicfit: ffmpeg: Error writing trailer: No space left on device/);
  assert.deepEqual(snapshot(out), before);
  assert.deepEqual(fs.readdirSync(path.dirname(out)).filter((e) => e.startsWith(".musicfit-")), []);
});

// Runs the CLI until it starts writing a WAV, then sends it `signal`. With
// `twice`, the run has a process group of its own, which gets the signal,
// and the run gets it again a moment later, as makersmcp's supervisor
// passes a cancel on.
function stopWhileWriting(args, signal, { twice = false } = {}) {
  const mark = path.join(dir, `mark-${signal}-${process.hrtime.bigint()}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { detached: twice, env: { ...process.env, FFMPEG_PATH: path.join(FIXTURES, "slowwav", "ffmpeg"), MUSICFIT_TEST_MARK: mark } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const started = Date.now();
    const wait = setInterval(() => {
      if (fs.existsSync(mark)) {
        clearInterval(wait);
        if (!twice) return void child.kill(signal);
        process.kill(-child.pid, signal);
        setTimeout(() => child.kill(signal), 1);
      } else if (Date.now() - started > 60000) {
        clearInterval(wait);
        child.kill("SIGKILL");
        reject(new Error(`the run never wrote a WAV: ${stderr}`));
      }
    }, 20);
    child.on("error", reject);
    child.on("exit", (code, sig) => {
      clearInterval(wait);
      resolve({ code, signal: sig, stderr });
    });
  });
}

const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("a run stopped with SIGTERM or SIGINT while it writes leaves the earlier files as they were, and ends by that signal", posix, async () => {
  const out = goodFit("stopped");
  const before = snapshot(out);
  const { file } = fixture("house");
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const run = await stopWhileWriting([file, "--length", "14", "--voice", fixture("voice").file, "--out", out], signal);
    assert.equal(run.signal, signal, `${signal}: ${run.code} ${run.stderr}`);
    assert.match(run.stderr, new RegExp(`\nmusicfit: stopped, so ${quote(out)} is as it was\n$`));
    assert.deepEqual(snapshot(out), before, signal);
  }
  // Into a folder that is not there: nothing is made.
  const fresh = outDir("stopped-fresh");
  const run = await stopWhileWriting([file, "--length", "14", "--out", fresh], "SIGTERM");
  assert.equal(run.signal, "SIGTERM", run.stderr);
  assert.ok(!fs.existsSync(fresh));
  assert.deepEqual(fs.readdirSync(path.dirname(fresh)).filter((e) => e.startsWith(".musicfit-")), []);
});

test("a stop that comes twice, to the process group and then to the run, as makersmcp cancels a job, is handled once", posix, async () => {
  const out = goodFit("stopped-twice");
  const before = snapshot(out);
  const { file } = fixture("house");
  for (let round = 0; round < 4; round++) {
    const run = await stopWhileWriting([file, "--length", "14", "--voice", fixture("voice").file, "--out", out], "SIGTERM", { twice: true });
    assert.equal(run.signal, "SIGTERM", `round ${round}: ${run.code} ${run.stderr}`);
    assert.equal((run.stderr.match(/musicfit: stopped/g) || []).length, 1, `round ${round}: ${run.stderr}`);
    assert.deepEqual(snapshot(out), before, `round ${round}`);
  }
});

test("a refused run into a folder that is not there makes no folder", () => {
  const silent = path.join(dir, "silent-refused.wav");
  writeWav(silent, { rate: 48000, L: new Float32Array(48000 * 6), R: new Float32Array(48000 * 6) });
  const out = path.join(dir, "not-made", "fit");
  const run = cli([silent, "--length", "5", "--drop", "2", "--out", out]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /The track is silent/);
  assert.ok(!fs.existsSync(path.join(dir, "not-made")));
  assert.deepEqual(fs.readdirSync(dir).filter((e) => e.startsWith(".musicfit-")), []);
});

test("a good run leaves exactly its own files: the earlier run's go, the user's stay", () => {
  const out = goodFit("own-files");
  fs.writeFileSync(path.join(out, "notes.txt"), "mine\n");
  const { file } = fixture("house");
  const plain = cli([file, "--length", "12", "--out", out]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), ["FIT.md", "cues.json", "fitted.wav", "notes.txt", "seams.png"]);
  const read = cli([file, "--analyze", "--out", out]);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), ["FIT.md", "cues.json", "notes.txt", "seams.png"]);
});

test("a folder under the name of a file a run writes stops it before any work, and one under another name stays", () => {
  const { file } = fixture("house");
  const out = outDir("folder-named");
  fs.mkdirSync(path.join(out, "FIT.md"), { recursive: true });
  fs.writeFileSync(path.join(out, "FIT.md", "notes.txt"), "mine\n");
  const run = cli([file, "--length", "12", "--out", out]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /FIT\.md is a folder, and this run writes its FIT\.md there/);
  assert.doesNotMatch(run.stderr, /Reading/);
  assert.deepEqual(fs.readdirSync(out), ["FIT.md"]);
  assert.equal(fs.readFileSync(path.join(out, "FIT.md", "notes.txt"), "utf8"), "mine\n");
  // A plain fit writes no mix.wav, so a folder of that name is not in its way.
  fs.rmSync(path.join(out, "FIT.md"), { recursive: true });
  fs.mkdirSync(path.join(out, "mix.wav"));
  fs.writeFileSync(path.join(out, "mix.wav", "take.wav"), "mine\n");
  const plain = cli([file, "--length", "12", "--out", out]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(fs.readFileSync(path.join(out, "mix.wav", "take.wav"), "utf8"), "mine\n");
});

// The number of a process that has ended.
function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

function age(folder, minutes) {
  const then = new Date(Date.now() - minutes * 60000);
  const walk = (at) => {
    if (fs.statSync(at).isDirectory()) for (const e of fs.readdirSync(at)) walk(path.join(at, e));
    fs.utimesSync(at, then, then);
  };
  walk(folder);
}

test("the hidden folder a killed run left goes at the next good run once it is old, nothing of it comes back, and a live run's stays", () => {
  const out = goodFit("swept");
  const dead = deadPid();
  // Killed while it put its files in place: the earlier mix.wav moved aside.
  const killed = path.join(out, `.musicfit-part-${dead}-aaaaaaaa`);
  fs.mkdirSync(path.join(killed, ".old"), { recursive: true });
  fs.copyFileSync(path.join(out, "mix.wav"), path.join(killed, ".old", "mix.wav"));
  age(killed, 20);
  const recent = path.join(out, `.musicfit-part-${dead}-bbbbbbbb`);
  fs.mkdirSync(recent);
  const alive = path.join(out, `.musicfit-part-${process.pid}-cccccccc`);
  fs.mkdirSync(alive);
  age(alive, 20);
  const { file } = fixture("house");
  const plain = cli([file, "--length", "12", "--out", out]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(!fs.existsSync(killed), "the killed run's old folder is still there");
  assert.ok(fs.existsSync(recent), "a folder changed in the last 15 minutes went");
  assert.ok(fs.existsSync(alive), "a live run's folder went");
  assert.ok(!fs.existsSync(path.join(out, "mix.wav")), "the killed run's mix.wav came back");
});

test("files made in the hidden folder get the access a default ACL gives the out folder", { skip: process.platform !== "linux" }, (t) => {
  const base = path.join(dir, "acl");
  fs.mkdirSync(base);
  const uid = process.getuid();
  const set = spawnSync("setfacl", ["-m", `d:u:${uid}:rwx,d:g::r-x,d:o::---`, base], { encoding: "utf8" });
  if (set.error || set.status !== 0) return t.skip("setfacl is not there, or this disk has no ACLs");
  const acl = (at) => spawnSync("getfacl", ["-cp", at], { encoding: "utf8" }).stdout;
  const { file } = fixture("house");
  // Made by the run, next to where it goes, and renamed into place.
  const made = path.join(base, "made");
  assert.equal(cli([file, "--length", "12", "--out", made]).status, 0);
  fs.mkdirSync(path.join(base, "plain"));
  assert.equal(acl(made), acl(path.join(base, "plain")));
  // There already: files built in the hidden folder inside it.
  fs.writeFileSync(path.join(base, "plain", "by-hand.wav"), "");
  assert.equal(cli([file, "--length", "12", "--out", path.join(base, "plain")]).status, 0);
  for (const name of ["fitted.wav", "cues.json"]) assert.equal(acl(path.join(base, "plain", name)), acl(path.join(base, "plain", "by-hand.wav")), name);
});

test("a commit moves the earlier cues.json aside first and the new one in last, and one that fails half way puts every earlier file back", () => {
  const folder = goodFit("commit-order");
  const fill = (run) => {
    for (const name of ["fitted.wav", "cues.json", "seams.png", "FIT.md"]) fs.writeFileSync(run.file(name), `new ${name}\n`);
  };
  const real = fs.renameSync;
  const moves = [];
  try {
    fs.renameSync = (from, to) => {
      moves.push([path.relative(folder, from), path.relative(folder, to)]);
      return real(from, to);
    };
    const run = out.begin(folder);
    fill(run);
    run.commit();
  } finally {
    fs.renameSync = real;
  }
  const part = (at) => at.replace(/^\.musicfit-part-\d+-[0-9a-f]{8}/, "part");
  assert.deepEqual(moves[0].map(part), ["cues.json", "part/.old/cues.json"]);
  assert.deepEqual(moves[moves.length - 1].map(part), ["part/cues.json", "cues.json"]);
  assert.deepEqual(fs.readdirSync(folder).sort(), ["FIT.md", "cues.json", "fitted.wav", "seams.png"]);

  // A move that fails half way: what had moved goes back.
  const again = goodFit("commit-fails");
  const earlier = snapshot(again);
  let count = 0;
  try {
    fs.renameSync = (from, to) => {
      if (++count === 4) throw Object.assign(new Error("not now"), { code: "EIO" });
      return real(from, to);
    };
    const run = out.begin(again);
    fill(run);
    assert.throws(() => run.commit(), /Could not put the new files in .*: not now\. .* is as it was\./);
    run.abort();
  } finally {
    fs.renameSync = real;
  }
  assert.deepEqual(snapshot(again), earlier);
});

test("--analyze and a fit keep their own default folders, so reading a track never replaces its fit", () => {
  const { file } = fixture("house");
  const cwd = path.join(dir, "defaults");
  fs.mkdirSync(cwd);
  const run = (args) => spawnSync(process.execPath, [CLI, file, ...args], { cwd, encoding: "utf8" });
  assert.equal(run(["--length", "12"]).status, 0);
  assert.equal(run(["--analyze"]).status, 0);
  assert.ok(fs.existsSync(path.join(cwd, "musicfit-house", "fitted.wav")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, "musicfit-house", "cues.json"), "utf8")).mode, "bars");
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, "musicfit-analysis-house", "cues.json"), "utf8")).mode, "analysis");
  assert.deepEqual(fs.readdirSync(path.join(cwd, "musicfit-analysis-house")).sort(), ["FIT.md", "cues.json", "seams.png"]);
});

test("a track named in any script gets a folder of its own, and one with no letters a short hash", () => {
  const { slug } = require("../skills/musicfit/scripts/lib/fit");
  assert.equal(slug("песня один.wav"), "песня-один");
  assert.equal(slug("歌 二.mp3"), "歌-二");
  assert.equal(slug("Şarkı Güzel.mp3"), "sarkı-guzel");
  assert.equal(slug("İstanbul.m4a"), "istanbul");
  assert.equal(slug("Café del Mar (Remix).flac"), "cafe-del-mar-remix");
  assert.equal(slug("موسيقى.wav"), "موسيقى");
  assert.equal(slug("트랙.wav"), "트랙");
  assert.match(slug("!!!.wav"), /^track-[0-9a-f]{6}$/);
  assert.notEqual(slug("!!!.wav"), slug("???.wav"));
  assert.equal(Array.from(slug(`${"а".repeat(100)}.wav`)).length, 60);

  const cwd = path.join(dir, "scripts");
  fs.mkdirSync(cwd);
  for (const name of ["песня один.wav", "歌 二.wav"]) fs.copyFileSync(fixture("house").file, path.join(cwd, name));
  for (const name of ["песня один.wav", "歌 二.wav"]) assert.equal(spawnSync(process.execPath, [CLI, name, "--length", "10"], { cwd, encoding: "utf8" }).status, 0);
  assert.deepEqual(fs.readdirSync(cwd).filter((e) => e.startsWith("musicfit-")).sort(), ["musicfit-песня-один", "musicfit-歌-二"].sort());
});
