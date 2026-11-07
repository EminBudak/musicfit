"use strict";

// The out folder. A run makes its files in a hidden folder and puts them in
// place only once it has ended well. The hidden folder is made when the run
// writes its first file, after the track is read: inside the out folder when
// that is there, else next to it, so it is on the same disk and gets the
// same mode and default ACL. A run that fails, is refused or is stopped
// leaves the out folder as it was and adds nothing to it. A run that ends
// well moves the earlier run's files aside, moves its own in, then removes
// the earlier ones, so at no moment are both gone; files musicfit did not
// write are left alone.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// The names musicfit writes in its folder. video.mp4, which --video adds,
// is musicfit's only when the folder's cues.json says musicfit wrote it:
// a video of that name is often the user's own.
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
const lstat = (at) => fs.lstatSync(at, { throwIfNoEntry: false });

const WHY = { EACCES: "permission denied", EPERM: "permission denied", EROFS: "the disk is read-only", ENOTDIR: "a file is in the way", ENOSPC: "the disk is full", EDQUOT: "the disk quota is used up" };

// Whether the folder to write to can be made, checked before any work so a
// run does not fail at its end over it (and so a recursive mkdir is never
// tried where it does not return, such as /proc): the nearest folder that
// exists has to be one, and writable.
function writable(dir) {
  let at = path.resolve(dir);
  while (!fs.existsSync(at)) at = path.dirname(at);
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

// Whether the video.mp4 in `dir` is one musicfit wrote: the cues.json
// there is musicfit's and names it.
function ownVideo(dir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, "cues.json"), "utf8"));
    return Boolean(c && c.musicfit && c.video && c.video.file === VIDEO);
  } catch {
    return false;
  }
}

// The earlier run's files in `dir`: the names musicfit writes that are
// there as files or links, video.mp4 only when it is musicfit's. A folder
// under one of those names is not musicfit's, and stays.
function earlier(dir) {
  const own = ownVideo(dir);
  return NAMES.filter((name) => isFile(path.join(dir, name)) && (name !== VIDEO || own));
}

// Checked before any work, for the names this run writes: the folder can be
// written, none of them is a folder there, and a video.mp4 there is one
// musicfit wrote.
function claim(dir, writes) {
  writable(dir);
  if (!fs.existsSync(dir)) return;
  for (const name of writes) {
    const s = lstat(path.join(dir, name));
    if (s && s.isDirectory()) throw new Error(`${path.join(dir, name)} is a folder, and this run writes its ${name} there: move it, or give another --out`);
  }
  if (writes.includes(VIDEO) && isFile(path.join(dir, VIDEO)) && !ownVideo(dir)) throw new Error(`${path.join(dir, VIDEO)} is not a file musicfit wrote, and this run would replace it: move it, or give another --out`);
}

// Windows can refuse a rename for a moment while a virus scanner or a sync
// client reads a file that was just written, so it is tried again for up to
// two seconds there. Synchronous, like the whole commit.
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
  for (let at = home; !fs.existsSync(at); at = path.dirname(at)) state.made.push(at);
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

// What a failed move says: the file it was, or the folder when the whole
// hidden folder was being moved.
function moveError(state, err) {
  const name = err.file ? path.join(state.dir, err.file) : state.dir;
  const held = ["EBUSY", "EPERM", "EACCES"].includes(err.code);
  return { held, why: held ? `${name} is held open by another program, or may not be changed (${err.code})` : err.file ? `${name}: ${err.message}` : err.message };
}

// Puts the run's files in place, synchronously, so no signal handler runs
// in the middle of it. cues.json is moved aside first and in last, so a
// commit cut short never leaves a cues.json that speaks for files it does
// not describe. Any move that fails puts back what was moved.
function commit(state) {
  const { target } = state;
  const work = open(state);
  remove(path.join(work, ".tmp"));
  const fresh = NAMES.filter((name) => fs.existsSync(path.join(work, name)));
  if (!fs.existsSync(target)) {
    // The run made the folder: the hidden one becomes it.
    try {
      rename(work, target);
    } catch (err) {
      const { held, why } = moveError(state, err);
      throw new Error(`Could not put the new files in ${state.dir}: ${why}. Nothing was made${held ? "; close the file and run again" : ""}.`);
    }
    ended(state, true);
    sweep(path.dirname(target));
    return;
  }
  const before = earlier(target);
  const old = path.join(work, ".old");
  fs.mkdirSync(old);
  const moved = [];
  const move = (from, to, name) => {
    try {
      rename(from, to);
    } catch (err) {
      throw Object.assign(err, { file: name });
    }
    moved.push([from, to]);
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
    for (const [from, to] of moved.reverse()) {
      try {
        rename(to, from);
      } catch {
        stuck.push(to);
      }
    }
    const { held, why } = moveError(state, err);
    if (stuck.length) {
      // What could not be put back stays, in a folder no later run removes.
      ended(state, false);
      const kept = keep(state, stuck);
      throw new Error(`Could not put the new files in ${state.dir}: ${why}. Some of the earlier files could not be put back: they are in ${kept}.`);
    }
    throw new Error(`Could not put the new files in ${state.dir}: ${why}. ${state.dir} is as it was${held ? "; close the file and run again" : ""}.`);
  }
  ended(state, true);
  // The earlier files, and the hidden folder with them.
  remove(work);
  sweep(target);
  sweep(path.dirname(target));
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

module.exports = { OUTPUTS, NAMES, writable, claim, begin, stopAll, sweep, earlier };
