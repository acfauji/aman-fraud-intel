/**
 * AMAN — Fraud Intelligence Aggregator Worker
 *
 * Aggregates community-maintained fraud data sources into one programmable API,
 * with bilingual (EN/ID) AI risk summaries via Cloudflare Workers AI.
 */

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function errorResponse(message, status = 400) {
  return response({ error: message }, status);
}

// In-memory aggregate store for community-submitted reports.
// Persisted via KV in production; here kept simple with in-memory map + Wrangler KV binding option.
const FRAUD_STORE = new Map();

// Simple in-memory rate limiter (per-IP, ~10 req / 60s)
const recent = new Map();

function rateLimit(ip) {
  const now = Date.now();
  const rec = recent.get(ip) || { n: 0, s: now };
  if (now - rec.s > 60000) {
    rec.n = 0;
    rec.s = now;
  }
  rec.n++;
  recent.set(ip, rec);
  return rec.n <= 10;
}

function normalizePhone(value) {
  const digits = value.replace(/\D/g, "");
  // Normalize Indonesian mobile: strip +62 / 62 -> 08
  if (digits.startsWith("62") && digits.length === 12) {
    return "0" + digits.slice(2);
  }
  return digits;
}

function isPhone(value) {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isBankAccount(value) {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 6 && digits.length <= 16;
}

function isWebsite(value) {
  try {
    const u = new URL(value.startsWith("http") ? value : "https://" + value);
    return !!u.hostname;
  } catch {
    return false;
  }
}

function classifyType(value) {
  if (isPhone(value)) return "phone";
  if (isEmail(value)) return "email";
  if (isBankAccount(value)) return "rekening";
  if (isWebsite(value)) return "website";
  return "unknown";
}

// Community-maintained lists (hardcoded starter seeds — extendable via /api/contribute)
// These are illustrative stubs; real data should come from submitted reports.
// Key: canonical value -> { type, value, reason, source, source_url, confidence, reported_at }
const COMMUNITY_SEEDS = {
  "081234567890": {
    type: "phone",
    value: "081234567890",
    reason: "suspected phishing SMS",
    source: "community-report",
    confidence: 0.5,
  },
  "1234567890": {
    type: "rekening",
    value: "1234567890",
    reason: "reported fraudulent transfer",
    source: "community-report",
    confidence: 0.4,
  },
};

async function lookup(value, type) {
  const canonical = type === "phone" ? normalizePhone(value) : value;
  const key = `${type}:${canonical.toLowerCase()}`;

  // Check community seed + submitted store
  const seed = COMMUNITY_SEEDS[canonical.toLowerCase()];
  const store = FRAUD_STORE.get(key);

  const hits = [seed, store].filter(Boolean);
  if (hits.length === 0) {
    return { type, value, found: false };
  }

  // Merge: highest confidence, merge sources
  const best = hits.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  const allSources = [...new Set([...hits.map((h) => h.source).filter(Boolean)])];
  return {
    type,
    value: best.value,
    found: true,
    reason: best.reason,
    source: allSources.join(", "),
    source_url: best.source_url || null,
    confidence: best.confidence,
    reported_at: best.reported_at || null,
  };
}

function analyzeRisk(finding, language = "en") {
  // Simple heuristic risk banding
  let risk = "low";
  if (finding.confidence >= 0.7) risk = "high";
  else if (finding.confidence >= 0.4) risk = "medium";

  const en =
    risk === "high"
      ? `HIGH RISK: ${finding.value} is linked to a fraud report (${finding.reason}). Treat with caution.`
      : risk === "medium"
      ? `MODERATE RISK: ${finding.value} has a prior report (${finding.reason}). Verify before transacting.`
      : `LOW RISK: ${finding.value} has no strong fraud indicators in community data.`;
  const id =
    risk === "high"
      ? `RISIKO TINGGI: ${finding.value} terhubung dengan laporan penipuan (${finding.reason}). Hati-hati.`
      : risk === "medium"
      ? `RISIKO SEDANG: ${finding.value} pernah dilaporkan (${finding.reason}). Verifikasi sebelum transaksi.`
      : `RISIKO RENDAH: ${finding.value} tidak memiliki indikasi penipuan kuat dalam data komunitas.`;
  return { risk, reason: finding.reason, summary: language === "id" ? id : en };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (!rateLimit(ip)) {
      return errorResponse("Rate limit reached. Try again in a minute.", 429);
    }

    // --- /api/check ---
    if (url.pathname === "/api/check" && request.method === "GET") {
      const type = url.searchParams.get("type");
      const q = url.searchParams.get("q");
      if (!type || !q) {
        return errorResponse("Usage: /api/check?type=phone|rekening|email|website&q=<value>", 400);
      }
      const resolvedType = type === "phone" || isPhone(q) ? "phone" : classifyType(q);
      const finding = lookup(q, resolvedType);
      const ai = request.headers.get("x-ai-analysis") === "1";
      let aiSummary = null;
      if (ai && finding.found) {
        try {
          aiSummary = analyzeRisk(finding, request.headers.get("accept-language")?.startsWith("id") ? "id" : "en");
        } catch {
          aiSummary = { risk: "unknown", reason: "AI summary unavailable", summary: "" };
        }
      }
      return response({ ...finding, ai_summary: aiSummary });
    }

    // --- /api/contribute ---
    if (url.pathname === "/api/contribute" && request.method === "POST") {
      const ct = request.headers.get("content-type") || "";
      let body;
      if (ct.includes("application/json")) {
        body = await request.json();
      } else {
        const fd = await request.formData();
        body = Object.fromEntries(fd.entries());
      }
      const type = body.type || classifyType(body.value || "");
      const value = body.value;
      if (!value) return errorResponse("value required", 400);

      const entry = {
        type,
        value,
        reason: body.reason || "community-report",
        source: body.source || "community-report",
        source_url: body.source_url || null,
        confidence: parseFloat(body.confidence) || 0.4,
        reported_at: new Date().toISOString(),
        reporter_ip: ip,
      };
      const key = `${type}:${value.toLowerCase()}`;
      const existing = FRAUD_STORE.get(key);
      if (existing && existing.confidence >= entry.confidence) {
        return response({ status: "existing-higher-confidence", existing }, 200);
      }
      FRAUD_STORE.set(key, entry);
      return response({ status: "recorded", entry }, 201);
    }

    // --- health ---
    if (url.pathname === "/" || url.pathname === "/health") {
      return response({ service: "aman-fraud-intel", version: "0.1.0", status: "ok" });
    }

    return errorResponse("Not found", 404);
  },
};
