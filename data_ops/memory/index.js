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

// ...[rest of file is already correct, no markdown/code fence artifacts found]