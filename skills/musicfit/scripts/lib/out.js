"use strict";

// The out folder. A run makes its files in a hidden folder and puts them in
// place only once it has ended well. The hidden folder is made when the run
// writes its first file, after the track is read: inside the out folder when
// that is there, else next to it, so it is on the same disk and gets the
// same mode and default ACL. A run that fails, is refused or is stopped
// leaves the out folder as it was and adds nothing to it. A run that ends
// well moves the earlier run's files aside, moves its own in, then removes
// the earlier ones, so at no moment are both gone. The earlier run's files
// are the ones its cues.json lists, while they are as it wrote them; any
// other file under one of musicfit's names is someone else's, and stops a
// run that would write over it before any work.

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

// The musicfit cues.json in `dir`, or null.
function cuesIn(dir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, "cues.json"), "utf8"));
    return c && typeof c === "object" && c.musicfit ? c : null;
  } catch {
    return null;
  }
}

// The files a musicfit run wrote in `dir`, as its cues.json lists them:
// cues.json, seams.png and FIT.md always, fitted.wav for a fit, mix.wav
// with a voice and video.mp4 with a video. None when no cues.json there is
// musicfit's.
function listed(dir, c = cuesIn(dir)) {
  if (!c) return [];
  const names = ["cues.json", "seams.png", "FIT.md"];
  if (c.file === "fitted.wav") names.push("fitted.wav");
  if (c.mix === "mix.wav") names.push("mix.wav");
  if (c.video && c.video.file === VIDEO) names.push(VIDEO);
  return names;
}

// The earlier run's files in `dir`: those its cues.json lists that are
// still as that run wrote them. cues.json gives the size in bytes of each
// of the others under `sizes`, and video.mp4 has to carry musicfit's mark
// too, so a cues.json copied next to someone else's files, or a file
// changed since, never makes them musicfit's. FIT.md may have had its line
// ends turned into CR LF, as git does on Windows. A cues.json with no
// sizes, as musicfit 0.1 wrote it, is taken at its word for the names 0.1
// wrote; 0.1 wrote no video.mp4. A folder or a link under one of those
// names is not the earlier run's.
function earlier(dir) {
  const c = cuesIn(dir);
  const names = listed(dir, c);
  const sizes = c && c.sizes && typeof c.sizes === "object" ? c.sizes : null;
  const kept = (name) => {
    const at = path.join(dir, name);
    const s = lstat(at);
    if (!s || !s.isFile()) return false;
    if (name === "cues.json") return true;
    if (!sizes) return name !== VIDEO;
    if (name === "FIT.md" && s.size > sizes[name] && s.size < 1 << 20) return s.size - crlf(at) === sizes[name];
    return s.size === sizes[name] && (name !== VIDEO || require("./video").marked(at));
  };
  return NAMES.filter((name) => names.includes(name) && kept(name));
}

