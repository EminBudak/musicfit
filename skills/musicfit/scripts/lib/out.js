"use strict";

// The out folder. A run makes its files in a hidden folder and puts them in
// place only once it has ended well. The hidden folder is made when the run
// writes its first file, after the track is read: inside the out folder when
// that is there, else next to it, so it is on the same disk and gets the
// same mode and default ACL. A run that fails, is refused or is stopped
// leaves the out folder as it was and adds nothing to it. A run that ends
// well moves the earlier run's files aside, moves its own in, then removes
// the earlier ones, so at no moment are both gone. The earlier run's files
// are the ones its cues.json lists; a file under one of musicfit's names
// that no musicfit cues.json there lists is someone else's, and stops a run
// that would write over it before any work.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// The names musicfit writes in its folder.
const OUTPUTS = ["fitted.wav", "mix.wav", "cues.json", "seams.png", "FIT.md"];
const VIDEO = "video.mp4";
const NAMES = [...OUTPUTS, VIDEO];
// A run's hidden folder, .musicfit-part-<pid>-<8 hex digits>.
const PART = /^\.musicfit-part-(\d+)-[0-9a-f]{8}$/;
// A run killed outright cannot remove its hidden folder. A later run that
// ends well in that place removes it once its process is gone and nothing
// in it has changed for this long, so a run on another machine sharing the
// folder keeps its own while it works.
const STALE = 15 * 60 * 1000;
// Held in the out folder while a run puts its files there, so two runs that
// end at the same moment take turns. A commit holds it for a few renames;
// one older than LOCK_STALE was left by a run killed while it held it.
const LOCK = ".musicfit-commit";
const LOCK_STALE = 60 * 1000;
const LOCK_WAIT = 90 * 1000;
// A lock that names no process was left by a run killed in the moment it
// made it, before it wrote its line.
const LOCK_BARE = 5 * 1000;

const lstat = (at) => fs.lstatSync(at, { throwIfNoEntry: false });

const WHY = { EACCES: "permission denied", EPERM: "permission denied", EROFS: "the disk is read-only", ENOTDIR: "a file is in the way", ENOSPC: "the disk is full", EDQUOT: "the disk quota is used up" };

// Whether the folder to write to can be made, checked before any work so a
// run does not fail at its end over it (and so a recursive mkdir is never
// tried where it does not return, such as /proc): the nearest folder that
// exists has to be one, and writable. A link to a folder that is not there
// on the way is refused, and so is a drive or a share that is not there.
function writable(dir) {
  let at = path.resolve(dir);
  // A folder on the way, named as the user named the out folder.
  const named = (folder) => (folder === path.resolve(dir) ? "it" : path.isAbsolute(dir) ? folder : path.relative(process.cwd(), folder) || folder);
  while (!fs.existsSync(at)) {
    let s = null;
    try {
      s = fs.lstatSync(at);
    } catch {
      // Not there, or a file on the way, which is told below.
    }
    if (s && s.isSymbolicLink()) throw new Error(`Cannot write to ${dir}: ${named(at)} is a link to ${fs.readlinkSync(at)}, which is not there`);
    const up = path.dirname(at);
    if (up === at) throw new Error(`Cannot write to ${dir}: ${at} is not there`);
    at = up;
  }
  try {
    if (!fs.statSync(at).isDirectory()) throw Object.assign(new Error(`${at} is a file`), { code: "ENOTDIR" });
    fs.accessSync(at, fs.constants.W_OK);
  } catch (err) {
    throw new Error(`Cannot write to ${dir}: ${WHY[err.code] || err.message}`);
  }
}

const isFile = (at) => {
  const s = lstat(at);
  return Boolean(s) && !s.isDirectory();
};

// The files a musicfit run wrote in `dir`, as its cues.json lists them:
// cues.json, seams.png and FIT.md always, fitted.wav for a fit, mix.wav
// with a voice and video.mp4 with a video. None when no cues.json there is
// musicfit's.
function listed(dir) {
  let c;
  try {
    c = JSON.parse(fs.readFileSync(path.join(dir, "cues.json"), "utf8"));
  } catch {
    return [];
  }
  if (!c || typeof c !== "object" || !c.musicfit) return [];
  const names = ["cues.json", "seams.png", "FIT.md"];
  if (c.file === "fitted.wav") names.push("fitted.wav");
  if (c.mix === "mix.wav") names.push("mix.wav");
  if (c.video && c.video.file === VIDEO) names.push(VIDEO);
  return names;
}

