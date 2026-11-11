"use strict";

// ffmpeg does the decoding, the encoding and the loudness measurement.
// Samples travel through pipes as raw 32-bit floats, so nothing is written
// to disk but the final files. Every call here works with ffmpeg 4.4 (the
// one Ubuntu 22.04 has) and newer. A sound goes to ffmpeg as interleaved
// floats, or as stereo { L, R }, which is interleaved a block at a time on
// its way, so no interleaved copy of a long sound is ever held whole.

const fs = require("node:fs");
const path = require("node:path");
const { getSystemErrorMap } = require("node:util");
const { spawn } = require("node:child_process");
const { CHUNK, breathe } = require("./breathe");

const RATE = 48000;

// A name made whole from the folder musicfit was started in. path.resolve
// works out a .. by its letters, while the system goes up from wherever a
// link on the way leads, so a name with a .. in it keeps it. Windows goes by
// the letters too.
function whole(name) {
  if (process.platform === "win32" || !name.split("/").includes("..")) return path.resolve(name);
  return path.isAbsolute(name) ? name : `${process.cwd()}/${name}`;
}

// A path with folders in it is read from where musicfit was started, also
// for a call that runs ffmpeg in another folder.
function ffmpegPath() {
  const named = process.env.FFMPEG_PATH;
  if (!named) return "ffmpeg";
  return path.basename(named) === named ? named : whole(named);
}

