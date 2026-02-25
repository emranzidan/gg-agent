// services/persistDisk.js — disk read/write with atomic writes + single-process locking
'use strict';

const fs = require('fs');
const path = require('path');

function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function readJsonSafeSync(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// Atomic write: write temp then rename
function writeJsonAtomicSync(file, obj) {
  const dir = path.dirname(file);
  ensureDirSync(dir);

  const tmp = `${file}.tmp.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const data = JSON.stringify(obj, null, 2);

  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

// Simple in-process lock (serializes all writes)
let _queue = Promise.resolve();

function withLock(fn) {
  _queue = _queue.then(async () => {
    try { return await fn(); } catch (e) { throw e; }
  });
  return _queue;
}

module.exports = {
  ensureDirSync,
  readJsonSafeSync,
  writeJsonAtomicSync,
  withLock,
};
