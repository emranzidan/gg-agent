'use strict';

/**
 * Two simple commands:
 *   /export orders                 -> export ALL orders (no delete)
 *   /clear and export orders       -> export ALL orders, then DELETE them
 *
 * Owner-only (reads OWNER_IDS env). Uses data_ops/memory.exportCsv + pruneOrders.
 * Works even if memory module exposes pruneAllOrders(); otherwise uses pruneOrders({ all: true }).
 */

const crypto = require('crypto');
const mem = require('../data_ops/memory');

function isOwner(ctx) {
  const ownerIds = String(process.env.OWNER_IDS || '')
    .split(',').map(s => Number(s.trim())).filter(Number.isFinite);
  return ownerIds.includes(ctx.from?.id);
}

function sig(name) {
  const salt = process.env.EXPORT_SALT || 'gg_salt';
  return crypto.createHash('sha1').update(`${salt}|${name}`).digest('hex').slice(0, 8);
}

function makeFilename(base = 'orders') {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'); // YYYY-MM-DD-HH-MM
  return `${base}_${stamp}_${sig(base)}.csv`;
}

async function sendCsv(ctx, csv, rows, base = 'orders') {
  if (!rows || rows.length === 0) {
    await ctx.reply('No rows found.');
    return false;
  }
  const filename = makeFilename(base);
  await ctx.replyWithDocument(
    { source: Buffer.from(csv, 'utf8'), filename },
    { caption: `${rows.length} rows` }
  );
  return true;
}

module.exports = function wireExportCommands(bot) {
  // /export orders  — export everything
  bot.command('export', async (ctx) => {
    try {
      if (!isOwner(ctx)) return; // silent for non-owners
      const text = String(ctx.message?.text || '').trim().toLowerCase();
      if (text !== '/export orders' && text !== '/export') {
        // Only accept these two forms; anything else ignore (keeps it simple).
        return;
      }

      const { csv, rows } = await mem.exportCsv({}, { returnRows: true });
      await sendCsv(ctx, csv, rows, 'orders');
    } catch (e) {
      console.error('export error:', e);
      await ctx.reply(`⚠️ Export failed: ${e.message || e}`);
    }
  });

  // /clear and export orders  — export everything, then delete everything
  bot.command('clear', async (ctx) => {
    try {
      if (!isOwner(ctx)) return;
      const text = String(ctx.message?.text || '').trim().toLowerCase();
      if (text !== '/clear and export orders') return;

      // 1) Export ALL
      const { csv, rows } = await mem.exportCsv({}, { returnRows: true });
      const ok = await sendCsv(ctx, csv, rows, 'orders');
      if (!ok) return;

      // 2) Delete ALL
      if (typeof mem.pruneAllOrders === 'function') {
        const deleted = await mem.pruneAllOrders();
        await ctx.reply(`🧹 Deleted ${deleted} rows.`);
      } else if (typeof mem.pruneOrders === 'function') {
        const deleted = await mem.pruneOrders({ all: true });
        await ctx.reply(`🧹 Deleted ${deleted} rows.`);
      } else {
        await ctx.reply('⚠️ Delete not available: memory module lacks prune helpers.');
      }
    } catch (e) {
      console.error('clear+export error:', e);
      await ctx.reply(`⚠️ Clear+Export failed: ${e.message || e}`);
    }
  });
};