// The variable that holds PATH and its entries, as the system reads them.
// Windows takes the variable's name in any case, and an entry in quotes,
// which may hold a ; of its own. No entries when there is no PATH.
function pathEntries() {
  const windows = process.platform === "win32";
  const key = windows ? Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") : "PATH";
  if (!key || process.env[key] === undefined) return { key, entries: null };
  return { key, entries: windows ? process.env[key].match(/(?<=^|;)("[^"]*"?|'[^']*'?)?[^;]*/g) : process.env[key].split(path.posix.delimiter) };
}

// The bare folder of an entry of PATH written in quotes on Windows.
const unquoted = (entry) => entry.replace(/^["']|["']$/g, "");

// The environment for a call run in another folder: a relative entry of PATH
// reads from that folder when ffmpeg is looked up, so that entry is written
// from where musicfit was started, and the others stay as they are. An empty
// entry is the current folder too. Windows passes over an empty entry.
function fromHere() {
  const windows = process.platform === "win32";
  const { delimiter, isAbsolute } = windows ? path.win32 : path.posix;
  const { key, entries } = pathEntries();
  if (!entries) return process.env;
  const written = entries.map((entry) => {
    const bare = windows ? unquoted(entry) : entry;
    return isAbsolute(bare) || (windows && !bare) ? entry : whole(bare);
  });
  return { ...process.env, [key]: written.join(delimiter) };
}

// A file as ffmpeg is given it: by its full path, since ffmpeg takes a name
// whose part before a colon is all letters and digits (9:16.mp4) for a
// protocol, and never a full path.
const where = (file) => whole(file);

// Whether a file the run looked at before any work is not there now, as
// when it was taken away since: only then is a "No such file" that ffmpeg
// says while it reads it about that file. ffmpeg 7 and newer say it on a
// line that does not name the file.
function gone(file) {
  try {
    fs.statSync(where(file));
    return false;
  } catch (err) {
    return err.code === "ENOENT" || err.code === "ENOTDIR";
  }
}

// How each message that asks for an ffmpeg says to get one.
const INSTALL = "brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg";

// Where the system looks for a program when there is no PATH: glibc in
// /bin, then /usr/bin, musl in /usr/local/bin first, and Node on macOS, as
// the BSDs do, in /usr/bin, then /bin.
function defaultFolders() {
  if (process.platform !== "linux") return ["/usr/bin", "/bin"];
  return process.report.getReport().header.glibcVersionRuntime ? ["/bin", "/usr/bin"] : ["/usr/local/bin", "/bin", "/usr/bin"];
}

// The files the system tries, in its order, for the program FFMPEG_PATH
// names, or ffmpeg: that path when it has a folder in it, else that name in
// each folder of PATH, an empty or a relative one read from where musicfit
// was started, or with no PATH at all in the system's own folders. Windows
// looks in the current folder first and adds .com and .exe to the name,
// which it tries as it is only when it has an extension. A path with a
// folder in it comes first as it is all the same, so a file there with no
// extension is named for what it is (see barred()).
function places(program) {
  const windows = process.platform === "win32";
  if (path.basename(program) !== program) return [program, ...(windows ? [`${program}.com`, `${program}.exe`] : [])];
  const { entries } = pathEntries();
  const folders = windows ? ["", ...(entries || []).map(unquoted).filter(Boolean)] : entries || defaultFolders();
  const names = windows ? [...(path.extname(program) ? [program] : []), `${program}.com`, `${program}.exe`] : [program];
  return folders.flatMap((folder) => {
    const at = whole(folder || ".");
    return names.map((name) => `${at}${at.endsWith(path.sep) ? "" : path.sep}${name}`);
  });
}

// The system's words for an error, such as "permission denied", else its code.
const worded = (err) => (getSystemErrorMap().get(err.errno) || [])[1] || err.code;

// The file a path goes through as if it were a folder, as notes.txt in
// notes.txt/ffmpeg, or null.
function fileOnTheWay(file) {
  const parts = file.split(path.sep);
  for (let i = 2; i < parts.length; i++) {
    const part = parts.slice(0, i).join(path.sep);
    try {
      if (!fs.statSync(part).isDirectory()) return part;
    } catch {
      return null;
    }
  }
  return null;
}

// What keeps the system from running the file at a place, as far as can be
// told for certain before it runs: null when nothing does, else the words
// for it, and in `on` what the system does with it when it looks for a
// program on PATH. It "passes" over a folder, a file this user may not run
// and a link to nothing, and looks in the next folder; it passes over
// nothing there and a folder this user may not enter "quietly", as these
// may hold no such program at all; and it "stops" at a path it cannot
// follow, as a loop of links. Windows passes over a file whose name has no
// extension too, as it tries that name with .com and .exe added (see
// places()).
function barred(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") {
      let link = false;
      try {
        link = fs.lstatSync(file).isSymbolicLink();
      } catch {
        // Nothing there at all.
      }
      if (link) return { on: "passes", words: "is a link to a file that is not there" };
      const through = err.code === "ENOTDIR" && fileOnTheWay(file);
      return { on: "quietly", words: through ? `where there is none, as ${through} is a file, not a folder` : "where there is none" };
    }
    if (err.code === "EACCES" || err.code === "EPERM") return { on: "quietly", words: "may not be run: permission denied" };
    if (err.code === "ELOOP") return { on: "stops", words: "goes through a loop of links" };
    return { on: "stops", words: `cannot be looked at: ${worded(err)}` };
  }
  if (stat.isDirectory()) return { on: "passes", words: "is a folder" };
  if (process.platform === "win32" && !path.extname(file)) return { on: "passes", words: "has no .exe in its name, so Windows does not run it" };
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    return { on: "passes", words: (stat.mode & 0o111) === 0 ? "is not executable" : "may not be run: permission denied" };
  }
  return null;
}

// The errors that say the system is short of something to start a program
// with, not that ffmpeg is wrong: what it is short of, and what to do.
const SHORT = {
  EMFILE: "too many open files. Raise the limit on open files (ulimit -n) and run it again",
  ENFILE: "the system has too many files open. Run it again once fewer are",
  EAGAIN: "the system starts no more processes for now. Run it again once fewer are running",
  ENOMEM: "not enough memory. Free some and run it again",
  E2BIG: "its environment is too large. Run it with fewer or shorter environment variables",
};

// The errors a start fails with that the system passes over, as glibc's
// execvp does, to try the next folder of PATH: a file that is not there or
// may not be run, or one whose interpreter or loader is not there.
const PASSED = new Set(["ENOENT", "EACCES", "ENOTDIR", "ESTALE", "ENODEV", "ETIMEDOUT"]);

// How long ffmpeg -version may take, in milliseconds: on a machine short
// of memory, with its swap full, ffmpeg 4.4 took more than 30 seconds.
const LIMIT = 120000;

// A line a program printed, in quotes, as it printed it, with its control
// characters written out, as \r or \x1b. A line longer than 200 characters
// keeps its first 120 and its last 80, as its end most often says why.
function quoted(line) {
  const chars = Array.from(line).map((c) => {
    if (c === "\t") return "\\t";
    if (c === "\r") return "\\r";
    if (!/[\p{Cc}\p{Cf}]/u.test(c)) return c;
    const n = c.codePointAt(0);
    return n < 0x100 ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u${n.toString(16).padStart(4, "0")}`;
  });
  const shown = chars.length > 200 ? [...chars.slice(0, 120), "...", ...chars.slice(-80)] : chars;
  return `"${shown.join("")}"`;
}

// The first line with anything in it of what a program printed, or null.
function firstLine(text) {
  return (
    String(text || "")
      .split(/\r?\n/)
      .find((l) => l.trim()) || null
  );
}

// The first line of a file that starts with #!, as the system reads it to
// find the program that runs the file, or null.
function bangLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const bytes = Buffer.alloc(256);
    const got = bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0));
    if (got.indexOf("#!") !== 0) return null;
    const end = got.indexOf(10);
    return got.subarray(0, end < 0 ? got.length : end).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// What happened to a file the system did not start with `err`, after the
// certain checks found nothing wrong with the file itself. The system says
// ENOENT of a file that is there when an interpreter or a loader it needs
// is not, so a script's first line, which names its interpreter, is shown.
function unstartable(file, err) {
  if (["ENOEXEC", "EFTYPE", "EBADARCH"].includes(err.code)) return "it is not a program this system can run";
  const line = bangLine(file);
  const first = line === null ? "" : `; its first line is ${quoted(line)}`;
  if (err.code === "ENOENT") return `the system could not start it, as an interpreter or a loader it needs is not there${first}`;
  return `the system could not start it: ${worded(err)}${first}`;
}

// What a file that ran with -version and did not answer as ffmpeg did:
// the first line it printed, on its error output, where a program says
// what is wrong, else on its output, then how it ended. ffmpeg prints its
// version on its output, so a program that ended well printing only on its
// error output is said to.
function answered(r, limit) {
  if (r.late) return `it gave no answer in ${limit / 1000} s`;
  const ended = r.signal ? `was stopped by ${r.signal}` : `exited with ${r.code}`;
  const line = firstLine(r.stderr);
  if (line && r.code === 0 && !firstLine(r.stdout)) return `it printed ${quoted(line)} on its error output, nothing on its output, and exited with 0`;
  if (line || firstLine(r.stdout)) return `it printed ${quoted(line || firstLine(r.stdout))} and ${ended}`;
  return r.signal ? `it was stopped by ${r.signal}` : `it printed nothing and exited with ${r.code}`;
}

// An error for an ffmpeg that could not be used, marked, so what reads
// ffmpeg's words of a failure leaves it as it is.
const unusable = (message, more) => Object.assign(new Error(message), { unstarted: true }, more);

// The error for the ffmpeg at `file`, with `words` that say what happened
// there: by FFMPEG_PATH when it gives a path, else as the one on PATH, and
// how to get an ffmpeg or point to one.
function needs(file, words) {
  const program = ffmpegPath();
  const how = process.env.FFMPEG_PATH ? `Set FFMPEG_PATH to an ffmpeg, or unset it and install one (${INSTALL}).` : `Install ffmpeg (${INSTALL}) or set FFMPEG_PATH to one.`;
  if (path.basename(program) !== program) return `musicfit needs ffmpeg, and FFMPEG_PATH points to ${file}, ${words.startsWith("where ") ? words : `which ${words}`}. ${how}`;
  return `musicfit needs ffmpeg, and the ${program} on PATH, ${file}, ${words}. ${how}`;
}

// What `file` did when run with -version, as { code, signal, stdout,
// stderr }; { late: true } when it gave no answer in `limit` milliseconds
// and was stopped; { err } when the system did not start it.
function version(file, limit) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ err });
      return;
    }
    running.add(child);
    let timer = null;
    const end = (result) => {
      clearTimeout(timer);
      running.delete(child);
      resolve(result);
    };
    child.on("error", (err) => end({ err }));
    // With no file descriptor left Node makes no pipes, and says so a moment
    // later.
    if (!child.stdout || !child.stderr) return;
    const said = { stdout: [], stderr: [] };
    let size = 0;
    for (const name of ["stdout", "stderr"]) {
      child[name].on("data", (chunk) => {
        if (size >= 1 << 16) return;
        said[name].push(chunk);
        size += chunk.length;
      });
    }
    // A program that hands its output on to one that goes on running may
    // never close it, so the answer is not waited for past the limit.
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      end({ late: true });
    }, limit);
    child.on("close", (code, signal) => end({ code, signal, stdout: Buffer.concat(said.stdout).toString("utf8"), stderr: Buffer.concat(said.stderr).toString("utf8") }));
  });
}

// The ffmpeg every call runs, as a path, found before any work as the
// system finds it: the path FFMPEG_PATH gives, or the first file on PATH
// the system would start (see places()), past what it passes over (see
// barred() and PASSED), and run once with -version. It is taken only when
// it exits with 0 and prints a line that starts with "ffmpeg version";
// else the run stops, with what the system said or the first line the
// program printed (see needs()). When the system finds none after a file
// it passed over, the first such file is named.
async function find(limit) {
  const program = ffmpegPath();
  let passed = null;
  let none = null;
  for (const file of places(program)) {
    let seen = barred(file);
    if (!seen) {
      const r = await version(file, limit);
      if (r.err && Object.hasOwn(SHORT, r.err.code)) throw unusable(`musicfit could not start ffmpeg: ${SHORT[r.err.code]}.`);
      if (!r.err && r.code === 0 && /^ffmpeg version\b/m.test(r.stdout)) return file;
      seen = { on: r.err && PASSED.has(r.err.code) ? "passes" : "stops", words: `did not run as ffmpeg: ${r.err ? unstartable(file, r.err) : answered(r, limit)}`, signal: r.signal };
    }
    if (seen.on === "stops") throw unusable(needs(file, seen.words), { stopped: Boolean(seen.signal) });
    if (seen.on === "quietly") none = none || seen;
    else passed = passed || { file, words: seen.words };
  }
  if (passed) throw unusable(needs(passed.file, passed.words));
  if (path.basename(program) !== program) throw unusable(needs(program, none ? none.words : "where there is none"));
  if (process.env.FFMPEG_PATH) throw unusable(`musicfit needs ffmpeg, and FFMPEG_PATH names ${program}, which is not on PATH. Set FFMPEG_PATH to an ffmpeg, or unset it and install one (${INSTALL}).`);
  throw unusable(`musicfit needs ffmpeg. Install it (${INSTALL}) or set FFMPEG_PATH to it.`);
}

// The ffmpeg found for the FFMPEG_PATH, the PATH and the folder musicfit
// runs with now, found once for them (see find()). A failure is not kept,
// so a later call looks again.
let found = null;

function ready(limit = LIMIT) {
  let here = "";
  try {
    here = process.cwd();
  } catch {
    // A folder taken away since: only PATH's relative entries read from it.
  }
  const key = JSON.stringify([process.env.FFMPEG_PATH, pathEntries().entries, here]);
  if (found && found.key === key) return found.file;
  const file = find(limit);
  found = { key, file };
  file.catch(() => {
    if (found && found.file === file) found = null;
  });
  return file;
}

// Whether a call can run in a folder: a start that fails there for want of
// the folder is no fault of ffmpeg's.
function enterable(folder) {
  try {
    fs.accessSync(folder, fs.constants.X_OK);
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

// What ffmpeg prints once it has given up, after the line that says why:
// how it stopped, which says nothing of the cause. ffmpeg 4.4 ends with the
// first five, newer ones with the others.
const CLOSING = [
  /^Conversion failed!?$/,
  /^Error while processing the decoded data/,
  /^Failed to inject frame into filter network/,
  /^Error reinitializing filters!?$/,
  /^Exiting normally/,
  /^Error initializing a simple filtergraph$/,
  /^Error opening (input|output) files?\b/,
  /^Error selecting an encoder$/,
  /^Error closing file\b/,
  /^Error muxing a packet$/,
  /^Task finished with error code/,
  /^Terminating thread with return code/,
  // The report of what it wrote, which ffmpeg prints at -v info at the end
  // of a run, a failed one too: "video:0kB audio:0kB ..." in 4.4 and
  // "video:0KiB audio:0KiB ..." in newer ones. Its "muxing overhead:
  // unknown" is no cause.
  /^video:\S+ audio:\S+ /,
];
// The words of a line that says what went wrong.
const WRONG = /error|\b(invalid|unable|cannot|can't|could not|couldn't|failed|not found|no such|unknown|unrecognized|not supported|denied|no space|refused|not opened|is not|does not)\b/i;
// What ffmpeg says of its input and output on the way, for a run that names no error.
const INFO = /^(Input|Output) #\d|^Stream (mapping|#)|^Guessed Channel Layout|^Estimating duration|^Duration:|^Metadata:|^Press \[q\]|^(size|frame)=|^Summary:$/;

// Whether ffmpeg was stopped by a signal: one it did not catch, or one it
// caught, as Ctrl-C, after which it exits with 255. At -v info it then says
// "Exiting normally, received signal N."; at -v error it says nothing at
// all. ffmpeg 7 and newer also exit with 255 when the system refuses an
// operation, but they say so first.
function stopped(stderr, code, signal) {
  return Boolean(signal) || /received signal \d+/.test(stderr || "") || (code === 255 && !String(stderr || "").trim());
}

// Why ffmpeg failed, from what it printed: the last line that names an
// error once the closing lines and the indented ones (a summary, the
// streams) are left out, without the "[name @ 0x...]" that starts it; else
// the last line it printed that says something.
function reason(stderr, code, signal) {
  if (signal) return `ffmpeg was stopped (${signal})`;
  // ffmpeg stopped by a signal it caught, as Ctrl-C.
  const caught = /received signal (\d+)/.exec(stderr || "");
  if (caught) return `ffmpeg was stopped (signal ${caught[1]})`;
  if (stopped(stderr, code, signal)) return "ffmpeg was stopped";
  const lines = String(stderr || "")
    .split(/\r?\n|\r/)
    .filter((line) => line.trim() && !/^\s/.test(line))
    .map((line) => line.replace(/^(\[[^\]]*\]\s*)+/, "").trim())
    .filter((line) => line && !CLOSING.some((closing) => closing.test(line)));
  const line = lines.filter((l) => WRONG.test(l)).pop() || lines.filter((l) => !INFO.test(l)).pop();
  if (!line) return `ffmpeg exited with ${code}`;
  return /ffmpeg/i.test(line) ? line : `ffmpeg: ${line}`;
}

// ffmpeg 4.4 exits with 0 when it cannot finish a file: when the disk fills
// as it writes an MP4's index or a WAV's sizes, it says "Error writing
// trailer of <file>: No space left on device" and leaves a file no player
// reads. A call that writes `file` and says so, in those words for that
// file or in ffmpeg 7's for its output, has failed, whatever its exit
// code. Nothing else it prints is read for them, so a file's name, as in
// what ffmpeg says of a video it reads, is never taken for its words.
function unfinished(stderr, file) {
  const said = `\n${stderr}`;
  return said.includes(`\nError writing trailer of ${file}: `) || /\n\[out#\d+\/\w+ @ 0x[0-9a-f]+\] Error writing trailer\b/.test(said);
}

// The ffmpeg processes running now, so a run that is stopped stops them
// too: a signal sent to node alone does not reach them.
const running = new Set();

function stopChildren() {
  for (const child of running) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Gone already.
    }
  }
  running.clear();
}

// Runs ffmpeg with `args`, and `input` on its stdin. `writes` is the file
// the call writes, if any, and `cwd` the folder to run it in, if not this one.
// The ffmpeg it runs is found and asked its version before the first call
// (see ready()), so one that cannot be used stops the run before any work.
function run(args, input, options = {}) {
  return ready().then((file) => call(file, args, input, options));
}

function call(file, args, input, { writes = null, cwd } = {}) {
  return new Promise((resolve, reject) => {
    // The system short of something to start it with, the folder of the
    // call gone, which is no fault of ffmpeg's, or an ffmpeg that ran when
    // the run began and cannot be started now, as when it was removed or
    // changed since.
    const failed = (error) => {
      if (Object.hasOwn(SHORT, error.code)) reject(unusable(`musicfit could not start ffmpeg: ${SHORT[error.code]}.`));
      else if (cwd && !enterable(cwd)) reject(error);
      else reject(unusable(`musicfit could not start ffmpeg, ${file}, again: ${worded(error)}. Check that it is still there and may be run, and run musicfit again.`));
    };
    let child;
    try {
      child = spawn(file, ["-hide_banner", ...(input ? [] : ["-nostdin"]), ...args], { cwd, env: cwd ? fromHere() : process.env, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    } catch (err) {
      failed(err);
      return;
    }
    running.add(child);
    child.on("error", (error) => {
      running.delete(child);
      failed(error);
    });
    // With no file descriptor left Node makes no pipes, and says so a moment
    // later.
    if (!child.stdout || !child.stderr) return;
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("close", (code, signal) => {
      running.delete(child);
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === 0 && !(writes && unfinished(stderr, writes))) resolve({ chunks: out, stderr });
      else reject(Object.assign(new Error(reason(stderr, code, signal)), { stderr, signal, stopped: stopped(stderr, code, signal) }));
    });
    if (input) {
      // ffmpeg may stop reading early when it fails; the error that follows
      // tells why, the broken pipe does not.
      child.stdin.on("error", () => {});
      if (input.L) feed(child.stdin, input).catch(() => {});
      else child.stdin.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
    }
  });
}

// Stereo { L, R } written to ffmpeg as interleaved floats, a block at a
// time, each written once the one before has gone down the pipe.
async function feed(stdin, { L, R }) {
  const block = 1 << 16;
  const ready = () =>
    new Promise((resolve) => {
      const go = () => {
        stdin.off("drain", go);
        stdin.off("close", go);
        resolve();
      };
      stdin.on("drain", go);
      stdin.on("close", go);
    });
  for (let from = 0; from < L.length && !stdin.destroyed; from += block) {
    const to = Math.min(L.length, from + block);
    const out = new Float32Array(2 * (to - from));
    for (let i = from; i < to; i++) {
      out[2 * (i - from)] = L[i];
      out[2 * (i - from) + 1] = R[i];
    }
    if (!stdin.write(Buffer.from(out.buffer))) await ready();
  }
  stdin.end();
}

// The pipe's chunks copied byte for byte into one array of floats, without
// joining them first: a long track would be held twice.
async function floats(chunks) {
  const bytes = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(Math.floor(bytes / 4));
  const view = new Uint8Array(out.buffer);
  let at = 0;
  let since = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, view.length - at);
    if (take <= 0) break;
    view.set(chunk.subarray(0, take), at);
    at += take;
    since += take;
    if (since >= 4 * CHUNK) {
      since = 0;
      await breathe();
    }
  }
  return out;
}

// The first audio stream of any file ffmpeg reads (a video's too), or the
// one numbered `stream` from 0, as interleaved floats at the given rate and
// channel count. With `from` it is read on the file's own timeline from that
// second on, for a video's own sound from its picture's first frame: cut
// where the sound starts before it, silence where the sound starts after it
// or has a gap, so a second into the sound is a second into the picture.
async function decode(file, { rate = RATE, channels = 2, from = null, stream = 0 } = {}) {
  const timeline = from === null ? [] : ["-copyts"];
  const align = from === null ? [] : ["-af", `aresample=${rate}:async=1:first_pts=${Math.round(from * rate)}`];
  try {
    const { chunks } = await run(["-v", "error", ...timeline, "-i", where(file), "-map", `0:a:${stream}`, "-vn", ...align, "-ac", String(channels), "-ar", String(rate), "-f", "f32le", "pipe:1"]);
    const samples = await floats(chunks);
    if (!samples.length) throw new Error(`${file} has no audio`);
    return samples;
  } catch (err) {
    if (err.unstarted) throw err;
    // ffmpeg says why early and sums up last, so all it said is searched.
    const said = err.stderr || err.message;
    if (/matches no streams/.test(said)) throw new Error(`${file} has no audio stream`);
    if (/No such file|does not exist/.test(said) && gone(file)) throw new Error(`Cannot read ${file}: no such file`);
    if (/Invalid data found/.test(said)) throw new Error(`Cannot read ${file}: ffmpeg does not know this format`);
    throw err;
  }
}

// Writes a stereo sound as a 24-bit WAV. bitexact leaves out the
// header's note of the ffmpeg that wrote it, so any ffmpeg writes the same
// bytes for the same sound.
async function encodeWav(samples, file, { rate = RATE, channels = 2 } = {}) {
  await run(["-v", "error", "-f", "f32le", "-ar", String(rate), "-ac", String(channels), "-i", "pipe:0", "-c:a", "pcm_s24le", "-fflags", "+bitexact", "-y", where(file)], samples, { writes: where(file) });
}

// EBU R128 loudness as ffmpeg's ebur128 meter reads it: integrated
// loudness (LUFS), true peak (dBTP, oversampled), loudness range (LU).
// Silence reads -Infinity. loudnorm measures the same way but upsamples
// everything to 192 kHz first, which is ten times slower. framelog=verbose
// keeps the meter's line for every 100 ms out of what -v info prints;
// ffmpeg 4.4 has no quieter value, and the summary is the same.
const METER = "ebur128=peak=true:framelog=verbose";

function summary(stderr) {
  const said = stderr.slice(stderr.lastIndexOf("Integrated loudness:"));
  const read = (label) => {
    const m = new RegExp(`${label}:\\s*(-?inf|-?[\\d.]+)`).exec(said);
    if (!m) throw new Error("ffmpeg's ebur128 printed no measurement");
    return /inf/.test(m[1]) ? -Infinity : Number(m[1]);
  };
  const integrated = read("I");
  return { integrated: integrated <= -70 ? -Infinity : integrated, truePeak: read("Peak"), range: read("LRA") };
}

async function measure(samples, { rate = RATE, channels = 2 } = {}) {
  const { stderr } = await run(["-v", "info", "-nostats", "-f", "f32le", "-ar", String(rate), "-ac", String(channels), "-i", "pipe:0", "-af", METER, "-f", "null", "-"], samples);
  return summary(stderr);
}

// The same for the first sound of a file the run made, as a player decodes
// it. Named from its own folder: the hosted service's ffmpeg refuses an input
// with a % in its path, and the name of the out folder is the user's.
async function measureFile(file) {
  const { stderr } = await run(["-v", "info", "-nostats", "-i", path.basename(file), "-map", "0:a:0", "-af", METER, "-f", "null", "-"], null, { cwd: path.dirname(file) });
  return summary(stderr);
}

module.exports = { RATE, decode, encodeWav, fromHere, gone, measure, measureFile, quoted, ready, run, reason, stopChildren, where };
