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

// The number of a process that has ended.
function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

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
  // The earlier files took room too: they stay until the new ones are in place.
  assert.match(run.stderr, new RegExp(`musicfit: Cannot write to ${quote(out)}: the disk is full\\. ${quote(ROOM)}\n$`));
  assert.deepEqual(snapshot(out), before);
  assert.deepEqual(fs.readdirSync(path.dirname(out)).filter((e) => e.startsWith(".musicfit-")), []);
});

// Runs the CLI until it starts writing a WAV, then sends it `signal`. With
// `twice`, the run has a process group of its own, which gets the signal,
// and the run gets it again a moment later, as makersmcp's supervisor
// passes a cancel on. Resolves with how it ended and the ffmpeg stand-in's
// process number.
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
      } else if (Date.now() - started > 180000) {
        clearInterval(wait);
        child.kill("SIGKILL");
        reject(new Error(`the run never wrote a WAV: ${stderr}`));
      }
    }, 20);
    child.on("error", reject);
    child.on("exit", (code, sig) => {
      clearInterval(wait);
      const ffmpeg = Number((fs.existsSync(mark) && fs.readFileSync(mark, "utf8").trim()) || 0);
      resolve({ code, signal: sig, stderr, ffmpeg });
    });
  });
}

// Whether a process of that number still runs, once it has had a moment
// to go. One that has ended but was not waited for yet (a zombie, as in a
// container whose first process waits for no one) does not run.
async function alive(pid) {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    if (!state || state.startsWith("Z")) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What a full disk says where an earlier run's files are.
const ROOM = "The earlier files there stay until the new ones are in place, so the run needs room for both: free some space, or give another --out";

test("a run stopped with SIGTERM or SIGINT while it writes leaves the earlier files as they were, and ends by that signal", posix, async () => {
  const out = goodFit("stopped");
  const before = snapshot(out);
  const { file } = fixture("house");
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const run = await stopWhileWriting([file, "--length", "14", "--voice", fixture("voice").file, "--out", out], signal);
    assert.equal(run.signal, signal, `${signal}: ${run.code} ${run.stderr}`);
    assert.match(run.stderr, new RegExp(`\nmusicfit: stopped, so ${quote(out)} is as it was\n$`));
    assert.deepEqual(snapshot(out), before, signal);
    // The ffmpeg it had started was stopped with it, though only the run got the signal.
    assert.ok(run.ffmpeg > 0, "the stand-in left no process number");
    assert.equal(await alive(run.ffmpeg), false, `${signal}: the ffmpeg of the stopped run is still there`);
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
  // Made by the run when it put its files in place.
  const made = path.join(base, "made");
  assert.equal(cli([file, "--length", "12", "--out", made]).status, 0);
  fs.mkdirSync(path.join(base, "plain"));
  assert.equal(acl(made), acl(path.join(base, "plain")));
  // There already: files built in the hidden folder inside it.
  fs.writeFileSync(path.join(base, "plain", "by-hand.wav"), "");
  assert.equal(cli([file, "--length", "12", "--out", path.join(base, "plain")]).status, 0);
  for (const name of ["fitted.wav", "cues.json"]) assert.equal(acl(path.join(base, "plain", name)), acl(path.join(base, "plain", "by-hand.wav")), name);
});

test("a commit moves the earlier cues.json aside first and the new one in last, and one that fails half way puts every earlier file back", async () => {
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
    await run.commit();
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
    await assert.rejects(run.commit(), /Could not put the new files in .*: not now\. .* is as it was\./);
    run.abort();
  } finally {
    fs.renameSync = real;
  }
  assert.deepEqual(snapshot(again), earlier);
});

test("a commit that fails never moves back over a file that came in its place, nor takes away one that is not its own", async () => {
  const folder = goodFit("commit-guarded");
  const real = fs.renameSync;
  let count = 0;
  try {
    // The third move puts the new fitted.wav in; at the fourth, another
    // program has put a file of its own there, and the move fails.
    fs.renameSync = (from, to) => {
      if (++count === 4) {
        fs.rmSync(path.join(folder, "fitted.wav"));
        fs.writeFileSync(path.join(folder, "fitted.wav"), "another program's\n");
        throw Object.assign(new Error("not now"), { code: "EIO" });
      }
      return real(from, to);
    };
    const run = out.begin(folder);
    for (const name of ["fitted.wav", "cues.json", "seams.png", "FIT.md"]) fs.writeFileSync(run.file(name), `new ${name}\n`);
    await assert.rejects(run.commit(), /\. The earlier fitted\.wav could not be put back: it is in .*musicfit-kept-[^/]+\/\.old\.$/);
    run.abort();
  } finally {
    fs.renameSync = real;
  }
  assert.equal(fs.readFileSync(path.join(folder, "fitted.wav"), "utf8"), "another program's\n");
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "cues.json"), "utf8")).musicfit, require("../package.json").version);
  const kept = fs.readdirSync(folder).find((e) => e.startsWith("musicfit-kept-"));
  assert.ok(fs.existsSync(path.join(folder, kept, ".old", "fitted.wav")), "the earlier fitted.wav is not in the kept folder");
});

test("two runs that put their files in one folder at the same moment take turns, and the later one's files are what is left", async () => {
  const folder = goodFit("taking-turns");
  const fill = (run, who) => {
    for (const name of ["fitted.wav", "seams.png", "FIT.md"]) fs.writeFileSync(run.file(name), `${who} ${name}\n`);
    fs.writeFileSync(run.file("cues.json"), JSON.stringify({ musicfit: "test", file: "fitted.wav", mix: null, video: null, run: who }) + "\n");
  };
  const a = out.begin(folder);
  fill(a, "A");
  const b = out.begin(folder);
  fill(b, "B");
  const real = fs.renameSync;
  let later = null;
  try {
    // B ends while A moves its first file, as another process would.
    fs.renameSync = (from, to) => {
      const done = real(from, to);
      if (!later) later = b.commit();
      return done;
    };
    await a.commit();
  } finally {
    fs.renameSync = real;
  }
  await later;
  for (const name of ["fitted.wav", "seams.png", "FIT.md"]) assert.equal(fs.readFileSync(path.join(folder, name), "utf8"), `B ${name}\n`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "cues.json"), "utf8")).run, "B");
  assert.deepEqual(fs.readdirSync(folder).sort(), ["FIT.md", "cues.json", "fitted.wav", "seams.png"]);
});

