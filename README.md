# AMAN — Fraud Intelligence Aggregator

> **Status:** Work in progress (early development). Endpoints and data sources may change.

Open Indonesian fraud-intelligence aggregator.

Aggregates community-maintained fraud data sources (check-account, scam-number listings, etc.) into a single programmable API, with bilingual (EN/ID) analysis via Cloudflare Workers AI.

## Endpoints

### `GET /api/check`
Aggregate lookup across data types.

Query params:
- `type=phone|rekening|email|website`
- `q=<value>`

```
GET /api/check?type=phone&q=08123456789
```

### `GET /api/contribute`
Submit a new fraud report (POST form or JSON):
```
POST /api/contribute
{ "type": "phone", "value": "08123456789", "reason": "scam", "source": "community-report" }
```

## Deploy

Deploy to Cloudflare Workers:

```bash
CLOUDFLARE_API_TOKEN=... npx wrangler deploy
```

## Data sources

Aggregates community-maintained lists:
- Bank account blacklist (cek-nomor-penipu)
- Phone spam reports (NoCall, rahmansurya/Whatsapp-filter-number)
- Scam website/domain listings

All data is aggregated from public, user-reported sources. Individual sources remain responsible for their own accuracy; AMAN does not verify claims.

## AI analysis

When `CLOUDFLARE_API_TOKEN` is set, AMAN can generate bilingual (EN/ID) risk summaries per lookup using Cloudflare Workers AI.

## License

MIT
