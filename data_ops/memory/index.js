// data_ops/memory/index.js
// Supabase-backed persistence with safe merge + local fallback.
// Exports: persist(orderObj, phase, { tz?, createdAtMs? })

'use strict';

const fs   = require('fs');
const path = require('path');

let createClient = null;
try {
  ({ createClient } = require('@supabase/supabase-js'));
} catch (_) {
  // keep null — we'll use local fallback
}

const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY  = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const TABLE         = process.env.SUPABASE_TABLE || 'orders';

const HAS_SB = !!(createClient && SUPABASE_URL && SUPABASE_KEY);
const sb = HAS_SB ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Local JSON fallback (if Supabase missing/unavailable)
const FALLBACK_FILE = path.join(__dirname, 'local_orders.json');
function readLocal() {
  try { return JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8')); }
  catch { return []; }
}
function writeLocal(arr) {
  try { fs.writeFileSync(FALLBACK_FILE, JSON.stringify(arr, null, 2), 'utf8'); }
  catch (e) { console.error('local fallback write error:', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Time helpers
function fmtDateDDMMYYYY(d, tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' });
    const parts = fmt.formatToParts(d);
    const dd = parts.find(p => p.type === 'day')?.value || '01';
    const mm = parts.find(p => p.type === 'month')?.value || '01';
    const yy = parts.find(p => p.type === 'year')?.value || '1970';
    return `${dd}/${mm}/${yy}`;
  } catch {
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yy = d.getUTCFullYear();
    return `${dd}/${mm}/${yy}`;
  }
}
function fmtHHMM(d, tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    return fmt.format(d);
  } catch {
    const hh = String(d.getUTCHours()).padStart(2,'0');
    const mm = String(d.getUTCMinutes()).padStart(2,'0');
    return `${hh}:${mm}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase helpers
async function sbGetById(order_id) {
  if (!HAS_SB) return null;
  const { data, error } = await sb.from(TABLE).select('*').eq('order_id', order_id).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}
async function sbUpsert(row) {
  if (!HAS_SB) return;
  const { error } = await sb.from(TABLE).upsert(row, { onConflict: 'order_id', returning: 'minimal' });
  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge keeping existing values when incoming is null/undefined/empty
function mergeKeep(oldRow, patch) {
  const out = { ...(oldRow || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

// Normalize incoming values to DB row shape
function normalize(orderObj = {}) {
  // Numbers
  const toNum = (x) => {
    if (x === undefined || x === null || x === '') return null;
    const n = Number(String(x).replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const row = {
    order_id:            orderObj.order_id || null,
    date:                orderObj.date || null,           // "DD/MM/YYYY"
    time_ordered:        orderObj.time_ordered || null,   // "HH:MM"
    customer_name:       orderObj.customer_name || null,
    email:               orderObj.email || null,
    phone:               orderObj.phone || null,
    payment_status:      orderObj.payment_status || null, // e.g., 'approved'
    driver_name:         orderObj.driver_name || null,

    driver_accepted_time: orderObj.driver_accepted_time || null,
    driver_picked_time:   orderObj.driver_picked_time   || null,
    driver_delivered_time:orderObj.driver_delivered_time|| null,

    delivery_location:   orderObj.delivery_location || null,
    product_price:       toNum(orderObj.product_price),
    delivery_price:      toNum(orderObj.delivery_price),
    type_chosen:         orderObj.type_chosen || null,
    roast_level:         orderObj.roast_level || null,
    size:                orderObj.size || null,           // e.g., "250g"
    qty:                 orderObj.qty !== undefined ? Number(orderObj.qty) : null,
  };

  return row;
}

// Ensure date/time_ordered exist for a new order (using createdAtMs or now)
function ensureOrderTimestamp(row, opts = {}) {
  const tz = opts.tz || 'Africa/Addis_Ababa';
  const base = opts.createdAtMs ? new Date(opts.createdAtMs) : new Date();
  if (!row.date)         row.date = fmtDateDDMMYYYY(base, tz);
  if (!row.time_ordered) row.time_ordered = fmtHHMM(base, tz);
  return row;
}

// Phase-specific enrichments (15s silent windows are handled in index.js; here we only persist final states)
function stampPhase(row, phase, opts = {}) {
  const tz = opts.tz || 'Africa/Addis_Ababa';
  const now = new Date();

  if (phase === 'payment_confirmed') {
    // nothing extra; index.js already ensures this runs after hold window
    // we only guarantee date/time_ordered exist
  } else if (phase === 'driver_accepted') {
    row.driver_accepted_time = row.driver_accepted_time || fmtHHMM(now, tz);
  } else if (phase === 'picked') {
    row.driver_picked_time = row.driver_picked_time || fmtHHMM(now, tz);
  } else if (phase === 'delivered') {
    row.driver_delivered_time = row.driver_delivered_time || fmtHHMM(now, tz);
  }
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: persist
/**
 * @param {Object} orderObj - partial fields for the order row
 * @param {('payment_confirmed'|'driver_accepted'|'picked'|'delivered')} phase
 * @param {{ tz?: string, createdAtMs?: number }} opts
 */
async function persist(orderObj, phase = 'payment_confirmed', opts = {}) {
  try {
    if (!orderObj || !orderObj.order_id) throw new Error('persist(): missing order_id');
    const id = orderObj.order_id;

    // 1) Normalize incoming data
    let incoming = normalize(orderObj);

    // 2) Enforce timestamp fields for new rows
    incoming = ensureOrderTimestamp(incoming, opts);

    // 3) Add phase stamp
    incoming = stampPhase(incoming, phase, opts);

    // 4) Merge with existing (to avoid null-overwrites)
    let merged = incoming;

    if (HAS_SB) {
      const existing = await sbGetById(id);
      merged = mergeKeep(existing, incoming);
      await sbUpsert(merged);
      return { ok: true, where: 'supabase', order_id: id, phase };
    }

    // Fallback local file
    const arr = readLocal();
    const idx = arr.findIndex(r => r.order_id === id);
    if (idx >= 0) {
      arr[idx] = mergeKeep(arr[idx], incoming);
    } else {
      arr.push(incoming);
    }
    writeLocal(arr);
    return { ok: true, where: 'local', order_id: id, phase };

  } catch (e) {
    console.error('persist error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (Optional) helpers — used by /export or cleanup command modules

async function exportOrdersCSV({ fromDate, toDate } = {}) {
  // Returns { ok, csv }
  try {
    if (!HAS_SB) {
      // export local fallback as CSV
      const rows = readLocal();
      const csv = toCSV(rows);
      return { ok: true, csv, where: 'local' };
    }

    let q = sb.from(TABLE).select('*').order('date', { ascending: true }).order('time_ordered', { ascending: true });

    if (fromDate) q = q.gte('date', fromDate); // expects 'DD/MM/YYYY' or adjust in caller
    if (toDate)   q = q.lte('date', toDate);

    const { data, error } = await q;
    if (error) throw error;
    return { ok: true, csv: toCSV(data || []), where: 'supabase' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function pruneOrdersBefore(cutoffDateDDMMYYYY) {
  // Dangerous! Ensure caller exports first.
  try {
    if (!HAS_SB) {
      const rows = readLocal().filter(r => (r.date || '') >= cutoffDateDDMMYYYY);
      writeLocal(rows);
      return { ok: true, where: 'local', kept: rows.length };
    }
    const { error } = await sb
      .from(TABLE)
      .delete()
      .lt('date', cutoffDateDDMMYYYY);
    if (error) throw error;
    return { ok: true, where: 'supabase' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function pruneOrdersOlderThanDays(days = 90, tz = 'Africa/Addis_Ababa') {
  // Converts to a DD/MM/YYYY cutoff in tz; then calls pruneOrdersBefore
  const now = new Date();
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  const cutoff = fmtDateDDMMYYYY(new Date(cutoffMs), tz);
  return pruneOrdersBefore(cutoff);
}

// CSV utility
function toCSV(rows) {
  const cols = [
    'order_id','date','time_ordered','customer_name','email','phone','payment_status',
    'driver_name','driver_accepted_time','driver_picked_time','driver_delivered_time',
    'delivery_location','product_price','delivery_price','type_chosen','roast_level','size','qty'
  ];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = cols.join(',');
  const lines = (rows || []).map(r => cols.map(c => esc(r[c])).join(','));
  return [header, ...lines].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  persist,
  // optional helpers (used by export/cleanup command file, if you add it)
  exportOrdersCSV,
  pruneOrdersBefore,
  pruneOrdersOlderThanDays,
};
