// services/orderStore.js — EMMA PRO MAX (final)
// Single source of truth for: intake saves, payment status, driver events,
// export CSV, clear+archive. Idempotent, RLS-safe (service-role), null-safe.

'use strict';

const { createClient } = require('@supabase/supabase-js');

// ────────────────────────────────────────────────────────────────────────────────
// ENV & Client
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
// Prefer service-role; fall back to legacy var if present (but service-role is recommended)
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_ANON_KEY || '';

const TABLE_ORDERS  = process.env.SUPABASE_TABLE || 'orders';
const TABLE_ARCHIVE = process.env.SUPABASE_TABLE_ARCHIVE || 'orders_archive';

// Note: Keep RLS ON in Supabase and use SERVICE_ROLE key here.
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('[db] Supabase: OFF (missing URL or KEY)');
}
const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
      global: { headers: { 'x-gg-agent': 'emma-pro-max' } },
    })
  : null;

if (supabase) console.log('[db] Supabase: ON');

// ────────────────────────────────────────────────────────────────────────────────
// Helpers

const TZ_FALLBACK = 'Africa/Addis_Ababa';

const toNull = (v) =>
  (v === undefined || v === null || (typeof v === 'string' && v.trim() === ''))
    ? null
    : v;

const moneyOrNull = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const clampIntOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

function localParts(ms = Date.now(), tz = TZ_FALLBACK) {
  try {
    const d = new Date(ms);
    const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const [y, m, d2] = fmtDate.format(d).split('-');
    // Some locales insert NBSP; normalize
    const t = fmtTime.format(d).replace(/\u202F|\u00A0/g, ''); // HH:mm:ss
    return { date: `${y}-${m}-${d2}`, time: t };
  } catch {
    // Fallback UTC+3 simple formatting
    const t = new Date(ms);
    const y = t.getUTCFullYear();
    const m = String(t.getUTCMonth() + 1).padStart(2, '0');
    const d = String(t.getUTCDate()).padStart(2, '0');
    const hh = String((t.getUTCHours() + 3) % 24).padStart(2, '0');
    const mm = String(t.getUTCMinutes()).padStart(2, '0');
    const ss = String(t.getUTCSeconds()).padStart(2, '0');
    return { date: `${y}-${m}-${d}`, time: `${hh}:${mm}:${ss}` };
  }
}

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  // If contains comma, quote, or newline, wrap in quotes and escape quotes
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCSV(rows, columns) {
  const header = columns.join(',');
  const body = rows.map((r) =>
    columns.map((c) => csvEscape(r[c])).join(',')
  );
  return [header, ...body].join('\n');
}

async function selectAllPaged(table, columns, order = { column: 'created_at', asc: true }) {
  const pageSize = 1000;
  let from = 0;
  let to = pageSize - 1;
  let all = [];
  // Paged fetch
  for (;;) {
    const q = supabase
      .from(table)
      .select(columns.join(','), { head: false })
      .order(order.column, { ascending: order.asc })
      .range(from, to);

    const { data, error } = await q;
    if (error) throw error;
    const chunk = data || [];
    all = all.concat(chunk);
    if (chunk.length < pageSize) break;
    from += pageSize;
    to += pageSize;
  }
  return all;
}

