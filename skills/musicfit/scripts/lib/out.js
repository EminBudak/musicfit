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

// A folder itself, not a link to one.
const isFolder = (at) => {
  const s = lstat(at);
  return Boolean(s) && s.isDirectory();
};

// The text of a small file of its own, or null for anything else: a link
// is not followed out of its folder, and a pipe or a device is never opened
// to wait on, which would hold the run where no stop is heard.
function readSmall(at, most = 16 << 20) {
  const s = lstat(at);
  if (!s || !s.isFile() || s.size > most) return null;
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  let fd;
  try {
    fd = fs.openSync(at, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const t = fs.fstatSync(fd);
    if (!t.isFile() || t.size > most) return null;
    const bytes = Buffer.alloc(t.size);
    let got = 0;
    for (let n; got < bytes.length && (n = fs.readSync(fd, bytes, got, bytes.length - got, got)); ) got += n;
    return bytes.toString("utf8", 0, got);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The musicfit cues.json at `at`, or null.
function cuesAt(at) {
  try {
    const c = JSON.parse(readSmall(at));
    return c && typeof c === "object" && c.musicfit ? c : null;
  } catch {
    return null;
  }
}

// The musicfit cues.json in `dir`, or null.
const cuesIn = (dir) => cuesAt(path.join(dir, "cues.json"));

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
// still as that run wrote them. cues.json gives the size in bytes and the
// SHA-256 of each of the others (`sizes`, `sha256`), and its own SHA-256,
// of its text without that one, so a cues.json copied next to someone
// else's files, or a file changed since, cues.json itself included, never
// makes them musicfit's. FIT.md may have had its line ends turned into CR
// LF, as git does on Windows. A cues.json with no SHA-256s, as musicfit 0.1
// wrote it, is taken at its word for itself, and for the files it lists
// only while they look as 0.1 left them (see asLeft()). A folder or a link
// under one of those names is not the earlier run's.
function earlier(dir) {
  const c = cuesIn(dir);
  const names = listed(dir, c);
  const sha = c && c.sha256 && typeof c.sha256 === "object" ? c.sha256 : null;
  const sizes = c && c.sizes && typeof c.sizes === "object" ? c.sizes : {};
  const kept = (name) => {
    const at = path.join(dir, name);
    const s = lstat(at);
    if (!s || !s.isFile()) return false;
    if (!sha) return name === "cues.json" || asLeft(at, name, s, c, lstat(path.join(dir, "cues.json")));
    if (name === "cues.json") return sealed(c);
    if (typeof sha[name] !== "string") return false;
    if (s.size === sizes[name]) return digest(at) === sha[name];
    // FIT.md, its line ends turned into CR LF.
    if (name !== "FIT.md") return false;
    const text = readSmall(at, 1 << 20);
    return text !== null && text.includes("\r\n") && hash(text.replace(/\r\n/g, "\n")) === sha[name];
  };
  return NAMES.filter((name) => names.includes(name) && kept(name));
}

// Whether a file a cues.json of musicfit 0.1 lists looks as 0.1 left it.
// 0.1 kept no record of its files, but wrote them all within moments of
// cues.json, each of its own kind: fitted.wav and mix.wav 48 kHz stereo at
// 24 bits and cues.json's length long, seams.png a PNG that names musicfit
// as its maker, FIT.md headed with the track's name. A file of another
// kind, or one changed more than a minute before or after cues.json was
// written, is the user's. 0.1 wrote no video.mp4.
const MOMENTS = 60 * 1000;
function asLeft(at, name, s, c, cues) {
  if (!cues || Math.abs(s.mtimeMs - cues.mtimeMs) > MOMENTS) return false;
  if (name === "fitted.wav" || name === "mix.wav") {
    const wav = wavOf(at);
    return Boolean(wav) && wav.rate === 48000 && wav.channels === 2 && wav.bits === 24 && Math.abs(wav.frames - c.length * 48000) <= 25;
  }
  if (name === "seams.png") return pngMaker(at) === "musicfit";
  if (name === "FIT.md") {
    const head = readHead(at, 4096).toString("utf8");
    const title = `# ${c.track}`;
    return head.startsWith(title) && /^( fitted to |\r?\n)/.test(head.slice(title.length));
  }
  return false;
}

// The first bytes of a file of its own, read without following a link or
// waiting on a pipe; none for anything else.
function readHead(at, most) {
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  let fd;
  try {
    fd = fs.openSync(at, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return Buffer.alloc(0);
    const bytes = Buffer.alloc(most);
    return bytes.subarray(0, fs.readSync(fd, bytes, 0, most, 0));
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// A WAV file's rate, channels, bits and length in frames, from its chunks;
// null when it is not one.
function wavOf(at) {
  const b = readHead(at, 65536);
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") return null;
  let fmt = null;
  for (let p = 12; p + 8 <= b.length; ) {
    const id = b.toString("latin1", p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === "fmt " && size >= 16 && p + 24 <= b.length) fmt = { channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === "data") return fmt && fmt.channels && fmt.bits ? { ...fmt, frames: size / (fmt.channels * (fmt.bits / 8)) } : null;
    p += 8 + size + (size & 1);
  }
  return null;
}

// The Software text of a PNG, as musicfit 0.1 wrote it before the picture.
function pngMaker(at) {
  const b = readHead(at, 4096);
  if (b.length < 8 || !b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  for (let p = 8; p + 8 <= b.length; ) {
    const size = b.readUInt32BE(p);
    const type = b.toString("latin1", p + 4, p + 8);
    if (type === "IDAT" || p + 8 + size > b.length) return null;
    if (type === "tEXt") {
      const [key, value] = b.toString("latin1", p + 8, p + 8 + size).split("\0");
      if (key === "Software") return value;
    }
    p += 12 + size;
  }
  return null;
}

const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");

// cues.json as musicfit writes it.
const cuesText = (c) => JSON.stringify(c, null, 2) + "\n";

// Whether a cues.json is as musicfit wrote it: its SHA-256 is of the text
// it had before that entry was added, which reading it and writing it again
// gives back, whatever line ends it has now.
function sealed(c) {
  const own = c.sha256["cues.json"];
  if (typeof own !== "string") return false;
  const copy = JSON.parse(JSON.stringify(c));
  delete copy.sha256["cues.json"];
  return hash(cuesText(copy)) === own;
}

// A file's SHA-256, read a block at a time without following a link or
// waiting on a pipe; null when it is not a file. A file is read once: a
// later look finds it by what tells it from one that came in its place.
const digests = new Map();
function digest(at) {
  const id = identity(at);
  // By its full path: a run looks at its out folder as the user named it
  // and as the absolute path, and a long file takes a second to read.
  const key = path.resolve(at);
  const known = digests.get(key);
  if (id !== null && known && known.id === id) return known.hex;
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  let fd;
  try {
    fd = fs.openSync(at, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return null;
    const sum = crypto.createHash("sha256");
    const block = Buffer.allocUnsafe(1 << 20);
    for (let n; (n = fs.readSync(fd, block, 0, block.length, null)); ) sum.update(block.subarray(0, n));
    const hex = sum.digest("hex");
    digests.set(key, { id, hex });
    return hex;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The same, read without holding the main thread, which has to stay free
// to hear a stop: for the files a run has just written.
async function digestOf(at) {
  const sum = crypto.createHash("sha256");
  const handle = await fs.promises.open(at, "r");
  try {
    const block = Buffer.allocUnsafe(1 << 20);
    for (let n; (n = (await handle.read(block, 0, block.length, null)).bytesRead); ) sum.update(block.subarray(0, n));
  } finally {
    await handle.close();
  }
  return sum.digest("hex");
}

// Writes cues.json, last of the run's files: with the size in bytes and the
// SHA-256 of each file the run wrote beside it, and its own SHA-256, so a
// later run knows them for this run's only while they are as it wrote them
// (see earlier()).
async function record(run, c) {
  c.sizes = {};
  c.sha256 = {};
  for (const name of [c.file, c.mix, c.video && c.video.file, "seams.png", "FIT.md"].filter(Boolean)) {
    c.sizes[name] = fs.statSync(run.file(name)).size;
    c.sha256[name] = await digestOf(run.file(name));
  }
  c.sha256["cues.json"] = hash(cuesText(c));
  fs.writeFileSync(run.file("cues.json"), cuesText(c));
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
  undoKilled(path.resolve(dir));
  for (const name of writes) {
    const s = lstat(path.join(dir, name));
    if (s && s.isDirectory()) throw new Error(`${path.join(dir, name)} is a folder, and this run writes its ${name} there: move it, or give another --out`);
  }
  const ours = earlier(dir);
  const theirs = writes.filter((name) => isFile(path.join(dir, name)) && !ours.includes(name));
  // A file the cues.json there lists that is not as that run wrote it.
  const list = listed(dir);
  const changed = theirs.some((name) => list.includes(name));
  // A cues.json changed by hand vouches for nothing, and moved alone it
  // leaves the files it lists with no record: they go with it.
  if (theirs.includes("cues.json") && list.includes("cues.json")) {
    const beside = NAMES.filter((name) => name !== "cues.json" && list.includes(name) && isFile(path.join(dir, name)));
    if (beside.length) throw new Error(`${path.join(dir, "cues.json")} was changed since musicfit wrote it, so this run cannot vouch for ${and(beside)} beside it: move them with it, or give another --out`);
  }
  if (theirs.length === 1) throw new Error(`${path.join(dir, theirs[0])} is ${changed ? `not the ${theirs[0]} musicfit wrote there` : "a file no musicfit cues.json there lists"}, and this run would replace it: move it, or give another --out`);
  if (theirs.length) throw new Error(`${dir} holds ${and(theirs)}, which ${changed ? "are not the files musicfit wrote there" : "no musicfit cues.json there lists"}, and this run would replace them: move them, or give another --out`);
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
  try {
    return !lstat(at);
  } catch {
    return false;
  }
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
// both are in is made by the first of them. removes(writes) names the
// earlier run's files in `dir` that a run writing `writes` does not make
// again, for its reports to say, and those are the ones it removes: commit()
// puts the outputs in place and removes them, abort() leaves no trace. A run
// killed in that folder's commit since this run's claim() is undone first, so
// removes() never reads a folder left half moved.
function begin(dir) {
  const state = {
    dir,
    target: path.resolve(dir),
    work: null,
    made: [],
    ended: false,
    removing: null,
    file: (name) => path.join(open(state), name),
    scratch: (name) => path.join(open(state), ".tmp", name),
    removes: (writes) => {
      undoKilled(state.target);
      return (state.removing = earlier(state.target).filter((name) => !writes.includes(name)));
    },
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
    const why = ["ENOSPC", "EDQUOT"].includes(err.code) ? full(state, err.code) : `Cannot write to ${state.dir}: ${WHY[err.code] || err.message}`;
    throw told(new Error(`${why}${state.left ? `. ${asWas(state)}` : ""}`));
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
  const s = lstat(at);
  const text = readSmall(at, 4096);
  if (!s || text === null) return null;
  const [host, pid] = text.trim().split(" ");
  const named = Boolean(host) && Number(pid) > 0;
  const gone = named && host === os.hostname() && !running(Number(pid));
  const age = Date.now() - s.mtimeMs;
  return gone || age > LOCK_STALE || (!named && age > LOCK_BARE) ? text : null;
}

// Undoes what a run killed while it put its files in `target` left there.
function undoKilled(target) {
  const stale = staleLock(path.join(target, LOCK));
  if (stale !== null) takeOver(target, stale);
}

// A lock a killed run left is taken away, only while it is still the one
// found stale. A run killed in the moment it moved its files in (kill -9,
// or the system when memory runs out) left some of its new files in the out
// folder, and the earlier cues.json, with some earlier files, in its hidden
// folder's .old; its own cues.json, which goes in last, is still in that
// hidden folder. Under the lock, taken over, the out folder is put back as
// it was before that run: its new files go back to its hidden folder, which
// then goes, and the earlier files come back, cues.json last.
function takeOver(target, stale) {
  const at = path.join(target, LOCK);
  if (staleLock(at) !== stale) return;
  fs.rmSync(at, { force: true });
  const work = halfDone(target, Number(stale.trim().split(" ")[1]));
  if (!work) return;
  try {
    if (!lock(at)) return;
  } catch {
    return;
  }
  try {
    putBack(target, work);
  } finally {
    try {
      fs.unlinkSync(at);
    } catch {
      // Gone already.
    }
  }
}

// The hidden folder of the run `pid`, in the out folder or next to it, that
// still holds its cues.json: one killed before it had put all its files in.
// A link under such a name is no run's folder, and is never followed.
function halfDone(target, pid) {
  if (!(pid > 0)) return null;
  for (const home of [target, path.dirname(target)]) {
    let entries = [];
    try {
      entries = fs.readdirSync(home, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const m = PART.exec(entry.name);
      if (m && entry.isDirectory() && Number(m[1]) === pid && cuesAt(path.join(home, entry.name, "cues.json"))) return path.join(home, entry.name);
    }
  }
  return null;
}

// The moves that undo a commit cut short. A file in the out folder goes back
// only when it is that run's, as its cues.json records it, and an earlier
// file only to a place that is free; whatever cannot move stays where it is.
function putBack(target, work) {
  const fresh = isFolder(work) ? cuesAt(path.join(work, "cues.json")) : null;
  if (!fresh) return;
  const sha = fresh.sha256 && typeof fresh.sha256 === "object" ? fresh.sha256 : {};
  try {
    for (const name of NAMES.filter((n) => n !== "cues.json")) {
      const there = path.join(target, name);
      const s = lstat(there);
      if (s && s.isFile() && !lstat(path.join(work, name)) && typeof sha[name] === "string" && digest(there) === sha[name]) rename(there, path.join(work, name));
    }
    const old = path.join(work, ".old");
    const names = isFolder(old) ? fs.readdirSync(old) : [];
    let all = true;
    for (const name of [...names.filter((n) => n !== "cues.json"), ...names.filter((n) => n === "cues.json")]) {
      if (NAMES.includes(name) && !lstat(path.join(target, name))) rename(path.join(old, name), path.join(target, name));
      else all = false;
    }
    if (all) remove(work);
  } catch {
    // Left as far as it got; the run then refuses what is not musicfit's.
  }
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
  // The earlier files, and the hidden folder with them. The run has ended
  // well by now, and nothing from here on may say otherwise.
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
      takeOver(target, stale);
      continue;
    }
    // A folder or a pipe under the lock's name is no lock a run made, and
    // waiting does not make it one.
    const s = lstat(at);
    if (s && !s.isFile()) throw failed(`${path.join(state.dir, LOCK)} is not a file musicfit made, so this run cannot take its turn there: move it`);
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
// message says where each file is. Of the earlier files only those this run
// writes again, or said it removes, are moved: a file another run has added
// since the reports were written is no file of this run's to remove.
function swap(state) {
  const { target, work } = state;
  const fresh = NAMES.filter((name) => fs.existsSync(path.join(work, name)));
  const before = earlier(target).filter((name) => fresh.includes(name) || !state.removing || state.removing.includes(name));
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

// A full disk, in plain words. Where an earlier run's files are, they took
// room too: they stay until the new ones are in place.
function full(state, code) {
  const room = earlier(state.target).length ? ". The earlier files there stay until the new ones are in place, so the run needs room for both: free some space, or give another --out" : "";
  return `Cannot write to ${state.dir}: ${WHY[code]}${room}`;
}

// What a failure while the run made its files says, once abort() has taken
// them away: a full disk in plain words, a file by the name it would have
// in the out folder, not in the hidden folder, which goes with the run, and
// that hidden folder when it could not be removed. A message commit() wrote
// is given as it is.
function explain(state, err) {
  if (err.told) return err;
  const code = ["ENOSPC", "EDQUOT"].includes(err.code) ? err.code : fullDisk(err.stderr);
  let said = err;
  if (code) said = new Error(full(state, code));
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

// Whether a hidden folder is that of a run killed while it moved its files
// in: its commit had begun, as .old is made first, and had not ended, as its
// cues.json goes in last. The earlier files wait there, and only the next
// run in its own out folder knows where they belong (takeOver()).
const cutShort = (work) => isFolder(path.join(work, ".old")) && Boolean(lstat(path.join(work, "cues.json")));

// Removes the hidden folders of runs killed outright: their process is
// gone and nothing in them has changed for STALE. Nothing in one is put
// back: the run that ends well here has made the folder what it should be.
// One whose earlier files a message sent the user to keeps them, and so does
// one cut short while it moved its files in, which this run may not be the
// one to put back. A folder this user may not look into stays too: a run
// that has ended well does not fail over another run's leftovers.
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
    try {
      if (running(Number(m[1])) || Date.now() - touched(at) < STALE || lstat(path.join(at, KEPT)) || cutShort(at)) continue;
      remove(at);
    } catch {
      // Left where it is.
    }
  }
}

module.exports = { OUTPUTS, NAMES, LOCK, writable, claim, begin, stopAll, sweep, earlier, listed, sameFile, cuesAt, record };
