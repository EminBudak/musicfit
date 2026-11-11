"use strict";

// The command line, the options and the version in every manifest. Only
// the ones that read a file need ffmpeg.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { parse, parseTime, parseFps } = require("../skills/musicfit/scripts/musicfit");
const { quoted } = require("../skills/musicfit/scripts/lib/audio");
const { fixture, dir } = require("./helpers");

const CLI = path.resolve(__dirname, "../skills/musicfit/scripts/musicfit.js");

test("the skill folder carries its own version, the same as the package's and every plugin manifest's", () => {
  const version = require("../skills/musicfit/scripts/lib/version");
  assert.equal(version, require("../package.json").version);
  assert.equal(version, require("../package-lock.json").version);
  assert.equal(version, require("../.claude-plugin/marketplace.json").plugins[0].version);
  assert.equal(version, require("../.codex-plugin/plugin.json").version);
  assert.equal(version, require("../plugin.json").version);
});

test("the Agent Plugins manifest keeps to its closed schema", () => {
  const manifest = require("../plugin.json");
  const allowed = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);
  for (const key of Object.keys(manifest)) assert.ok(allowed.has(key), `plugin.json has ${key}`);
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.match(manifest.name, /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
});

test("the CLI explains itself and refuses a missing track, a missing length or a bad option", () => {
  const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: musicfit <track> --length <time>/);
  const none = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /Give one track/);
  // A name with nothing in it, as a script gives for a variable never set.
  const empty = spawnSync(process.execPath, [CLI, "", "--length", "10"], { encoding: "utf8" });
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /^musicfit: Give one track/);
  assert.doesNotMatch(empty.stderr, /Reading/);
  const noLength = spawnSync(process.execPath, [CLI, "song.mp3"], { encoding: "utf8" });
  assert.equal(noLength.status, 2);
  assert.match(noLength.stderr, /Give --length/);
  const late = spawnSync(process.execPath, [CLI, "song.mp3", "--length", "20", "--hit", "25"], { encoding: "utf8" });
  assert.equal(late.status, 2);
  assert.match(late.stderr, /--hit has to fall inside --length/);
  const version = spawnSync(process.execPath, [CLI, "-v"], { encoding: "utf8" });
  assert.equal(version.stdout.trim(), require("../package.json").version);
});

test("times in seconds, frames and minutes, and frame rates as decimals or fractions", () => {
  assert.equal(parseTime("--length", "32", 30), 32);
  assert.equal(parseTime("--length", "32.5s", 30), 32.5);
  assert.equal(parseTime("--length", "960f", 30), 32);
  assert.equal(parseTime("--length", "1:05", 30), 65);
  assert.equal(parseTime("--length", "1:05.5", 30), 65.5);
  assert.throws(() => parseTime("--hit", "soon", 30), /--hit takes a time/);
  assert.equal(parseFps("25"), 25);
  assert.ok(Math.abs(parseFps("30000/1001") - 29.97) < 0.001);
  assert.equal(parseFps("29.97"), 29.97);
  assert.throws(() => parseFps("fast"), /--fps takes a frame rate/);

  const options = parse(["song.mp3", "--length", "960f", "--hit=825f", "--fps", "30", "--voice", "vo.wav", "--duck", "-12", "--lufs", "-16", "--end", "Fade", "--meter", "3/4", "--bpm", "128", "--out", "fit", "--json"]);
  assert.equal(options.length, 32);
  assert.equal(options.hit, 27.5);
  assert.equal(options.voice, "vo.wav");
  assert.equal(options.duck, 12);
  assert.equal(options.lufs, -16);
  assert.equal(options.end, "fade");
  assert.equal(options.meter, 3);
  assert.equal(options.bpm, 128);
  assert.equal(options.out, "fit");
  assert.equal(options.json, true);
  assert.throws(() => parse(["song.mp3", "--length", "30", "--end", "never"]), /--end takes auto, natural or fade/);
  assert.throws(() => parse(["song.mp3", "--length", "30", "--lufs", "0"]), /--lufs takes/);
  assert.throws(() => parse(["song.mp3", "--length"]), /--length needs a value/);
  assert.throws(() => parse(["song.mp3", "--length", "30", "--wat"]), /Unknown option/);
  assert.equal(parse(["song.mp3", "--analyze"]).analyze, true);
});

