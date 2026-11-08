"use strict";

// A stop (Ctrl-C, or the signal a supervisor sends) is heard only while the
// main thread is free, and going through every sample of a long sound takes
// seconds. So the loops over the samples go through them in blocks of half
// a million and give way before each, and a stop is heard within a moment
// at any point of a run. Each block is done in one plain call, which runs as
// fast as the loop did in one go.

const CHUNK = 1 << 19;
const breathe = () => new Promise((resolve) => setImmediate(resolve));

// body(from, to) for each block of [start, end), `size` long, first to
// last. What a body carries from one block to the next it reads into its
// own variables at the start of the block and writes back at the end,
// never in its loop.
async function blocks(start, end, body, size = CHUNK) {
  for (let from = start; from < end; from += size) {
    await breathe();
    body(from, Math.min(end, from + size));
  }
}

module.exports = { CHUNK, breathe, blocks };
