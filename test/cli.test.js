"use strict";

// The command line, the options and the version in every manifest. Only
// the ones that read a file need ffmpeg.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { parse, parseTime, parseFps } = require("../skills/musicfit/scripts/musicfit");
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
