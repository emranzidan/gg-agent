// services/orderStore.js — save intake, approve, driver times, CSV export & clear
// EMMA PRO MAX — FINAL
'use strict';

const { on, upsert, patch, selectAll, delAll, insert } = require('./db');

const TABLE      = (process.env.SUPABASE_TABLE || 'orders').trim();
const ARCHIVE    = (process.env.SUPABASE_TABLE_ARCHIVE || 'orders_archive').trim();
const TZ         = 'Africa/Addis_Ababa';

/* ─────────────────────────── helpers ─────────────────────────── */

const COLS = [
  'order_id',
  'date',
  'time_ordered',
  'customer_name',
  'email',
  'phone',
  'type',
  'size',
  'roast_level',
  'product_price',
  'delivery_price',
  'total',
  'delivery_location',
  'payment_status',
  'driver_name',
  'driver_accepted_time',
  'driver_picked_time',
  'driver_delivered_time'
];

const esc = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const toNumber = (n) => {
  if (n == null) return null;
  const x = Number(String(n).replace(/[^\d.]/g, ''));
  return Number.isFinite(x) ? x : null;
};

const nowISO = () => new Date().toISOString();

const toLocalParts = (isoOrUnixSec) => {
  let d;
  if (!isoOrUnixSec) d = new Date();
  else if (typeof isoOrUnixSec === 'number') d = new Date(isoOrUnixSec * 1000);
  else d = new Date(isoOrUnixSec);

  const date = d.toLocaleDateString('en-GB', { timeZone: TZ }); // 31/08/2025
  const time = d.toLocaleTimeString('en-GB', {
    timeZone: TZ,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  }); // 23:27
  return { date, time };
};

const joinLocation = (fields) => {
  const addr = (fields.delivery_location || fields.address || '').trim();
  const map  = (fields.map_url || fields.map || '').trim();
  if (addr && map) return `${addr} | ${map}`;
  return addr || map || '';
};

const computeTotal = (product_price, qty, delivery_price, fallbackTotal) => {
  const pp = toNumber(product_price);
  const q  = toNumber(qty) || 1;
  const dp = toNumber(delivery_price) || 0;
  const t  = toNumber(fallbackTotal);
  if (pp != null) return (pp * q) + dp;
  if (t != null)  return t;
  return null;
};

/* ─────────────────────────── base row builder ─────────────────────────── */

function buildIntakeRow(fields, ctx) {
  // fields can include: order_id/ref, customer_name, email, phone, type, size, roast_level,
  // qty, product_price, delivery_price, total, delivery_location/address, map_url, raw_text
  const order_id = fields.order_id || fields.ref || '';
  const { date, time } = toLocalParts(ctx?.message?.date);
  const product_price = toNumber(fields.product_price);
  const delivery_price = toNumber(fields.delivery_price);
  const qty = toNumber(fields.qty) || 1;
  const total = computeTotal(product_price, qty, delivery_price, fields.total);

  return {
    order_id,
    date,
    time_ordered: time,
    customer_name: (fields.customer_name || '').trim(),
    email: (fields.email || '').trim(),
    phone: (fields.phone || '').trim(),
    type: (fields.type || '').trim(),
    size: (fields.size || '').trim(),
    roast_level: (fields.roast_level || '').trim(),
    product_price,
    delivery_price,
    total,
    delivery_location: joinLocation(fields),
    payment_status: 'pending',
    driver_name: '',
    driver_accepted_time: '',
    driver_picked_time: '',
    driver_delivered_time: '',
    created_at: nowISO(),
    updated_at: nowISO()
  };
}

/* ─────────────────────────── public API ─────────────────────────── */

/**
 * Save order intake (first time we see the order message).
 * Fills: date, time_ordered, email, type, size, roast, prices, total, delivery_location.
 * Conflict target: order_id (unique).
 */
