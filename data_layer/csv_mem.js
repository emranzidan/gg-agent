// data_layer/csv_mem.js
// In-memory upsert store keyed by order_id + CSV exporter.
// Survives per-process lifetime; the Google Sheet is the durable store.

const { COLUMNS, toRow, mergeRows } = require('./schema');

// order_id -> row object
const STORE = new Map();

function upsert(partial) {
  const incoming = toRow(partial);
  const id = (incoming.order_id || '').trim();
  if (!id) return; // ignore rows without order_id
  const prev = STORE.get(id) || toRow({ order_id: id });
  const next = mergeRows(prev, incoming);
  STORE.set(id, next);
}

function exportCSV() {
  const lines = [];
  // header
  lines.push(COLUMNS.join(','));
  // rows
  for (const row of STORE.values()) {
    const vals = COLUMNS.map((c) => csvEscape(row[c]));
    lines.push(vals.join(','));
  }
  return lines.join('\n');
}

function csvEscape(val) {
  const s = String(val == null ? '' : val);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// optional helper for tests
function _dump() {
  return Array.from(STORE.values());
}

module.exports = {
  upsert,
  exportCSV,
  _dump
};