test("the lock a run killed while it moved its files left is taken over", async () => {
  const folder = goodFit("stale-lock");
  fs.writeFileSync(path.join(folder, out.LOCK), `${require("node:os").hostname()} ${deadPid()}\n`);
  const run = out.begin(folder);
  for (const name of ["fitted.wav", "cues.json", "seams.png", "FIT.md"]) fs.writeFileSync(run.file(name), `new ${name}\n`);
  await run.commit();
  assert.deepEqual(fs.readdirSync(folder).sort(), ["FIT.md", "cues.json", "fitted.wav", "seams.png"]);
});

test("the hidden folder is made only when the run writes its first file, and one that cannot be made leaves nothing and says why", () => {
  const folder = path.join(dir, "lazy", "deeper", "fit");
  const run = out.begin(folder);
  assert.ok(!fs.existsSync(path.join(dir, "lazy")), "begin() made a folder");
  const real = fs.mkdirSync;
  try {
    fs.mkdirSync = (at, ...rest) => {
      if (path.basename(at) === ".tmp") throw Object.assign(new Error(`ENOSPC: no space left on device, mkdir '${at}'`), { code: "ENOSPC" });
      return real(at, ...rest);
    };
    assert.throws(() => run.file("fitted.wav"), new RegExp(`^Error: Cannot write to ${quote(folder)}: the disk is full$`));
  } finally {
    fs.mkdirSync = real;
  }
  run.abort();
  assert.ok(!fs.existsSync(path.join(dir, "lazy")), "a folder made for the hidden one is still there");
  // Where an earlier run's files are, a full disk says they took room too.
  const earlier = goodFit("lazy-full");
  const before = snapshot(earlier);
  const again = out.begin(earlier);
  try {
    fs.mkdirSync = (at, ...rest) => {
      if (path.basename(at).startsWith(".musicfit-part-")) throw Object.assign(new Error(`ENOSPC: no space left on device, mkdir '${at}'`), { code: "ENOSPC" });
      return real(at, ...rest);
    };
    assert.throws(() => again.file("fitted.wav"), new RegExp(`^Error: Cannot write to ${quote(earlier)}: the disk is full\\. ${quote(ROOM)}$`));
  } finally {
    fs.mkdirSync = real;
  }
  again.abort();
  assert.deepEqual(snapshot(earlier), before);
});

test("--analyze and a fit keep their own default folders, so reading a track never replaces its fit, nor the fit of a track whose name starts with Analysis", () => {
  const { file } = fixture("house");
  const cwd = path.join(dir, "defaults");
  fs.mkdirSync(cwd);
  for (const name of ["house.wav", "Analysis House.wav"]) fs.copyFileSync(file, path.join(cwd, name));
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  const cues = (folder) => JSON.parse(fs.readFileSync(path.join(cwd, folder, "cues.json"), "utf8"));
  assert.equal(run(["house.wav", "--length", "12"]).status, 0);
  assert.equal(run(["Analysis House.wav", "--length", "12"]).status, 0);
  assert.equal(run(["house.wav", "--analyze"]).status, 0);
  assert.equal(run(["Analysis House.wav", "--analyze"]).status, 0);
  assert.deepEqual(fs.readdirSync(cwd).filter((e) => e.startsWith("musicfit-")).sort(), ["musicfit-analysis-house", "musicfit-analysis-house.analysis", "musicfit-house", "musicfit-house.analysis"]);
  for (const [folder, track] of [["musicfit-house", "house.wav"], ["musicfit-analysis-house", "Analysis House.wav"]]) {
    assert.deepEqual(fs.readdirSync(path.join(cwd, folder)).sort(), ["FIT.md", "cues.json", "fitted.wav", "seams.png"], folder);
    assert.deepEqual([cues(folder).mode, cues(folder).track], ["bars", track], folder);
    assert.deepEqual(fs.readdirSync(path.join(cwd, `${folder}.analysis`)).sort(), ["FIT.md", "cues.json", "seams.png"], `${folder}.analysis`);
    assert.deepEqual([cues(`${folder}.analysis`).mode, cues(`${folder}.analysis`).track], ["analysis", track], `${folder}.analysis`);
  }
});

test("a run killed outright while it analyses the track leaves nothing behind: the hidden folder comes only with the first file, with a video too", posix, async () => {
  const out = goodFit("killed-analysing");
  const before = snapshot(out);
  const fresh = path.join(dir, "killed-fresh", "fit");
  // A video is read before the track, and leaves nothing on the disk.
  const film = path.join(dir, "killed-film.mp4");
  const made = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=14", "-c:v", "mpeg4", film], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  for (const [folder, video] of [[out, []], [fresh, []], [out, ["--video", film]], [fresh, ["--video", film]]]) {
    const mark = path.join(dir, `decoded-${process.hrtime.bigint()}`);
    const child = spawn(process.execPath, [CLI, fixture("house").file, "--length", "14", ...video, "--out", folder], { env: { ...process.env, FFMPEG_PATH: path.join(FIXTURES, "decoded", "ffmpeg"), MUSICFIT_TEST_MARK: mark } });
    const ended = new Promise((resolve) => child.on("exit", resolve));
    for (let i = 0; i < 12000 && !fs.existsSync(mark); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(mark), "the track was never decoded");
    child.kill("SIGKILL");
    await ended;
  }
  assert.deepEqual(snapshot(out), before);
  assert.deepEqual(fs.readdirSync(path.dirname(out)).filter((e) => e.startsWith(".musicfit-")), []);
  assert.ok(!fs.existsSync(path.join(dir, "killed-fresh")), "a folder was made");
});

test("a stop while the track is analysed is heard at once, as the analysis has a thread of its own", posix, async () => {
  // A track that takes seconds to analyse.
  const long = path.join(dir, "long-house.wav");
  const made = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-stream_loop", "4", "-i", fixture("house").file, "-c", "copy", long], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const folder = goodFit("stopped-analysing");
  const before = snapshot(folder);
  const mark = path.join(dir, `analysing-${process.hrtime.bigint()}`);
  const child = spawn(process.execPath, [CLI, long, "--length", "30", "--out", folder], { env: { ...process.env, FFMPEG_PATH: path.join(FIXTURES, "analysing", "ffmpeg"), MUSICFIT_TEST_MARK: mark } });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
  for (let i = 0; i < 12000 && !fs.existsSync(mark); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(mark), "the track was never decoded");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const sent = Date.now();
  child.kill("SIGTERM");
  const end = await ended;
  assert.equal(end.signal, "SIGTERM", `${end.code} ${stderr}`);
  // The tempo is said as soon as the analysis is done: the stop came first.
  assert.doesNotMatch(stderr, /BPM/);
  assert.match(stderr, new RegExp(`\nmusicfit: stopped, so ${quote(folder)} is as it was\n$`));
  assert.ok(end.at - sent < 2000, `the stop took ${end.at - sent} ms`);
  assert.deepEqual(snapshot(folder), before);
});

