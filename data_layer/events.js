// data_layer/events.js
// Public API that index.js calls. Upserts into memory + posts to HTTP sink.

const { toRow, mergeRows } = require('./schema');
const mem = require('./csv_mem');
let sink = null;
try {
  sink = require('./sink');
} catch (e) {
  console.warn('[data_layer] sink not available, HTTP writes disabled.');
}

// Helper: push to in-memory + try to write to sink
async function _commit(partial) {
  const row = toRow(partial);
  mem.upsert(row);
  if (sink && typeof sink.writeRow === 'function') {
    // fire-and-forget; we do not throw
    sink.writeRow(row).catch(()=>{});
  }
  return row;
}

/** New order parsed (call from your flow right after extract) */
async function recordNewOrder(p) {
  // Expecting: order_id, date, time_ordered, customer_name, email, phone,
  // delivery_location, product_price, delivery_price, type_chosen, roast_level, size, qty
  return _commit(p);
}

/** Payment accepted */
async function markPaid(p) {
  return _commit({ ...p, payment_status: 'accepted' });
}

/** Payment rejected */
async function markRejected(p) {
  return _commit({ ...p, payment_status: 'rejected' });
}

/** Driver accepted */
async function assignDriver(p) {
  // Expect p: { order_id, driver_name, driver_accepted_time, ...optional fields... }
  return _commit(p);
}

/** Driver picked up */
async function markPicked(p) {
  // Expect p: { order_id, driver_picked_time }
  return _commit(p);
}

/** Driver delivered */
async function markDelivered(p) {
  // Expect p: { order_id, driver_delivered_time }
  return _commit(p);
}

// CSV export used by /ops/export.csv
async function exportCSV() {
  return mem.exportCSV();
}

// Optional quick self-test: node -e "require('./data_layer/events')._selfTest()"
async function _selfTest() {
  await recordNewOrder({
    order_id: 'GG_ABC123',
    date: '2025-08-31',
    time_ordered: '12:34:56',
    customer_name: 'Test User',
    email: 'test@example.com',
    phone: '+251900000000',
    delivery_location: 'Bole',
    product_price: '595',
    delivery_price: '100',
    type_chosen: 'beans',
    roast_level: 'medium',
    size: '250g',
    qty: '1'
  });
  await markPaid({ order_id: 'GG_ABC123' });
  await assignDriver({ order_id: 'GG_ABC123', driver_name: 'Abebe', driver_accepted_time: new Date().toISOString() });
  await markPicked({ order_id: 'GG_ABC123', driver_picked_time: new Date().toISOString() });
  await markDelivered({ order_id: 'GG_ABC123', driver_delivered_time: new Date().toISOString() });

  const csv = await exportCSV();
  console.log(csv);
}

module.exports = {
  recordNewOrder,
  markPaid,
  markRejected,
  assignDriver,
  markPicked,
  markDelivered,
  exportCSV,
  _selfTest
};