// The earlier run's files in `dir`: those its cues.json lists that are
// there as files or links. A folder under one of those names stays.
function earlier(dir) {
  const names = listed(dir);
  return NAMES.filter((name) => names.includes(name) && isFile(path.join(dir, name)));
}

// Whether two paths name one file, however each is reached.
function sameFile(a, b) {
  try {
    const x = fs.statSync(a, { bigint: true });
    const y = fs.statSync(b, { bigint: true });
    // A disk that keeps no file numbers gives 0; the real paths stand in.
    if (!x.ino || !y.ino) return fs.realpathSync.native(a) === fs.realpathSync.native(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

const and = (names) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

// Checked before any work, for the names this run writes and the files it
// reads: the folder can be written, none of those names is a folder there
// or a file musicfit did not write, and no input is a file this run
// replaces or removes once it ends well.
function claim(dir, writes, inputs = []) {
  writable(dir);
  if (!fs.existsSync(dir)) return;
  for (const name of writes) {
    const s = lstat(path.join(dir, name));
    if (s && s.isDirectory()) throw new Error(`${path.join(dir, name)} is a folder, and this run writes its ${name} there: move it, or give another --out`);
  }
  const ours = listed(dir);
  const theirs = writes.filter((name) => isFile(path.join(dir, name)) && !ours.includes(name));
  if (theirs.length === 1) throw new Error(`${path.join(dir, theirs[0])} is not a file musicfit wrote, and this run would replace it: move it, or give another --out`);
  if (theirs.length) throw new Error(`${dir} holds ${and(theirs)}, which musicfit did not write, and this run would replace them: move them, or give another --out`);
  for (const input of inputs.filter(Boolean)) {
    for (const name of earlier(dir)) {
      const at = path.join(dir, name);
      // A link there is replaced, not the file it leads to.
      if (lstat(at).isSymbolicLink() || !sameFile(input, at)) continue;
      throw new Error(`${input} is the ${name} in ${dir}, which this run ${writes.includes(name) ? "replaces" : "removes"} once it ends well: copy it somewhere else first, or give another --out`);
    }
  }
}

// Windows can refuse a rename for a moment while a virus scanner or a sync
// client reads a file that was just written, so it is tried again for up to
// two seconds there. Synchronous, like the swap it is part of.
function rename(from, to) {
  for (let waited = 0; ; waited += 50) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(err.code) || waited >= 2000) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function remove(at) {
  try {
    fs.rmSync(at, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A file held open (on Windows) keeps it; a later run removes it.
  }
}

// Empty folders the run made, deepest first; one that holds anything stays,
// and so do the folders above it.
function unmake(folders) {
  for (const folder of folders) {
    try {
      fs.rmdirSync(folder);
    } catch {
      break;
    }
  }
}

// The runs that have begun and not ended, for a stop to undo, and the out
// folders of runs that began and did not end well, for a stop to name.
const live = new Set();
const unfinished = new Set();
let hooked = false;

// begin(dir): a run that writes in `dir`. file(name) is where it writes an
// output, scratch(name) where it keeps what is not one; the hidden folder
// both are in is made by the first of them. commit() puts the outputs in
// place, abort() leaves no trace.
function begin(dir) {
  const state = {
    dir,
    target: path.resolve(dir),
    work: null,
    made: [],
    ended: false,
    file: (name) => path.join(open(state), name),
    scratch: (name) => path.join(open(state), ".tmp", name),
    commit: () => commit(state),
    abort: () => abort(state),
  };
  live.add(state);
  unfinished.add(state);
  if (!hooked) {
    hooked = true;
    // However the process ends, no hidden folder of a run that has not
    // ended is left behind, and no ffmpeg of it runs on.
    process.on("exit", stopAll);
  }
  return state;
}

// The hidden folder, made the first time the run writes: inside the out
// folder when that is there, else next to it, with the folders above it
// that are not there yet. mkdirSync with the default mode: under a default
// ACL the folder gets the access the out folder gives (mkdtemp's 0700 would
// shut out the others the ACL lets in).
function open(state) {
  if (state.work) return state.work;
  const home = fs.existsSync(state.target) ? state.target : path.dirname(state.target);
  for (let at = home; !fs.existsSync(at) && path.dirname(at) !== at; at = path.dirname(at)) state.made.push(at);
  const work = path.join(home, `.musicfit-part-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(work);
    state.work = work;
    fs.mkdirSync(path.join(work, ".tmp"));
  } catch (err) {
    if (state.work) remove(state.work);
    state.work = null;
    unmake(state.made);
    state.made = [];
    throw new Error(`Cannot write to ${state.dir}: ${WHY[err.code] || err.message}`);
  }
  return work;
}

function ended(state, well) {
  state.ended = true;
  live.delete(state);
  if (well) unfinished.delete(state);
}

// What a failed move says: the file it was, or the folder.
function moveError(state, err) {
  const name = err.file ? path.join(state.dir, err.file) : state.dir;
  const held = ["EBUSY", "EPERM", "EACCES"].includes(err.code);
  return { held, why: held ? `${name} is held open by another program, or may not be changed (${err.code})` : err.file ? `${name}: ${err.message}` : err.message };
}

// The lock: a file made only if it is not there, naming the machine and the
// process that holds it. When its line cannot be written, as when the disk
// fills in between, it goes again, so the folder is as it was.
function lock(at) {
  let fd;
  try {
    fd = fs.openSync(at, "wx");
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
  }
  let open = true;
  try {
    fs.writeSync(fd, `${os.hostname()} ${process.pid}\n`);
    open = false;
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (open) {
      try {
        fs.closeSync(fd);
      } catch {
        // Closed already.
      }
    }
    fs.rmSync(at, { force: true });
    throw err;
  }
}

// Whether a lock is one a killed run left: its process is gone from this
// machine, it names none and was made a while ago, or it has been held far
// longer than any commit takes.
function staleLock(at) {
  let text;
  let s;
  try {
    text = fs.readFileSync(at, "utf8");
    s = fs.statSync(at);
  } catch {
    return null;
  }
  const [host, pid] = text.trim().split(" ");
  const named = Boolean(host) && Number(pid) > 0;
  const gone = named && host === os.hostname() && !running(Number(pid));
  const age = Date.now() - s.mtimeMs;
  return gone || age > LOCK_STALE || (!named && age > LOCK_BARE) ? text : null;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Puts the run's files in place. Two runs that share an out folder take
// turns: each holds the lock while it moves its files, and waits while
// another holds it. The moves themselves are synchronous, so no signal
// handler runs in the middle of them.
async function commit(state) {
  const { target } = state;
  open(state);
  remove(path.join(state.work, ".tmp"));
  const at = path.join(target, LOCK);
  const started = Date.now();
  for (;;) {
    if (state.ended) throw new Error(`stopped, so ${state.dir} is as it was`);
    // The out folder, made now when the run is the first to write there.
    if (!fs.existsSync(target)) {
      try {
        fs.mkdirSync(target);
        state.made.unshift(target);
      } catch (err) {
        if (err.code !== "EEXIST") throw new Error(`Could not put the new files in ${state.dir}: ${WHY[err.code] || err.message}. Nothing was made.`);
      }
    }
    let held = false;
    try {
      held = lock(at);
    } catch (err) {
      if (err.code !== "ENOENT") throw new Error(`Could not put the new files in ${state.dir}: ${WHY[err.code] || err.message}. ${state.dir} is as it was.`);
      // A link to a folder that is not there, made while the run worked:
      // no waiting makes it one.
      const s = lstat(target);
      if (s && s.isSymbolicLink() && !fs.existsSync(target)) throw new Error(`Could not put the new files in ${state.dir}: it is a link to ${fs.readlinkSync(target)}, which is not there. ${state.dir} is as it was.`);
      // Else the folder went again in the meantime: it is made again.
    }
    if (held) {
      try {
        swap(state);
      } finally {
        try {
          fs.unlinkSync(at);
        } catch {
          // Gone already.
        }
      }
      break;
    }
    const stale = staleLock(at);
    if (stale !== null) {
      // Taken away only while it is still the one found stale.
      if (staleLock(at) === stale) fs.rmSync(at, { force: true });
      continue;
    }
    if (Date.now() - started > LOCK_WAIT) throw new Error(`Could not put the new files in ${state.dir}: another musicfit run has been putting its files there for ${LOCK_WAIT / 1000} s. ${state.dir} is as it was.`);
    await pause(25);
  }
  // The earlier files, and the hidden folder with them.
  remove(state.work);
  sweep(target);
  sweep(path.dirname(target));
}

// What tells a file from one that came in its place: a new file can get
// the number of one just removed, but not its times too.
function identity(at) {
  const s = fs.lstatSync(at, { bigint: true, throwIfNoEntry: false });
  return s ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` : null;
}

// The moves, with the lock held. cues.json is moved aside first and in
// last, so a commit cut short never leaves a cues.json that speaks for
// files it does not describe. A move that fails puts back what was moved,
// each file only while it is still the one this run moved and its place is
// free; what cannot go back waits in a folder no later run removes.
function swap(state) {
  const { target, work } = state;
  const fresh = NAMES.filter((name) => fs.existsSync(path.join(work, name)));
  const before = earlier(target);
  const old = path.join(work, ".old");
  fs.mkdirSync(old, { recursive: true });
  const moved = [];
  const move = (from, to, name) => {
    try {
      rename(from, to);
    } catch (err) {
      throw Object.assign(err, { file: name });
    }
    moved.push({ from, to, id: identity(to) });
  };
  const aside = (name) => {
    if (before.includes(name)) move(path.join(target, name), path.join(old, name), name);
  };
  const into = (name) => {
    if (!fresh.includes(name)) return;
    if (lstat(path.join(target, name))) throw Object.assign(new Error("a file came there while the run worked"), { file: name });
    move(path.join(work, name), path.join(target, name), name);
  };
  try {
    aside("cues.json");
    for (const name of NAMES.filter((n) => n !== "cues.json")) {
      aside(name);
      into(name);
    }
    into("cues.json");
  } catch (err) {
    const stuck = [];
    for (const m of moved.reverse()) {
      const ours = m.id !== null && identity(m.to) === m.id;
      try {
        if (!ours || lstat(m.from)) throw new Error("changed");
        rename(m.to, m.from);
      } catch {
        if (ours) stuck.push(m.to);
      }
    }
    const { held, why } = moveError(state, err);
    if (stuck.length) {
      ended(state, false);
      const kept = keep(state, stuck);
      throw new Error(`Could not put the new files in ${state.dir}: ${why}. Some of the earlier files could not be put back: they are in ${kept}.`);
    }
    throw new Error(`Could not put the new files in ${state.dir}: ${why}. ${state.dir} is as it was${held ? "; close the file and run again" : ""}.`);
  }
  ended(state, true);
}

function keep(state, stuck) {
  const to = path.join(path.dirname(state.work), path.basename(state.work).replace(/^\.musicfit-part-/, "musicfit-kept-"));
  try {
    fs.writeFileSync(path.join(state.work, "musicfit-kept.txt"), `A musicfit run could not put these files back in ${state.dir}:\n${stuck.map((f) => `  ${path.relative(state.work, f)}`).join("\n")}\nMove them where they belong, then remove this folder. musicfit leaves it alone.\n`);
    rename(state.work, to);
    return to;
  } catch {
    return state.work;
  }
}

function abort(state) {
  if (state.ended) return;
  ended(state, false);
  if (state.work) remove(state.work);
  unmake(state.made);
}

// Stops every run of this process that has not ended: their ffmpeg, then
// their hidden folders. Returns the out folders of the runs that began and
// did not end well, these and any that failed a moment before.
function stopAll() {
  require("./audio").stopChildren();
  for (const state of [...live]) abort(state);
  return [...unfinished].map((state) => state.dir);
}

// Whether a process of that number runs on this machine.
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// The newest time anything in a folder was changed, two levels down.
function touched(folder) {
  let newest = 0;
  const look = (at, depth) => {
    const s = lstat(at);
    if (!s) return;
    newest = Math.max(newest, s.mtimeMs);
    if (depth > 0 && s.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(at);
      } catch {
        return;
      }
      for (const entry of entries) look(path.join(at, entry), depth - 1);
    }
  };
  look(folder, 2);
  return newest;
}

// Removes the hidden folders of runs killed outright: their process is
// gone and nothing in them has changed for STALE. Nothing in one is put
// back: the run that ends well here has made the folder what it should be.
function sweep(folder) {
  let entries = [];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const m = PART.exec(entry.name);
    if (!m || !entry.isDirectory()) continue;
    const at = path.join(folder, entry.name);
    if (running(Number(m[1])) || Date.now() - touched(at) < STALE) continue;
    remove(at);
  }
}

module.exports = { OUTPUTS, NAMES, LOCK, writable, claim, begin, stopAll, sweep, earlier, listed, sameFile };
