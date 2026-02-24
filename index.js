const path = require('path');

// ===== LIVE FEED (Dashboard API) — SAFE IMPORTS (do not edit) =====
let liveOrderFeed = null;
let liveOrdersRoutes = null;
try { liveOrderFeed = require("./services/liveOrderFeed"); } catch (e) { liveOrderFeed = null; }
try { liveOrdersRoutes = require("./routes/liveOrdersRoutes"); } catch (e) { liveOrdersRoutes = null; }

// other existing content of index.js 



// ===== LIVE FEED (Dashboard API) — CAPTURE ORDER (do not edit) =====
try {
  const __ggDraft =
    (typeof msg === "string" && msg) ? msg :
    (typeof message === "string" && message) ? message :
    (typeof draft === "string" && draft) ? draft :
    (typeof card === "string" && card) ? card :
    null;
  if (liveOrderFeed && __ggDraft) {
    if (typeof liveOrderFeed.captureTelegramDraft === "function") {
      liveOrderFeed.captureTelegramDraft(__ggDraft);
    } else if (typeof liveOrderFeed.capture === "function") {
      liveOrderFeed.capture({ draft: __ggDraft });
    } else if (typeof liveOrderFeed.add === "function") {
      liveOrderFeed.add({ draft: __ggDraft });
    }
  }
} catch (_) {}

// other existing content of index.js 

if (f.customerName) card = `👤 ${f.customerName}\n` + card;
if (f.phone) card += `\n📞 ${f.phone}`;

// ===== LIVE FEED (Dashboard API) — CAPTURE ORDER (do not edit) =====
try {
  const __ggDraft =
    (typeof msg === "string" && msg) ? msg :
    (typeof message === "string" && message) ? message :
    (typeof draft === "string" && draft) ? draft :
    (typeof card === "string" && card) ? card :
    null;
  if (liveOrderFeed && __ggDraft) {
    if (typeof liveOrderFeed.captureTelegramDraft === "function") {
      liveOrderFeed.captureTelegramDraft(__ggDraft);
    } else if (typeof liveOrderFeed.capture === "function") {
      liveOrderFeed.capture({ draft: __ggDraft });
    } else if (typeof liveOrderFeed.add === "function") {
      liveOrderFeed.add({ draft: __ggDraft });
    }
  }
} catch (_) {}

// other existing content of index.js
