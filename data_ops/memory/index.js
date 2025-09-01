// data_ops/memory/index.js
// Supabase-backed persistence with safe merge + local JSON fallback.
// Exports: persist(orderObj, phase, { tz?, createdAtMs? }), exportCsv(range), pruneOrders(range)
//
// Range examples (for exportCsv / pruneOrders):
//   "last-month"              -> [start of previous month, start of this month)
//   "before-this-month"       -> created_at < start of this month
//   "older 90"                -> created_at < now - 90 days
//   "before 2025-09-01"       -> created_at < 2025-09-01T00:00:00Z
//
// Notes:
//  - No top-level bot usage.
//  - Works even if Supabase is not configured (falls back to local JSON file).

'use strict';

const fs   = require('fs');
const path = require('path');

// ───────────────────────────────────────────────────────────────────────────────
// Supabase client (optional)
let createClient = null;
try {
  ({ createClient } = require('@supabase/supabase-js'));
} catch (_) {
  // Package not installed — we'll operate purely on local fallback.
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  '';

const TABLE = process.env.SUPABASE_TABLE || 'orders';

const HAS_SB = !!(createClient && SUPABASE_URL && SUPABASE_KEY);
const sb     = HAS_SB ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// ───────────────────────────────────────────────────────────────────────────────
// Local JSON fallback
const FALLBACK_FILE = path.join(__dirname, 'local_orders.json');
function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function readLocal() {
  try {
    if (!fs.existsSync(FALLBACK_FILE)) return [];
    const raw = fs.readFileSync(FALLBACK_FILE, 'utf8');
    return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function writeLocal(arr) {
  try {
    ensureDirFor(FALLBACK_FILE);
    fs.writeFileSync(FALLBACK_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) {
    console.error('local fallback write error:', e.message);
  }
}

// CSV export target
const EXPORT_DIR = path.join(__dirname, 'exports');
function ensureExportDir() {
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

// ───────────────────────────────────────────────────────────────────────────────
// Time helpers
function toIsoDateStart(d) {
  // Normalize to 00:00:00Z of given Date (which should already be in UTC)
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
  return t.toISOString();
}
function startOfThisMonthUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}
function startOfPrevMonthUTC() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const prev = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  return prev;
}
function daysAgoUTC(n) {
  const now = new Date();
  const t = new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 0, 0, 0, 0));
}

// Parse a human-ish range string into { gteIso?, ltIso? } where created_at is compared.
// Supported:
//   last-month
//   before-this-month
//   older N
//   before YYYY-MM-DD
function parseRange(rangeRaw) {
  const range = String(rangeRaw || '').trim().toLowerCase();

  // Defaults
  let gteIso = null; // inclusive lower bound
  let ltIso  = null; // exclusive upper bound

  if (!range || range === 'last-month') {
    const gte = startOfPrevMonthUTC();
    const lt  = startOfThisMonthUTC();
    gteIso = toIsoDateStart(gte);
    ltIso  = toIsoDateStart(lt);
    return { gteIso, ltIso, label: 'last-month' };
  }

  if (range === 'before-this-month') {
    const lt = startOfThisMonthUTC();
    ltIso = toIsoDateStart(lt);
    return { gteIso: null, ltIso, label: 'before-this-month' };
  }

  // older N
  const olderMatch = range.match(/^older\s+(\d{1,4})$/);
  if (olderMatch) {
    const days = Math.max(0, Math.min(36500, Number(olderMatch[1]))); // cap 100 years
    const lt = daysAgoUTC(days);
    ltIso = toIsoDateStart(lt);
    return { gteIso: null, ltIso, label: `older-${days}` };
  }

  // before YYYY-MM-DD
  const beforeMatch = range.match(/^before\s+(\d{4}-\d{2}-\d{2})$/);
  if (beforeMatch) {
    const parts = beforeMatch[1].split('-').map(Number);
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0));
    ltIso = toIsoDateStart(d);
    return { gteIso: null, ltIso, label: `before-${beforeMatch[1]}` };
  }

  // Fallback to last-month semantics
  const gte = startOfPrevMonthUTC();
  const lt  = startOfThisMonthUTC();
  gteIso = toIsoDateStart(gte);
  ltIso  = toIsoDateStart(lt);
  return { gteIso, ltIso, label: 'last-month' };
}

// ───────────────────────────────────────────────────────────────────────────────
// CSV helpers
const CSV_COLUMNS = [
  'order_id',
  'customer_name',
  'email',
  'phone',
  'payment_status',
  'driver_name',
  'delivery_location',
  'product_price',
  'delivery_price',
  'type_chosen',
  'roast_level',
  'size',
  'qty',
  'date',
  'time_ordered',
  'phase',
  'created_at',
  'updated_at'
];

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
function toCSV(rows) {
  const header = CSV_COLUMNS.join(',');
  const lines = rows.map(r => CSV_COLUMNS.map(col => csvEscape(r[col])).join(','));
  return [header].concat(lines).join('\n');
}