test("--video and --video-sound: what they take, what they refuse, and frames that wait for the video's rate", () => {
  const options = parse(["song.mp3", "--length", "12", "--video", "film.mp4", "--video-sound", "Drop"]);
  assert.equal(options.video, "film.mp4");
  assert.equal(options.videoSound, "drop");
  assert.equal(options.fps, undefined);
  assert.equal(parse(["song.mp3", "--length", "12", "--video", "film.mp4"]).videoSound, undefined);
  const later = parse(["song.mp3", "--length", "300f", "--hit", "8", "--video", "film.mp4"]);
  assert.deepEqual(later.frames, { length: "300f" });
  assert.equal(later.hit, 8);
  assert.equal(parse(["song.mp3", "--length", "300f", "--fps", "25", "--video", "film.mp4"]).length, 12);
  assert.throws(() => parse(["song.mp3", "--length", "12", "--video", "film.mp4", "--video-sound", "loud"]), /--video-sound takes keep, voice or drop/);
  assert.throws(() => parse(["song.mp3", "--length", "12", "--video-sound", "drop"]), /--video-sound goes with --video/);
  assert.throws(() => parse(["song.mp3", "--analyze", "--video", "film.mp4"]), /--video lays a fit under a video and --analyze only reads the track: give one of them/);
  const refused = spawnSync(process.execPath, [CLI, "song.mp3", "--length", "12", "--video-sound", "keep"], { encoding: "utf8" });
  assert.equal(refused.status, 2);
  const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" }).stdout;
  assert.match(help, /\n {2}--video <file> {4}a video to lay the result under: also writes video\.mp4,/);
  assert.match(help, /\n {2}--video-sound <how>\n {20}what becomes of the video's own sound: keep/);
});

test("--help keeps to the width of its widest option lines, and the README lists the options as --help does", () => {
  const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" }).stdout;
  for (const line of help.split("\n")) assert.ok(line.length <= 82, `${line.length} characters: ${line}`);
  const options = (text) => text.slice(text.indexOf("  --length <time>"), text.indexOf("  --json ")).trimEnd();
  assert.equal(options(fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8")), options(help));
});

test("without ffmpeg it says how to get it", () => {
  const { file } = fixture("house");
  const run = spawnSync(process.execPath, [CLI, file, "--length", "10"], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: "/nonexistent/ffmpeg" } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /musicfit needs ffmpeg/);
});

const POINT = "Set FFMPEG_PATH to an ffmpeg, or unset it and install one (brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg).";
const GET = "Install ffmpeg (brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg) or set FFMPEG_PATH to one.";
// The ffmpeg these tests run, which the stand-ins and wrappers run in turn.
const REAL = process.env.FFMPEG_PATH ? path.resolve(process.env.FFMPEG_PATH) : spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();

// Runs musicfit for each [env, message] of `cases` from `root`, once as a
// run that reads the track first and once as one that reads the video's
// frame rate before it begins, and holds that each stops before any work
// with that message, exits with 1, and leaves no out folder, no hidden
// folder beside it and nothing in TMPDIR. A run goes through the command
// `wrap` when there is one, and node is given `node` before the script.
function refused(root, cases, { wrap = [], node = [] } = {}) {
  const { file } = fixture("house");
  const { FFMPEG_PATH, PATH, TMPDIR, ...rest } = process.env;
  let n = 0;
  for (const [env, message] of cases) {
    for (const args of [["--length", "10", "--voice", file], ["--length", "250f", "--video", file, "--json"]]) {
      const folder = path.join(root, "runs", String(n));
      const tmp = path.join(root, "tmp", String(n++));
      fs.mkdirSync(folder, { recursive: true });
      fs.mkdirSync(tmp, { recursive: true });
      const command = [...wrap, process.execPath, ...node, CLI, file, ...args, "--out", path.join(folder, "out")];
      const run = spawnSync(command[0], command.slice(1), { cwd: root, encoding: "utf8", env: { ...rest, TMPDIR: tmp, ...env } });
      const what = `${JSON.stringify(env)} ${args.join(" ")}`;
      assert.equal(run.status, 1, `${what}: ${run.stderr}`);
      assert.equal(run.stderr, `musicfit: ${message}\n`, what);
      if (args.includes("--json")) assert.deepEqual(JSON.parse(run.stdout), { ok: false, error: message }, what);
      assert.deepEqual(fs.readdirSync(folder), [], what);
      assert.deepEqual(fs.readdirSync(tmp), [], what);
    }
  }
}

// A file named ffmpeg in a folder of its own under `root`.
function put(root, folder, bytes, mode = 0o755) {
  const file = path.join(root, folder, "ffmpeg");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  fs.chmodSync(file, mode);
  return file;
}

// Whether binfmt_misc gives files that start with `magic` (in hex) to a
// program of its own, as qemu or wine, which would run them.
function handled(magic) {
  try {
    const root = "/proc/sys/fs/binfmt_misc";
    return fs.readdirSync(root).some((name) => {
      if (name === "register" || name === "status") return false;
      const entry = fs.readFileSync(path.join(root, name), "utf8");
      return /^enabled$/m.test(entry) && entry.includes(`\nmagic ${magic}`);
    });
  } catch {
    return false;
  }
}

// A copy of the ffmpeg these tests run, at `file`, that the system's
// loader cannot start: the loader its ELF headers name (PT_INTERP), or
// the first library they say it needs (DT_NEEDED), has another name. That
// name, or null when that ffmpeg is no 64-bit little-endian ELF that names
// one, as a static build.
function unloadable(file, what) {
  let bytes;
  try {
    bytes = fs.readFileSync(REAL);
  } catch {
    return null;
  }
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1) return null;
  const headers = Array.from({ length: bytes.readUInt16LE(0x38) }, (_, i) => {
    const at = Number(bytes.readBigUInt64LE(0x20)) + i * bytes.readUInt16LE(0x36);
    return { type: bytes.readUInt32LE(at), offset: Number(bytes.readBigUInt64LE(at + 8)), vaddr: Number(bytes.readBigUInt64LE(at + 16)), size: Number(bytes.readBigUInt64LE(at + 32)) };
  });
  let from = -1;
  let at = -1;
  if (what === "loader") {
    const interp = headers.find((h) => h.type === 3);
    if (interp) [from, at] = [interp.offset, bytes.indexOf(0, interp.offset) - 1];
  } else {
    const dynamic = headers.find((h) => h.type === 2);
    const entries = [];
    for (let e = dynamic ? dynamic.offset : 0; dynamic && e + 16 <= dynamic.offset + dynamic.size && bytes.readBigInt64LE(e) !== 0n; e += 16) entries.push({ tag: Number(bytes.readBigInt64LE(e)), value: Number(bytes.readBigUInt64LE(e + 8)) });
    const strtab = (entries.find((e) => e.tag === 5) || {}).value;
    const needed = entries.find((e) => e.tag === 1);
    const load = headers.find((h) => h.type === 1 && h.vaddr <= strtab && strtab < h.vaddr + h.size);
    if (needed && load) from = at = load.offset + strtab - load.vaddr + needed.value;
  }
  if (at < from || from < 0) return null;
  bytes[at] = bytes[at] === 0x58 ? 0x59 : 0x58;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  fs.chmodSync(file, 0o755);
  return bytes.toString("latin1", from, bytes.indexOf(0, from));
}

// What musicfit says of a file that ran when asked its version and did
// not answer as ffmpeg does: the first line it printed, on its error
// output or else on its output, in quotes, and how it ended, as the test
// sees it run the same way with `env`.
function printed(file, env = process.env) {
  const r = spawnSync(file, ["-version"], { encoding: "utf8", env });
  const first = (text) => String(text || "").split(/\r?\n/).find((line) => line.trim());
  const line = first(r.stderr);
  if (line && r.status === 0 && !first(r.stdout)) return `did not run as ffmpeg: it printed ${quoted(line)} on its error output, nothing on its output, and exited with 0`;
  const ended = r.signal ? `was stopped by ${r.signal}` : `exited with ${r.status}`;
  if (line || first(r.stdout)) return `did not run as ffmpeg: it printed ${quoted(line || first(r.stdout))} and ${ended}`;
  return `did not run as ffmpeg: ${r.signal ? `it was stopped by ${r.signal}` : `it printed nothing and exited with ${r.status}`}`;
}

// What musicfit says of a file the system did not start, as its
// interpreter or its loader is not there, with the first line of a script.
const lacking = (line) => `did not run as ffmpeg: the system could not start it, as an interpreter or a loader it needs is not there${line ? `; its first line is ${quoted(line)}` : ""}`;

test("an ffmpeg that cannot be started or does not answer as ffmpeg when asked its version stops a run before any work, with its path and what the system or the program said", () => {
  const root = path.join(dir, "unstarted");
  const at = (...names) => path.join(root, ...names);
  const posix = process.platform !== "win32";
  const { PATH } = process.env;
  // Folders whose names hold words a failed read of the track or the video
  // looks for in what ffmpeg says.
  fs.mkdirSync(at("does not exist"), { recursive: true });
  const given = (file, words) => [{ PATH, FFMPEG_PATH: file }, `musicfit needs ffmpeg, and FFMPEG_PATH points to ${file}, ${words.startsWith("where ") ? words : `which ${words}`}. ${POINT}`];
  const onPath = (folders, file, words) => [{ PATH: folders.join(path.delimiter) }, `musicfit needs ffmpeg, and the ffmpeg on PATH, ${file}, ${words}. ${GET}`];
  const cases = [
    given(at("nothing", "ffmpeg"), "where there is none"),
    given(at("does not exist"), "is a folder"),
    given(at("Invalid data found", "ffmpeg"), "where there is none"),
    [{ PATH, FFMPEG_PATH: "ffmpeg-not-there" }, `musicfit needs ffmpeg, and FFMPEG_PATH names ffmpeg-not-there, which is not on PATH. ${POINT}`],
  ];
  if (posix) {
    fs.mkdirSync(at("empty"), { recursive: true });
    fs.mkdirSync(at("bin", "ffmpeg"), { recursive: true });
    const plain = put(root, "plain", "not a program\n", 0o644);
    const script = put(root, "script", "#!/nonexistent/interpreter\n");
    const notes = put(root, "notes", "some notes\n", 0o644);
    const scriptOfNotes = put(root, "notes-script", `#!${notes}\n`);
    const scriptOfFolder = put(root, "folder-script", `#!${at("bin")} -x\n`);
    // A script whose interpreter is a script whose interpreter is missing.
    const nested = put(root, "nested", `#!${script}\n`);
    // Saved with Windows line ends, its #! line names "/bin/sh" and a carriage return.
    const crlf = put(root, "crlf", `#!/bin/sh\r\nexec "${REAL}" "$@"\r\n`);
    const empty = put(root, "void", "");
    // What `echo > ffmpeg` leaves, blanks, comments, a #! line that names
    // no program, zero bytes, a file that does nothing and a script that
    // runs nothing: the system hands the first ones to the shell, which
    // runs nothing in them either.
    const idle = [put(root, "blank", "\n"), put(root, "blanks", "   \n\t\n"), put(root, "comments", "# ffmpeg goes here\n  # see the README\n"), put(root, "bare-bang", "#!\n# no program\n"), put(root, "zeros", Buffer.alloc(300000)), put(root, "colon", ":\n"), put(root, "sh", "#!/bin/sh\n")];
    const text = put(root, "text", "not a program\n");
    const bangText = put(root, "bang-text", "#!\nnot a program\n");
    // Another program in ffmpeg's place, one that prints only on its error
    // output, as a wrapper that sends ffmpeg's output there, and programs a
    // signal stops, one of them once it has said why, as macOS's loader
    // does of an ffmpeg whose library is gone.
    const probe = put(root, "probe", "#!/bin/sh\necho 'ffprobe version 9.9 Copyright (c) 2007-2026 the FFmpeg developers'\n");
    const toError = put(root, "to-error", `#!/bin/sh\nexec "${REAL}" "$@" >&2\n`);
    const dyld = put(root, "dyld", "#!/bin/sh\necho 'dyld[4321]: Library not loaded: /opt/homebrew/opt/x265/lib/libx265.215.dylib' >&2\nkill -TERM $$\n");
    const killed = put(root, "killed", "#!/bin/sh\nkill -KILL $$\n");
    fs.mkdirSync(at("loop"), { recursive: true });
    fs.symlinkSync(at("loop", "b"), at("loop", "a"));
    fs.symlinkSync(at("loop", "a"), at("loop", "b"));
    fs.mkdirSync(at("loop-bin"), { recursive: true });
    fs.symlinkSync(at("loop-bin", "ffmpeg"), at("loop-bin", "ffmpeg"));
    fs.mkdirSync(at("links"), { recursive: true });
    fs.symlinkSync(at("bin", "ffmpeg"), at("links", "to-folder"));
    fs.symlinkSync(at("gone", "ffmpeg"), at("links", "to-none"));
    fs.mkdirSync(at("dangling"), { recursive: true });
    fs.symlinkSync(at("gone", "ffmpeg"), at("dangling", "ffmpeg"));
    cases.push(
      [{ PATH: at("empty") }, "musicfit needs ffmpeg. Install it (brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg) or set FFMPEG_PATH to it."],
      given(plain, "is not executable"),
      given(script, lacking("#!/nonexistent/interpreter")),
      given(nested, lacking(`#!${script}`)),
      given(crlf, lacking("#!/bin/sh\r")),
      given(scriptOfNotes, `did not run as ffmpeg: the system could not start it: permission denied; its first line is ${quoted(`#!${notes}`)}`),
      given(scriptOfFolder, `did not run as ffmpeg: the system could not start it: permission denied; its first line is ${quoted(`#!${at("bin")} -x`)}`),
      given(at("loop", "a"), "goes through a loop of links"),
      given(at("links", "to-folder"), "is a folder"),
      given(at("links", "to-none"), "is a link to a file that is not there"),
      given(path.join(plain, "ffmpeg"), `where there is none, as ${plain} is a file, not a folder`),
      given(empty, "did not run as ffmpeg: it printed nothing and exited with 0"),
      ...idle.map((file) => given(file, "did not run as ffmpeg: it printed nothing and exited with 0")),
      given(text, printed(text)),
      given(bangText, printed(bangText)),
      given(probe, 'did not run as ffmpeg: it printed "ffprobe version 9.9 Copyright (c) 2007-2026 the FFmpeg developers" and exited with 0'),
      given(toError, printed(toError)),
      given(dyld, 'did not run as ffmpeg: it printed "dyld[4321]: Library not loaded: /opt/homebrew/opt/x265/lib/libx265.215.dylib" and was stopped by SIGTERM'),
      given(killed, "did not run as ffmpeg: it was stopped by SIGKILL"),
      // On PATH the system passes over a folder, a file it may not run, a
      // link to nothing and a script whose interpreter is missing, and the
      // first of them is named when no ffmpeg comes after them. It stops at
      // a loop of links, and runs the first file it may run, though a
      // working one comes after it.
      onPath([at("bin"), at("plain")], at("bin", "ffmpeg"), "is a folder"),
      onPath([at("plain"), at("bin")], plain, "is not executable"),
      onPath([at("dangling"), at("empty")], at("dangling", "ffmpeg"), "is a link to a file that is not there"),
      onPath([at("script"), at("bin")], script, lacking("#!/nonexistent/interpreter")),
      onPath([at("crlf")], crlf, lacking("#!/bin/sh\r")),
      onPath([at("script"), at("loop-bin"), at("void")], at("loop-bin", "ffmpeg"), "goes through a loop of links"),
      onPath([at("script"), at("void")], empty, "did not run as ffmpeg: it printed nothing and exited with 0"),
      onPath([at("blank"), PATH], idle[0], "did not run as ffmpeg: it printed nothing and exited with 0"),
      onPath([at("text"), PATH], text, printed(text)),
      // Named by the name FFMPEG_PATH gives, found on PATH.
      [{ PATH: [at("void"), PATH].join(path.delimiter), FFMPEG_PATH: "ffmpeg" }, `musicfit needs ffmpeg, and the ffmpeg on PATH, ${empty}, did not run as ffmpeg: it printed nothing and exited with 0. ${POINT}`],
    );
  }
  if (process.platform === "linux") {
    // The heads of an ffmpeg made for macOS, for a processor other than
    // this one and for Windows: glibc gives each to /bin/sh, which reads it
    // as a script and fails, and so it does with a web page saved in place
    // of the program.
    const mac = put(root, "mac", Buffer.concat([Buffer.from("cffaedfe07000001030000000200000000", "hex"), Buffer.alloc(4096)]));
    const elf = Buffer.concat([Buffer.from("7f454c4602010100000000000000000002000000", "hex"), Buffer.alloc(4096)]);
    elf.writeUInt16LE(process.arch === "arm64" ? 0x3e : 0xb7, 0x12);
    const foreign = put(root, "foreign", elf);
    const windows = put(root, "windows", Buffer.concat([Buffer.from("4d5a90000300000004000000ffff0000b8000000000000004000", "hex"), Buffer.alloc(4096)]));
    const page = put(root, "page", "<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head>\n<body><h1>Not Found</h1></body></html>\n");
    cases.push(
      given(mac, printed(mac)),
      given(page, printed(page)),
      // Found through an entry of PATH that is relative, read from where musicfit was started.
      [{ PATH: "mac" }, `musicfit needs ffmpeg, and the ffmpeg on PATH, ${mac}, ${printed(mac)}. ${GET}`],
    );
    // Unless the system has a program of its own that runs them.
    if (!handled("7f454c46")) cases.push(given(foreign, printed(foreign)));
    if (!handled("4d5a")) cases.push(given(windows, printed(windows)));
    // A real program whose loader is missing, and one that needs a library
    // that is missing, which glibc's loader names.
    if (unloadable(at("noloader", "ffmpeg"), "loader")) cases.push(given(at("noloader", "ffmpeg"), lacking(null)));
    const glibc = Boolean(process.report.getReport().header.glibcVersionRuntime);
    const library = glibc && unloadable(at("nolib", "ffmpeg"), "library");
    if (library) {
      const said = printed(at("nolib", "ffmpeg"));
      assert.match(said, new RegExp(`error while loading shared libraries: ${library.replace(/\./g, "\\.")}: cannot open shared object file`));
      cases.push(given(at("nolib", "ffmpeg"), said), onPath([at("nolib"), PATH], at("nolib", "ffmpeg"), said));
      // The one whose loader is missing comes first on PATH, and the system
      // passes over it to the one whose library is missing.
      if (fs.existsSync(at("noloader", "ffmpeg"))) cases.push(onPath([at("noloader"), at("nolib")], at("nolib", "ffmpeg"), said));
    }
  }
  refused(root, cases);
});

test("on PATH a run uses the ffmpeg the system starts, past a folder, a file it may not run, a link to nothing and a script whose interpreter is missing", { skip: process.platform === "win32" ? "the scripts are shell scripts" : false }, () => {
  const root = path.join(dir, "passed-over");
  const at = (...names) => path.join(root, ...names);
  fs.mkdirSync(at("bin", "ffmpeg"), { recursive: true });
  put(root, "plain", "#!/bin/sh\n", 0o644);
  put(root, "script", "#!/nonexistent/interpreter\n");
  put(root, "crlf", `#!/bin/sh\r\nexec "${REAL}" "$@"\r\n`);
  fs.mkdirSync(at("dangling"), { recursive: true });
  fs.symlinkSync(at("gone", "ffmpeg"), at("dangling", "ffmpeg"));
  fs.mkdirSync(at("real"), { recursive: true });
  fs.symlinkSync(REAL, at("real", "ffmpeg"));
  const PATH = ["bin", "plain", "script", "crlf", "dangling", "real"].map((name) => at(name)).join(path.delimiter);
  const { FFMPEG_PATH, ...rest } = process.env;
  const run = spawnSync(process.execPath, [CLI, __filename, "--length", "10", "--out", at("out")], { encoding: "utf8", env: { ...rest, PATH } });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr.split("\n").filter(Boolean).pop(), `musicfit: Cannot read ${__filename}: ffmpeg does not know this format`);
});

test("with no PATH at all a run uses the ffmpeg the system starts then, from its own folders", { skip: process.platform === "win32" ? "Windows has no such folders" : false }, () => {
  const { FFMPEG_PATH, PATH, ...rest } = process.env;
  const glibc = Boolean(process.report.getReport().header.glibcVersionRuntime);
  const folders = process.platform !== "linux" ? ["/usr/bin", "/bin"] : glibc ? ["/bin", "/usr/bin"] : ["/usr/local/bin", "/bin", "/usr/bin"];
  // The first one there that this user may run is the one the system starts.
  const first = folders.map((folder) => path.join(folder, "ffmpeg")).find((file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
  const answers = first && /^ffmpeg version/m.test(spawnSync(first, ["-version"], { encoding: "utf8" }).stdout || "");
  const run = spawnSync(process.execPath, [CLI, __filename, "--length", "10", "--out", path.join(dir, "no-path")], { encoding: "utf8", env: rest });
  assert.equal(run.status, 1, run.stderr);
  if (answers) assert.equal(run.stderr.split("\n").filter(Boolean).pop(), `musicfit: Cannot read ${__filename}: ffmpeg does not know this format`);
  else assert.match(run.stderr, /^musicfit: musicfit needs ffmpeg/);
});

test("a script in ffmpeg's place, as a wrapper or a guard, that cannot start the program it runs, or that its shell will not run, stops a run before any work with what it printed", { skip: process.platform === "win32" ? "the scripts are shell scripts" : false }, () => {
  const root = path.join(dir, "wrapped");
  const at = (...names) => path.join(root, ...names);
  const { PATH } = process.env;
  fs.mkdirSync(at("bin", "ffmpeg"), { recursive: true });
  const text = put(root, "text", "not a program\n");
  const plain = put(root, "plain", "#!/bin/sh\nexit 0\n", 0o644);
  const noInterpreter = put(root, "script", "#!/nonexistent/interpreter\n");
  const empty = put(root, "void", "");
  const page = put(root, "page", "<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head>\n<body><h1>Not Found</h1></body></html>\n");
  // A script in ffmpeg's place that runs `target`, by `shell`, with exec or
  // not, and what is said of it, given and on PATH.
  let n = 0;
  const wrap = (target, { shell = "/bin/sh", exec = "exec ", line = "#!" + shell + "\n" } = {}) => put(root, `wrap${n++}`, `${line}${exec}"${target}" "$@"\n`);
  const cases = [];
  const named = (wrapper, env = {}) => {
    const words = printed(wrapper, { ...process.env, ...env });
    cases.push([{ PATH, ...env, FFMPEG_PATH: wrapper }, `musicfit needs ffmpeg, and FFMPEG_PATH points to ${wrapper}, which ${words}. ${POINT}`]);
    if (!env.PATH) cases.push([{ PATH: `${path.dirname(wrapper)}:${PATH}` }, `musicfit needs ffmpeg, and the ffmpeg on PATH, ${wrapper}, ${words}. ${GET}`]);
    return words;
  };
  for (const target of [at("gone", "ffmpeg"), at("bin", "ffmpeg"), plain, text, noInterpreter, empty, page, "ffmpeg-not-on-path"]) {
    named(wrap(target));
    named(wrap(target, { exec: "" }));
  }
  // With no #! line, which the system hands to the shell.
  named(wrap(at("gone", "ffmpeg"), { line: "" }));
  // A #! line whose shell refuses an option, as bash takes -o pipefail on
  // macOS and not on Linux, which says so: the shell works, and is not
  // called a program that cannot run.
  for (const line of ["#!/bin/sh -Z\n", ...(fs.existsSync("/bin/bash") ? ["#!/bin/bash -eo pipefail\n"] : [])]) {
    assert.doesNotMatch(named(wrap(REAL, { line })), /not a program/);
  }
  if (fs.existsSync("/bin/bash")) {
    for (const exec of ["exec ", ""]) {
      named(wrap(at("gone", "ffmpeg"), { shell: "/bin/bash", exec }));
      named(wrap(at("bin", "ffmpeg"), { shell: "/bin/bash", exec }));
      named(wrap(text, { shell: "/bin/bash", exec }));
    }
  }
  if (fs.existsSync("/usr/bin/env")) {
    // A script whose #! line has env look up an interpreter that is not on PATH.
    named(wrap(put(root, "env-missing", "#!/usr/bin/env nonexistent-ffmpeg-runner\n")));
  }
  // A link loop.
  fs.mkdirSync(at("loop"), { recursive: true });
  fs.symlinkSync(at("loop", "b"), at("loop", "a"));
  fs.symlinkSync(at("loop", "a"), at("loop", "b"));
  named(wrap(at("loop", "a")));
  // A script that runs another that cannot start what it runs.
  named(wrap(wrap(at("gone", "ffmpeg")), { exec: "" }));
  if (process.platform === "linux") {
    const elf = Buffer.concat([Buffer.from("7f454c4602010100000000000000000002000000", "hex"), Buffer.alloc(4096)]);
    elf.writeUInt16LE(process.arch === "arm64" ? 0x3e : 0xb7, 0x12);
    const foreign = put(root, "foreign", elf);
    if (!handled("7f454c46")) named(wrap(foreign));
    if (unloadable(at("noloader", "ffmpeg"), "loader")) named(wrap(at("noloader", "ffmpeg")));
    const glibc = Boolean(process.report.getReport().header.glibcVersionRuntime);
    if (glibc && unloadable(at("nolib", "ffmpeg"), "library")) {
      named(wrap(at("nolib", "ffmpeg")));
      // A wrapper that puts a folder of its own first on PATH and runs
      // ffmpeg by name: the loader names it as the wrapper started it, and
      // no other ffmpeg is named.
      const own = put(root, "own-path", `#!/bin/sh\nPATH="${at("nolib")}:$PATH"\nexec ffmpeg "$@"\n`);
      assert.doesNotMatch(named(own), new RegExp(REAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      // One that runs ffmpeg by name, with a PATH whose first ffmpeg the
      // shell passes over, as its loader is missing.
      if (fs.existsSync(at("noloader", "ffmpeg"))) {
        const byName = put(root, "by-name", '#!/bin/sh\nexec ffmpeg "$@"\n');
        assert.doesNotMatch(named(byName, { PATH: `${at("noloader")}:${at("nolib")}` }), /noloader/);
      }
    }
  }
  refused(root, cases);
});

test("a script in ffmpeg's place that answers as ffmpeg goes ahead, and a track or a video it cannot read is told as one, with exec or not, with no #! line and when its shell first says something of a line it goes past", { skip: process.platform === "win32" ? "the scripts are shell scripts" : false }, () => {
  const root = path.join(dir, "answers");
  const wrappers = [
    put(root, "exec", `#!/bin/sh\nexec "${REAL}" "$@"\n`),
    put(root, "call", `#!/bin/sh\n"${REAL}" "$@"\n`),
    put(root, "no-bang", `exec "${REAL}" "$@"\n`),
    // dash has no source, and bash no ech: each says so and goes on.
    put(root, "no-bang-source", `source /etc/os-release\nexec "${REAL}" "$@"\n`),
    put(root, "typo", `#!/bin/sh\nech starting\nexec "${REAL}" "$@"\n`),
  ];
  // A film cut off before its index, as a download that stopped.
  const whole = path.join(root, "film.mp4");
  const made = spawnSync(REAL, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=64x48:r=25:d=2", "-c:v", "mpeg4", whole], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const cut = path.join(root, "cut film.mp4");
  const bytes = fs.readFileSync(whole);
  fs.writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length * 0.4)));
  for (const wrapper of wrappers) {
    const env = { ...process.env, FFMPEG_PATH: wrapper };
    const notAudio = spawnSync(process.execPath, [CLI, __filename, "--length", "10", "--out", path.join(root, "not-audio")], { encoding: "utf8", env });
    assert.equal(notAudio.status, 1, notAudio.stderr);
    assert.equal(notAudio.stderr.split("\n").filter(Boolean).pop(), `musicfit: Cannot read ${__filename}: ffmpeg does not know this format`, wrapper);
    const cutShort = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "50f", "--video", cut, "--out", path.join(root, "cut-short")], { encoding: "utf8", env });
    assert.equal(cutShort.status, 1, cutShort.stderr);
    assert.equal(cutShort.stderr, `musicfit: Cannot read ${cut}: it is cut short or damaged, so ffmpeg finds no index in it\n`, wrapper);
  }
  // And a run with one of them ends well.
  const read = spawnSync(process.execPath, [CLI, fixture("house").file, "--analyze", "--out", path.join(root, "read")], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: wrappers[3] } });
  assert.equal(read.status, 0, read.stderr);
});

