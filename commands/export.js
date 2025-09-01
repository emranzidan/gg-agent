// commands/export.js
// Owner-only export (NO delete). Uses data_ops/memory { exportCsv, persist }.
// Falls back to a local CSV builder if mem.toCsv is missing.
'use strict';

module.exports = (bot) => {
  const ownerIds = String(process.env.OWNER_IDS || '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(Number.isFinite);

  const isOwner   = (ctx) => ownerIds.includes(ctx.from?.id);
  const isPrivate = (ctx) => ctx.chat?.type === 'private';

  const mem = require('../data_ops/memory'); // must export exportCsv, persist (toCsv optional)

  // ─────────────────────────────────────────────────────────────
  // Helpers

  function normalizeRange(arg) {
    // Accepts "YYYY-MM-DD..YYYY-MM-DD" after "range "
    if (!arg) return null;
    const s = String(arg).trim();
    const m = s.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
    return m ? `${m[1]}..${m[2]}` : null;
  }

  // Fallback CSV if mem.toCsv isn’t provided
  function toCsvFallback(rows = []) {
    if (!Array.isArray(rows) || rows.length === 0) return '';
    // Prefer a stable, semantic order for common columns; then append any extras
    const preferred = [
      'order_id', 'date', 'time_ordered',
      'customer_name', 'email', 'phone',
      'payment_status',
      'driver_name', 'driver_accepted_time', 'driver_picked_time', 'driver_delivered_time',
      'delivery_location',
      'product_price', 'delivery_price',
      'type_chosen', 'roast_level', 'size', 'qty'
    ];
    const allKeys = new Set();
    for (const r of rows) Object.keys(r || {}).forEach(k => allKeys.add(k));
    const extras = [...allKeys].filter(k => !preferred.includes(k)).sort();
    const headers = preferred.filter(k => allKeys.has(k)).concat(extras);

    const esc = (v) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') v = JSON.stringify(v);
      v = String(v);
      // escape quotes, wrap in quotes if contains comma, quote, or newline
      const needs = /[",\n]/.test(v);
      if (needs) v = '"' + v.replace(/"/g, '""') + '"';
      return v;
    };

    const lines = [];
    lines.push(headers.join(','));
    for (const r of rows) {
      lines.push(headers.map(h => esc(r?.[h])).join(','));
    }
    return lines.join('\n');
  }

  function buildDummyOrder() {
    const now = new Date();
    const y  = now.getFullYear();
    const m  = String(now.getMonth() + 1).padStart(2, '0');
    const d  = String(now.getDate()).padStart(2, '0');
    const HH = String(now.getHours()).padStart(2, '0');
    const MM = String(now.getMinutes()).padStart(2, '0');
    return {
      order_id: `GG_TEST_${y}${m}${d}_${HH}${MM}`,
      date: `${y}-${m}-${d}`,
      time_ordered: `${HH}:${MM}`,
      customer_name: 'Test Customer',
      email: 'test@example.com',
      phone: '0000000000',
      payment_status: 'approved',
      driver_name: 'Test Driver',
      driver_accepted_time: null,
      driver_picked_time: null,
      driver_delivered_time: null,
      delivery_location: 'Test Location',
      product_price: 1000,
      delivery_price: 50,
      type_chosen: 'Powder',
      roast_level: 'Medium',
      size: '250g',
      qty: 1
    };
  }

  async function sendCsv(ctx, rows, filename = 'orders.csv') {
    const toCsv = typeof mem.toCsv === 'function' ? mem.toCsv : toCsvFallback;
    const csv = toCsv(rows || []);
    const buf = Buffer.from(csv, 'utf8');
    await ctx.replyWithDocument(
      { source: buf, filename },
      { caption: `${(rows || []).length} row${(rows || []).length === 1 ? '' : 's'}` }
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Commands

  // /test_memory → persist a dummy order (approved)
  bot.command('test_memory', async (ctx) => {
    if (!isOwner(ctx) || !isPrivate(ctx)) return;
    try {
      await mem.persist(buildDummyOrder(), 'payment_confirmed');
      await ctx.reply('Order Saved ✅');
    } catch (e) {
      console.error('test_memory error:', e);
      await ctx.reply(`Save Error ❌ ${e.message || ''}`.trim());
    }
  });

  // /export [spec]
  // Specs:
  //   (none) | orders | last-month | before-this-month | older 90 | before 2025-09-01
  //   range YYYY-MM-DD..YYYY-MM-DD
  bot.command('export', async (ctx) => {
    if (!isOwner(ctx) || !isPrivate(ctx)) return;

    try {
      const parts = String(ctx.message?.text || '').split(' ').slice(1);
      let spec = parts.join(' ').trim();

      if (!spec || spec.toLowerCase() === 'orders') {
        spec = ''; // adapter's default (e.g., all/before-this-month)
      } else if (spec.toLowerCase().startsWith('range ')) {
        const norm = normalizeRange(spec.slice(6));
        if (!norm) {
          await ctx.reply('⚠️ Bad range. Use: /export range YYYY-MM-DD..YYYY-MM-DD');
          return;
        }
        spec = norm;
      }

      const { filename, rows } = await mem.exportCsv(spec);
      if (!rows || rows.length === 0) {
        await ctx.reply('No rows found for that filter.');
        return;
      }
      await sendCsv(ctx, rows, filename || 'orders.csv');
    } catch (e) {
      console.error('export error:', e);
      await ctx.reply(`⚠️ Export failed: ${e.message || 'unknown error'}`);
    }
  });
};
