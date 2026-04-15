# viveworker-share

Private HTML hosting for viveworker users. Cloudflare Worker + R2 + KV.

- **Auth:** reuses the A2A relay's user records (`X-A2A-User` + `X-A2A-Key`).
- **Storage:** one R2 object per upload, keyed by a 16-char base62 slug.
- **URL shape:** `https://share.viveworker.com/v/<slug>`.
- **Crawlers:** blocked via `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` and `robots.txt` `Disallow: /`.
- **Optional:** per-upload password (PBKDF2-SHA256, 10k rounds) and expiry (days).
- **Per-user limits:** 5 MB total, 10 live files, 10 uploads/hour (rolling), 10 patches/hour (rolling, separate bucket), 5 MB per file. Uploads default to a 30-day TTL when `expiresDays` is omitted.
- **R2 lifecycle:** all objects in `viveworker-share-files` are unconditionally deleted after 90 days of inactivity (enforced by Cloudflare R2, not the Worker). Max `expiresDays` is capped to 30 so KV TTL stays well inside the lifecycle window; PATCH extensions re-`put` the object so the 90-day countdown resets. See the Deployment section for the `wrangler r2 bucket lifecycle add` command.
- **Grace period:** KV metadata lives for `expiresAtMs + 60 days`, so an already-expired share is still revivable via `PATCH /api/share/:slug` with a new `expiresDays` (as long as R2 hasn't reaped the body). `GET /v/<slug>` is strict — it still returns `410 Expired` past `expiresAtMs` until a revival PATCH lands.

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
           share_stats:<userId>        → { bytes, count, files, rateWindow, patchWindow }

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

# 5. Add the R2 lifecycle rule so orphaned objects are auto-deleted.
#    Max `expiresDays` on upload/PATCH is 30, and PATCH re-puts the R2 object
#    whenever expiry is touched (resetting LastModified). 90 days of buffer
#    keeps the KV-valid / R2-present invariant intact even if the window
#    evaluator fires late, while minimising the orphan tail.
wrangler r2 bucket lifecycle add viveworker-share-files expire-orphans \
  --expire-days 90 --force

# 6. (First time only) Point share.viveworker.com at the Worker
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
| `expiresDays` | number | no | 1–**30** days; defaults to 30 when omitted. Views return 410 after expiry. Server responds with `{"error":"invalid-expiresDays","maxDays":30}` on out-of-range values. |

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

### PATCH /api/share/:slug — application/json

Owner-only metadata update. Use it to add/change/remove the password or reset the expiry without re-uploading.

```json
{
  "password": "new-pw",   // optional; omit to keep. "" or null removes. string sets/replaces.
  "expiresDays": 7        // optional; omit to keep. number resets TTL to N days from now. null resets to default 30.
}
```

Notes:
- Changing the password rotates the internal `passwordSalt`, which is folded into the unlock-cookie HMAC. That invalidates every previously issued `share_unlock` cookie for this slug — viewers must re-enter the new password.
- `expiresDays` is always relative to *now*, so PATCH both extends and shortens the TTL.
- When `expiresDays` is touched, the R2 object is re-`put` with the same bytes so R2's `LastModified` advances. The bucket's 90-day lifecycle rule counts from the last modification, and `expiresDays` is capped at 30, so the re-put keeps KV validity within the R2 window even when a user chains PATCH extensions.
- **Revival:** a share that's already past `expiresAtMs` (and therefore returns 410 on `GET /v/<slug>`) can still be resurrected via PATCH with a new `expiresDays`, provided the KV entry (grace period = 60 days past `expiresAtMs`) and the R2 body (90 days past last write) are both still alive. PATCH on an expired share **without** `expiresDays` is rejected (`expired-requires-expiresDays`, 410) — a password-only change on a share that still 410s to viewers is never what the caller wants.
- Rate-limited to **10 patches/hour per user** (`share_stats.patchWindow`, rolling hour; separate bucket from the upload rate limit). Returns `429` with `Retry-After` on the 11th attempt.
- Costs 1 KV read + 2 KV writes (`share:<slug>` + `share_stats:<userId>`) + (if expiry changed) 1 R2 Class-B + 1 R2 Class-A.

Errors:

| HTTP | `error` | Meaning |
|---|---|---|
| 400 | `invalid-json` / `invalid-body` / `no-changes` | Body couldn't be parsed, wasn't an object, or had no updatable keys |
| 400 | `invalid-password` / `password-too-long` | Password value is wrong type or > 256 chars |
| 400 | `invalid-expiresDays` | Not a finite number in 1–30 (server also returns `maxDays` in the payload) |
| 403 | `forbidden` | Caller is not the owner |
| 404 | `not-found` | Slug does not exist |
| 410 | `expired-requires-expiresDays` | Share is past its `expiresAtMs`; supply `expiresDays` to revive (server also returns `maxDays`) |
| 410 | `object-missing` | R2 lifecycle already removed the body — share is effectively dead |
| 429 | `rate-limited` | 10 patches in the last hour; `scope: "patch"`, `retryAfterSec` in body and `Retry-After` header |

Response:
```json
{
  "ok": true,
  "slug": "a1B2c3D4e5F6g7H8",
  "url": "https://share.viveworker.com/v/a1B2c3D4e5F6g7H8",
  "createdAtMs": 1765920000000,
  "expiresAtMs": 1768512000000,
  "hasPassword": true,
  "size": 12345,
  "originalName": "report.html"
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
- **R2:** 10 GB storage + free egress. With a 5 MB per-user cap, 30-day hard cap on `expiresDays`, and a 90-day unconditional lifecycle rule on the bucket, storage is tightly bounded (orphan tail ≤ 90 days).
  - Class A (writes/copy/delete) free tier: 1M/month. Upload = 1, Patch (with expiry change) = 1, Delete = 1.
  - Class B (get/head) free tier: 10M/month. View = 1, Patch (with expiry change) = 1.
- **KV:** 100k reads + 1k writes + 1k deletes + 1k lists / day.
  - Upload: 1 read (`share_stats`) + 2 writes (`share:<slug>` + `share_stats`) → ≤ 500 uploads/day before writes run out.
  - View: 1 read.
  - Patch: 2 reads (`share:<slug>` + `share_stats`) + 2 writes (`share:<slug>` + `share_stats`) → patch-rate-limited to 10/hour/user, well inside the 1k/day write budget.
  - Delete: 1 read (`share:<slug>`) + 1 read (`share_stats`) + 1 write (`share_stats`) + 2 deletes (R2 + `share:<slug>`).
  - List: 1 read (`share_stats`) + N reads (per live file). No `.list()` calls — the file set lives inside `share_stats`.
- **Per-user quota:** 5 MB total, 10 files, 10 uploads/hour, 10 patches/hour.

For personal/agent-volume usage, this easily fits free tier.
