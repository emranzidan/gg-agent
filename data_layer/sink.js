// data_layer/sink.js
// HTTP sink with retry + fallback. Primary target: NocodeAPI endpoint for Google Sheets.
// Fallback: sheet.best (or any webhook that accepts JSON).
// Mode supports 'append' (default) or 'upsert' (if your endpoint supports key-based updates).

const DEFAULT_TIMEOUT_MS = Number(process.env.DATA_SINK_TIMEOUT_MS || 4000);
const RETRIES = Number(process.env.DATA_SINK_RETRIES || 3);
const PRIMARY_URL = process.env.DATA_SINK_PRIMARY_URL || '';   // REQUIRED for live writes
const FALLBACK_URL = process.env.DATA_SINK_FALLBACK_URL || ''; // optional
const MODE = (process.env.DATA_SINK_MODE || 'append').toLowerCase(); // 'append' | 'upsert'
const KEY_FIELD = process.env.DATA_SINK_KEY_FIELD || 'order_id';     // used when MODE=upsert

// Tiny fetch with timeout
async function httpPost(url, json, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!url) throw new Error('no url');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify(json)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await safeJson(res);
  } finally {
    clearTimeout(t);
  }
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

// Build a generic payload most no-code sheet endpoints can map
function buildPayload(row) {
  const body = {
    mode: MODE,                // hint for your endpoint
    keyField: KEY_FIELD,       // if upsert, use this column
    row                         // our data
  };
  return body;
}

async function writeRow(row) {
  const body = buildPayload(row);
  // Attempt primary with retries
  let lastErr;
  for (let i = 0; i < RETRIES; i++) {
    try { await httpPost(PRIMARY_URL, body); return true; }
    catch (e) { lastErr = e; await sleep(250 * (i + 1)); }
  }
  // Fallback
  if (FALLBACK_URL) {
    try { await httpPost(FALLBACK_URL, body); return true; }
    catch (e) { lastErr = e; }
  }
  console.warn('[data_layer] sink failed:', lastErr?.message || lastErr);
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  writeRow
};
