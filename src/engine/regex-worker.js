'use strict';

const { parentPort, workerData } = require('node:worker_threads');

const { pattern, flags, value } = workerData;
parentPort.postMessage({ matched: new RegExp(pattern, flags).test(value) });