test("no stretch of a long fit holds the main thread long enough to keep a stop waiting", async () => {
  const { fit } = require("../skills/musicfit/scripts/lib/fit");
  const folder = outDir("held");
  // Made first: making the track is the test's work, not the run's.
  const track = fixture("house").file;
  // The time the main thread itself works between two turns of a timer, so
  // a machine busy with other work, which only makes the turns come late,
  // does not count. Node 22 before 22.19 tells only the time that passed.
  const spent = process.threadCpuUsage ? () => (({ user, system }) => (user + system) / 1000)(process.threadCpuUsage()) : () => Date.now();
  let last = spent();
  let longest = 0;
  const timer = setInterval(() => {
    const now = spent();
    longest = Math.max(longest, now - last);
    last = now;
  }, 5);
  try {
    await fit(track, { length: 600, hit: 300, out: folder, fps: 30, duck: 10, lufs: -14, end: "auto", warnings: [] });
  } finally {
    clearInterval(timer);
  }
  // In one go, the work on ten minutes of sound held it for a second at a time.
  assert.ok(longest < 500, `held for ${longest.toFixed(0)} ms`);
});

test("while a track is analysed the run is free to hear a stop: the analysis has a thread of its own", async () => {
  const { analyzeInThread } = require("../skills/musicfit/scripts/lib/thread");
  const { analyze } = require("../skills/musicfit/scripts/lib/analyze");
  const { decode } = require("../skills/musicfit/scripts/lib/audio");
  const samples = await decode(fixture("house").file, { rate: 24000, channels: 1 });
  const alone = analyze(samples.slice(), {});
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const started = Date.now();
  const a = await analyzeInThread(samples, {});
  const took = Date.now() - started;
  clearInterval(timer);
  assert.ok(ticks >= Math.min(5, took / 20), `${ticks} ticks in ${took} ms`);
  // The same analysis, the bars' distance included.
  assert.equal(a.tempo.bpm, alone.tempo.bpm);
  assert.deepEqual(a.bars, alone.bars);
  assert.equal(a.distance(1, 5), alone.distance(1, 5));
});

test("a stop whose ffmpeg ended a moment before it, as with Ctrl-C to the whole group, is still said and ends by that signal", posix, async () => {
  const out = goodFit("dies-first");
  const before = snapshot(out);
  const child = spawn(process.execPath, [CLI, fixture("house").file, "--length", "14", "--out", out, "--json"], { env: { ...process.env, FFMPEG_PATH: path.join(FIXTURES, "diesfirst", "ffmpeg") } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const [code, signal] = await new Promise((resolve) => child.on("exit", (...end) => resolve(end)));
  assert.equal(signal, "SIGINT", `${code} ${stderr}`);
  assert.match(stderr, new RegExp(`musicfit: stopped, so ${quote(out)} is as it was\n$`));
  assert.deepEqual(JSON.parse(stdout), { ok: false, error: `stopped, so ${out} is as it was` });
  assert.deepEqual(snapshot(out), before);
});

test("a process that exits with a run not ended takes its hidden folder with it", () => {
  const folder = path.join(dir, "exits", "fit");
  const script = `const out = require(${JSON.stringify(path.resolve(__dirname, "../skills/musicfit/scripts/lib/out"))}); const run = out.begin(${JSON.stringify(folder)}); require("node:fs").writeFileSync(run.file("fitted.wav"), "half"); process.exit(3);`;
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(run.status, 3, run.stderr);
  assert.ok(!fs.existsSync(path.join(dir, "exits")), `left: ${fs.existsSync(path.join(dir, "exits")) ? JSON.stringify(snapshot(path.join(dir, "exits"))) : ""}`);
});

test("a file under one of musicfit's names that no musicfit cues.json there lists stops the run before any work, and files under other names stay", () => {
  const { file } = fixture("house");
  const folder = outDir("their-files");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "cues.json"), JSON.stringify({ mine: "cue sheet from my editor" }));
  fs.writeFileSync(path.join(folder, "FIT.md"), "my own notes\n");
  const both = cli([file, "--length", "12", "--out", folder]);
  assert.equal(both.status, 1);
  assert.match(both.stderr, new RegExp(`musicfit: ${quote(folder)} holds cues\\.json and FIT\\.md, which musicfit did not write, and this run would replace them: move them, or give another --out\n`));
  assert.doesNotMatch(both.stderr, /Reading/);
  fs.rmSync(path.join(folder, "cues.json"));
  const one = cli([file, "--length", "12", "--out", folder]);
  assert.equal(one.status, 1);
  assert.match(one.stderr, new RegExp(`musicfit: ${quote(path.join(folder, "FIT.md"))} is not a file musicfit wrote, and this run would replace it: move it, or give another --out\n`));
  assert.equal(fs.readFileSync(path.join(folder, "FIT.md"), "utf8"), "my own notes\n");
  // A mix.wav of the user's, which a run without a voice does not write, stays.
  fs.rmSync(path.join(folder, "FIT.md"));
  fs.writeFileSync(path.join(folder, "mix.wav"), "my mix\n");
  const fits = cli([file, "--length", "12", "--out", folder]);
  assert.equal(fits.status, 0, fits.stderr);
  const again = cli([file, "--length", "12", "--out", folder]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(path.join(folder, "mix.wav"), "utf8"), "my mix\n");
});

// A fit with a voice and a video of no sound of its own: every file a run
// can write.
function videoFit(name) {
  const film = path.join(dir, `${name}-film.mp4`);
  const made = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-c:v", "mpeg4", film], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const folder = outDir(name);
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--voice", fixture("voice").file, "--video", film, "--out", folder]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(fs.readdirSync(folder).sort(), ["FIT.md", "cues.json", "fitted.wav", "mix.wav", "seams.png", "video.mp4"]);
  return { folder, film };
}

test("cues.json gives the size of each file the run wrote beside it", () => {
  const { folder } = videoFit("sizes");
  const sizes = (at) => JSON.parse(fs.readFileSync(path.join(at, "cues.json"), "utf8")).sizes;
  assert.deepEqual(Object.keys(sizes(folder)).sort(), ["FIT.md", "fitted.wav", "mix.wav", "seams.png", "video.mp4"]);
  for (const [name, size] of Object.entries(sizes(folder))) assert.equal(size, fs.statSync(path.join(folder, name)).size, name);
  const read = outDir("sizes-analysis");
  const run = cli([fixture("house").file, "--analyze", "--out", read, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).sizes, sizes(read));
  assert.deepEqual(Object.keys(sizes(read)).sort(), ["FIT.md", "seams.png"]);
  for (const [name, size] of Object.entries(sizes(read))) assert.equal(size, fs.statSync(path.join(read, name)).size, name);
});

