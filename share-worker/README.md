# viveworker-share

Private file hosting for viveworker users. Cloudflare Worker + R2 + KV.

- **Auth:** reuses the A2A relay's user records (`X-A2A-User` + `X-A2A-Key`).
- **Accepted file types:** `.html` / `.htm` / `.pdf` / `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` / `.csv`. SVG is intentionally excluded (script-execution surface, same as HTML).
- **Per-type rendering on view:** HTML passes through, PDFs and images get `Content-Disposition: inline`, CSVs are rendered server-side as an HTML table (opt out with `?raw=1`; `?raw=1&download=1` triggers attachment download).
- **Storage:** one R2 object per upload, keyed by a 16-char base62 slug.
- **URL shape:** `https://share.viveworker.com/v/<slug>`.
- **Crawlers:** blocked via `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` and `robots.txt` `Disallow: /`.
- **Optional:** per-upload password (PBKDF2-SHA256, 10k rounds), expiry (days), or an **x402 payment gate** (testnet USDC / JPYC / USDt — see "Payment" below). Password and payment gates are mutually exclusive on a single share.
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

# 3b. (Optional, paid-share support only) Set the x402 facilitator auth token.
#     Paste an empty string on testnet; paste the Coinbase CDP API key on
#     mainnet. Omit entirely if you're not enabling paid shares.
wrangler secret put X402_FACILITATOR_AUTH

# 3c. (Optional, paid-share support only) Set the closed-beta allowlist.
#     CSV of userIds permitted to attach --price / --pay-to on upload. Unset
#     means block-all (default-deny); pass "*" to open to everyone once paid
#     shares leave beta. Example: echo "alice,bob" | wrangler secret put X402_BETA_ALLOWLIST
wrangler secret put X402_BETA_ALLOWLIST

# 3d. (Optional, metrics support) Set Cloudflare API credentials so the worker
#     can query Analytics Engine on behalf of `share list --metrics`. The API
#     token needs the "Account Analytics: Read" permission scoped to this
#     account. Without both values set, /api/metrics returns 501.
wrangler secret put CF_ACCOUNT_ID
wrangler secret put CF_API_TOKEN

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
| `file` | File | yes | One of `.html` / `.htm` / `.pdf` / `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` / `.csv`, max 5 MB. Magic-byte sniffed per kind (HTML: first non-whitespace byte `<`; PDF: `%PDF`; PNG: 8-byte signature; JPEG: `FF D8`; GIF: `GIF87a` / `GIF89a`; WebP: `RIFF....WEBP`; CSV: no magic). Mismatch → `content-mismatch` 400. |
| `password` | string | no | 1–256 chars; enables password gate. Mutually exclusive with `price` / `payTo` / `paymentOptions`. |
| `price` | string | no | Decimal amount, e.g. `0.10`; must fit the selected asset decimals (6 for USDC, 18 for JPYC, 8 for USDt / L-BTC). Must be supplied with legacy `payTo` or capability-based `paymentOptions`. Min `0.01`, max `1000` asset units per share. |
| `payTo` | string | no | Legacy single-option EVM payout address. 0x-prefixed 40-hex-char address receiving USDC on `X402_NETWORK`. Must be supplied together with `price`. |
| `paymentOptions` | JSON string | no | Capability-based x402 options. Array of `{ network, asset, payTo, scheme?, payoutMethod? }`; currently supports `base-sepolia:usdc`, `polygon-amoy:usdc`, `polygon-amoy:jpyc`, and `liquidtestnet:usdt`. Mainnet networks are rejected until formal release. |
| `expiresDays` | number | no | 1–**30** days; defaults to 30 when omitted. Views return 410 after expiry. Server responds with `{"error":"invalid-expiresDays","maxDays":30}` on out-of-range values. |

Errors:

