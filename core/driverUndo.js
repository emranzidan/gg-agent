'use strict';

// In-memory undo windows keyed by "ref:action"
const windows = new Map();
const k = (ref, action) => `${ref}:${action}`;

function open(ref, action, driverId, seconds = 30) {
  const key = k(ref, action);
  // clear any previous window for same ref+action
  const prev = windows.get(key);
  if (prev?.timer) clearTimeout(prev.timer);
  const expiresAt = Date.now() + seconds * 1000;
  const timer = setTimeout(() => windows.delete(key), seconds * 1000);
  windows.set(key, { driverId: Number(driverId), expiresAt, timer });
  return { ref, action, driverId, expiresAt };
}

function isActive(ref, action) {
  const w = windows.get(k(ref, action));
  if (!w) return false;
  if (Date.now() > w.expiresAt) {
    if (w.timer) clearTimeout(w.timer);
    windows.delete(k(ref, action));
    return false;
  }
  return true;
}

function consume(ref, action, driverId) {
  const key = k(ref, action);
  const w = windows.get(key);
  if (!w) return { ok: false, reason: 'expired' };
  if (Date.now() > w.expiresAt) {
    if (w.timer) clearTimeout(w.timer);
    windows.delete(key);
    return { ok: false, reason: 'expired' };
  }
  if (Number(driverId) !== Number(w.driverId)) return { ok: false, reason: 'not_owner' };
  if (w.timer) clearTimeout(w.timer);
  windows.delete(key);
  return { ok: true };
}

function cancel(ref, action) {
  const key = k(ref, action);
  const w = windows.get(key);
  if (w?.timer) clearTimeout(w.timer);
  windows.delete(key);
}

module.exports = { open, isActive, consume, cancel };