test("a file counts as the earlier run's only while it is as that run wrote it, so a copied cues.json never makes the user's files musicfit's", () => {
  const { file } = fixture("house");
  const { folder: made, film } = videoFit("copied-from");
  // cues.json copied into a project folder that holds the user's own film
  // and mix under musicfit's names, as for a Remotion edit.
  const project = outDir("copied-into");
  fs.mkdirSync(project);
  fs.copyFileSync(path.join(made, "cues.json"), path.join(project, "cues.json"));
  fs.copyFileSync(film, path.join(project, "video.mp4"));
  fs.writeFileSync(path.join(project, "mix.wav"), "my own mix\n");
  const before = snapshot(project);
  const both = cli([file, "--length", "12", "--voice", fixture("voice").file, "--video", film, "--out", project]);
  assert.equal(both.status, 1);
  assert.match(both.stderr, new RegExp(`musicfit: ${quote(project)} holds mix\\.wav and video\\.mp4, which are not the files musicfit wrote there, and this run would replace them: move them, or give another --out\n`));
  assert.doesNotMatch(both.stderr, /Reading/);
  assert.deepEqual(snapshot(project), before);
  // A fit that writes neither leaves them as they are.
  const plain = cli([file, "--length", "12", "--out", project]);
  assert.equal(plain.status, 0, plain.stderr);
  const after = snapshot(project);
  assert.deepEqual([after["video.mp4"], after["mix.wav"]], [before["video.mp4"], before["mix.wav"]]);
  assert.deepEqual(Object.keys(after).sort(), ["FIT.md", "cues.json", "fitted.wav", "mix.wav", "seams.png", "video.mp4"]);

  // A FIT.md changed since musicfit wrote it is the user's now; one whose
  // line ends git turned into CR LF is still musicfit's.
  const notes = path.join(project, "FIT.md");
  const written = fs.readFileSync(notes, "utf8");
  fs.writeFileSync(notes, `${written}\nMy notes on the cut.\n`);
  const edited = cli([file, "--length", "12", "--out", project]);
  assert.equal(edited.status, 1);
  assert.match(edited.stderr, new RegExp(`musicfit: ${quote(notes)} is not the FIT\\.md musicfit wrote there, and this run would replace it: move it, or give another --out\n`));
  fs.writeFileSync(notes, written.replace(/\n/g, "\r\n"));
  const crlf = cli([file, "--length", "12", "--out", project]);
  assert.equal(crlf.status, 0, crlf.stderr);

  // A video.mp4 of the size cues.json gives but without musicfit's mark is
  // not musicfit's either: a fit without --video leaves it, and removes the
  // earlier mix.wav, which is musicfit's.
  const unmarked = outDir("unmarked");
  fs.cpSync(made, unmarked, { recursive: true });
  const video = fs.readFileSync(path.join(unmarked, "video.mp4"));
  const at = video.indexOf("a fitted track laid under this picture");
  assert.ok(at > 0, "video.mp4 has no mark");
  video.write("A", at);
  fs.writeFileSync(path.join(unmarked, "video.mp4"), video);
  const fit = cli([file, "--length", "12", "--out", unmarked]);
  assert.equal(fit.status, 0, fit.stderr);
  assert.deepEqual(fs.readdirSync(unmarked).sort(), ["FIT.md", "cues.json", "fitted.wav", "seams.png", "video.mp4"]);
  assert.ok(fs.readFileSync(path.join(unmarked, "video.mp4")).equals(video));
});

test("a run that ends well names the earlier run's files it removed: an analysis in a fit's folder, a fit without --video in the folder of one with it", () => {
  const { file } = fixture("house");
  const { folder } = videoFit("removed-by-analysis");
  const copy = outDir("removed-by-fit");
  fs.cpSync(folder, copy, { recursive: true });
  const said = (run, note) => {
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`\n  Note    ${quote(note)}\n`));
  };
  const read = cli([file, "--analyze", "--out", folder]);
  const note = `This run removed the earlier fit's fitted.wav, mix.wav and video.mp4 from ${folder}, as it writes none of them.`;
  said(read, note);
  assert.ok(JSON.parse(fs.readFileSync(path.join(folder, "cues.json"), "utf8")).warnings.includes(note));
  assert.ok(fs.readFileSync(path.join(folder, "FIT.md"), "utf8").includes(`\n- ${note}\n`));
  assert.deepEqual(fs.readdirSync(folder).sort(), ["FIT.md", "cues.json", "seams.png"]);
  // A fit with the voice and no video: only video.mp4 goes, and in --json too.
  const fit = cli([file, "--length", "12", "--voice", fixture("voice").file, "--out", copy, "--json"]);
  assert.equal(fit.status, 0, fit.stderr);
  assert.ok(JSON.parse(fit.stdout).warnings.includes(`This run removed the earlier fit's video.mp4 from ${copy}, as it does not write one.`), fit.stdout);
  assert.ok(fs.readFileSync(path.join(copy, "FIT.md"), "utf8").includes(`This run removed the earlier fit's video.mp4 from ${copy}`));
  // Then without the voice: mix.wav goes.
  said(cli([file, "--length", "12", "--out", copy]), `This run removed the earlier fit's mix.wav from ${copy}, as it does not write one.`);
  // A run that writes all the earlier run wrote removes nothing, and says nothing of it.
  const again = cli([file, "--length", "12", "--out", copy]);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /This run removed/);
});

test("an input that is a file the run replaces or removes once it ends well is refused before any work", () => {
  const { file } = fixture("house");
  const folder = goodFit("inputs-inside");
  const copy = path.join(dir, "inputs-inside-track.wav");
  fs.copyFileSync(file, copy);
  const cases = [
    [[path.join(folder, "fitted.wav"), "--length", "10", "--out", folder], /fitted\.wav is the fitted\.wav in .*, which this run replaces once it ends well: copy it somewhere else first, or give another --out/],
    [[copy, "--length", "10", "--voice", path.join(folder, "mix.wav"), "--out", folder], /mix\.wav is the mix\.wav in .*, which this run replaces once it ends well/],
    [[copy, "--length", "10", "--hit", "5", "--out", folder, "--voice", path.join(folder, "fitted.wav")], /fitted\.wav is the fitted\.wav in .*, which this run replaces once it ends well/],
    // Without --voice a run removes the earlier mix.wav.
    [[path.join(folder, "mix.wav"), "--length", "10", "--out", folder], /mix\.wav is the mix\.wav in .*, which this run removes once it ends well/],
  ];
  const before = snapshot(folder);
  for (const [args, message] of cases) {
    const run = cli(args);
    assert.equal(run.status, 1, `${args.join(" ")}: ${run.stderr}`);
    assert.match(run.stderr, message);
    assert.doesNotMatch(run.stderr, /Reading/);
  }
  assert.deepEqual(snapshot(folder), before);
});