async function insertArchiveRows(rows) {
  if (!rows || rows.length === 0) return;
  const batchSize = 1000;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(TABLE_ARCHIVE).insert(batch);
    if (error) throw error;
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Public API

/**
 * saveOrderIntake(fields, ctx?)
 * Idempotent upsert by order_id. Fills date/time if missing. Stores raw_text, chat_id if ctx present.
 * Expected fields (strings allowed, null-safe):
 *  order_id (required), customer_name, email, phone, type, size, roast_level, qty,
 *  product_price, delivery_price, total, delivery_location, map_url, date, time_ordered
 */
async function saveOrderIntake(fields, ctx, opts = {}) {
  if (!supabase) return;
  const order_id = toNull(fields.order_id);
  if (!order_id) return;

  const tz = opts.tz || TZ_FALLBACK;
  const nowMs = opts.nowMs || Date.now();
  const parts = localParts(nowMs, tz);

  const row = {
    order_id,
    date:          toNull(fields.date) || parts.date,
    time_ordered:  toNull(fields.time_ordered) || parts.time,
    customer_name: toNull(fields.customer_name),
    email:         toNull(fields.email),
    phone:         toNull(fields.phone),
    type:          toNull(fields.type),
    size:          toNull(fields.size),
    roast_level:   toNull(fields.roast_level),
    qty:           clampIntOrNull(fields.qty),
    product_price: moneyOrNull(fields.product_price),
    delivery_price: moneyOrNull(fields.delivery_price),
    total:         moneyOrNull(fields.total),
    delivery_location: toNull(fields.delivery_location),
    map_url:       toNull(fields.map_url),
    // Convenience metadata
    chat_id:       ctx?.chat?.id ?? null,
    raw_text:      toNull(ctx?.message?.text),
    updated_at:    new Date(nowMs).toISOString(),
  };

  // Idempotent upsert by order_id
  const { error } = await supabase
    .from(TABLE_ORDERS)
    .upsert(row, { onConflict: 'order_id' });

  if (error) {
    console.error('[db] upsert error', error);
    throw error;
  }
}

/**
 * savePaymentStatus(order_id, status)
 * status: 'pending' | 'approved' | 'rejected' | ...
 */
async function savePaymentStatus(order_id, status) {
  if (!supabase || !order_id) return;
  const { error } = await supabase
    .from(TABLE_ORDERS)
    .upsert({
      order_id,
      payment_status: toNull(status),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'order_id' });

  if (error) {
    console.error('[db] payment_status error', error);
    throw error;
  }
}

/**
 * saveDriverEvent(order_id, kind, driverName?)
 * kind: 'accepted' | 'picked' | 'delivered'
 * Sets the appropriate timestamp column; also stores driver_name if provided.
 * Respects optional opts.tz / opts.whenMs.
 */
async function saveDriverEvent(order_id, kind, driverName, opts = {}) {
  if (!supabase || !order_id) return;

  const tz = opts.tz || TZ_FALLBACK;
  const whenMs = opts.whenMs || Date.now();
  const isoNow = new Date(whenMs).toISOString();

  const patch = {
    order_id,
    updated_at: isoNow,
  };
  if (driverName) patch.driver_name = toNull(driverName);

  if (kind === 'accepted') patch.driver_accepted_time = isoNow;
  else if (kind === 'picked') patch.driver_picked_time = isoNow;
  else if (kind === 'delivered') patch.driver_delivered_time = isoNow;

  const { error } = await supabase
    .from(TABLE_ORDERS)
    .upsert(patch, { onConflict: 'order_id' });

  if (error) {
    console.error('[db] driver event error', error);
    throw error;
  }
}

// Columns used for CSV export (stable order)
const EXPORT_COLUMNS = [
  'order_id',
  'date',
  'time_ordered',
  'customer_name',
  'email',
  'phone',
  'type',
  'size',
  'roast_level',
  'qty',
  'product_price',
  'delivery_price',
  'total',
  'delivery_location',
  'map_url',
  'payment_status',
  'driver_name',
  'driver_accepted_time',
  'driver_picked_time',
  'driver_delivered_time',
  'created_at',
  'updated_at',
];

/**
 * exportAllCSV()
 * Reads ALL rows from live table and returns a CSV string.
 */
async function exportAllCSV() {
  if (!supabase) return 'order_id\n'; // minimal header fallback
  const rows = await selectAllPaged(TABLE_ORDERS, EXPORT_COLUMNS);
  // Normalize types for CSV (null -> '', numeric stays numeric)
  const normalized = rows.map((r) => {
    const out = {};
    for (const c of EXPORT_COLUMNS) {
      const v = r[c];
      if (v === null || v === undefined) { out[c] = ''; continue; }
      if (typeof v === 'object' && v !== null && 'toString' in v) out[c] = String(v);
      else out[c] = String(v);
    }
    return out;
  });
  return rowsToCSV(normalized, EXPORT_COLUMNS);
}

/**
 * clearAndExportAllCSV()
 * 1) Pull all rows from live table
 * 2) Write them to archive table
 * 3) Delete all rows from live table
 * Returns CSV string of what was exported.
 */
async function clearAndExportAllCSV() {
  if (!supabase) return 'order_id\n';
  // 1) fetch all
  const rows = await selectAllPaged(TABLE_ORDERS, EXPORT_COLUMNS);
  const csv = rowsToCSV(
    rows.map((r) => {
      const out = {};
      for (const c of EXPORT_COLUMNS) out[c] = r[c] ?? '';
      return out;
    }),
    EXPORT_COLUMNS
  );

  if (!rows.length) return csv;

  // 2) archive insert (best effort; throws on error)
  await insertArchiveRows(rows);

  // 3) delete all from live
  const { error: delErr } = await supabase
    .from(TABLE_ORDERS)
    .delete()
    .not('order_id', 'is', null);
  if (delErr) {
    console.error('[db] clear live orders error', delErr);
    // We already archived; we won’t throw to avoid losing the CSV on bot side.
  }

  return csv;
}

// ────────────────────────────────────────────────────────────────────────────────
module.exports = {
  saveOrderIntake,
  savePaymentStatus,
  saveDriverEvent,
  exportAllCSV,
  clearAndExportAllCSV,
};