| HTTP | `error` | Meaning |
|---|---|---|
| 400 | `unsupported-extension` | File extension is not in the allow-list (`allowed` array in the body lists accepted extensions) |
| 400 | `unsupported-content-type` | Declared `Content-Type` doesn't match what the extension implies (body includes `declared` + `expected`) |
| 400 | `content-mismatch` | File body failed the per-kind magic-byte sniff (body includes `kind`) |
| 400 | `price-payTo-both-required` | `price` was not paired with `payTo` or `paymentOptions` |
| 400 | `price-and-password-mutually-exclusive` | Both a password and a price were attached to the same upload |
| 400 | `invalid-price` | Price was not a valid decimal for the selected payment asset |
| 400 | `price-out-of-range` | Price is outside `$0.01`–`$1000` (body includes `minAtomic` + `maxAtomic`) |
| 400 | `invalid-payTo` | `payTo` isn't a 0x-prefixed 40-hex-char EVM address |
| 403 | `paid-shares-closed-beta` | Caller's userId isn't in `X402_BETA_ALLOWLIST`. Body includes `hint` and `network`. |
| 500 | `payment-network-not-configured` | Worker's `X402_NETWORK` var isn't a supported chain name (`base-sepolia` / `polygon-amoy`; mainnet `base` / `polygon` are reserved for formal release) |
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
  "price": "100000",
  "payTo": "0x0000000000000000000000000000000000000000",
  "chainId": 84532,
  "network": "base-sepolia",
  "paymentOptions": [
    { "network": "base-sepolia", "asset": "usdc", "scheme": "exact", "payTo": "0x0000000000000000000000000000000000000000" }
  ],
  "size": 12345,
  "originalName": "report.html",
  "quota": { "bytes": 12345, "maxBytes": 5242880, "count": 1, "maxCount": 10 }
}
```

`price` / `payTo` / `chainId` / `network` are `null` on free shares.

### GET /api/list

Returns the caller's uploads (newest first) plus current quota usage. Also opportunistically reconciles `share_stats` against any slugs whose KV TTL has fired.

```json
{
  "ok": true,
  "items": [{ "slug": "...", "url": "...", "size": 123, "hasPassword": false, ... }],
  "quota": { "bytes": 12345, "maxBytes": 5242880, "count": 1, "maxCount": 10 }
}
```

### GET /api/metrics

Payment-flow metrics for the caller's paid shares, read from Cloudflare Analytics Engine. Returns 24-hour and 7-day event counters plus a per-slug breakdown (top shares by total activity). Requires `CF_ACCOUNT_ID` and `CF_API_TOKEN` secrets on the worker — without them, returns `501 metrics-not-configured`.

```json
{
  "ok": true,
  "userId": "alice",
  "network": "base-sepolia",
  "last24h":  { "upload_paid": 3, "402_served": 12, "paid_view": 8, "paid_cookie_hit": 5, "verify_failed": 1, "facilitator_unavailable": 0, "settle_failed": 0 },
  "last7d":   { "upload_paid": 14, "402_served": 91, "paid_view": 63, "paid_cookie_hit": 42, "verify_failed": 4, "facilitator_unavailable": 1, "settle_failed": 0 },
  "perSlug7d": [
    { "slug": "a1B2c3D4e5F6g7H8", "total": 47, "counts": { "402_served": 18, "paid_view": 15, "paid_cookie_hit": 12, "verify_failed": 2, "upload_paid": 0, "facilitator_unavailable": 0, "settle_failed": 0 } }
  ]
}
```

Events (written via `writeShareEvent` throughout the payment path):

| Event | Emitted when |
|---|---|
| `upload_paid` | New paid share created via `POST /api/upload` with `price`+`payTo`. |
| `402_served` | First-visit GET returned `402 Payment Required` (no cookie, no `X-PAYMENT`). |
| `402_served_head` | HEAD preflight returned 402 with hint headers. |
| `paid_view` | `X-PAYMENT` header settled and content served. |
| `paid_cookie_hit` | Returning buyer's `share_paid` cookie verified; no facilitator round-trip. |
| `verify_failed` | Facilitator rejected the `X-PAYMENT` header (bad signature, expired nonce, wrong amount). |
| `facilitator_unavailable` | Facilitator endpoint was unreachable during verify. |
| `settle_failed` | Settle/broadcast returned non-success after verify passed. |

CLI: `viveworker share list --metrics` appends a "Paid-share metrics" block to the standard file listing.

### PATCH /api/share/:slug — application/json or multipart/form-data

Owner-only update. Use JSON to add/change/remove the password, payment gate, or expiry. Use multipart form data with a `file` field to replace the bytes behind the same public URL.

```json
{
  "password": "new-pw",   // optional; omit to keep. "" or null removes. string sets/replaces.
  "price": "0.20",        // optional; omit to keep. "" or null removes the payment gate entirely (also clears payTo/chainId/paymentSalt). string/number sets or changes.
  "payTo": "0x…",         // optional; required alongside price if the share had no prior payTo. On its own (no `price` key), only legal when a price gate already exists — changes the recipient without rotating paymentSalt.
  "paymentOptions": "[{\"network\":\"polygon-amoy\",\"asset\":\"usdc\",\"payTo\":\"0x…\"}]",
  "expiresDays": 7        // optional; omit to keep. number resets TTL to N days from now. null resets to default 30.
}
```

Multipart fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `file` | File | no | Same validation as upload. Replaces the R2 object under the existing slug and updates `originalName`, `size`, `contentType`, `kind`, and `updatedAtMs`. |
| `password` / `price` / `payTo` / `paymentOptions` / `expiresDays` | string | no | Same semantics as JSON PATCH. Empty `password` clears the password; empty `price` removes the payment gate. |

Notes:
- Changing the password rotates the internal `passwordSalt`, which is folded into the unlock-cookie HMAC. That invalidates every previously issued `share_unlock` cookie for this slug — viewers must re-enter the new password.
- Changing (or setting) `price` rotates `paymentSalt`, invalidating every outstanding `share_paid` cookie for this slug — in-flight paid viewers must re-pay. Changing *only* `payTo` does **not** rotate the salt (paid sessions keep working) and is rejected on shares with no existing price gate (`payTo-without-price`).
- Replacing the file preserves the slug and all gates. If the share has a payment gate, replacement rotates `paymentSalt` so outstanding paid sessions do not automatically unlock the new bytes.
- `price` is mutually exclusive with `password` on v1. Attempting to add a price to a password-protected share returns `price-and-password-mutually-exclusive`.
- `expiresDays` is always relative to *now*, so PATCH both extends and shortens the TTL.
- When `file` is supplied, the R2 object is re-`put` with the new bytes under the existing slug. When only `expiresDays` is touched, the R2 object is re-`put` with the same bytes so R2's `LastModified` advances. The bucket's 90-day lifecycle rule counts from the last modification, and `expiresDays` is capped at 30, so the re-put keeps KV validity within the R2 window even when a user chains PATCH extensions.
- **Revival:** a share that's already past `expiresAtMs` (and therefore returns 410 on `GET /v/<slug>`) can still be resurrected via PATCH with a new `expiresDays`, provided the KV entry (grace period = 60 days past `expiresAtMs`) and the R2 body (90 days past last write) are both still alive. PATCH on an expired share **without** `expiresDays` is rejected (`expired-requires-expiresDays`, 410) — a password-only change on a share that still 410s to viewers is never what the caller wants.
- Rate-limited to **10 patches/hour per user** (`share_stats.patchWindow`, rolling hour; separate bucket from the upload rate limit). Returns `429` with `Retry-After` on the 11th attempt.
- Costs 1 KV read + 2 KV writes (`share:<slug>` + `share_stats:<userId>`) + (if file replaced) 1 R2 Class-A + (if expiry changed without file replacement) 1 R2 Class-B + 1 R2 Class-A.

Errors:

| HTTP | `error` | Meaning |
|---|---|---|
| 400 | `invalid-json` / `invalid-body` / `invalid-form-data` / `no-changes` | Body couldn't be parsed, wasn't an object/form, or had no updatable keys |
| 400 | `invalid-password` / `password-too-long` | Password value is wrong type or > 256 chars |
| 400 | `invalid-expiresDays` | Not a finite number in 1–30 (server also returns `maxDays` in the payload) |
| 400 | `unsupported-extension` / `unsupported-content-type` / `content-mismatch` | Replacement file failed the same validation used by upload |
| 400 | `invalid-price` / `price-out-of-range` / `invalid-payTo` | Same semantics as on upload |
| 400 | `price-payTo-both-required` | Setting a price on a share with no existing payment option requires `payTo` or `paymentOptions` in the same PATCH |
| 400 | `price-and-password-mutually-exclusive` | Tried to add a price to a password-protected share (or vice versa) |
| 400 | `payTo-without-price` | Changed `payTo` on a share that has no active price gate |
| 400 | `payTo-cannot-be-cleared-alone` | Tried to clear `payTo` without also clearing `price` (hint: set `price: null` to remove the whole gate) |
| 403 | `paid-shares-closed-beta` | Caller's userId isn't in `X402_BETA_ALLOWLIST`. Only fires when the PATCH *sets* a price or rotates `payTo`; clearing with `price: null` is always allowed. Body includes `hint` and `network`. |
| 500 | `payment-network-not-configured` | Worker's `X402_NETWORK` var or requested payment option network is not supported |
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
  "originalName": "report.html",
  "updatedAtMs": 1765920300000,
  "fileReplaced": true
}
```

