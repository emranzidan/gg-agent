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

const COLS = [
  'order_id','date','time_ordered','customer_name','email','phone','payment_status',
  'driver_name','driver_accepted_time','driver_picked_time','driver_delivered_time',
  'delivery_location','product_price','delivery_price','type_chosen','roast_level','size','qty'
];

function toCSV(rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = COLS.join(',');
  const lines = (rows || []).map(r => COLS.map(c => esc(r[c])).join(','));
  return [header, ...lines].join('\n');
}

function parseDDMMYYYY(s) {
  // Accepts 'DD/MM/YYYY'
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const dd = Number(m[1]), mm = Number(m[2]), yy = Number(m[3]);
  const d = new Date(Date.UTC(yy, mm - 1, dd, 0, 0, 0));
  return Number.isFinite(d.getTime()) ? d : null;
}

function startOfThisMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
}
function daysAgo(n) {
  const now = new Date();
  return new Date(now.getTime() - n*24*60*60*1000);
}
function isBefore(row, cutoff) {
  const d = parseDDMMYYYY(row.date);
  if (!d) return false;
  return d.getTime() < cutoff.getTime();
}

async function fetchAllRowsSB() {
  const page = 1000;
  let from = 0;
  let rows = [];
  while (true) {
    const { data, error } = await sb.from(TABLE).select('*').range(from, from + page - 1);
    if (error) throw error;
    const batch = data || [];
    rows = rows.concat(batch);
    if (batch.length < page) break;
    from += page;
  }
  return rows;
}

function fetchAllRowsLocal() {
  try { return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8')); }
  catch { return []; }
}

async function deleteByIdsSB(ids) {
  // Batch deletes (IN lists have practical limits; use chunks of 500)
  const chunk = 500;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const { error } = await sb.from(TABLE).delete().in('order_id', slice);
    if (error) throw error;
  }
}

function writeRowsLocal(rows) {
  try { fs.writeFileSync(LOCAL_FILE, JSON.stringify(rows, null, 2), 'utf8'); }
  catch (e) { /* ignore */ }
}

function filenameFor(prefix) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${prefix}_${y}-${m}-${d}.csv`;
}

module.exports = function wireCleanMemory(bot, { ownerIds = [] } = {}) {
  const isOwner = (ctx) => ownerIds.includes(ctx.from?.id);
  const isPrivate = (ctx) => ctx.chat?.type === 'private';

  bot.command('cleanmemory', async (ctx) => {
    try {
      if (!isPrivate(ctx) || !isOwner(ctx)) {
        return ctx.reply('Owner only. DM me to run this.');
      }

      const args = String(ctx.message?.text || '').split(' ').slice(1);
      const mode = (args[0] || '').toLowerCase(); // 'preview' | 'run'
      let scope = 'before-this-month';            // default
      let olderDays = 0;
      let customBefore = null;

      if (mode !== 'preview' && mode !== 'run') {
        return ctx.reply([
          'Usage:',
          '  /cleanmemory preview',
          '  /cleanmemory run',
          '  /cleanmemory run older 90',
          '  /cleanmemory run before 01/09/2025'
        ].join('\n'));
      }

      if (mode === 'run') {
        const sub = (args[1] || '').toLowerCase();
        if (sub === 'older') {
          olderDays = Math.max(1, parseInt(args[2] || '90', 10) || 90);
          scope = 'older-days';
        } else if (sub === 'before') {
          const raw = args[2] || '';
          const d = parseDDMMYYYY(raw);
          if (!d) return ctx.reply('Invalid date. Use DD/MM/YYYY, e.g. 01/09/2025');
          customBefore = d;
          scope = 'before-date';
        }
      } else if (mode === 'preview') {
        // allow preview with the same optional filters
        const sub = (args[1] || '').toLowerCase();
        if (sub === 'older') {
          olderDays = Math.max(1, parseInt(args[2] || '90', 10) || 90);
          scope = 'older-days';
        } else if (sub === 'before') {
          const raw = args[2] || '';
          const d = parseDDMMYYYY(raw);
          if (!d) return ctx.reply('Invalid date. Use DD/MM/YYYY, e.g. 01/09/2025');
          customBefore = d;
          scope = 'before-date';
        }
      }

      const cutoff =
        scope === 'older-days'  ? daysAgo(olderDays) :
        scope === 'before-date' ? customBefore :
        startOfThisMonth(); // default

      await ctx.reply('Scanning orders…');

      // 1) Pull all rows
      let allRows = [];
      if (HAS_SB) {
        allRows = await fetchAllRowsSB();
      } else {
        allRows = fetchAllRowsLocal();
      }

      // 2) Filter rows to archive
      const toArchive = allRows.filter(r => isBefore(r, cutoff));
      const count = toArchive.length;

      if (count === 0) {
        return ctx.reply('Nothing eligible to archive 👍');
      }

      if (mode === 'preview') {
        const approxSizeKB = Math.ceil(Buffer.byteLength(toCSV(toArchive), 'utf8') / 1024);
        return ctx.reply(`Preview: ${count} rows eligible. ~${approxSizeKB} KB CSV.\nCutoff: before ${cutoff.toISOString().slice(0,10)}`);
      }

      // 3) Export CSV first (never delete before successful export)
      const csv = toCSV(toArchive);
      const fname = filenameFor(
        scope === 'older-days'  ? `orders_older_${olderDays}d` :
        scope === 'before-date' ? `orders_before_${String(args[2]).replace(/\//g,'-')}` :
                                  `orders_before_this_month`
      );

      await ctx.replyWithDocument({
        source: Buffer.from(csv, 'utf8'),
        filename: fname
      });

      // 4) Delete ONLY exported rows
      if (HAS_SB) {
        const ids = toArchive.map(r => r.order_id).filter(Boolean);
        await deleteByIdsSB(ids);
      } else {
        const keep = new Set(toArchive.map(r => r.order_id));
        const remaining = allRows.filter(r => !keep.has(r.order_id));
        writeRowsLocal(remaining);
      }

      return ctx.reply(`✅ Cleaned ${count} rows (exported as ${fname}).`);

    } catch (e) {
      console.error('cleanmemory error:', e);
      return ctx.reply(`⚠️ Clean failed: ${e.message || e}`);
    }
  });
};

