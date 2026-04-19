/**
 * share-cli.mjs — CLI for viveworker's file-share hosting service.
 *
 * Reads credentials from `~/.viveworker/a2a.env` (same creds as the A2A relay).
 *
 * Accepted file types (mirrors share-worker/worker.js SHARE_TYPES):
 *   .html .htm .pdf .png .jpg .jpeg .gif .webp .csv
 *
 * Commands:
 *   viveworker share upload <file> [--password <pw>] [--price <usd> --pay-to <0x…>] [--expires-days <n>] [--no-optimize] [--json]
 *   viveworker share list [--json]
 *   viveworker share update <slug> [--password <pw>] [--no-password] [--price <usd>] [--no-price] [--pay-to <0x…>] [--expires-days <n>] [--json]
 *   viveworker share link <slug> --password <pw> [--ttl-hours <n>] [--json]
 *   viveworker share delete <slug>
 *
 * Paid shares: `--price 0.10 --pay-to 0x…` attaches an x402 payment gate.
 * Buyers hit HTTP 402 on first view, pay USDC on Base (testnet or mainnet
 * depending on worker config), and the worker serves the content. Any
 * x402-compatible client (e.g. `x402-fetch` on npm) can pay; viveworker
 * itself does not currently ship a buyer wallet.
 *
 * Environment overrides:
 *   VIVEWORKER_SHARE_URL — share worker base URL (default: https://share.viveworker.com)
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Blob, File } from "node:buffer";

const A2A_ENV_FILE = path.join(os.homedir(), ".viveworker", "a2a.env");
const DEFAULT_SHARE_URL = "https://share.viveworker.com";
const MAX_FILE_SIZE = 5 * 1024 * 1024; // mirror worker

// Mirror share-worker/worker.js SHARE_TYPES. Keep in sync by inspection —
// scripts/ and share-worker/ don't share a module. Adding a new type here
// without the worker will cause 400 unsupported-extension on upload.
const SHARE_TYPES = {
  ".html": { mime: "text/html; charset=utf-8" },
  ".htm":  { mime: "text/html; charset=utf-8" },
  ".pdf":  { mime: "application/pdf" },
  ".png":  { mime: "image/png" },
  ".jpg":  { mime: "image/jpeg" },
  ".jpeg": { mime: "image/jpeg" },
  ".gif":  { mime: "image/gif" },
  ".webp": { mime: "image/webp" },
  ".csv":  { mime: "text/csv; charset=utf-8" },
};
const ALLOWED_EXTENSIONS = Object.keys(SHARE_TYPES);

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function runShareCli(args) {
  const cmd = args[0];

  switch (cmd) {
    case "upload":
      return handleUpload(args.slice(1));
    case "list":
      return handleList(args.slice(1));
    case "update":
      return handleUpdate(args.slice(1));
    case "link":
      return handleLink(args.slice(1));
    case "delete":
    case "rm":
      return handleDelete(args.slice(1));
    default:
      printHelp();
      if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") {
        throw new Error(`Unknown command: ${cmd}`);
      }
  }
}

function printHelp() {
  console.log("Commands:");
  console.log("  viveworker share upload <file> [--password <pw>] [--price <usd> --pay-to <0x…>] [--expires-days <n>] [--no-optimize] [--json]");
  console.log("  viveworker share list [--metrics] [--json]");
  console.log("  viveworker share update <slug> [--password <pw>] [--no-password] [--price <usd>] [--no-price] [--pay-to <0x…>] [--expires-days <n>] [--json]");
  console.log("  viveworker share link <slug> --password <pw> [--ttl-hours <n>] [--json]");
  console.log("  viveworker share delete <slug>");
  console.log("");
  console.log(`Accepted file types: ${ALLOWED_EXTENSIONS.join(" / ")}`);
  console.log("CSV files are rendered as an HTML table on view; append ?raw=1 for bytes.");
  console.log("HTML uploads are optimized by default when possible (use --no-optimize to disable).");
  console.log("");
  console.log("Paid shares (x402 / USDC on Base — CLOSED BETA, testnet only): --price 0.10 --pay-to 0x…");
  console.log("  Buyers use any x402-compatible client (e.g. `x402-fetch` on npm).");
  console.log("  --price and --password are mutually exclusive on a single share.");
  console.log("  `share list --metrics` prints 24h / 7d payment-flow stats for your shares.");
  console.log("");
  console.log("Credentials are read from ~/.viveworker/a2a.env (same as `viveworker a2a`).");
}

const PRICE_REGEX = /^\d+(\.\d{1,6})?$/;
const ETH_ADDR_REGEX = /^0x[0-9a-fA-F]{40}$/;

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------

async function handleUpload(args) {
  const flags = parseFlags(args);
  const filePath = flags._[0];
  if (!filePath) {
    throw new Error("Usage: viveworker share upload <file> [--password <pw>] [--expires-days <n>]");
  }

  const absolute = path.resolve(filePath);
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }
  if (stat.size === 0) {
    throw new Error(`File is empty: ${filePath}`);
  }
  const ext = path.extname(absolute).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Accepted file types: ${ALLOWED_EXTENSIONS.join(" / ")}. ` +
      `Got: ${ext || "(no extension)"}`
    );
  }
  const { mime } = SHARE_TYPES[ext];

  const password = flags["password"] || "";
  const expiresDays = flags["expires-days"] || flags["expiresDays"] || "";
  const price = flags["price"] || "";
  const payTo = flags["pay-to"] || flags["payTo"] || "";

  if (password && password.length > 256) {
    throw new Error("Password too long (max 256 chars)");
  }
  if (expiresDays) {
    const n = Number(expiresDays);
    if (!Number.isFinite(n) || n <= 0 || n > 30) {
      throw new Error("--expires-days must be a number between 1 and 30");
    }
  }

  // --price / --pay-to are both required or both absent.
  const anyPrice = Boolean(price);
  const anyPayTo = Boolean(payTo);
  if (anyPrice !== anyPayTo) {
    throw new Error("--price and --pay-to must be supplied together");
  }
  if (anyPrice) {
    if (!PRICE_REGEX.test(price)) {
      throw new Error("--price must be a decimal with ≤6 fractional digits (e.g. `0.10`)");
    }
    if (!ETH_ADDR_REGEX.test(payTo)) {
      throw new Error("--pay-to must be a 0x-prefixed 40-hex-char EVM address");
    }
    if (password) {
      throw new Error("--price and --password cannot be combined on a single share");
    }
  }

  const { apiKey, userId, shareUrl } = await resolveCredentials();

  const originalBytes = await fs.readFile(absolute);
  const optimization =
    flags["no-optimize"] || flags["noOptimize"]
      ? { bytes: originalBytes, info: null }
      : maybeOptimizeUpload({ absolute, ext, bytes: originalBytes });
  const bytes = optimization.bytes;
  if (bytes.length > MAX_FILE_SIZE) {
    const detail = optimization.info
      ? ` after optimization to ${formatSize(bytes.length)}`
      : "";
    throw new Error(`File too large (${originalBytes.length} bytes, max ${MAX_FILE_SIZE})${detail}`);
  }
  const form = new FormData();
  const blob = new Blob([bytes], { type: mime });
  const file = new File([blob], path.basename(absolute), { type: mime });
  form.set("file", file);
  if (password) form.set("password", password);
  if (expiresDays) form.set("expiresDays", String(expiresDays));
  if (anyPrice) {
    form.set("price", price);
    form.set("payTo", payTo);
  }

  const res = await fetchWithTimeout(`${shareUrl}/api/upload`, {
    method: "POST",
    headers: {
      "x-a2a-user": userId,
      "x-a2a-key": apiKey,
    },
    body: form,
  }, 60_000);

  const body = await readJson(res);
  if (!res.ok || body.error) {
    throw new Error(formatApiError("Upload", res.status, body));
  }

  if (flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log("");
  console.log(`✅ Uploaded ${body.originalName || path.basename(absolute)} (${formatSize(body.size)})`);
  console.log("");
  if (optimization.info) {
    console.log(
      `   Optimized HTML: ${formatSize(optimization.info.originalBytes)} → ${formatSize(optimization.info.optimizedBytes)}`
    );
    console.log(
      `   Removed embedded fonts: ${optimization.info.removedFonts}`
    );
    console.log("");
  }
  console.log(`   ${body.url}`);
  console.log("");
  if (body.hasPassword) console.log(`   🔒 Password-protected`);
  if (body.price && body.payTo) {
    console.log(`   💰 Paid — ${formatUsdc(body.price)} USDC on ${body.network || "?"} → ${body.payTo}`);
  }
  if (body.expiresAtMs) console.log(`   ⏱  Expires ${new Date(body.expiresAtMs).toISOString()}`);
  if (body.hasPassword || body.price || body.expiresAtMs) console.log("");
  console.log(`   Slug: ${body.slug}`);
  console.log(`   Delete: viveworker share delete ${body.slug}`);
  if (body.quota) {
    console.log(
      `   Quota: ${formatSize(body.quota.bytes)} / ${formatSize(body.quota.maxBytes)} · ${body.quota.count}/${body.quota.maxCount} files`
    );
  }
  console.log("");
}

function maybeOptimizeUpload({ absolute, ext, bytes }) {
  if (ext !== ".html" && ext !== ".htm") {
    return { bytes, info: null };
  }

  const source = bytes.toString("utf8");
  const optimized = optimizeBundledStandaloneHtml(source);
  if (!optimized) {
    return { bytes, info: null };
  }

  const optimizedBytes = Buffer.from(optimized.html, "utf8");
  if (optimizedBytes.length >= bytes.length) {
    return { bytes, info: null };
  }

  return {
    bytes: optimizedBytes,
    info: {
      kind: "bundled-standalone-html",
      removedFonts: optimized.removedFonts,
      originalBytes: bytes.length,
      optimizedBytes: optimizedBytes.length,
      file: absolute,
    },
  };
}

function optimizeBundledStandaloneHtml(source) {
  const manifestTagPattern = /(<script\b[^>]*type="__bundler\/manifest"[^>]*>)([\s\S]*?)(<\/script>)/i;
  const templateTagPattern = /(<script\b[^>]*type="__bundler\/template"[^>]*>)([\s\S]*?)(<\/script>)/i;
  const manifestMatch = source.match(manifestTagPattern);
  const templateMatch = source.match(templateTagPattern);
  if (!manifestMatch || !templateMatch) {
    return null;
  }

  let manifest;
  let template;
  try {
    manifest = JSON.parse(manifestMatch[2]);
    template = JSON.parse(templateMatch[2]);
  } catch {
    return null;
  }

  const fontUuids = Object.entries(manifest)
    .filter(([, entry]) => entry?.mime === "font/woff2")
    .map(([uuid]) => uuid);
  if (fontUuids.length === 0) {
    return null;
  }

  for (const uuid of fontUuids) {
    delete manifest[uuid];
    const escapedUuid = escapeRegExp(uuid);
    template = template.replace(
      new RegExp(`@font-face\\s*\\{[^{}]*${escapedUuid}[^{}]*\\}`, "g"),
      "",
    );
    template = template.split(uuid).join("");
  }

  let html = source.replace(
    manifestTagPattern,
    (_, openTag, _json, closeTag) => `${openTag}${stringifyForHtmlScriptTag(manifest)}${closeTag}`,
  );
  html = html.replace(
    templateTagPattern,
    (_, openTag, _json, closeTag) => `${openTag}${stringifyForHtmlScriptTag(template)}${closeTag}`,
  );

  return {
    html,
    removedFonts: fontUuids.length,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stringifyForHtmlScriptTag(value) {
  return JSON.stringify(value)
    .replace(/<\//g, "<\\/")
    .replace(/<!--/g, "<\\!--")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function handleList(args) {
  const flags = parseFlags(args);
  const wantsMetrics = Boolean(flags.metrics);
  const { apiKey, userId, shareUrl } = await resolveCredentials();

  // Fire both requests in parallel when --metrics is set; the file list is
  // authoritative, the metrics bucket is best-effort (it 501s when the
  // worker's CF_ACCOUNT_ID / CF_API_TOKEN secrets aren't configured).
  const listReq = fetchWithTimeout(`${shareUrl}/api/list`, {
    method: "GET",
    headers: { "x-a2a-user": userId, "x-a2a-key": apiKey },
  }, 30_000);
  const metricsReq = wantsMetrics
    ? fetchWithTimeout(`${shareUrl}/api/metrics`, {
        method: "GET",
        headers: { "x-a2a-user": userId, "x-a2a-key": apiKey },
      }, 30_000).catch((err) => ({ _netErr: String(err?.message || err) }))
    : null;

  const res = await listReq;
  const body = await readJson(res);
  if (!res.ok || body.error) {
    throw new Error(formatApiError("List", res.status, body));
  }

  let metricsBody = null;
  let metricsErr = null;
  if (metricsReq) {
    const mRes = await metricsReq;
    if (mRes && mRes._netErr) {
      metricsErr = `metrics fetch failed: ${mRes._netErr}`;
    } else {
      metricsBody = await readJson(mRes);
      if (!mRes.ok || metricsBody?.error) {
        metricsErr = formatApiError("Metrics", mRes.status, metricsBody);
        metricsBody = null;
      }
    }
  }

  const items = body.items || [];

  if (flags.json) {
    const combined = wantsMetrics
      ? { ...body, metrics: metricsBody, metricsError: metricsErr }
      : body;
    console.log(JSON.stringify(combined, null, 2));
    return;
  }

  if (items.length === 0) {
    if (body.quota) {
      console.log(
        `(no uploads yet) — quota: ${formatSize(body.quota.bytes)} / ${formatSize(body.quota.maxBytes)} · ${body.quota.count}/${body.quota.maxCount} files`
      );
    } else {
      console.log("(no uploads yet)");
    }
    if (wantsMetrics) printMetricsSection(metricsBody, metricsErr);
    return;
  }

  const now = Date.now();
  const quotaLine = body.quota
    ? ` — quota: ${formatSize(body.quota.bytes)} / ${formatSize(body.quota.maxBytes)} · ${body.quota.count}/${body.quota.maxCount} files`
    : "";
  console.log(`\nYour shared files (${items.length})${quotaLine}:\n`);
  for (const item of items) {
    const age = formatRelative(now - (item.createdAtMs || now));
    const size = formatSize(item.size || 0);
    const gateIcon = item.hasPassword
      ? "🔒"
      : item.price
      ? "💰"
      : "  ";
    const expiry = item.expiresAtMs ? ` · exp ${new Date(item.expiresAtMs).toISOString().slice(0, 10)}` : "";
    console.log(`  ${gateIcon} ${item.slug}  ${size.padStart(8)}  ${age.padStart(10)}${expiry}`);
    console.log(`     ${item.url}`);
    if (item.originalName) console.log(`     ${item.originalName}`);
    if (item.price && item.payTo) {
      console.log(`     💰 ${formatUsdc(item.price)} USDC on ${item.network || "?"} → ${item.payTo}`);
    }
    console.log("");
  }

  if (wantsMetrics) printMetricsSection(metricsBody, metricsErr);
}

// Pretty-prints the Analytics Engine summary returned by GET /api/metrics.
// Kept inline with handleList because it's only invoked from there; lifting it
// into its own subcommand would duplicate auth + formatters for no real gain.
function printMetricsSection(metrics, err) {
  console.log("Paid-share metrics");
  if (err) {
    console.log(`  ⚠ ${err}`);
    console.log("");
    return;
  }
  if (!metrics) {
    console.log("  ⚠ no data returned from /api/metrics");
    console.log("");
    return;
  }
  const networkLabel = metrics.network ? ` on ${metrics.network}` : "";
  console.log(`  (x402 closed beta${networkLabel})`);
  console.log("");
  const labels = {
    upload_paid: "paid shares uploaded",
    "402_served": "402 responses served (GET)",
    "402_served_head": "402 responses served (HEAD)",
    paid_view: "verified paid views",
    paid_cookie_hit: "paid session reloads",
    verify_failed: "verification rejections",
    facilitator_unavailable: "facilitator unreachable",
    settle_failed: "async settle failures",
  };
  const pad = Math.max(...Object.values(labels).map((s) => s.length));
  const row = (label, d, w) => {
    const padded = label.padEnd(pad);
    const dStr = String(d).padStart(6);
    const wStr = String(w).padStart(6);
    console.log(`  ${padded}   24h ${dStr}   · 7d ${wStr}`);
  };
  for (const [k, label] of Object.entries(labels)) {
    row(label, metrics.last24h?.[k] ?? 0, metrics.last7d?.[k] ?? 0);
  }
  const perSlug = Array.isArray(metrics.perSlug7d) ? metrics.perSlug7d : [];
  if (perSlug.length > 0) {
    console.log("");
    console.log(`  Per-share (last 7d, top ${Math.min(5, perSlug.length)}):`);
    for (const entry of perSlug.slice(0, 5)) {
      const c = entry.counts || {};
      const views = (c.paid_view || 0) + (c.paid_cookie_hit || 0);
      const fails = (c.verify_failed || 0) + (c.facilitator_unavailable || 0) + (c.settle_failed || 0);
      const fourOhTwos = (c["402_served"] || 0) + (c["402_served_head"] || 0);
      console.log(
        `    ${entry.slug}  views=${views}  402=${fourOhTwos}  fails=${fails}`
      );
    }
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function handleUpdate(args) {
  const flags = parseFlags(args);
  const slug = flags._[0];
  if (!slug) {
    throw new Error(
      "Usage: viveworker share update <slug> [--password <pw>] [--no-password] [--price <usd>] [--no-price] [--pay-to <0x…>] [--expires-days <n>]"
    );
  }
  if (!/^[A-Za-z0-9]+$/.test(slug)) {
    throw new Error(`Invalid slug: ${slug}`);
  }

  const hasPassword = Object.prototype.hasOwnProperty.call(flags, "password");
  const hasNoPassword = Object.prototype.hasOwnProperty.call(flags, "no-password");
  const hasExpires = Object.prototype.hasOwnProperty.call(flags, "expires-days") ||
    Object.prototype.hasOwnProperty.call(flags, "expiresDays");
  const hasPrice = Object.prototype.hasOwnProperty.call(flags, "price");
  const hasNoPrice = Object.prototype.hasOwnProperty.call(flags, "no-price") ||
    Object.prototype.hasOwnProperty.call(flags, "noPrice");
  const hasPayTo = Object.prototype.hasOwnProperty.call(flags, "pay-to") ||
    Object.prototype.hasOwnProperty.call(flags, "payTo");

  if (hasPassword && hasNoPassword) {
    throw new Error("Pass either --password OR --no-password, not both");
  }
  if (hasPrice && hasNoPrice) {
    throw new Error("Pass either --price OR --no-price, not both");
  }
  if (hasPrice && hasPassword) {
    throw new Error("--price and --password cannot be combined on a single share");
  }
  if (!hasPassword && !hasNoPassword && !hasExpires && !hasPrice && !hasNoPrice && !hasPayTo) {
    throw new Error(
      "Nothing to update — specify at least one of --password <pw>, --no-password, --price <usd>, --no-price, --pay-to <0x…>, --expires-days <n>"
    );
  }

  const body = {};

  if (hasPassword) {
    const pw = flags.password;
    if (typeof pw !== "string" || pw.length === 0) {
      throw new Error("--password requires a non-empty value (use --no-password to clear)");
    }
    if (pw.length > 256) {
      throw new Error("Password too long (max 256 chars)");
    }
    body.password = pw;
  } else if (hasNoPassword) {
    body.password = null;
  }

  if (hasPrice) {
    const pv = flags.price;
    if (typeof pv !== "string" || pv.length === 0) {
      throw new Error("--price requires a value (use --no-price to clear)");
    }
    if (!PRICE_REGEX.test(pv)) {
      throw new Error("--price must be a decimal with ≤6 fractional digits (e.g. `0.10`)");
    }
    body.price = pv;
    // --pay-to is only required on first set; the worker rejects with
    // `payTo-required-on-first-price` if the share had no payTo before, so
    // let it do the policy enforcement. But if the user passed --pay-to
    // alongside --price, thread it through now.
    if (hasPayTo) {
      const addr = flags["pay-to"] || flags["payTo"];
      if (typeof addr !== "string" || !ETH_ADDR_REGEX.test(addr)) {
        throw new Error("--pay-to must be a 0x-prefixed 40-hex-char EVM address");
      }
      body.payTo = addr;
    }
  } else if (hasNoPrice) {
    body.price = null;
    if (hasPayTo) {
      throw new Error("--no-price clears both price and payTo; drop --pay-to when removing the gate");
    }
  } else if (hasPayTo) {
    // Change recipient only — does not rotate paymentSalt; existing paid
    // sessions keep working. Worker rejects this when the share has no
    // price gate attached.
    const addr = flags["pay-to"] || flags["payTo"];
    if (typeof addr !== "string" || !ETH_ADDR_REGEX.test(addr)) {
      throw new Error("--pay-to must be a 0x-prefixed 40-hex-char EVM address");
    }
    body.payTo = addr;
  }

  if (hasExpires) {
    const raw = flags["expires-days"] || flags["expiresDays"];
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 30) {
      throw new Error("--expires-days must be a number between 1 and 30");
    }
    body.expiresDays = n;
  }

  const { apiKey, userId, shareUrl } = await resolveCredentials();

  const res = await fetchWithTimeout(`${shareUrl}/api/share/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-a2a-user": userId,
      "x-a2a-key": apiKey,
    },
    body: JSON.stringify(body),
  }, 30_000);

  const respBody = await readJson(res);
  if (!res.ok || respBody.error) {
    throw new Error(formatApiError("Update", res.status, respBody));
  }

  if (flags.json) {
    console.log(JSON.stringify(respBody, null, 2));
    return;
  }

  console.log("");
  console.log(`✅ Updated ${slug}`);
  console.log("");
  console.log(`   ${respBody.url}`);
  console.log("");
  if (respBody.hasPassword) {
    console.log(`   🔒 Password-protected${hasPassword ? " (existing unlock cookies invalidated)" : ""}`);
  } else if (hasNoPassword) {
    console.log(`   🔓 Password removed`);
  }
  if (respBody.price && respBody.payTo) {
    const rotated = hasPrice ? " (paid sessions invalidated)" : "";
    console.log(
      `   💰 Paid — ${formatUsdc(respBody.price)} USDC on ${respBody.network || "?"} → ${respBody.payTo}${rotated}`
    );
  } else if (hasNoPrice) {
    console.log(`   💸 Payment gate removed`);
  }
  if (respBody.expiresAtMs) {
    console.log(`   ⏱  Expires ${new Date(respBody.expiresAtMs).toISOString()}`);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// link — mint a short-lived `?t=<token>` URL for handing off a
// password-protected share to another agent without disclosing the password.
//
// The owner keeps the password on their side; the receiver only needs to GET
// the returned URL. Tokens default to 24h, capped at 168h (7d) and capped by
// the share's own `expiresAtMs`. Rotating the password via `share update
// --password ...` invalidates every outstanding token for the slug.
// ---------------------------------------------------------------------------

async function handleLink(args) {
  const flags = parseFlags(args);
  const slug = flags._[0];
  if (!slug) {
    throw new Error("Usage: viveworker share link <slug> --password <pw> [--ttl-hours <n>] [--json]");
  }
  if (!/^[A-Za-z0-9]+$/.test(slug)) {
    throw new Error(`Invalid slug: ${slug}`);
  }

  const password = flags.password;
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("--password is required (the share's current password)");
  }
  if (password.length > 256) {
    throw new Error("Password too long (max 256 chars)");
  }

  const hasTtl = Object.prototype.hasOwnProperty.call(flags, "ttl-hours") ||
    Object.prototype.hasOwnProperty.call(flags, "ttlHours");
  let ttlHours;
  if (hasTtl) {
    const raw = flags["ttl-hours"] || flags["ttlHours"];
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 168) {
      throw new Error("--ttl-hours must be a number between 1 and 168");
    }
    ttlHours = n;
  }

  const { apiKey, userId, shareUrl } = await resolveCredentials();

  const payload = { password };
  if (ttlHours !== undefined) payload.ttlHours = ttlHours;

  const res = await fetchWithTimeout(`${shareUrl}/v/${encodeURIComponent(slug)}/unlock.json`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-a2a-user": userId,
      "x-a2a-key": apiKey,
    },
    body: JSON.stringify(payload),
  }, 30_000);

  const body = await readJson(res);
  if (!res.ok || body.error) {
    throw new Error(formatApiError("Link", res.status, body));
  }

  if (flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log("");
  console.log(`🔗 ${body.url}`);
  console.log("");
  if (body.expiresAtMs) {
    console.log(`   ⏱  Expires ${new Date(body.expiresAtMs).toISOString()}`);
  }
  console.log(`   Note: rotating the password via 'share update --password' invalidates this link.`);
  console.log("");
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

async function handleDelete(args) {
  const flags = parseFlags(args);
  const slug = flags._[0];
  if (!slug) {
    throw new Error("Usage: viveworker share delete <slug>");
  }
  if (!/^[A-Za-z0-9]+$/.test(slug)) {
    throw new Error(`Invalid slug: ${slug}`);
  }

  const { apiKey, userId, shareUrl } = await resolveCredentials();

  const res = await fetchWithTimeout(`${shareUrl}/api/share/${encodeURIComponent(slug)}`, {
    method: "DELETE",
    headers: {
      "x-a2a-user": userId,
      "x-a2a-key": apiKey,
    },
  }, 30_000);

  const body = await readJson(res);
  if (!res.ok || body.error) {
    throw new Error(formatApiError("Delete", res.status, body));
  }

  if (flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`✅ Deleted ${slug}`);
}

function formatApiError(op, status, body) {
  const code = body?.error || "";
  switch (code) {
    case "rate-limited":
      return `${op} failed (${status}): rate limit — ${body.limit}/${Math.round((body.windowSec || 3600) / 60)}m, retry in ${body.retryAfterSec}s`;
    case "quota-exceeded":
      return `${op} failed (${status}): quota exceeded — used ${formatSize(body.currentBytes)} of ${formatSize(body.maxTotalBytes)}, file is ${formatSize(body.fileBytes)}`;
    case "file-count-exceeded":
      return `${op} failed (${status}): file count exceeded — ${body.current}/${body.max}. Delete something first.`;
    case "file-too-large":
      return `${op} failed (${status}): file too large (max ${formatSize(body.maxBytes)})`;
    case "unsupported-extension":
      return `${op} failed (${status}): unsupported file type. Accepted: ${(body.allowed || []).join(" / ") || "n/a"}`;
    case "unsupported-content-type":
      return `${op} failed (${status}): declared content-type ${body.declared || "?"} does not match ${body.expected || "the file extension"}`;
    case "content-mismatch":
      return `${op} failed (${status}): file body does not match its extension (kind=${body.kind || "?"})`;
    case "expired-requires-expiresDays":
      return `${op} failed (${status}): share is expired — pass --expires-days <1-${body.maxDays || 30}> to revive it`;
    case "object-missing":
      return `${op} failed (${status}): the R2 body is gone (90-day lifecycle reaped it). Re-upload instead.`;
    case "invalid-password":
      return `${op} failed (${status}): wrong password`;
    case "not-password-protected":
      return `${op} failed (${status}): share has no password — no link token needed, just share the URL directly`;
    case "invalid-ttlHours":
      return `${op} failed (${status}): --ttl-hours must be between 1 and ${body.maxHours || 168}`;
    // x402 / paid-share error codes — thrown by the worker on upload,
    // PATCH, or view. Keep the messages actionable; agents read these
    // back to the user verbatim.
    case "invalid-price":
      return `${op} failed (${status}): --price must be a decimal with ≤6 fractional digits (e.g. \`0.10\`)`;
    case "price-out-of-range":
      return `${op} failed (${status}): price must be between $${formatUsdc(body.minAtomic || "10000")} and $${formatUsdc(body.maxAtomic || "1000000000")}`;
    case "invalid-payTo":
      return `${op} failed (${status}): --pay-to must be a 0x-prefixed 40-hex-char EVM address`;
    case "price-payTo-both-required":
      return `${op} failed (${status}): both --price and --pay-to must be supplied together`;
    case "price-and-password-mutually-exclusive":
      return `${op} failed (${status}): --price and --password cannot be combined on a single share`;
    case "payTo-without-price":
      return `${op} failed (${status}): cannot set --pay-to on a free share — use --price together with --pay-to to add the gate first`;
    case "payTo-cannot-be-cleared-alone":
      return `${op} failed (${status}): --no-price clears both price and payTo; clearing payTo alone is not supported`;
    case "payment-network-not-configured":
      return `${op} failed (${status}): the worker's X402_NETWORK var is not set to a supported chain (base / base-sepolia)`;
    case "payment-required":
      return `${op} failed (${status}): this share requires payment (x402). Use an x402-compatible client (e.g. \`x402-fetch\` on npm) to pay.`;
    case "payment-verification-failed":
    case "malformed-x-payment":
      return `${op} failed (${status}): payment verification failed — the facilitator rejected the X-PAYMENT header`;
    case "facilitator-unavailable":
      return `${op} failed (${status}): x402 facilitator is unreachable — try again shortly`;
    case "paid-shares-closed-beta": {
      // Closed-beta gate on --price / --pay-to uploads and PATCHes while x402
      // is pinned to testnet. The hint + network come from the worker so the
      // message stays accurate even if we flip to mainnet.
      const net = body?.network ? ` (network: ${body.network})` : "";
      const hint = body?.hint ? `\n  hint: ${body.hint}` : "";
      return `${op} failed (${status}): paid shares are in closed beta${net}.${hint}`;
    }
    case "metrics-not-configured":
      return `${op} failed (${status}): metrics endpoint is not configured on the worker (missing CF_ACCOUNT_ID / CF_API_TOKEN secrets). Ask the operator to set them.`;
    default:
      return `${op} failed (${status}): ${code || body?.statusText || "unknown error"}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveCredentials() {
  let text;
  try {
    text = await fs.readFile(A2A_ENV_FILE, "utf8");
  } catch {
    throw new Error(
      `Missing ${A2A_ENV_FILE}.\n` +
      `Run 'viveworker a2a setup --user-id <id>' first to provision credentials.`
    );
  }

  const apiKey = envValue(text, "A2A_API_KEY");
  const userId = envValue(text, "A2A_RELAY_USER_ID");
  if (!apiKey || !userId) {
    throw new Error(
      `A2A_API_KEY and/or A2A_RELAY_USER_ID missing from ${A2A_ENV_FILE}.\n` +
      `Re-run 'viveworker a2a setup --user-id <id>'.`
    );
  }

  const shareUrl = (
    process.env.VIVEWORKER_SHARE_URL ||
    envValue(text, "VIVEWORKER_SHARE_URL") ||
    DEFAULT_SHARE_URL
  ).replace(/\/$/u, "");

  return { apiKey, userId, shareUrl };
}

function envValue(text, key) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === key) return trimmed.slice(eq + 1);
  }
  return "";
}

function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[arg.slice(2)] = args[++i];
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// USDC uses 6-decimals. `atomic` is a stringified integer ("100000" = $0.10).
// Returns a human-facing decimal with at least two fractional digits and
// trailing zeros beyond that trimmed (so "1000000" → "1.00", "123456" →
// "0.123456", "12" → "0.000012"). Accepts either strings or bigints; falls
// back to "0.00" on anything unparseable so we never crash the CLI output
// on a malformed server response.
function formatUsdc(atomic) {
  let n;
  try {
    n = BigInt(String(atomic ?? "0"));
  } catch {
    return "0.00";
  }
  if (n < 0n) n = -n;
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  if (!frac) return `${whole}.00`;
  return `${whole}.${frac.padEnd(2, "0")}`;
}

function formatRelative(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
