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
    // At -v info, as the loudness meter and the read of a video run, ffmpeg
    // ends a failure with its report of what it wrote, "... muxing
    // overhead: unknown": in 4.4 when the pipe it writes to closes, in 8
    // when the system starts no more threads for it.
    "closed-pipe-4.4": "ffmpeg: Error writing trailer of pipe:1: Broken pipe",
    "no-threads-8.0": "ffmpeg: Error sending frames to consumers: Resource temporarily unavailable",
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

const lowLimit = { skip: process.platform === "win32" ? "it takes sh to lower the limit" : false };

// What a node with 256 file descriptors at most prints when it holds all
// it may but one, too few for ffmpeg's pipes, and runs ffmpeg: first, or
// once the start check has passed while they were free.
function shortOfFiles(checkFirst) {
  const script = `
    const fs = require("node:fs");
    const { ready, run } = require(${JSON.stringify(path.join(ROOT, "skills", "musicfit", "scripts", "lib", "audio"))});
    (${checkFirst} ? ready() : Promise.resolve()).then(() => {
      const held = [];
      try {
        for (;;) held.push(fs.openSync(${JSON.stringify(__filename)}, "r"));
      } catch {}
      fs.closeSync(held.pop());
      return run(["-version"], null);
    }).then(() => console.log("ran"), (err) => console.log(err.message, err.unstarted));
  `;
  const r = spawnSync("sh", ["-c", 'ulimit -n 256 && exec "$0" -e "$1"', process.execPath, script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const NO_FILES = "musicfit could not start ffmpeg: too many open files. Raise the limit on open files (ulimit -n) and run it again. true\n";

test("a start check that cannot start ffmpeg for want of file descriptors says so and what to do", lowLimit, () => {
  assert.equal(shortOfFiles(false), NO_FILES);
});

test("a call after the start check that cannot start ffmpeg for want of file descriptors says so and what to do, where the run ended with the words of a TypeError", lowLimit, () => {
  assert.equal(shortOfFiles(true), NO_FILES);
});

test("a line a program printed is quoted as it is, its control characters written out, and a long one keeps its start and its end", () => {
  const { quoted } = require("../skills/musicfit/scripts/lib/audio");
  assert.equal(quoted("#!/bin/sh\r"), '"#!/bin/sh\\r"');
  assert.equal(quoted("a\tb\x1b[31mc\x7f\u0085\ufeffd\u202e"), '"a\\tb\\x1b[31mc\\x7f\\x85\\ufeffd\\u202e"');
  assert.equal(quoted("env: \u2018runner\u2019: No such file or directory"), '"env: \u2018runner\u2019: No such file or directory"');
  const long = `${"a".repeat(150)}${"b".repeat(100)}`;
  assert.equal(quoted(long), `"${"a".repeat(120)}...${"b".repeat(80)}"`);
  assert.equal(quoted("x".repeat(200)), `"${"x".repeat(200)}"`);
});

test("an ffmpeg that gives no answer when asked its version is stopped once the time is up, and the run stops saying only that, with no advice to install one", posix, async () => {
  const { ready } = require("../skills/musicfit/scripts/lib/audio");
  const real = process.env.FFMPEG_PATH ? path.resolve(process.env.FFMPEG_PATH) : spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  // One that never answers, and an ffmpeg that would, a moment too late,
  // as on a machine short of memory.
  for (const [name, script] of [
    ["silent", "#!/bin/sh\nexec sleep 30\n"],
    ["slow", `#!/bin/sh\nsleep 2 && exec "${real}" "$@"\n`],
  ]) {
    const standIn = path.join(outDir(name), "ffmpeg");
    fs.mkdirSync(path.dirname(standIn), { recursive: true });
    fs.writeFileSync(standIn, script);
    fs.chmodSync(standIn, 0o755);
    const was = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = standIn;
    const began = Date.now();
    try {
      await assert.rejects(ready(500), (err) => {
        assert.equal(err.message, `musicfit could not check ffmpeg, ${standIn}: it gave no answer in 0.5 s when asked its version, as on a machine short of memory. Run it again.`);
        assert.ok(err.unstarted);
        return true;
      });
    } finally {
      if (was === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = was;
    }
    assert.ok(Date.now() - began < 10000, `${name}: ${Date.now() - began} ms`);
  }
});

test("the ffmpeg is asked its version once for its FFMPEG_PATH and PATH, looked for again after a failure, and one that can no longer be started is said to be", posix, async () => {
  const { ready, run } = require("../skills/musicfit/scripts/lib/audio");
  const real = process.env.FFMPEG_PATH ? path.resolve(process.env.FFMPEG_PATH) : spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const folder = outDir("asked-once");
  fs.mkdirSync(folder, { recursive: true });
  const standIn = path.join(folder, "ffmpeg");
  const asked = path.join(folder, "asked");
  const was = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = standIn;
  try {
    await assert.rejects(ready(), { message: /^musicfit needs ffmpeg, and FFMPEG_PATH points to .*, where there is none\./ });
    fs.writeFileSync(standIn, `#!/bin/sh\necho "$*" >> "${asked}"\nexec "${real}" "$@"\n`);
    fs.chmodSync(standIn, 0o755);
    assert.equal(await ready(), standIn);
    await run(["-version"], null);
    await run(["-version"], null);
    assert.equal(fs.readFileSync(asked, "utf8"), "-version\n-hide_banner -nostdin -version\n-hide_banner -nostdin -version\n");
    fs.rmSync(standIn);
    await assert.rejects(run(["-version"], null), (err) => {
      assert.equal(err.message, `musicfit could not start ffmpeg, ${standIn}, again: no such file or directory. Check that it is still there and may be run, and run musicfit again.`);
      assert.ok(err.unstarted);
      return true;
    });
  } finally {
    if (was === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = was;
  }
});

test("an ffmpeg that cannot be started again later in a run is told as one, never as a track or a video ffmpeg cannot read, nor as a video.mp4 that cannot be read back", posix, () => {
  const real = process.env.FFMPEG_PATH ? path.resolve(process.env.FFMPEG_PATH) : spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const root = outDir("started-again");
  const film = path.join(root, "film.mp4");
  fs.mkdirSync(root, { recursive: true });
  const made = spawnSync(real, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-c:v", "mpeg4", "-q:v", "6", film], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const { file } = fixture("house");
  const { FFMPEG_PATH, ...rest } = process.env;
  // The track is read first, or with --video the video, once ffmpeg has
  // answered its version; video.mp4 is read back once it is written.
  for (const [n, gone, args] of [
    [1, "-version", []],
    [2, "-version", ["--video", film]],
    [3, "+faststart", ["--video", film]],
  ]) {
    // A wrapper that runs ffmpeg and takes itself away after the call that
    // has `gone` in it, in a folder whose name holds the words a failed read
    // of the track or the video looks for in what ffmpeg says.
    const standIn = path.join(root, String(n), "Invalid data found", "ffmpeg");
    fs.mkdirSync(path.dirname(standIn), { recursive: true });
    fs.writeFileSync(standIn, `#!/bin/sh\n"${real}" "$@"\nstatus=$?\ncase " $* " in *" ${gone} "*) rm -f "$0" ;; esac\nexit $status\n`);
    fs.chmodSync(standIn, 0o755);
    const out = path.join(root, String(n), "out");
    const run = spawnSync(process.execPath, [CLI, file, "--length", "12", ...args, "--out", out], { encoding: "utf8", env: { ...rest, FFMPEG_PATH: standIn } });
    assert.equal(run.status, 1, run.stderr);
    assert.ok(`\n${run.stderr}`.endsWith(`\nmusicfit: musicfit could not start ffmpeg, ${standIn}, again: no such file or directory. Check that it is still there and may be run, and run musicfit again.\n`), `${n}: ${run.stderr}`);
    assert.deepEqual(fs.readdirSync(path.dirname(out)), ["Invalid data found"], `${n}`);
  }
});

test("on Windows an FFMPEG_PATH that names a file with no extension is said to have no .exe in its name, which Windows does not run, and an ffmpeg.exe beside it is used", posix, async () => {
  // Windows as this system plays it, with stand-ins its shell runs.
  const { ready } = require("../skills/musicfit/scripts/lib/audio");
  const real = process.env.FFMPEG_PATH ? path.resolve(process.env.FFMPEG_PATH) : spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const bare = path.join(outDir("no-extension"), "ffmpeg");
  const answers = `#!/bin/sh\nexec "${real}" "$@"\n`;
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  fs.writeFileSync(bare, answers);
  fs.chmodSync(bare, 0o755);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const was = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = bare;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    await assert.rejects(ready(), (err) => {
      assert.equal(err.message, `musicfit needs ffmpeg, and FFMPEG_PATH points to ${bare}, which has no .exe in its name, so Windows does not run it. Set FFMPEG_PATH to an ffmpeg, or unset it and install one (brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg).`);
      assert.ok(err.unstarted);
      return true;
    });
    fs.writeFileSync(`${bare}.exe`, answers);
    fs.chmodSync(`${bare}.exe`, 0o755);
    assert.equal(await ready(), `${bare}.exe`);
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (was === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = was;
  }
});

test("a call in a folder that is not there is not taken for an ffmpeg that cannot start", async () => {
  const { run } = require("../skills/musicfit/scripts/lib/audio");
  const gone = path.join(outDir("no-such-folder"), "inside");
  await assert.rejects(run(["-version"], null, { cwd: gone }), (err) => {
    assert.ok(!err.unstarted, err.message);
    assert.doesNotMatch(err.message, /needs ffmpeg/);
    return true;
  });
});

test("a track or a video is said to be missing only when it is: a No such file or does not exist in what ffmpeg says, as in the name of the folder it is in, or of another file, is told in ffmpeg's words", posix, async () => {
  const { decode } = require("../skills/musicfit/scripts/lib/audio");
  const { probe } = require("../skills/musicfit/scripts/lib/video");
  const gone = outDir("taken-away.wav");
  await assert.rejects(decode(gone), { message: `Cannot read ${gone}: no such file` });
  await assert.rejects(probe(gone), { message: `Cannot read ${gone}: no such file` });
  // A file that is no track and no video, in folders named with those words.
  for (const folder of ["No such file", "does not exist"]) {
    const notes = path.join(outDir(folder), "notes.txt");
    fs.mkdirSync(path.dirname(notes), { recursive: true });
    fs.writeFileSync(notes, "some notes\n");
    await assert.rejects(decode(notes), { message: `Cannot read ${notes}: ffmpeg does not know this format` });
    await assert.rejects(probe(notes), { message: `Cannot read ${notes}: ffmpeg does not know this format` });
  }
  // An ffmpeg that fails on a part of the input that is not there, in the
  // words ffmpeg 4.4 and 8 use.
  const { file } = fixture("house");
  const real = process.env.FFMPEG_PATH ? path.resolve(process.env.FFMPEG_PATH) : spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const was = process.env.FFMPEG_PATH;
  for (const [said, message] of [
    ["/nonexistent/part.wav: No such file or directory", "ffmpeg: /nonexistent/part.wav: No such file or directory"],
    ["[in#0 @ 0x5d9b3c0a8cc0] Error opening input: No such file or directory\nError opening input file /nonexistent/part.wav.\nError opening input files: No such file or directory", "ffmpeg: Error opening input: No such file or directory"],
  ]) {
    const standIn = path.join(outDir(`partgone-${message.length}`), "ffmpeg");
    fs.mkdirSync(path.dirname(standIn), { recursive: true });
    fs.writeFileSync(standIn, `#!/bin/sh\nif [ "$1" = -version ]; then exec "${real}" -version; fi\ncat >&2 <<'LINES'\n${said}\nLINES\nexit 1\n`);
    fs.chmodSync(standIn, 0o755);
    process.env.FFMPEG_PATH = standIn;
    try {
      await assert.rejects(decode(file), { message });
      await assert.rejects(probe(file), { message });
    } finally {
      if (was === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = was;
    }
  }
});