test("a track named in any script gets a folder of its own, and one with no letters a short hash", () => {
  const { slug } = require("../skills/musicfit/scripts/lib/fit");
  assert.equal(slug("песня один.wav"), "песня-один");
  assert.equal(slug("歌 二.mp3"), "歌-二");
  assert.equal(slug("Şarkı Güzel.mp3"), "sarkı-guzel");
  assert.equal(slug("İstanbul.m4a"), "istanbul");
  assert.equal(slug("Café del Mar (Remix).flac"), "cafe-del-mar-remix");
  // The same name written with a separate accent.
  assert.equal(slug("Cafe\u0301 del Mar (Remix).flac"), "cafe-del-mar-remix");
  assert.equal(slug("موسيقى.wav"), "موسيقى");
  assert.equal(slug("트랙.wav"), "트랙");
  assert.match(slug("!!!.wav"), /^track-[0-9a-f]{6}$/);
  assert.notEqual(slug("!!!.wav"), slug("???.wav"));
  // A sign that needs no letter is no name: an emoji with its variation selector.
  assert.match(slug("\u2764\ufe0f.wav"), /^track-[0-9a-f]{6}$/);
  // Marks that are part of a letter stay: the vowel signs of Hindi, Tamil
  // and Thai, and the й of Russian.
  for (const [a, b] of [["गाना.mp3", "गुना.mp3"], ["काल.wav", "कल.wav"], ["किल.wav", "कल.wav"], ["கானா.mp3", "கனா.mp3"], ["เพลง.mp3", "เพลิง.mp3"], ["мой.wav", "мои.wav"]]) {
    assert.notEqual(slug(a), slug(b), `${a} and ${b}`);
  }
  assert.equal(slug("गाना.mp3"), "गाना");
  assert.equal(slug("เพลิง.mp3"), "เพลิง");
  // A long name is cut, and ends in a hash of the whole of it.
  const long = (n) => `Epic Cinematic Orchestral Trailer Music for a Product Launch Video (${n}).wav`;
  assert.notEqual(slug(long(1)), slug(long(2)));
  assert.match(slug(long(1)), /^epic-cinematic-orchestral-trailer-music-for-a-product-[0-9a-f]{6}$/);
  assert.equal(Array.from(slug(`${"а".repeat(100)}.wav`)).length, 60);
  assert.notEqual(slug(`${"а".repeat(100)}.wav`), slug(`${"а".repeat(99)}б.wav`));

  const cwd = path.join(dir, "scripts");
  fs.mkdirSync(cwd);
  const names = ["песня один.wav", "歌 二.wav", "गाना.wav", "गुना.wav"];
  for (const name of names) fs.copyFileSync(fixture("house").file, path.join(cwd, name));
  for (const name of names) assert.equal(spawnSync(process.execPath, [CLI, name, "--length", "10"], { cwd, encoding: "utf8" }).status, 0);
  assert.deepEqual(fs.readdirSync(cwd).filter((e) => e.startsWith("musicfit-")).sort(), ["musicfit-песня-один", "musicfit-歌-二", "musicfit-गाना", "musicfit-गुना"].sort());
});

test("a disk that fills as the lock is made leaves nothing of it: the out folder is as it was, and one the run made goes again", async () => {
  const real = { openSync: fs.openSync, writeSync: fs.writeSync, writeFileSync: fs.writeFileSync };
  const full = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  const lockAt = (at) => typeof at === "string" && path.basename(at) === out.LOCK;
  const fill = (run) => {
    for (const name of ["fitted.wav", "cues.json", "seams.png", "FIT.md"]) fs.writeFileSync(run.file(name), `new ${name}\n`);
  };
  const lockFds = new Set();
  // The file is made, and its line does not fit on the disk: however the
  // lock is written, with a descriptor or in one go.
  const stub = () => {
    fs.openSync = (at, ...rest) => {
      const fd = real.openSync(at, ...rest);
      if (lockAt(at)) lockFds.add(fd);
      return fd;
    };
    fs.writeSync = (fd, ...rest) => {
      if (lockFds.has(fd)) throw full();
      return real.writeSync(fd, ...rest);
    };
    fs.writeFileSync = (at, ...rest) => {
      if (!lockAt(at)) return real.writeFileSync(at, ...rest);
      fs.closeSync(real.openSync(at, "wx"));
      throw full();
    };
  };
  const folder = goodFit("lock-full");
  const before = snapshot(folder);
  const fresh = path.join(dir, "lock-full-new", "fit");
  for (const [at, check] of [[folder, () => assert.deepEqual(snapshot(folder), before)], [fresh, () => assert.ok(!fs.existsSync(path.dirname(fresh)), "the folders the run made are still there")]]) {
    const run = out.begin(at);
    fill(run);
    try {
      stub();
      await assert.rejects(run.commit(), new RegExp(`^Error: Could not put the new files in ${quote(at)}: the disk is full\\. ${quote(at)} is as it was\\.$`));
    } finally {
      Object.assign(fs, real);
    }
    run.abort();
    check();
  }
});

test("a lock that names no process and was made a while ago is taken over at once", { timeout: 30000 }, async () => {
  const folder = goodFit("bare-lock");
  const lock = path.join(folder, out.LOCK);
  fs.writeFileSync(lock, "");
  const then = new Date(Date.now() - 10000);
  fs.utimesSync(lock, then, then);
  const run = out.begin(folder);
  for (const name of ["fitted.wav", "cues.json", "seams.png", "FIT.md"]) fs.writeFileSync(run.file(name), `new ${name}\n`);
  const started = Date.now();
  await run.commit();
  assert.ok(Date.now() - started < 5000, `the commit waited ${Date.now() - started} ms`);
  assert.deepEqual(fs.readdirSync(folder).sort(), ["FIT.md", "cues.json", "fitted.wav", "seams.png"]);
});