test("an ffmpeg this user may not run, by its mode or the folder it is in, or a script this user may run but not read, stops a run before any work", { skip: process.platform === "win32" ? "Windows keeps no such mode" : process.getuid() === 0 ? "root may run any file with an x bit, and read and enter any" : false }, () => {
  const root = path.join(dir, "denied");
  const at = (...names) => path.join(root, ...names);
  // x for the group and the others, none for its owner, who runs it.
  const others = put(root, "others", "#!/bin/sh\nexec ffmpeg \"$@\"\n", 0o055);
  const locked = put(root, "locked", "#!/bin/sh\nexec ffmpeg \"$@\"\n");
  // x and no r: the system starts its shell, which cannot read it.
  const unread = put(root, "unread", `#!/bin/sh\nexec "${REAL}" "$@"\n`, 0o111);
  const words = printed(unread);
  fs.chmodSync(at("locked"), 0);
  try {
    refused(root, [
      [{ PATH: process.env.PATH, FFMPEG_PATH: others }, `musicfit needs ffmpeg, and FFMPEG_PATH points to ${others}, which may not be run: permission denied. ${POINT}`],
      [{ PATH: process.env.PATH, FFMPEG_PATH: locked }, `musicfit needs ffmpeg, and FFMPEG_PATH points to ${locked}, which may not be run: permission denied. ${POINT}`],
      [{ PATH: `${at("others")}:${at("nothing")}` }, `musicfit needs ffmpeg, and the ffmpeg on PATH, ${others}, may not be run: permission denied. ${GET}`],
      [{ PATH: process.env.PATH, FFMPEG_PATH: unread }, `musicfit needs ffmpeg, and FFMPEG_PATH points to ${unread}, which ${words}. ${POINT}`],
    ]);
  } finally {
    // So the folder can be removed when the tests end.
    fs.chmodSync(at("locked"), 0o755);
  }
  assert.match(words, /Permission denied/);
});