### DELETE /api/share/:slug

Owner-only. Removes the R2 object, the `share:<slug>` KV entry, and updates `share_stats:<userId>`. 404 if slug missing, 403 if the caller is not the owner.

### GET /v/:slug

Serves the uploaded bytes. Gates run in order: **password → payment → format**. If either gate blocks, the format branch is not reached.

| `kind` | Behaviour |
|---|---|
| `html` | Pass-through; `Content-Type: text/html; charset=utf-8`. Legacy shares (no `kind` in metadata) fall into this case. |
| `pdf` | Pass-through; `Content-Type: application/pdf` + `Content-Disposition: inline; filename="<originalName>"`. |
| `image` | Pass-through; `Content-Type` is whatever the extension implies (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) + `Content-Disposition: inline`. |
| `csv` | Default: server-side render to an HTML table (served as `text/html`) with a tight `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, every cell HTML-escaped, 5000-row cap (truncation banner + raw-download link). `?raw=1` returns the original bytes as `text/csv`; `?raw=1&download=1` adds `Content-Disposition: attachment`. |

If the upload has a password, this returns `401` with an unlock form instead. The unlock form POSTs to `/v/:slug/unlock`, which sets an HMAC-signed cookie (`share_unlock`, Path=/v/:slug, 7 days) on success. Programmatic callers can POST `/v/:slug/unlock.json` with the password to mint a short-lived `?t=<token>` URL (see "Agent handoff" in the root CLAUDE.md).

If the upload has a price, this returns `402 Payment Required` with an x402 requirements body (see "Payment" below). Callers supply a signed `X-PAYMENT` header on retry; on successful verify and settle, the share is served with a short-lived `share_paid` cookie + `X-PAYMENT-RESPONSE` header.

## Payment (x402 / payment capabilities) — CLOSED BETA

> **Beta status.** Paid shares can advertise configured testnet capabilities: **Base Sepolia USDC**, **Polygon Amoy USDC / JPYC**, and **Liquid Testnet USDt**. Uploads / PATCHes that attach `price` or rotate payment options from non-allowlisted userIds return `403 paid-shares-closed-beta`. Removing a price (`--no-price` / `price: null`) is always allowed so users who leave the allowlist can wind their shares down cleanly. The 402 HTML page renders a prominent "⚠ CLOSED BETA" banner for testnets so buyers never mistake test assets for real value. Mainnet capabilities (`base`, `polygon`, `liquidv1`) are intentionally rejected until formal release.

Shares uploaded with `price` + `payTo` or `price` + `paymentOptions` are gated by the [x402](https://x402.org) HTTP-native payment protocol. The worker emits spec-compliant `402 Payment Required` responses; any compatible buyer can pay one of the advertised options and unlock the content without viveworker holding any funds.

### Flow

```
Buyer: GET /v/<slug>
    ▼