test("an out folder that is a link to a folder that is not there, or is below one, is refused before any work", posix, () => {
  const { file } = fixture("house");
  const link = path.join(dir, "link-to-nowhere");
  fs.symlinkSync(path.join(dir, "no-such-folder"), link);
  for (const [at, message] of [[link, `it is a link to ${quote(path.join(dir, "no-such-folder"))}, which is not there`], [path.join(link, "fit"), `${quote(link)} is a link to ${quote(path.join(dir, "no-such-folder"))}, which is not there`]]) {
    const run = cli([file, "--length", "12", "--out", at]);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, new RegExp(`^musicfit: Cannot write to ${quote(at)}: ${message}\n$`));
    assert.ok(!fs.existsSync(path.join(dir, "no-such-folder")));
  }
  assert.deepEqual(fs.readdirSync(dir).filter((e) => e.startsWith(".musicfit-")), []);
});

test("an out folder on a drive or a share that is not there is refused, not looked for forever", () => {
  // Every folder up to the top is missing, as on a drive that is not plugged in.
  const root = path.parse(process.cwd()).root;
  const at = path.join(root, "no-such-drive", "fit");
  const script = `const fs = require("node:fs"); fs.existsSync = () => false; try { require(${JSON.stringify(path.resolve(__dirname, "../skills/musicfit/scripts/lib/out"))}).writable(${JSON.stringify(at)}); } catch (err) { console.log(err.message); }`;
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10000 });
  assert.equal(run.signal, null, "writable() never returned");
  assert.equal(run.stdout, `Cannot write to ${at}: ${root} is not there\n`);
});

// A commit whose fourth move fails, as a file held open does, and whose new
// fitted.wav cannot go back to the hidden folder either. With `unlink`
// false, it cannot be removed from the out folder too.
async function commitHeld(name, { unlink = true, rename = true } = {}) {
  const folder = goodFit(name);
  const before = snapshot(folder);
  const real = { renameSync: fs.renameSync, unlinkSync: fs.unlinkSync };
  let count = 0;
  const run = out.begin(folder);
  for (const file of ["fitted.wav", "cues.json", "seams.png", "FIT.md"]) fs.writeFileSync(run.file(file), `new ${file}\n`);
  let error = null;
  try {
    fs.renameSync = (from, to) => {
      const busy = Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
      // Back from the out folder into the hidden one, not aside into .old.
      if (from === path.join(folder, "fitted.wav") && path.basename(path.dirname(to)).startsWith(".musicfit-part-")) throw busy;
      if (!rename && path.basename(to).startsWith("musicfit-kept-")) throw busy;
      if (++count === 4) throw Object.assign(new Error("not now"), { code: "EIO" });
      return real.renameSync(from, to);
    };
    fs.unlinkSync = (at) => {
      if (!unlink && at === path.join(folder, "fitted.wav")) throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
      return real.unlinkSync(at);
    };
    await run.commit();
  } catch (err) {
    error = err;
  } finally {
    Object.assign(fs, real);
  }
  run.abort();
  return { folder, before, error };
}

test("a commit that fails takes its new file out of the out folder when it cannot move it back, so every earlier file returns", async () => {
  const { folder, before, error } = await commitHeld("held-new");
  assert.match(String(error), new RegExp(`: not now\\. ${quote(folder)} is as it was\\.$`));
  assert.deepEqual(snapshot(folder), before);
});