test("an ffmpeg on a file system mounted noexec is named as one that may not be run, before any work", { skip: process.platform !== "linux" ? "noexec mounts are Linux's" : false }, (t) => {
  const root = path.join(dir, "noexec");
  const mount = path.join(root, "mount");
  fs.mkdirSync(mount, { recursive: true });
  // A tmpfs mounted noexec in a mount namespace of the test's own, where
  // this user is root and runs musicfit, as nothing on it may be run.
  const script = 'mount -t tmpfs -o noexec,size=1m tmpfs "$1" && printf "#!/bin/sh\\nexec ffmpeg \\"\\$@\\"\\n" > "$1/ffmpeg" && chmod 755 "$1/ffmpeg" && shift && exec "$@"';
  const wrap = ["unshare", "-rm", "sh", "-c", script, "sh", mount];
  const probe = spawnSync(wrap[0], [...wrap.slice(1), "true"], { encoding: "utf8" });
  if (probe.status !== 0) return t.skip(`no mount namespace for this user here: ${(probe.stderr || String(probe.error)).trim()}`);
  const file = path.join(mount, "ffmpeg");
  refused(root, [[{ PATH: process.env.PATH, FFMPEG_PATH: file }, `musicfit needs ffmpeg, and FFMPEG_PATH points to ${file}, which may not be run: permission denied. ${POINT}`]], { wrap });
});