// How many line ends of a text file are CR LF.
function crlf(at) {
  let n = 0;
  try {
    const bytes = fs.readFileSync(at);
    for (let i = 1; i < bytes.length; i++) if (bytes[i] === 10 && bytes[i - 1] === 13) n++;
  } catch {
    // Read as none.
  }
  return n;
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
// or a file that is not the earlier run's as it wrote it, and no input is
// a file this run replaces or removes once it ends well.
function claim(dir, writes, inputs = []) {
  writable(dir);
  if (!fs.existsSync(dir)) return;
  for (const name of writes) {
    const s = lstat(path.join(dir, name));
    if (s && s.isDirectory()) throw new Error(`${path.join(dir, name)} is a folder, and this run writes its ${name} there: move it, or give another --out`);
  }
  const ours = earlier(dir);
  const theirs = writes.filter((name) => isFile(path.join(dir, name)) && !ours.includes(name));
  // A file the cues.json there lists that is not as that run wrote it.
  const changed = theirs.some((name) => listed(dir).includes(name));
  if (theirs.length === 1) throw new Error(`${path.join(dir, theirs[0])} is not ${changed ? `the ${theirs[0]} musicfit wrote there` : "a file musicfit wrote"}, and this run would replace it: move it, or give another --out`);
  if (theirs.length) throw new Error(`${dir} holds ${and(theirs)}, which ${changed ? "are not the files musicfit wrote there" : "musicfit did not write"}, and this run would replace them: move them, or give another --out`);
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

// Removes a file or a folder with all it holds. Returns whether it is gone:
// a file held open (on Windows), or a folder that may not be changed, keeps
// it, and the run says so.
function remove(at) {
  try {
    fs.rmSync(at, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Told by what is left.
  }
  return !lstat(at);
}

// A path in the out folder or next to it, written from the out folder as
// the user named it.
function shown(state, at) {
  return path.join(path.dirname(at) === state.target ? state.dir : path.dirname(state.dir), path.basename(at));
}

// What a run that did not end well says of its out folder once it has
// taken its own files away: as it was, or as it was but for its hidden
// folder, when that could not be removed.
function asWas(state) {
  if (!state.left) return `${state.dir} is as it was`;
  return `${state.dir} is as it was but for the hidden folder ${shown(state, state.left)}, which could not be removed; ${sweeps(state)}`;
}

const sweeps = (state) => `a later run that ends well in ${state.dir} removes it once it is ${STALE / 60000} minutes old`;

// An error whose message is the one to give the user as it is.
const told = (err) => Object.assign(err, { told: true });

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
// both are in is made by the first of them. earlier() names the earlier
// run's files in `dir` as they are now, commit() puts the outputs in place
// and removes those, abort() leaves no trace.
function begin(dir) {
  const state = {
    dir,
    target: path.resolve(dir),
    work: null,
    made: [],
    ended: false,
    file: (name) => path.join(open(state), name),
    scratch: (name) => path.join(open(state), ".tmp", name),
    earlier: () => earlier(state.target),
    commit: () => commit(state),
    abort: () => abort(state),
    explain: (err) => explain(state, err),
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
    if (state.work && !remove(state.work)) state.left = state.work;
    state.work = null;
    unmake(state.made);
    state.made = [];
    throw told(new Error(`Cannot write to ${state.dir}: ${WHY[err.code] || err.message}${state.left ? `. ${asWas(state)}` : ""}`));
  }
  return work;
}

function ended(state, well) {
  state.ended = true;
  live.delete(state);
  if (well) unfinished.delete(state);
}

// What a failed move says: the file it was, or the folder; a full disk in
// plain words; and Node's words without the paths it adds, which name the
// hidden folder.
function moveError(state, err) {
  const name = err.file ? path.join(state.dir, err.file) : state.dir;
  const held = ["EBUSY", "EPERM", "EACCES"].includes(err.code);
  if (held) return { held, why: `${name} is held open by another program, or may not be changed (${err.code})` };
  if (WHY[err.code]) return { held, why: WHY[err.code] };
  return { held, why: err.file ? `${name}: ${plainly(err)}` : plainly(err) };
}

// An error in plain words: a full disk and the like as WHY says them, and
// Node's own words without the paths it adds.
function plainly(err) {
  if (WHY[err.code]) return WHY[err.code];
  return err.syscall ? err.message.replace(new RegExp(`, ${err.syscall} '[\\s\\S]*$`), "") : err.message;
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

// Puts the run's files in place. A commit that fails says so once the run's
// own files are gone again, so its message can say what is left.
async function commit(state) {
  try {
    await place(state);
  } catch (err) {
    throw settled(state, err);
  }
  // The earlier files, and the hidden folder with them.
  remove(state.work);
  sweep(state.target);
  sweep(path.dirname(state.target));
}

// Why a commit could not put the files in place, as `reason` to go after
// "Could not put the new files in <dir>: ", and what to do about it.
const failed = (reason, advice = null) => Object.assign(new Error(reason), { reason, advice });

// The message of a commit that failed. One that left files where they do
// not belong has said so itself; any other has put every earlier file
// back, and the run's own files go now.
function settled(state, err) {
  if (err.told) return err;
  abort(state);
  if (err.stopped) return told(new Error(`stopped, so ${asWas(state)}`));
  const reason = err.reason || plainly(err);
  return told(new Error(`Could not put the new files in ${state.dir}: ${reason}. ${asWas(state)}${err.advice ? `; ${err.advice}` : ""}.`));
}

// Two runs that share an out folder take turns: each holds the lock while
// it moves its files, and waits while another holds it. The moves
// themselves are synchronous, so no signal handler runs in the middle of
// them.
async function place(state) {
  const { target } = state;
  open(state);
  remove(path.join(state.work, ".tmp"));
  const at = path.join(target, LOCK);
  const started = Date.now();
  for (;;) {
    if (state.ended) throw Object.assign(new Error("stopped"), { stopped: true });
    // The out folder, made now when the run is the first to write there.
    if (!fs.existsSync(target)) {
      try {
        fs.mkdirSync(target);
        state.made.unshift(target);
      } catch (err) {
        if (err.code !== "EEXIST") throw failed(plainly(err));
      }
    }
    let held = false;
    try {
      held = lock(at);
    } catch (err) {
      if (err.code !== "ENOENT") throw failed(plainly(err));
      // A link to a folder that is not there, made while the run worked:
      // no waiting makes it one.
      const s = lstat(target);
      if (s && s.isSymbolicLink() && !fs.existsSync(target)) throw failed(`it is a link to ${fs.readlinkSync(target)}, which is not there`);
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
      return;
    }
    const stale = staleLock(at);
    if (stale !== null) {
      // Taken away only while it is still the one found stale.
      if (staleLock(at) === stale) fs.rmSync(at, { force: true });
      continue;
    }
    if (Date.now() - started > LOCK_WAIT) throw failed(`another musicfit run has been putting its files there for ${LOCK_WAIT / 1000} s`);
    await pause(25);
  }
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
// each file only while it is still the one this run moved: a new file goes
// back to the hidden folder, or is removed when it cannot go, and an
// earlier file goes back to its place when that is free. An earlier file
// that cannot go back waits in a folder no later run removes, and the
// message says where each file is.
function swap(state) {
  const { target, work } = state;
  const fresh = NAMES.filter((name) => fs.existsSync(path.join(work, name)));
  const before = earlier(target);
  const old = path.join(work, ".old");
  fs.mkdirSync(old, { recursive: true });
  const moved = [];
  const move = (from, to, name, fresh) => {
    try {
      rename(from, to);
    } catch (err) {
      throw Object.assign(err, { file: name });
    }
    moved.push({ from, to, name, fresh, id: identity(to) });
  };
  const aside = (name) => {
    if (before.includes(name)) move(path.join(target, name), path.join(old, name), name, false);
  };
  const into = (name) => {
    if (!fresh.includes(name)) return;
    if (lstat(path.join(target, name))) throw Object.assign(new Error("a file came there while the run worked"), { file: name });
    move(path.join(work, name), path.join(target, name), name, true);
  };
  try {
    aside("cues.json");
    for (const name of NAMES.filter((n) => n !== "cues.json")) {
      aside(name);
      into(name);
    }
    into("cues.json");
  } catch (err) {
    // The earlier files that stay in the hidden folder, and the new ones
    // that stay in the out folder.
    const earlierStuck = [];
    const newStuck = [];
    for (const m of moved.reverse()) {
      // A file that is no longer the one this run moved is not its own.
      if (m.id === null || identity(m.to) !== m.id) continue;
      try {
        if (lstat(m.from)) throw new Error("its place is taken");
        rename(m.to, m.from);
      } catch {
        if (!m.fresh) earlierStuck.push(m.name);
        else {
          try {
            fs.unlinkSync(m.to);
          } catch {
            newStuck.push(m.name);
          }
        }
      }
    }
    const { held, why } = moveError(state, err);
    if (earlierStuck.length || newStuck.length) {
      ended(state, false);
      const it = (names) => (names.length === 1 ? "it is" : "they are");
      let rest = "";
      if (earlierStuck.length) rest += ` The earlier ${and(earlierStuck)} could not be put back: ${it(earlierStuck)} in ${path.join(keep(state, earlierStuck, newStuck), ".old")}.`;
      // Only a folder that keeps earlier files stays: with none, the hidden
      // folder goes, and the new files moved back into it.
      else if (!remove(state.work)) state.left = state.work;
      unmake(state.made);
      if (newStuck.length) rest += ` The new ${and(newStuck)} could not be taken out again, so in ${state.dir} ${it(newStuck)} this run's.`;
      if (state.left) rest += ` The hidden folder ${shown(state, state.left)} could not be removed; ${sweeps(state)}.`;
      throw told(new Error(`Could not put the new files in ${state.dir}: ${why}.${rest}`));
    }
    throw failed(why, held ? "close the file and run again" : null);
  }
  ended(state, true);
}

// The hidden folder of a commit that could not put every earlier file
// back, under a name that is not hidden, with a note of what is in it and
// where each file belongs. The note also tells sweep() to leave the folder
// alone when it could not be renamed.
const KEPT = "musicfit-kept.txt";

function keep(state, earlierStuck, newStuck) {
  // Only the earlier files are kept: the new ones moved back go.
  try {
    for (const entry of fs.readdirSync(state.work)) if (entry !== ".old") remove(path.join(state.work, entry));
  } catch {
    // Kept along with them.
  }
  const note = path.join(state.work, KEPT);
  const lines = [
    `A musicfit run could not put its new files in ${state.dir}, nor every earlier file back. These earlier files are in .old here:`,
    ...earlierStuck.map((name) => `  .old/${name}, which belongs in ${state.dir} as ${name}`),
    ...(newStuck.length ? [`In ${state.dir}, ${and(newStuck)} ${newStuck.length === 1 ? "is" : "are"} that run's new ${newStuck.length === 1 ? "file" : "files"}: remove ${newStuck.length === 1 ? "it" : "them"} first.`] : []),
    `Move the earlier files back into ${state.dir}, then remove this folder. musicfit leaves it alone.`,
  ];
  try {
    fs.writeFileSync(note, lines.join("\n") + "\n");
  } catch {
    // A full disk: the note is there even when its words are not.
    try {
      fs.closeSync(fs.openSync(note, "a"));
    } catch {
      // Nothing more can be done here.
    }
  }
  const to = path.join(path.dirname(state.work), path.basename(state.work).replace(/^\.musicfit-part-/, "musicfit-kept-"));
  try {
    rename(state.work, to);
    return to;
  } catch {
    return state.work;
  }
}

// What a failure while the run made its files says, once abort() has taken
// them away: a full disk in plain words, a file by the name it would have
// in the out folder, not in the hidden folder, which goes with the run, and
// that hidden folder when it could not be removed. A message commit() wrote
// is given as it is.
function explain(state, err) {
  if (err.told) return err;
  const full = ["ENOSPC", "EDQUOT"].includes(err.code) ? err.code : fullDisk(err.stderr);
  let said = err;
  if (full) said = new Error(`Cannot write to ${state.dir}: ${WHY[full]}`);
  else if (state.work && WHY[err.code] && typeof err.path === "string" && err.path.startsWith(state.work + path.sep)) said = new Error(`Cannot write to ${state.dir}: ${WHY[err.code]}`);
  else if (state.work && err.message.includes(state.work)) err.message = err.message.split(path.join(state.work, ".tmp") + path.sep).join(state.dir + path.sep).split(state.work + path.sep).join(state.dir + path.sep);
  if (state.left) said.message = `${said.message.replace(/\.$/, "")}. ${asWas(state)}.`;
  return said;
}

// A full disk as ffmpeg says it: one of its own lines, which start at the
// left edge (a file's tags are indented), ending in the system's words for
// it. A file's name in a message is never read for them.
function fullDisk(stderr) {
  for (const line of String(stderr || "").split(/\r?\n|\r/)) {
    if (/^\s/.test(line)) continue;
    if (/: No space left on device\s*$/.test(line)) return "ENOSPC";
    if (/: Disk quota exceeded\s*$/.test(line)) return "EDQUOT";
  }
  return null;
}

// Takes away what a run that has not ended made: its hidden folder and the
// folders it made for it. Returns the hidden folder when it could not be
// removed, and asWas() says so.
function abort(state) {
  if (!state.ended) {
    ended(state, false);
    if (state.work && !remove(state.work)) state.left = state.work;
    unmake(state.made);
  }
  return state.left || null;
}

// Stops every run of this process that has not ended: their ffmpeg, then
// their hidden folders. Returns what each run that began and did not end
// well, these and any that failed a moment before, says of its out folder.
function stopAll() {
  require("./audio").stopChildren();
  for (const state of [...live]) abort(state);
  return [...unfinished].map(asWas);
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
// One whose earlier files a message sent the user to keeps them.
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
    if (running(Number(m[1])) || Date.now() - touched(at) < STALE || lstat(path.join(at, KEPT))) continue;
    remove(at);
  }
}

module.exports = { OUTPUTS, NAMES, LOCK, writable, claim, begin, stopAll, sweep, earlier, listed, sameFile };
