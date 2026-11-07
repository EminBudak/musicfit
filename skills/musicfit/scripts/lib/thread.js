"use strict";

// analyze() in a thread of its own. A long track takes seconds to analyse,
// and a stop (Ctrl-C, or the signal a supervisor sends) is heard only while
// the main thread is free, so the main thread waits for this one instead of
// doing the work. The bars' distance is a function, which a thread cannot
// hand back, so it is made again from the bars' features, the same way.

const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { analyze, barDistance } = require("./analyze");

if (!isMainThread && workerData && workerData.musicfit === "analyze") {
  const result = analyze(workerData.samples, workerData.options);
  delete result.distance;
  parentPort.postMessage(result);
}

// The samples are handed over, not copied: the caller cannot use them after.
function analyzeInThread(samples, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { musicfit: "analyze", samples, options }, transferList: [samples.buffer] });
    let done = false;
    worker.once("message", (result) => {
      done = true;
      if (result.barFeatures) result.distance = barDistance(result.barFeatures);
      resolve(result);
    });
    worker.once("error", (err) => {
      done = true;
      reject(err);
    });
    worker.once("exit", (code) => {
      if (!done) reject(new Error(`The analysis of the track stopped (exit ${code})`));
    });
  });
}

module.exports = { analyzeInThread };
