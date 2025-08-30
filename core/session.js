// core/session.js — central session/state store for GreenGold EMMA
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FEATURES_FILE = path.join(ROOT, 'features.json');

function safeReadJSON(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

let TTL_MINUTES = 90;
(function initTtl() {
  const f = safeReadJSON(FEATURES_FILE, {});
  const v = Number((f.flows && f.flows.sessionTtlMinutes) || 90);
  if (Number.isFinite(v) && v > 0) TTL_MINUTES = v;
})();

const sessions = new Map(); // uid -> session object
const refs     = new Map(); // ref -> uid

function now() { return Date.now(); }

function genRef() {
  let r;
  do { r = 'GG_' + Math.random().toString(36).slice(2, 6).toUpperCase(); }
  while (refs.has(r));
  return r;
}

function setSession(uid, s) {
  sessions.set(uid, s);
  if (s && s.ref) refs.set(s.ref, uid);
}

function getSession(uid) {
  return sessions.get(uid);
}

function deleteSession(uid) {
  const s = sessions.get(uid);
  if (s && s.ref) refs.delete(s.ref);
  sessions.delete(uid);
}

function setRef(ref, uid) {
  refs.set(ref, uid);
}

function deleteRef(ref) {
  refs.delete(ref);
}

function getSessionByRef(ref) {
  const uid = refs.get(ref);
  return uid ? sessions.get(uid) : null;
}

function ttlExpired(s) {
  const ttlMs = Number(TTL_MINUTES) * 60 * 1000;
  return !s || !s.createdAt || ((now() - s.createdAt) > ttlMs);
}

module.exports = {
  genRef,
  setSession,
  getSession,
  deleteSession,
  setRef,
  deleteRef,
  getSessionByRef,
  ttlExpired,
};