Worker: 402 Payment Required
        { "x402Version": 1,
          "accepts": [ { "scheme": "exact", "network": "base-sepolia",
                         "maxAmountRequired": "100000", "payTo": "0x742d…",
                         "asset": "0x036C…", "resource": "https://share.viveworker.com/v/<slug>",
                         "extra": { "name": "USDC", "version": "2" }, ... } ],
          "error": "payment-required" }
    ▼
Buyer signs EIP-3009 transferWithAuthorization for the given amount + payTo
    ▼
Buyer: GET /v/<slug>   (X-PAYMENT: <base64(signed payload)>)
    ▼
Worker → facilitator.verify → (valid) → facilitator.settle → serve content
        + Set-Cookie: share_paid=<hmac-token>; Path=/v/<slug>; Max-Age=900; HttpOnly; Secure; SameSite=Lax
        + X-PAYMENT-RESPONSE: <base64(preview-json)>
```

The `share_paid` cookie is an HMAC-signed token (same format as the `share_unlock` flow, but keyed by the share's `paymentSalt` instead of `passwordSalt`). It lasts **15 minutes** — short, because paid content is sensitive and re-paying costs pennies. Rotating the price via `PATCH` rotates `paymentSalt`, immediately invalidating every outstanding paid session for that slug.

### Worker config

| Key | Kind | Value |
|---|---|---|
| `X402_NETWORK` | `[vars]` in `wrangler.toml` | Legacy single-option default. Use `"base-sepolia"` or `"polygon-amoy"` for dogfooding; mainnet values are reserved for formal release. |
| `X402_FACILITATOR_URL` | `[vars]` in `wrangler.toml` | `"https://x402.org/facilitator"` on testnet; the Coinbase CDP URL on mainnet |
| `X402_FACILITATOR_AUTH` | Worker secret | Empty string on testnet; CDP API key on mainnet (`wrangler secret put X402_FACILITATOR_AUTH`) |
| `X402_BETA_ALLOWLIST` | Worker secret | CSV of userIds permitted to attach `price` / `payTo`. Unset → block-all (default-deny). `"*"` → open to everyone (flip this when paid shares leave beta). Example: `echo "alice,bob" \| wrangler secret put X402_BETA_ALLOWLIST` |
| `CF_ACCOUNT_ID` | Worker secret | Cloudflare account ID for the `share list --metrics` REST call. |
| `CF_API_TOKEN` | Worker secret | API token scoped to "Account Analytics: Read" on this account. Without both this and `CF_ACCOUNT_ID`, `/api/metrics` returns 501 `metrics-not-configured`. |

Legacy `payTo` uploads use `X402_NETWORK` for chain selection. Capability-based uploads store `paymentOptions[]` on the share and can advertise multiple networks or assets at once. EVM asset addresses and EIP-712 domain fields are derived by backend-api's payment registry; Liquid options are delegated to backend-api's Liquid x402 path.

### Observability

Payment events flow through Cloudflare Analytics Engine (binding `ANALYTICS`, dataset `viveworker_share_events`). Events: `upload_paid`, `402_served`, `402_served_head`, `paid_view`, `paid_cookie_hit`, `verify_failed`, `facilitator_unavailable`, `settle_failed`. Schema: `index1=slug`, `blob1=event`, `blob2=userId`, `blob3=network`, `blob4=reason`. Free tier is 10M datapoints/day — per-view KV counters would have crushed the 1k writes/day budget long before Analytics Engine noticed.

Sellers read their own metrics via `share list --metrics` (hits `GET /api/metrics` → `queryShareAnalytics` → CF REST SQL). 24h + 7d windows, plus a per-slug breakdown ranked by activity.

### Buyer reference (CLI)

The viveworker CLI ships buyer flows for EVM exact payments and Liquid PSET payments. For EVM networks such as Base Sepolia and Polygon Amoy, it reads `VIVEWORKER_BUYER_PRIVATE_KEY` or `BUYER_PK`, signs an EIP-3009 authorization, retries with `X-PAYMENT`, and optionally writes the unlocked bytes. It can also use the local hazBase Smart Wallet flow with `--wallet hazbase`; that path asks the paired device for Passkey reauth and returns a hazBase-issued `X-PAYMENT` proof after the Smart Wallet payment settles. For Liquid, use `--wallet liquid` with the `VIVEWORKER_LIQUID_*` RPC settings.

By default, the CLI is human-in-the-loop: after it parses the 402 requirements
and before it signs, it sends the amount, recipient, network, and resource URL
to the paired viveworker device and waits for approval. Use `--dry-run` for a
read-only inspection and `--no-approval` / `--yes` only for trusted smoke tests
or CI.

```bash
node scripts/viveworker.mjs share pay https://share.viveworker.com/v/<slug> --dry-run