test("a commit that can put neither its new file out nor the earlier one back says which is where, and the note says the same", async () => {
  const { folder, error } = await commitHeld("held-both", { unlink: false });
  const kept = fs.readdirSync(folder).find((e) => e.startsWith("musicfit-kept-"));
  assert.ok(kept, "no kept folder");
  assert.equal(String(error), `Error: Could not put the new files in ${folder}: ${path.join(folder, "mix.wav")}: not now. The earlier fitted.wav could not be put back: it is in ${path.join(folder, kept, ".old")}. The new fitted.wav could not be taken out again, so in ${folder} it is this run's.`);
  assert.equal(fs.readFileSync(path.join(folder, "fitted.wav"), "utf8"), "new fitted.wav\n");
  assert.ok(fs.existsSync(path.join(folder, kept, ".old", "fitted.wav")));
  // It keeps the earlier files and the note, not the new files moved back into it.
  assert.deepEqual(fs.readdirSync(path.join(folder, kept)).sort(), [".old", "musicfit-kept.txt"]);
  const note = fs.readFileSync(path.join(folder, kept, "musicfit-kept.txt"), "utf8");
  assert.match(note, new RegExp(`\n  \\.old/fitted\\.wav, which belongs in ${quote(folder)} as fitted\\.wav\n`));
  assert.match(note, new RegExp(`In ${quote(folder)}, fitted\\.wav is that run's new file: remove it first\\.`));
  assert.doesNotMatch(note, /\.\.\//);
});

test("a hidden folder with a note of the earlier files it keeps is never removed by a later run", async () => {
  const { folder, error } = await commitHeld("held-kept", { unlink: false, rename: false });
  assert.match(String(error), /The earlier fitted\.wav could not be put back: it is in .*\.musicfit-part-[^/]+\/\.old\./);
  // Its run has ended, and it has not changed for 20 minutes.
  const mine = fs.readdirSync(folder).find((e) => e.startsWith(".musicfit-part-"));
  const dead = path.join(folder, mine.replace(/^(\.musicfit-part-)\d+/, `$1${deadPid()}`));
  fs.renameSync(path.join(folder, mine), dead);
  age(dead, 20);
  fs.writeFileSync(path.join(folder, "fitted.wav"), fs.readFileSync(path.join(dead, ".old", "fitted.wav")));
  const plain = cli([fixture("house").file, "--length", "12", "--out", folder]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(fs.existsSync(path.join(dead, ".old", "fitted.wav")), "the earlier fitted.wav the message named went");
});

test("a disk that fills while the run writes is said in plain words, and a file is named in the out folder, never in the hidden one", posix, async () => {
  const { file } = fixture("house");
  const folder = outDir("said-full");
  const full = cli([file, "--length", "12", "--out", folder], { FFMPEG_PATH: path.join(FIXTURES, "fullwav", "ffmpeg") });
  assert.equal(full.status, 1);
  assert.equal(full.stderr.split("\n").filter(Boolean).pop(), `musicfit: Cannot write to ${folder}: the disk is full`);
  const denied = cli([file, "--length", "12", "--out", folder], { FFMPEG_PATH: path.join(FIXTURES, "deniedwav", "ffmpeg") });
  assert.equal(denied.status, 1);
  assert.equal(denied.stderr.split("\n").filter(Boolean).pop(), `musicfit: ffmpeg: Error opening output ${path.join(folder, "fitted.wav")}: Permission denied`);
  // Node's own words for a file it writes.
  const { fit } = require("../skills/musicfit/scripts/lib/fit");
  const real = fs.writeFileSync;
  try {
    fs.writeFileSync = (at, ...rest) => {
      if (String(at).endsWith("cues.json")) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" });
      return real(at, ...rest);
    };
    await assert.rejects(fit(file, { length: 12, out: folder, fps: 30, duck: 10, lufs: -14, end: "auto" }), new RegExp(`^Error: Cannot write to ${quote(folder)}: the disk is full$`));
  } finally {
    fs.writeFileSync = real;
  }
  assert.ok(!fs.existsSync(folder));
});

test("a file ffmpeg 4.4 could not finish as the disk filled, though it exits with 0, fails the run in plain words and the earlier files stay", posix, () => {
  const { file } = fixture("house");
  const film = path.join(dir, "trailer-film.mp4");
  const made = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-c:v", "mpeg4", film], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const folder = outDir("trailer");
  const args = [file, "--length", "12", "--hit", "8", "--video", film, "--out", folder];
  const first = cli(args);
  assert.equal(first.status, 0, first.stderr);
  const before = snapshot(folder);
  // video.mp4, the AAC its sound is measured from, and fitted.wav.
  for (const name of ["video.mp4", ".0.m4a", "fitted.wav"]) {
    const run = cli(args, { FFMPEG_PATH: path.join(FIXTURES, "trailer44", "ffmpeg"), MUSICFIT_TEST_TRAILER: name });
    assert.equal(run.status, 1, `${name}: ${run.stderr}`);
    assert.equal(run.stderr.split("\n").filter(Boolean).pop(), `musicfit: Cannot write to ${folder}: the disk is full. ${ROOM}`, name);
    assert.deepEqual(snapshot(folder), before, name);
  }
  // A video.mp4 that cannot be read back is never put in place, whatever ffmpeg said.
  const quiet = cli(args, { FFMPEG_PATH: path.join(FIXTURES, "trailer44", "ffmpeg"), MUSICFIT_TEST_TRAILER: "video.mp4", MUSICFIT_TEST_QUIET: "1" });
  assert.equal(quiet.status, 1, quiet.stderr);
  assert.match(quiet.stderr, /\nmusicfit: The video\.mp4 this run wrote cannot be read back \([^)\n]+\), so it was not put in place\n$/);
  assert.doesNotMatch(quiet.stderr, /musicfit-part/);
  assert.deepEqual(snapshot(folder), before);
});

test("a stop while the run reads the video's frame rate, before it began, is said too, and in --json", posix, async () => {
  const film = path.join(dir, "rate-film.mp4");
  const made = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-c:v", "mpeg4", film], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const folder = path.join(dir, "stopped-at-rate");
  const mark = path.join(dir, `rate-${process.hrtime.bigint()}`);
  // A time in frames with no --fps: the frame rate is read from the video first.
  const child = spawn(process.execPath, [CLI, fixture("house").file, "--length", "300f", "--hit", "200f", "--video", film, "--out", folder, "--json"], { env: { ...process.env, FFMPEG_PATH: path.join(FIXTURES, "slowprobe", "ffmpeg"), MUSICFIT_TEST_MARK: mark } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  for (let i = 0; i < 3000 && !fs.existsSync(mark); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(mark), "the video was never read");
  child.kill("SIGINT");
  const end = await ended;
  assert.equal(end.signal, "SIGINT", `${end.code} ${stderr}`);
  assert.equal(stderr, `musicfit: stopped, so ${folder} is as it was\n`);
  assert.deepEqual(JSON.parse(stdout), { ok: false, error: `stopped, so ${folder} is as it was` });
  assert.ok(!fs.existsSync(folder));
});

test("a fit whose commit fails says where the earlier files went, in a folder that is there, also when the disk is full", async () => {
  const { fit } = require("../skills/musicfit/scripts/lib/fit");
  const { file } = fixture("house");
  const options = (folder, more = {}) => ({ length: 12, out: folder, fps: 30, duck: 10, lufs: -14, end: "auto", warnings: [], ...more });
  const cases = [
    // The hidden folder cannot be renamed to musicfit-kept- either, so it is named.
    ["kept-unrenamed", (from, to) => Object.assign(new Error("not now"), { code: "EIO" }), false, /: .*seams\.png: not now\. The earlier fitted\.wav could not be put back: it is in (.+\/\.musicfit-part-[^/]+\/\.old)\.$/],
    // A move that fails as a full folder does: the message keeps where the earlier files are.
    ["kept-full", (from, to) => Object.assign(new Error(`ENOSPC: no space left on device, rename '${from}' -> '${to}'`), { code: "ENOSPC", syscall: "rename" }), true, /: the disk is full\. The earlier fitted\.wav could not be put back: it is in (.+\/musicfit-kept-[^/]+\/\.old)\.$/],
  ];
  for (const [name, failure, renamed, message] of cases) {
    const folder = outDir(name);
    await fit(file, options(folder));
    const earlier = fs.readFileSync(path.join(folder, "fitted.wav"));
    const real = fs.renameSync;
    let count = 0;
    let error = null;
    try {
      fs.renameSync = (from, to) => {
        const busy = Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}' -> '${to}'`), { code: "EBUSY", syscall: "rename" });
        if (to === path.join(folder, "fitted.wav") && path.basename(path.dirname(from)) === ".old") throw busy;
        if (!renamed && path.basename(to).startsWith("musicfit-kept-")) throw busy;
        if (from.startsWith(folder + path.sep) && ++count === 4) throw failure(from, to);
        return real(from, to);
      };
      await fit(file, options(folder, { hit: 8 }));
    } catch (err) {
      error = err;
    } finally {
      fs.renameSync = real;
    }
    assert.ok(error, `${name}: the fit did not fail`);
    const named = message.exec(error.message);
    assert.ok(named, `${name}: ${error.message}`);
    assert.ok(named[1].startsWith(folder + path.sep), `${name}: ${named[1]}`);
    assert.ok(fs.readFileSync(path.join(named[1], "fitted.wav")).equals(earlier), `${name}: the folder named does not hold the earlier fitted.wav`);
  }
});

test("a commit that fails with only a new file stuck in the out folder leaves no hidden folder", async () => {
  const folder = outDir("new-stuck");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "cues.json"), JSON.stringify({ musicfit: "test", file: "fitted.wav", mix: null, video: null }));
  for (const name of ["fitted.wav", "seams.png", "FIT.md"]) fs.writeFileSync(path.join(folder, name), `old ${name}\n`);
  const run = out.begin(folder);
  for (const name of ["fitted.wav", "cues.json", "seams.png", "FIT.md", "video.mp4"]) fs.writeFileSync(run.file(name), `new ${name}\n`);
  const real = { renameSync: fs.renameSync, unlinkSync: fs.unlinkSync };
  const busy = () => Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
  let error = null;
  try {
    // The last move fails, and the new video.mp4, which no earlier file
    // had the name of, can be neither moved back nor removed.
    fs.renameSync = (from, to) => {
      if (from === path.join(folder, "video.mp4")) throw busy();
      if (to === path.join(folder, "cues.json") && !from.includes(`${path.sep}.old${path.sep}`)) throw Object.assign(new Error("not now"), { code: "EIO" });
      return real.renameSync(from, to);
    };
    fs.unlinkSync = (at) => {
      if (at === path.join(folder, "video.mp4")) throw busy();
      return real.unlinkSync(at);
    };
    await run.commit();
  } catch (err) {
    error = err;
  } finally {
    Object.assign(fs, real);
  }
  run.abort();
  assert.equal(String(error), `Error: Could not put the new files in ${folder}: ${path.join(folder, "cues.json")}: not now. The new video.mp4 could not be taken out again, so in ${folder} it is this run's.`);
  assert.deepEqual(fs.readdirSync(folder).sort(), ["FIT.md", "cues.json", "fitted.wav", "seams.png", "video.mp4"]);
  for (const name of ["fitted.wav", "seams.png", "FIT.md"]) assert.equal(fs.readFileSync(path.join(folder, name), "utf8"), `old ${name}\n`);
});

