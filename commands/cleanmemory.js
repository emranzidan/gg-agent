// commands/cleanmemory.js
// Owner-only: archive (CSV export) then prune persisted orders.
// No top-level bot usage — everything is wired via the exported function.
'use strict';

module.exports = (bot) => {
  // Resolve owners from env (same convention as index.js)
  const ownerIds = String(process.env.OWNER_IDS || '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(Number.isFinite);

  const isOwner   = (ctx) => ownerIds.includes(ctx.from?.id);
  const isPrivate = (ctx) => ctx.chat?.type === 'private';

  // Data layer (Supabase-backed with local fallback)
  const { exportCsv, pruneOrders } = require('../data_ops/memory');

  /**
   * /cleanmemory [range]
   * Examples:
   *   /cleanmemory                -> defaults to "last-month"
   *   /cleanmemory last-month
   *   /cleanmemory older 90
   *   /cleanmemory before 2025-09-01
   *
   * Behavior:
   *   1) Export matching rows to a CSV (returns filename + row count).
   *   2) If export succeeds, prune the same rows.
   *   3) Reply with counts and the CSV filename.
   */
  bot.command('cleanmemory', async (ctx) => {
    if (!isOwner(ctx) || !isPrivate(ctx)) return;

    const range = ctx.message.text.split(' ').slice(1).join(' ').trim() || 'last-month';

    try {
      await ctx.reply(`⏳ Archiving rows for range: "${range}"…`);
      const { filename, rows } = await exportCsv(range); // throws on failure
      const pruned = await pruneOrders(range);

      await ctx.reply(
        `✅ Archive & prune complete.\n` +
        `• Archived (CSV): ${rows} rows → ${filename}\n` +
        `• Pruned (deleted): ${pruned} rows`
      );
    } catch (e) {
      console.error('cleanmemory error:', e);
      await ctx.reply(`⚠️ Clean aborted: ${e?.message || 'unknown error'}`);
    }
  });
};