test("a run with no file descriptor left for ffmpeg's pipes stops before any work and says what to do", { skip: process.platform === "win32" ? "it takes sh to lower the limit" : false }, () => {
  const root = path.join(dir, "no-descriptors");
  fs.mkdirSync(root, { recursive: true });
  // Loaded before musicfit: makes node's own signal pipes, then holds every
  // file descriptor it may but one, which musicfit's modules are read with
  // one at a time.
  const hold = path.join(root, "hold.js");
  fs.writeFileSync(hold, 'process.on("SIGWINCH", () => {});\nconst fs = require("node:fs");\nconst held = [];\ntry {\n  for (;;) held.push(fs.openSync(__filename, "r"));\n} catch {}\nfs.closeSync(held.pop());\n');
  const message = "musicfit could not start ffmpeg: too many open files. Raise the limit on open files (ulimit -n) and run it again.";
  refused(root, [[{ PATH: process.env.PATH }, message]], { wrap: ["sh", "-c", 'ulimit -n 256 && exec "$@"', "sh"], node: ["-r", hold] });
});

test("a file that is not audio gets a clear error", () => {
  const run = spawnSync(process.execPath, [CLI, __filename, "--length", "10"], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Cannot read|no audio/);
});

test("a video with no sound says so", () => {
  const film = path.join(dir, "silent-film.mp4");
  const made = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=32x32:d=0.5", "-c:v", "mpeg4", film], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const run = spawnSync(process.execPath, [CLI, film, "--length", "5", "--out", path.join(dir, "silent-film")], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /silent-film\.mp4 has no audio stream/);
});

