// data_layer/schema.js
// Defines column order + helpers to normalize event payloads into a single row.
// Row is keyed by order_id. Later events "fill in" the same row.

const COLUMNS = [
  'order_id',
  'date',
  'time_ordered',
  'customer_name',
  'email',
  'phone',
  'payment_status',              // accepted | rejected | pending
  'driver_name',
  'driver_accepted_time',
  'driver_picked_time',
  'driver_delivered_time',
  'delivery_location',
  'product_price',
  'delivery_price',
  'type_chosen',
  'roast_level',
  'size',
  'qty'
];

// Produce a blank row with all columns
function blankRow() {
  const row = {};
  for (const c of COLUMNS) row[c] = '';
  return row;
}

// Normalize a partial payload into a row aligned to COLUMNS
function toRow(partial = {}) {
  const base = blankRow();
  for (const k of Object.keys(partial || {})) {
    if (k in base) base[k] = partial[k] == null ? '' : String(partial[k]);
  }
  return base;
}

// Merge new fields into an existing row (existing wins unless new has a value)
function mergeRows(existing, incoming) {
  const out = { ...existing };
  for (const k of Object.keys(incoming || {})) {
    const v = incoming[k];
    if (v !== undefined && v !== null && String(v) !== '') {
      out[k] = String(v);
    }
  }
  return out;
}

module.exports = {
  COLUMNS,
  blankRow,
  toRow,
  mergeRows
};