test("a run whose hidden folder cannot be removed says so, when its commit fails and when it fails before", async () => {
  const real = { rmSync: fs.rmSync, openSync: fs.openSync, writeFileSync: fs.writeFileSync };
  // The hidden folder stays, as one in a folder that may not be changed does.
  const stays = () => {
    fs.rmSync = (at, ...rest) => {
      if (/\.musicfit-part-\d+-[0-9a-f]{8}$/.test(String(at))) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return real.rmSync(at, ...rest);
    };
  };
  const left = (folder) => fs.readdirSync(folder).filter((e) => e.startsWith(".musicfit-part-"));
  const said = (folder, part) => `${folder} is as it was but for the hidden folder ${path.join(folder, part)}, which could not be removed; a later run that ends well in ${folder} removes it once it is 15 minutes old`;

  const folder = goodFit("left-commit");
  const run = out.begin(folder);
  for (const name of ["fitted.wav", "cues.json", "seams.png", "FIT.md"]) fs.writeFileSync(run.file(name), `new ${name}\n`);
  let error = null;
  try {
    stays();
    fs.openSync = (at, ...rest) => {
      if (path.basename(String(at)) === out.LOCK) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return real.openSync(at, ...rest);
    };
    await run.commit();
  } catch (err) {
    error = err;
  } finally {
    Object.assign(fs, real);
  }
  assert.equal(left(folder).length, 1);
  assert.equal(String(error), `Error: Could not put the new files in ${folder}: permission denied. ${said(folder, left(folder)[0])}.`);

  const { fit } = require("../skills/musicfit/scripts/lib/fit");
  const plain = goodFit("left-plain");
  const before = snapshot(plain);
  error = null;
  try {
    stays();
    fs.writeFileSync = (at, ...rest) => {
      if (String(at).endsWith("cues.json")) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" });
      return real.writeFileSync(at, ...rest);
    };
    await fit(fixture("house").file, { length: 12, out: plain, fps: 30, duck: 10, lufs: -14, end: "auto", warnings: [] });
  } catch (err) {
    error = err;
  } finally {
    Object.assign(fs, real);
  }
  assert.equal(left(plain).length, 1);
  assert.equal(String(error), `Error: Cannot write to ${plain}: the disk is full. ${ROOM}. ${said(plain, left(plain)[0])}.`);
  fs.rmSync(path.join(plain, left(plain)[0]), { recursive: true });
  assert.deepEqual(snapshot(plain), before);
});

test("a run stopped in a folder that may not be changed says its hidden folder could not be removed, and in --json", { skip: process.platform === "win32" ? "the stand-ins are shell scripts" : process.getuid && process.getuid() === 0 ? "root may change any folder" : false }, async () => {
  const folder = goodFit("left-stopped");
  const mark = path.join(dir, `left-stopped-${process.hrtime.bigint()}`);
  const child = spawn(process.execPath, [CLI, fixture("house").file, "--length", "14", "--out", folder, "--json"], { env: { ...process.env, FFMPEG_PATH: path.join(FIXTURES, "slowwav", "ffmpeg"), MUSICFIT_TEST_MARK: mark } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  for (let i = 0; i < 12000 && !fs.existsSync(mark); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(mark), "the run never wrote a WAV");
  fs.chmodSync(folder, 0o555);
  let end;
  try {
    child.kill("SIGTERM");
    end = await ended;
  } finally {
    fs.chmodSync(folder, 0o755);
  }
  assert.equal(end.signal, "SIGTERM", `${end.code} ${stderr}`);
  const parts = fs.readdirSync(folder).filter((e) => e.startsWith(".musicfit-part-"));
  assert.equal(parts.length, 1, stderr);
  const message = `stopped, so ${folder} is as it was but for the hidden folder ${path.join(folder, parts[0])}, which could not be removed; a later run that ends well in ${folder} removes it once it is 15 minutes old`;
  assert.equal(stderr, `musicfit: ${message}\n`);
  assert.deepEqual(JSON.parse(stdout), { ok: false, error: message });
  fs.rmSync(path.join(folder, parts[0]), { recursive: true });
});

test("a track or a voice named like the words for a full disk is not taken for one", () => {
  const cwd = path.join(dir, "full-names");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "No space left on device.wav"), "not audio\n");
  fs.copyFileSync(fixture("house").file, path.join(cwd, "Disk quota exceeded.wav"));
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  const track = run(["No space left on device.wav", "--length", "12"]);
  assert.equal(track.status, 1);
  assert.equal(track.stderr.split("\n").filter(Boolean).pop(), "musicfit: Cannot read No space left on device.wav: ffmpeg does not know this format");
  const voice = run(["Disk quota exceeded.wav", "--length", "12", "--voice", "No space left on device.wav"]);
  assert.equal(voice.status, 1);
  assert.equal(voice.stderr.split("\n").filter(Boolean).pop(), "musicfit: Cannot read No space left on device.wav: ffmpeg does not know this format");
  assert.deepEqual(fs.readdirSync(cwd).sort(), ["Disk quota exceeded.wav", "No space left on device.wav"]);
});