// ───────────────────────────────────────────────────────────────────────────────
// Persist
// orderObj minimal fields: { order_id, ... }.
// phase is a label like 'payment_confirmed' | 'delivered' (optional).
// opts: { tz?: string, createdAtMs?: number }
async function persist(orderObj, phase = null, opts = {}) {
  if (!orderObj || !orderObj.order_id) throw new Error('persist: order_id is required');

  const now = new Date();
  const createdAt = opts.createdAtMs ? new Date(opts.createdAtMs) : now;

  // Normalize record
  const rec = {
    order_id:          String(orderObj.order_id),
    customer_name:     orderObj.customer_name ?? null,
    email:             orderObj.email ?? null,
    phone:             orderObj.phone ?? null,
    payment_status:    orderObj.payment_status ?? null,
    driver_name:       orderObj.driver_name ?? null,
    delivery_location: orderObj.delivery_location ?? null,
    product_price:     orderObj.product_price ?? null,
    delivery_price:    orderObj.delivery_price ?? null,
    type_chosen:       orderObj.type_chosen ?? null,
    roast_level:       orderObj.roast_level ?? null,
    size:              orderObj.size ?? null,
    qty:               orderObj.qty ?? null,
    date:              orderObj.date ?? null,
    time_ordered:      orderObj.time_ordered ?? null,
    phase:             phase ?? orderObj.phase ?? null,
    created_at:        orderObj.created_at ?? new Date(createdAt).toISOString(),
    updated_at:        new Date(now).toISOString()
  };

  if (HAS_SB) {
    // Use upsert on order_id
    const { error } = await sb
      .from(TABLE)
      .upsert(rec, { onConflict: 'order_id' });
    if (error) {
      console.error('Supabase persist error:', error.message);
      // fall back to local
    } else {
      return { ok: true, source: 'supabase' };
    }
  }

  // Local fallback: merge by order_id
  const arr = readLocal();
  const idx = arr.findIndex(x => x.order_id === rec.order_id);
  if (idx >= 0) {
    // shallow merge, preserve created_at, refresh updated_at
    const prev = arr[idx];
    arr[idx] = { ...prev, ...rec, created_at: prev.created_at || rec.created_at, updated_at: rec.updated_at };
  } else {
    arr.push(rec);
  }
  writeLocal(arr);
  return { ok: true, source: 'local' };
}

// ───────────────────────────────────────────────────────────────────────────────
// Query helpers (Supabase + local)
async function fetchByRange(rangeRaw) {
  const { gteIso, ltIso } = parseRange(rangeRaw);

  if (HAS_SB) {
    let q = sb.from(TABLE).select('*').order('created_at', { ascending: true });
    if (gteIso) q = q.gte('created_at', gteIso);
    if (ltIso)  q = q.lt('created_at', ltIso);

    // Pull in pages of 1000
    const pageSize = 1000;
    let from = 0;
    let all = [];
    while (true) {
      const to = from + pageSize - 1;
      const { data, error, count } = await q.range(from, to);
      if (error) throw new Error(error.message);
      all = all.concat(data || []);
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
    return all;
  }

  // Local
  const arr = readLocal();
  return arr.filter(r => {
    const ca = r.created_at ? new Date(r.created_at).toISOString() : null;
    if (!ca) return false;
    if (gteIso && !(ca >= gteIso)) return false;
    if (ltIso  && !(ca < ltIso))  return false;
    return true;
  }).sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

// ───────────────────────────────────────────────────────────────────────────────
// Export rows to CSV file based on range
async function exportCsv(rangeRaw) {
  const { label } = parseRange(rangeRaw);
  const rows = await fetchByRange(rangeRaw);

  ensureExportDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(EXPORT_DIR, `orders_${label}_${ts}.csv`);

  const csv = toCSV(rows);
  fs.writeFileSync(filename, csv, 'utf8');

  return { filename, rows: rows.length };
}

// ───────────────────────────────────────────────────────────────────────────────
// Prune (delete) rows based on the same range criteria
async function pruneOrders(rangeRaw) {
  const { gteIso, ltIso } = parseRange(rangeRaw);

  if (HAS_SB) {
    let q = sb.from(TABLE).delete();
    if (gteIso) q = q.gte('created_at', gteIso);
    if (ltIso)  q = q.lt('created_at', ltIso);
    const { error, count } = await q.select('order_id', { count: 'exact' });
    if (error) throw new Error(error.message);
    return count || 0;
  }

  // Local prune
  const all = readLocal();
  const keep = [];
  let pruned = 0;
  for (const r of all) {
    const ca = r.created_at ? new Date(r.created_at).toISOString() : null;
    let inRange = true;
    if (!ca) inRange = false;
    if (inRange && gteIso && !(ca >= gteIso)) inRange = false;
    if (inRange && ltIso  && !(ca < ltIso))  inRange = false;
    if (inRange) pruned++; else keep.push(r);
  }
  writeLocal(keep);
  return pruned;
}

// ───────────────────────────────────────────────────────────────────────────────
module.exports = { persist, exportCsv, pruneOrders };