test("a track, a voice or a video given as an address is refused before any work: musicfit reads files", () => {
  const { file } = fixture("house");
  const address = "http://127.0.0.1:9/track.wav";
  const cases = [
    [address, "--length", "10"],
    [file, "--length", "10", "--voice", "HTTPS://example.com/vo.wav"],
    [file, "--length", "300f", "--video", "https://example.com/film.mp4"],
  ];
  for (const args of cases) {
    const run = spawnSync(process.execPath, [CLI, ...args, "--out", path.join(dir, "addressed")], { encoding: "utf8" });
    assert.equal(run.status, 1, run.stderr);
    const name = args.find((a) => /:\/\//.test(a));
    assert.equal(run.stderr, `musicfit: Cannot read ${name}: musicfit reads files, not addresses, so download it first\n`);
  }
});

test("a track, a voice or a video that is a folder or may not be read is refused by its name before any work", () => {
  const { file } = fixture("house");
  const folder = path.join(dir, "a folder.wav");
  fs.mkdirSync(folder, { recursive: true });
  const locked = path.join(dir, "locked.mp4");
  fs.copyFileSync(file, locked);
  fs.chmodSync(locked, 0o000);
  const cases = [];
  for (const input of [folder, locked]) {
    let why = "it is a folder";
    if (input === locked) {
      // Root reads any file, and Windows keeps no such mode.
      try {
        fs.accessSync(locked, fs.constants.R_OK);
        continue;
      } catch {
        why = "permission denied";
      }
    }
    // As the track, the voice and the video, the last also with a length
    // in frames, which reads the video's frame rate before the run begins.
    cases.push([[input, "--length", "10"], input, why]);
    cases.push([[file, "--length", "10", "--voice", input], input, why]);
    cases.push([[file, "--length", "10", "--video", input], input, why]);
    cases.push([[file, "--length", "250f", "--video", input], input, why]);
  }
  for (const [args, input, why] of cases) {
    const out = path.join(dir, "refused-input");
    const run = spawnSync(process.execPath, [CLI, ...args, "--out", out], { encoding: "utf8" });
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stderr, `musicfit: Cannot read ${input}: ${why}\n`, args.join(" "));
    assert.ok(!fs.existsSync(out), args.join(" "));
  }
  fs.chmodSync(locked, 0o644);
});

