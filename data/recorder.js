// data/recorder.js — precise order recording (upserts + append-only events)
'use strict';

const db = require('./db');
const { parseOrderFields } = require('../parser');

function moneyOrNull(n) {
  if (n === null || n === undefined) return null;
  const i = Number(n);
  return Number.isFinite(i) ? Math.round(i) : null;
}

async function upsertOrderSnapshot(summaryText, opts = {}) {
  const f = parseOrderFields(summaryText || '');
  const ref = opts.ref || f.ref || opts.fallbackRef;
  if (!ref) throw new Error('Missing ref for upsert');

  const total    = moneyOrNull(f.total);
  const delivery = moneyOrNull(f.delivery);
  const goods    = (total != null && delivery != null) ? (total - delivery) : null;

  const itemsJson = JSON.stringify(f.items || []);
  const values = [
    ref,
    opts.created_at_utc || new Date().toISOString(),
    // customer/location
    f.customerName || null, f.phone || null, f.email || null,
    f.address || null, f.map || null, f.area || null,
    (f.distance_km != null ? Number(f.distance_km) : null),
    f.pickup || null,
    // payment & totals
    (opts.payment_method || (opts.method && String(opts.method).toUpperCase()) || null),
    goods, delivery, total, (f.qty != null ? Number(f.qty) : null),
    // raw/parsed
    itemsJson, summaryText
  ];

  await db.query(`
    insert into orders (
      ref, created_at_utc,
      customer_name, phone, email, address, map_url, area, distance_km, pickup_location,
      payment_method, goods_subtotal_etb, delivery_fee_etb, total_etb, qty_total,
      items_json, raw_summary
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    on conflict (ref) do update set
      customer_name       = excluded.customer_name,
      phone               = excluded.phone,
      email               = excluded.email,
      address             = excluded.address,
      map_url             = excluded.map_url,
      area                = excluded.area,
      distance_km         = excluded.distance_km,
      pickup_location     = excluded.pickup_location,
      payment_method      = coalesce(excluded.payment_method, orders.payment_method),
      goods_subtotal_etb  = coalesce(excluded.goods_subtotal_etb, orders.goods_subtotal_etb),
      delivery_fee_etb    = coalesce(excluded.delivery_fee_etb, orders.delivery_fee_etb),
      total_etb           = coalesce(excluded.total_etb, orders.total_etb),
      qty_total           = coalesce(excluded.qty_total, orders.qty_total),
      -- keep first parsed items to avoid drift; change if you want overwrites:
      items_json          = case when jsonb_array_length(orders.items_json)=0 then excluded.items_json else orders.items_json end
  `, values);

  // populate normalized items once (optional)
  const items = f.items || [];
  const { rows } = await db.query('select count(*)::int as n from order_items where ref=$1', [ref]);
  if ((rows[0]?.n || 0) === 0 && items.length) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await db.query(`
        insert into order_items (ref, item_seq, roast, type, size_g, qty, unit_price, line_total)
        values ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        ref, i + 1,
        it.roast || null, it.type || null,
        (it.size_g != null ? Number(it.size_g) : null),
        (it.qty != null ? Number(it.qty) : null),
        moneyOrNull(it.unit_price),
        moneyOrNull(it.line_total)
      ]);
    }
  }
  return { ref, parsed: f };
}

async function appendEvent(ref, event, meta = {}) {
  await db.query(`insert into order_events (ref, event, meta) values ($1,$2,$3)`, [ref, event, meta]);
}

module.exports = {
  // intake (new order pasted)
  async recordIntake(summaryText, opts = {}) {
    const { ref, parsed } = await upsertOrderSnapshot(summaryText, opts);
    await db.query(`update orders set status='AWAITING_PAYMENT' where ref=$1`, [ref]);
    await appendEvent(ref, 'intake', { area: parsed.area || null });
    return ref;
  },

  // payment method picked
  async recordPaymentSelected(ref, summaryText, method) {
    await upsertOrderSnapshot(summaryText, { ref, method });
    await db.query(`update orders set status='AWAITING_RECEIPT' where ref=$1`, [ref]);
    await appendEvent(ref, 'payment_selected', { method: String(method || '').toUpperCase() });
  },

  // receipt photo posted to staff
  async recordReceiptPosted(ref, summaryText) {
    await upsertOrderSnapshot(summaryText, { ref });
    await db.query(`update orders set status='AWAITING_REVIEW' where ref=$1`, [ref]);
    await appendEvent(ref, 'receipt_posted', {});
  },

  // staff approved
  async recordApproved(ref, summaryText) {
    await upsertOrderSnapshot(summaryText, { ref });
    await db.query(`update orders set status='APPROVED', approved_at_utc=now() where ref=$1`, [ref]);
    await appendEvent(ref, 'approved', {});
  },

  // staff rejected
  async recordRejected(ref, summaryText) {
    await upsertOrderSnapshot(summaryText, { ref });
    await db.query(`update orders set status='REJECTED', rejected_at_utc=now(), fail_reason='rejected' where ref=$1`, [ref]);
    await appendEvent(ref, 'rejected', {});
  },

  // mark abandoned (cron or manual rule)
  async recordAbandoned(ref, summaryText, reason='abandoned_no_receipt') {
    await upsertOrderSnapshot(summaryText, { ref });
    await db.query(`update orders set status='ABANDONED', fail_reason=$2 where ref=$1`, [ref, reason]);
    await appendEvent(ref, 'abandoned', { reason });
  },

  // driver actions (no driver_id stored; name/phone + timestamps)
  async recordDriverAssigned(ref, driver) {
    await db.query(`
      update orders set status='ASSIGNED',
        driver_name=$2, driver_phone=$3,
        driver_accepted_at_utc=now()
      where ref=$1
    `, [ref, driver?.name || null, driver?.phone || null]);
    await appendEvent(ref, 'assigned', { driver_name: driver?.name || null });
  },

  async recordPicked(ref) {
    await db.query(`update orders set status='OUT_FOR_DELIVERY', picked_at_utc=now() where ref=$1`, [ref]);
    await appendEvent(ref, 'picked', {});
  },

  async recordDelivered(ref) {
    await db.query(`update orders set status='DELIVERED', delivered_at_utc=now() where ref=$1`, [ref]);
    await appendEvent(ref, 'delivered', {});
  }
};
