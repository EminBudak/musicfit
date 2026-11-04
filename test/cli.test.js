"use strict";

// The command line, the options and the version in every manifest. None of
// these need ffmpeg except the last two.

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { parse, parseTime, parseFps } = require("../skills/musicfit/scripts/musicfit");
const { fixture } = require("./helpers");

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
