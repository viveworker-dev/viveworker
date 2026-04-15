# viveworker-share

Private HTML hosting for viveworker users. Cloudflare Worker + R2 + KV.

- **Auth:** reuses the A2A relay's user records (`X-A2A-User` + `X-A2A-Key`).
- **Storage:** one R2 object per upload, keyed by a 16-char base62 slug.
- **URL shape:** `https://share.viveworker.com/v/<slug>`.
- **Crawlers:** blocked via `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` and `robots.txt` `Disallow: /`.
- **Optional:** per-upload password (PBKDF2-SHA256, 10k rounds) and expiry (days).
- **Per-user limits:** 5 MB total, 10 live files, 10 uploads/hour (rolling), 5 MB per file. Uploads default to a 30-day TTL when `expiresDays` is omitted.

## Architecture

```
CLI (viveworker share upload)
    │  POST /api/upload  (X-A2A-User + X-A2A-Key)
    ▼
share-worker (Cloudflare Worker)
    │
    ├── validate creds against USERS_KV (A2A relay's KV, read-only)
    ├── load share_stats:<userId> → enforce quota + rate limit
    ├── write bytes to R2 bucket SHARE_FILES / <slug>
    └── write metadata to SHARE_KV
           share:<slug>                → JSON (file metadata)
           share_stats:<userId>        → { bytes, count, files, rateWindow }

Recipient
    │  GET https://share.viveworker.com/v/<slug>
    ▼
share-worker → reads R2 object → serves HTML (with no-store, no-index headers)
```

## Deployment (one-time)

```bash
cd share-worker

# 1. Create KV namespace for share metadata
wrangler kv namespace create SHARE_KV
wrangler kv namespace create SHARE_KV --preview
# → paste the returned `id` and `preview_id` into wrangler.toml

# 2. Create R2 bucket
wrangler r2 bucket create viveworker-share-files
wrangler r2 bucket create viveworker-share-files-preview

# 3. Set the HMAC secret for unlock cookies
openssl rand -hex 32 | wrangler secret put SHARE_SECRET

# 4. Deploy
wrangler deploy

# 5. (First time only) Point share.viveworker.com at the Worker
#    The route in wrangler.toml handles this automatically, but the DNS
#    record for `share` (CNAME → viveworker-share.<account>.workers.dev,
#    proxied through Cloudflare) must exist in the zone.
```

## API

All write endpoints require these headers:

```
X-A2A-User: <your viveworker user id>
X-A2A-Key:  <your A2A_API_KEY from ~/.viveworker/a2a.env>
```

### POST /api/upload — multipart/form-data

| Field | Type | Required | Notes |
|---|---|---|---|
| `file` | File | yes | `.html` or `.htm`, max 5 MB, must start with `<` after optional BOM/whitespace |
| `password` | string | no | 1–256 chars; enables password gate |
| `expiresDays` | number | no | 1–365 days; defaults to **30** when omitted. Views return 410 after expiry. |

Errors:

| HTTP | `error` | Meaning |
|---|---|---|
| 413 | `file-too-large` | File exceeds 5 MB |
| 413 | `quota-exceeded` | User would exceed the 5 MB total cap |
| 409 | `file-count-exceeded` | User already has 10 live files |
| 429 | `rate-limited` | User made 10 uploads in the last hour (`retryAfterSec` in body and `Retry-After` header) |

Response:
```json
{
  "ok": true,
  "slug": "a1B2c3D4e5F6g7H8",
  "url": "https://share.viveworker.com/v/a1B2c3D4e5F6g7H8",
  "createdAtMs": 1765920000000,
  "expiresAtMs": 1768512000000,
  "hasPassword": false,
  "size": 12345,
  "originalName": "report.html",
  "quota": { "bytes": 12345, "maxBytes": 5242880, "count": 1, "maxCount": 10 }
}
```

### GET /api/list

Returns the caller's uploads (newest first) plus current quota usage. Also opportunistically reconciles `share_stats` against any slugs whose KV TTL has fired.

```json
{
  "ok": true,
  "items": [{ "slug": "...", "url": "...", "size": 123, "hasPassword": false, ... }],
  "quota": { "bytes": 12345, "maxBytes": 5242880, "count": 1, "maxCount": 10 }
}
```

### DELETE /api/share/:slug

Owner-only. Removes the R2 object, the `share:<slug>` KV entry, and updates `share_stats:<userId>`. 404 if slug missing, 403 if the caller is not the owner.

### GET /v/:slug

Serves the HTML. If the upload has a password, this returns `401` with an unlock form instead. The unlock form POSTs to `/v/:slug/unlock`, which sets an HMAC-signed cookie (`share_unlock`, Path=/v/:slug, 7 days) on success.

## CLI

See `scripts/share-cli.mjs` (invoked via `viveworker share ...`). Commands: `upload`, `list`, `delete`.

## Free-tier capacity

- **Workers:** 100k requests / day — each upload = 1 req, each view = 1 req.
- **R2:** 10 GB storage + free egress. With a 5 MB per-user cap and auto-expiry after 30 days, storage is effectively bounded.
- **KV:** 100k reads + 1k writes + 1k deletes + 1k lists / day.
  - Upload: 1 read (`share_stats`) + 2 writes (`share:<slug>` + `share_stats`) → ≤ 500 uploads/day before writes run out.
  - View: 1 read.
  - Delete: 1 read (`share:<slug>`) + 1 read (`share_stats`) + 1 write (`share_stats`) + 2 deletes (R2 + `share:<slug>`).
  - List: 1 read (`share_stats`) + N reads (per live file). No `.list()` calls — the file set lives inside `share_stats`.
- **Per-user quota:** 5 MB total, 10 files, 10 uploads/hour.

For personal/agent-volume usage, this easily fits free tier.
