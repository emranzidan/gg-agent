'use strict';

/**
 * Supabase adapter for GreenGold orders.
 * Exposes: upsert(row), fetchAll({fromDate,toDate}), health()
 *
 * Env required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *
 * Table: public.orders  (columns exactly per your spec)
 */

const { createClient } = require('@supabase/supabase-js');

const TABLE = 'orders';

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---- coercion helpers -------------------------------------------------------

function normalizeDate(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);

  const s = String(d).trim();

  // already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    const yy = m[3];
    return `${yy}-${mm}-${dd}`;
  }

  // last resort
  const t = new Date(s);
  if (!isNaN(t)) return t.toISOString().slice(0, 10);
  return null;
}

function normalizeTime(t) {
  if (!t) return null;
  const s = String(t).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const hh = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    const ss = (m[3] || '00').padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return null;
}

function asNumber(n) {
  if (n === null || n === undefined || n === '') return null;
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function coerceRow(row) {
  if (!row || !row.order_id) throw new Error('upsert requires {order_id}');

  return {
    order_id: String(row.order_id),

    // core timestamps
    date: normalizeDate(row.date),
    time_ordered: normalizeTime(row.time_ordered),
    driver_accepted_time: normalizeTime(row.driver_accepted_time),
    driver_picked_time: normalizeTime(row.driver_picked_time),
    driver_delivered_time: normalizeTime(row.driver_delivered_time),

    // customer
    customer_name: row.customer_name ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    delivery_location: row.delivery_location ?? null,

    // status + driver
    payment_status: row.payment_status ?? null,
    driver_name: row.driver_name ?? null,

    // pricing + options
    product_price: asNumber(row.product_price),
    delivery_price: asNumber(row.delivery_price),
    type_chosen: row.type_chosen ?? null,
    roast_level: row.roast_level ?? null,
    size: row.size ?? null,
    qty: row.qty != null ? parseInt(row.qty, 10) : null
  };
}

// ---- public API -------------------------------------------------------------

async function upsert(row) {
  const client = getClient();
  const payload = coerceRow(row);

  const { data, error } = await client
    .from(TABLE)
    .upsert(payload, { onConflict: 'order_id' })
    .select('order_id')
    .single();

  if (error) throw new Error(`supabase upsert failed: ${error.message}`);
  return data;
}

async function fetchAll({ fromDate = null, toDate = null } = {}) {
  const client = getClient();
  let q = client.from(TABLE).select('*').order('created_at', { ascending: false });

  if (fromDate) q = q.gte('date', normalizeDate(fromDate));
  if (toDate)   q = q.lte('date', normalizeDate(toDate));

  const { data, error } = await q;
  if (error) throw new Error(`supabase fetchAll failed: ${error.message}`);
  return data || [];
}

async function health() {
  const client = getClient();
  const { error } = await client.from(TABLE).select('order_id').limit(1);
  if (error) throw new Error(`supabase health failed: ${error.message}`);
  return true;
}

module.exports = {
  upsert,
  fetchAll,
  health,
  _private: { normalizeDate, normalizeTime, coerceRow }
};
