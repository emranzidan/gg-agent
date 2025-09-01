// commands/cleanmemory.js
// Owner-only one-shot archive & prune.
// Usage (DM only):
//   /cleanmemory preview           -> show how many rows are eligible (no delete)
//   /cleanmemory run               -> export CSV of ALL rows before this month, then delete them
//   /cleanmemory run older 90      -> export CSV of rows older than 90 days, then delete them
//   /cleanmemory run before 01/09/2025 -> export CSV of rows with date < 01/09/2025, then delete them
//
// To wire it in index.js (near wireExportCommands):
//   try { require('./commands/cleanmemory')(bot, { ownerIds: OWNER_IDS }); } catch (e) { console.warn('cleanmemory not wired:', e.message); }

'use strict';

const fs = require('fs');
const path = require('path');

let createClient = null;
try { ({ createClient } = require('@supabase/supabase-js')); } catch (_) {}

const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY  = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const TABLE         = process.env.SUPABASE_TABLE || 'orders';
const HAS_SB        = !!(createClient && SUPABASE_URL && SUPABASE_KEY);
const sb            = HAS_SB ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Local fallback used by data_ops/memory
const LOCAL_FILE = path.join(__dirname, '..', 'data_ops', 'memory', 'local_orders.json');

// ...[rest of file is already correct, no markdown/code fence artifacts found]