VIVEWORKER_BUYER_PRIVATE_KEY=0x... \
  node scripts/viveworker.mjs share pay https://share.viveworker.com/v/<slug> \
  --output ./paid-report.pdf

node scripts/viveworker.mjs share pay https://share.viveworker.com/v/<slug> \
  --wallet hazbase \
  --output ./paid-report.pdf
```

### Buyer reference (Node.js)

For library-style clients, the same flow works with `x402-fetch`:

```js
import { wrapFetchWithPayment } from "x402-fetch";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const wallet = createWalletClient({
  account: privateKeyToAccount(process.env.BUYER_PK),
  chain: baseSepolia,
  transport: http(),
});

const fetchPaid = wrapFetchWithPayment(fetch, wallet);
const res = await fetchPaid("https://share.viveworker.com/v/<slug>");
console.log(res.status);                                // 200 on first pay, 200 on subsequent (cookie)
console.log(res.headers.get("x-payment-response"));     // base64-encoded settlement preview
console.log((await res.text()).slice(0, 200));
```

### Trust model

**Pay-first, non-custodial.** viveworker never holds funds. The buyer pays the seller's wallet directly via the facilitator-broadcast transaction; the worker only checks that the signature and amount match what was requested. There is no escrow and no dispute resolution — if the delivered content doesn't match expectations, the buyer's only recourse is to stop buying from that seller. For `$0.01`–`$1000` per-share deliverables between cooperating agents, this is the intended trade-off.

**Facilitator-down behaviour.** If the configured facilitator is unreachable, the worker returns `402` with `error: "facilitator-unavailable"` — the content never leaks, but paid buyers retry later. Each unreachable event also writes a `facilitator_unavailable` datapoint to Analytics Engine so `share list --metrics` surfaces the incident count alongside normal traffic.

## CLI

See `scripts/share-cli.mjs` (invoked via `viveworker share ...`). Commands: `upload`, `list` (pass `--metrics` for payment-flow stats), `update`, `link`, `delete`. The CLI mirrors the worker's accepted-type allow-list — keep `SHARE_TYPES` in both files in sync.

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