test("a voice file that is not there, or a folder that cannot be written, is told before any work", () => {
  const { file } = fixture("house");
  const voice = spawnSync(process.execPath, [CLI, file, "--length", "10", "--voice", path.join(dir, "nobody.wav"), "--out", path.join(dir, "no-voice")], { encoding: "utf8" });
  assert.equal(voice.status, 1);
  assert.match(voice.stderr, /Cannot read .*nobody\.wav: no such file/);
  assert.doesNotMatch(voice.stderr, /Reading/);
  const blocked = spawnSync(process.execPath, [CLI, file, "--length", "10", "--out", path.join(file, "out")], { encoding: "utf8" });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Cannot write to .*: a file is in the way/);
  assert.doesNotMatch(blocked.stderr, /Reading/);
});

test("--duck, --lufs, --bpm and --meter take numbers as people write them: a blank, hex or an exponent is refused in each flag's words", () => {
  for (const [flag, message] of [["--duck", /--duck takes 0 to 40 dB/], ["--lufs", /--lufs takes -40 to -5/], ["--bpm", /--bpm takes 40 to 250/], ["--meter", /--meter takes 3 or 4/]]) {
    for (const value of [" ", "0x10", "1e1", "-1e1", "Infinity", "12abc"]) assert.throws(() => parse(["song.mp3", "--length", "30", flag, value]), message, `${flag} ${JSON.stringify(value)}`);
  }
  for (const value of ["3/x", "3/", "3/4/5", "/4", "x/4"]) assert.throws(() => parse(["song.mp3", "--length", "30", "--meter", value]), /--meter takes 3 or 4/, value);
  const read = (flag, value) => parse(["song.mp3", "--length", "30", flag, value]);
  assert.equal(read("--duck", "6").duck, 6);
  assert.equal(read("--duck", "-6").duck, 6);
  assert.equal(read("--duck", "+7.5").duck, 7.5);
  assert.equal(read("--duck", ".5").duck, 0.5);
  assert.equal(read("--duck", " 6 ").duck, 6);
  assert.equal(read("--lufs", "-16").lufs, -16);
  assert.equal(read("--bpm", "124.5").bpm, 124.5);
  assert.equal(read("--meter", "3/4").meter, 3);
  assert.equal(read("--meter", "6/8").meter, 6);
  assert.equal(read("--meter", "4").meter, 4);
  // A hyphen starts a number here, not a flag.
  assert.equal(parse(["song.mp3", "--length", "30", "--lufs", "-9.5"]).lufs, -9.5);
});