async function saveOrderIntake(fields, ctx) {
  if (!on()) return { disabled: true };
  const row = buildIntakeRow(fields, ctx);
  if (!row.order_id) {
    console.warn('[store] saveOrderIntake called without order_id/ref');
    return { error: new Error('order_id missing') };
  }
  return upsert(TABLE, row, 'order_id');
}

/**
 * Mark payment approved (or pending).
 * status: 'approved' | 'pending'
 */
async function savePaymentStatus(order_id, status = 'approved') {
  if (!on()) return { disabled: true };
  if (!order_id) return { error: new Error('order_id missing') };
  return patch(TABLE, { order_id }, {
    payment_status: status,
    updated_at: nowISO()
  });
}

/**
 * Save / update driver info.
 * type: 'accepted' | 'picked' | 'delivered'
 * If tsISO not provided, uses now.
 */
async function saveDriverEvent(order_id, type, driver_name = '', tsISO = null) {
  if (!on()) return { disabled: true };
  if (!order_id) return { error: new Error('order_id missing') };

  const stamp = (tsISO || nowISO());
  const patchObj = { updated_at: nowISO() };

  if (driver_name) patchObj.driver_name = driver_name;

  if (type === 'accepted') patchObj.driver_accepted_time = stamp;
  else if (type === 'picked') patchObj.driver_picked_time = stamp;
  else if (type === 'delivered') patchObj.driver_delivered_time = stamp;
  else return { error: new Error('invalid driver event type') };

  return patch(TABLE, { order_id }, patchObj);
}

/**
 * Build CSV string for all rows in TABLE.
 * Ensures all columns exist (empty if missing).
 */
async function exportAllCSV() {
  // If DB is off, still return header
  if (!on()) return [COLS.join(',')].join('\n');

  const { data, error } = await selectAll(TABLE);
  if (error) {
    console.error('[store] export select error', error);
    // still return header
    return [COLS.join(',')].join('\n');
  }

  const rows = Array.isArray(data) ? data : [];

  const out = [COLS.join(',')];

  for (const r of rows) {
    // derive date/time if not stored
    const dt = toLocalParts(r.created_at || r.updated_at || Date.now());
    const line = [
      r.order_id || '',
      r.date || dt.date,
      r.time_ordered || dt.time,
      r.customer_name || '',
      r.email || '',
      r.phone || '',
      r.type || '',
      r.size || '',
      r.roast_level || '',
      r.product_price ?? '',
      r.delivery_price ?? '',
      (r.total ?? computeTotal(r.product_price, 1, r.delivery_price, r.total)) ?? '',
      r.delivery_location || '',
      r.payment_status || '',
      r.driver_name || '',
      r.driver_accepted_time || '',
      r.driver_picked_time || '',
      r.driver_delivered_time || ''
    ].map(esc).join(',');
    out.push(line);
  }

  return out.join('\n');
}

/**
 * Export everything, archive, then clear live table.
 * - Archives into ARCHIVE (best effort). If ARCHIVE is missing, export still works and we still clear.
 * - Returns CSV string (same as exportAllCSV).
 */
async function clearAndExportAllCSV() {
  const csv = await exportAllCSV();

  if (on()) {
    try {
      // try to archive current rows first
      const { data } = await selectAll(TABLE);
      if (Array.isArray(data) && data.length) {
        try {
          await insert(ARCHIVE, data);
        } catch (e) {
          console.warn('[store] archive insert failed (continuing):', e?.message || e);
        }
        // clear live
        await delAll(TABLE);
      }
    } catch (e) {
      console.error('[store] clear/export error (continuing):', e?.message || e);
    }
  }

  return csv;
}

/* ─────────────────────────── exports ─────────────────────────── */

module.exports = {
  saveOrderIntake,
  savePaymentStatus,
  saveDriverEvent,         // type: 'accepted' | 'picked' | 'delivered'
  exportAllCSV,
  clearAndExportAllCSV,
};
