// core/session.js — central session/state store for GreenGold EMMA
'use strict';

const fs   = require('fs');
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

// In-memory stores
const sessions = new Map(); // uid -> session object
const refs     = new Map(); // ref -> uid

const now = () => Date.now();

// ---------------- core API ----------------
function genRef() {
  let r;
  do { r = 'GG_' + Math.random().toString(36).slice(2, 6).toUpperCase(); }
  while (refs.has(r));
  return r;
}

function setSession(uid, s) {
  // Keep existing pendingNewSummary/supersededRefs if caller forgot to copy
  const existing = sessions.get(uid) || {};
  const merged = { ...s };

  if (existing.pendingNewSummary && !merged.pendingNewSummary) {
    merged.pendingNewSummary = existing.pendingNewSummary;
  }
  if (Array.isArray(existing.supersededRefs) && !Array.isArray(merged.supersededRefs)) {
    merged.supersededRefs = existing.supersededRefs.slice();
  }

  // Always stamp createdAt if missing
  if (!merged.createdAt) merged.createdAt = now();

  sessions.set(uid, merged);
  if (merged && merged.ref) refs.set(merged.ref, uid);
  // convenience: remember customerId if present
  if (merged._customerId == null && existing._customerId != null) {
    merged._customerId = existing._customerId;
  }
}

function updateSession(uid, mutator) {
  const cur = sessions.get(uid);
  if (!cur) return null;
  const draft = { ...cur };
  mutator(draft);
  setSession(uid, draft);
  return sessions.get(uid);
}

function getSession(uid) {
  return sessions.get(uid);
}

function deleteSession(uid) {
  const s = sessions.get(uid);
  if (s?.ref) refs.delete(s.ref);
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

// --------------- helpers for new flow ---------------
function setPendingNewSummary(uid, text) {
  const s = sessions.get(uid);
  if (!s) return null;
  s.pendingNewSummary = String(text || '');
  return s.pendingNewSummary;
}

function consumePendingNewSummary(uid) {
  const s = sessions.get(uid);
  if (!s) return '';
  const val = s.pendingNewSummary || '';
  delete s.pendingNewSummary;
  return val;
}

function addSupersededRef(uid, oldRef) {
  const s = sessions.get(uid);
  if (!s) return 0;
  if (!Array.isArray(s.supersededRefs)) s.supersededRefs = [];
  if (oldRef) s.supersededRefs.push(String(oldRef));
  return s.supersededRefs.length;
}

function clearSupersededRefs(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  delete s.supersededRefs;
}

// Optional cleaner (not exported): can be called by a cron/timer if desired
function _gcExpired() {
  const ttlMs = Number(TTL_MINUTES) * 60 * 1000;
  const cutoff = now() - ttlMs;
  for (const [uid, s] of sessions.entries()) {
    if (!s?.createdAt || s.createdAt < cutoff) {
      if (s?.ref) refs.delete(s.ref);
      sessions.delete(uid);
    }
  }
}

// ---------------- exports ----------------
module.exports = {
  genRef,
  setSession,
  updateSession,
  getSession,
  deleteSession,
  setRef,
  deleteRef,
  getSessionByRef,
  ttlExpired,
  // flow helpers
  setPendingNewSummary,
  consumePendingNewSummary,
  addSupersededRef,
  clearSupersededRefs,
  // internal util
  _gcExpired
};
