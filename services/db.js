// services/db.js — Supabase client helpers (service-role first, safe fallbacks)
// EMMA PRO MAX — FINAL
'use strict';

const { createClient } = require('@supabase/supabase-js');

/* ─────────────────────────── Env & Client ─────────────────────────── */

const SUPABASE_URL =
  (process.env.SUPABASE_URL || '').trim();

const SUPABASE_KEY =
  (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim() || // preferred for server writes (bypasses RLS)
  (process.env.SUPABASE_SERVICE_KEY || '').trim() ||      // your current key (may be anon)
  (process.env.SUPABASE_KEY || '').trim();                // fallback if named differently

const TIMEOUT_MS = Number(process.env.DB_TIMEOUT_MS || 10000);
const RETRY_MAX  = Math.max(1, Number(process.env.DB_RETRY_MAX || 3));
const RETRY_BASE = Math.max(100, Number(process.env.DB_RETRY_BASE_MS || 250)); // backoff base

let client = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { 'X-Client-Info': 'gg-agent/db:v1' }
    }
  });
  console.log('[db] Supabase: ON');
} else {
  console.warn('[db] Supabase: OFF (missing SUPABASE_URL or key)');
}

/* ─────────────────────────── Utilities ─────────────────────────── */

const on = () => !!client;

/** Promise timeout wrapper */
function withTimeout(promise, ms, label = 'db-op') {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`[db] timeout ${label} after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/** Simple retry with exponential backoff */
async function retry(fn, label) {
  let attempt = 0, lastErr = null;
  while (attempt < RETRY_MAX) {
    try {
      return await withTimeout(fn(), TIMEOUT_MS, label);
    } catch (e) {
      lastErr = e;
      const wait = RETRY_BASE * Math.pow(2, attempt);
      if (attempt < RETRY_MAX - 1) {
        console.warn(`[db] ${label} failed (attempt ${attempt + 1}/${RETRY_MAX}): ${e.message}. Retrying in ${wait}ms`);
        await new Promise(res => setTimeout(res, wait));
      }
    }
    attempt++;
  }
  console.error(`[db] ${label} failed permanently:`, lastErr?.message || lastErr);
  throw lastErr;
}

/** Shallow clone + stamp updated_at if not provided */
function withUpdatedAt(obj) {
  const copy = { ...obj };
  if (!('updated_at' in copy)) copy.updated_at = new Date().toISOString();
  return copy;
}

/* ─────────────────────────── Core Ops ─────────────────────────── */
/**
 * Insert one or many rows.
 * @param {string} table
 * @param {Object|Object[]} rows
 * @returns {Promise<{data:any,error:any,disabled?:boolean}>}
 */
async function insert(table, rows) {
  if (!client) return { data: null, error: null, disabled: true };
  const payload = Array.isArray(rows) ? rows.map(withUpdatedAt) : withUpdatedAt(rows);
  const run = () => client.from(table).insert(payload).select();
  try {
    const { data, error } = await retry(run, `insert:${table}`);
    if (error) console.error('[db] insert error', error);
    return { data, error };
  } catch (e) {
    return { data: null, error: e };
  }
}

/**
 * Upsert by conflict target (e.g., 'ref' or '(ref,chat_id)').
 * @param {string} table
 * @param {Object|Object[]} rows
 * @param {string} conflict
 */
async function upsert(table, rows, conflict) {
  if (!client) return { data: null, error: null, disabled: true };
  const payload = Array.isArray(rows) ? rows.map(withUpdatedAt) : withUpdatedAt(rows);
  const opts = conflict ? { onConflict: conflict } : undefined;
  const run = () => client.from(table).upsert(payload, opts).select();
  try {
    const { data, error } = await retry(run, `upsert:${table}`);
    if (error) console.error('[db] upsert error', error);
    return { data, error };
  } catch (e) {
    return { data: null, error: e };
  }
}

/**
 * Update rows matching a simple equality match object.
 * @param {string} table
 * @param {Object} match e.g. { ref: 'GG-...' }
 * @param {Object} patchObj fields to update
 */
async function patch(table, match, patchObj) {
  if (!client) return { data: null, error: null, disabled: true };
  const run = () => client.from(table).update(withUpdatedAt(patchObj)).match(match).select();
  try {
    const { data, error } = await retry(run, `patch:${table}`);
    if (error) console.error('[db] patch error', error);
    return { data, error };
  } catch (e) {
    return { data: null, error: e };
  }
}

/**
 * Select all rows (ordered newest first).
 * @param {string} table
 */
async function selectAll(table) {
  if (!client) return { data: [], error: null, disabled: true };
  const run = () => client.from(table).select('*').order('created_at', { ascending: false });
  try {
    const { data, error } = await retry(run, `selectAll:${table}`);
    if (error) console.error('[db] selectAll error', error);
    return { data, error };
  } catch (e) {
    return { data: [], error: e };
  }
}

/**
 * Select rows created since ISO time (inclusive).
 * @param {string} table
 * @param {string} sinceISO
 */
async function selectSince(table, sinceISO) {
  if (!client) return { data: [], error: null, disabled: true };
  const run = () => client.from(table).select('*').gte('created_at', sinceISO).order('created_at', { ascending: false });
  try {
    const { data, error } = await retry(run, `selectSince:${table}`);
    if (error) console.error('[db] selectSince error', error);
    return { data, error };
  } catch (e) {
    return { data: [], error: e };
  }
}

/**
 * Delete all rows (safeguarded).
 * @param {string} table
 */
async function delAll(table) {
  if (!client) return { data: null, error: null, disabled: true };
  const run = () => client.from(table).delete().neq('order_id', '__never__'); // guard against full table with impossible filter
  try {
    const { data, error } = await retry(run, `delAll:${table}`);
    if (error) console.error('[db] deleteAll error', error);
    return { data, error };
  } catch (e) {
    return { data: null, error: e };
  }
}

/* ─────────────────────────── Exports ─────────────────────────── */

module.exports = {
  client,
  on,
  insert,
  upsert,
  patch,
  selectAll,
  selectSince,
  delAll,
};
