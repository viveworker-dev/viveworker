#!/usr/bin/env node
// Moltbook watcher — standalone process that polls Moltbook for new comments
// on the operator's posts and pushes them to the local viveworker bridge so
// they arrive as Web Push notifications on the paired phone.
//
// Drafting and sending is delegated to the operator's Codex/Claude Desktop
// session via the `viveworker moltbook` CLI (see CLAUDE.md). This watcher is
// intentionally dumb: poll → push → mirror to an inbox directory.
//
// Env:
//   MOLTBOOK_API_KEY        required — Bearer token
//   MOLTBOOK_AGENT_ID       required — agent UUID (retained for future use)
//   VIVEWORKER_BASE_URL     default http://127.0.0.1:8765
//   VIVEWORKER_HOOK_SECRET  required — same value as bridge sessionSecret
//   MOLTBOOK_POLL_MS        default 120000

import http from "node:http";
import process from "node:process";

// The bridge usually listens on HTTPS with a self-signed certificate. Since
// we only ever talk to it on loopback, disable TLS verification for outgoing
// fetch calls from this process. Scoped to the watcher process only.
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

import {
  createMoltbookClient,
  extractNotifications,
  isCommentNotification,
  loadMoltbookEnv,
  writeInboxItem,
  updateInboxStatus,
  ensureInboxDir,
  listInboxItems,
  DEFAULT_INBOX_DIR,
} from "./moltbook-api.mjs";

const envFromFile = await loadMoltbookEnv();
const API_KEY = envFromFile.MOLTBOOK_API_KEY || process.env.MOLTBOOK_API_KEY || "";
const AGENT_ID = envFromFile.MOLTBOOK_AGENT_ID || process.env.MOLTBOOK_AGENT_ID || "";
const VIVEWORKER_BASE = (envFromFile.VIVEWORKER_BASE_URL || process.env.VIVEWORKER_BASE_URL || "http://127.0.0.1:8765").replace(/\/+$/u, "");
const HOOK_SECRET = envFromFile.VIVEWORKER_HOOK_SECRET || process.env.VIVEWORKER_HOOK_SECRET || "";
const POLL_MS = Number(process.env.MOLTBOOK_POLL_MS) || 120_000;
const CALLBACK_PORT = Number(process.env.MOLTBOOK_CALLBACK_PORT) || 8766;
const CALLBACK_HOST = process.env.MOLTBOOK_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_URL =
  process.env.MOLTBOOK_CALLBACK_URL || `http://${CALLBACK_HOST}:${CALLBACK_PORT}/callback`;

if (!API_KEY || !AGENT_ID || !HOOK_SECRET) {
  console.error("moltbook-watcher: missing MOLTBOOK_API_KEY, MOLTBOOK_AGENT_ID, or VIVEWORKER_HOOK_SECRET");
  process.exit(1);
}

const mb = createMoltbookClient(API_KEY);
await ensureInboxDir();

const seen = new Set(); // commentIds we've already pushed
// Pre-populate `seen` with any inbox items whose status is replied/skipped
// so a watcher restart does not resurrect them in the mobile unhandled list.
try {
  const existing = await listInboxItems();
  for (const item of existing) {
    if (item.status === "replied" || item.status === "skipped") {
      seen.add(String(item.commentId));
    }
  }
} catch (error) {
  console.error(`[moltbook-watcher] inbox bootstrap failed: ${error.message}`);
}
const pending = new Map(); // sourceId -> { commentId, postId }

async function pushToBridge(item) {
  // Loopback HTTPS call to the viveworker bridge. Normally completes in
  // milliseconds, but if the bridge process is hung this fetch — like any
  // unbounded fetch — would wait forever and eventually zombify the watcher
  // (same failure mode that took out the Moltbook poll path in April 2026).
  // 10s is a generous cap for a local call; anything slower means the bridge
  // is already unhealthy and we're better off erroring out and retrying next
  // poll cycle than blocking the whole watcher on it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${VIVEWORKER_BASE}/api/providers/moltbook/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-viveworker-hook-secret": HOOK_SECRET,
      },
      body: JSON.stringify(item),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`bridge ${res.status}: ${await res.text().catch(() => "")}`);
    }
    return await res.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`bridge timeout after 10000ms POST /api/providers/moltbook/events`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function draftReply() {
  // Intentionally empty — drafting is done in Codex/Claude Desktop via the
  // `viveworker moltbook` CLI. Kept as a function so a future plug-in can
  // restore auto-drafting without touching pollOnce.
  return "";
}

async function resolveAuthorName(postId, commentId, notifType, postCommentCache, postCache) {
  if (!postId) return "";
  try {
    if (commentId) {
      // Retry a couple of times with a small delay to absorb eventual
      // consistency between /notifications and /posts/:id/comments.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) {
          postCommentCache.delete(postId);
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
        if (!postCommentCache.has(postId)) {
          const tree = await mb(`/posts/${postId}/comments?sort=new&limit=100`);
          postCommentCache.set(postId, tree);
        }
        const tree = postCommentCache.get(postId);
        const flat = [];
        const walk = (nodes) => {
          if (!Array.isArray(nodes)) return;
          for (const node of nodes) {
            if (!node) continue;
            flat.push(node);
            walk(node.replies || node.children || []);
          }
        };
        walk(tree?.comments || tree?.data || tree || []);
        const hit = flat.find((c) => String(c?.id || c?.comment_id || "") === String(commentId));
        const a = hit?.author || hit?.user || {};
        const name = a.username || a.name || a.handle || "";
        if (name) return name;
      }
    }
    // Only fall back to post author for mention notifications. For reply
    // notifications, using the post author would misattribute the reply to
    // the post owner (often viveworker itself).
    const isMention = String(notifType || "").toLowerCase().includes("mention");
    if (!isMention) return "";
    if (!postCache.has(postId)) {
      const post = await mb(`/posts/${postId}`);
      postCache.set(postId, post);
    }
    const post = postCache.get(postId);
    const pa = post?.post?.author || post?.author || post?.user || {};
    return pa.username || pa.name || pa.handle || "";
  } catch {
    return "";
  }
}

async function pollOnce() {
  try {
    const data = await mb(`/notifications`);
    const notifications = extractNotifications(data);
    const postCommentCache = new Map();
    const postCache = new Map();
    const postIdsToMarkRead = new Set();
    for (const n of notifications) {
      if (!isCommentNotification(n)) continue;
      if (n.is_read === true || n.read === true || n.isRead === true) continue;
      const verificationStatus = String(
        n.comment?.verification_status || n.comment?.verificationStatus || ""
      ).toLowerCase();
      if (verificationStatus && verificationStatus !== "verified") continue;
      const commentId = String(
        n.comment_id || n.relatedCommentId || n.comment?.id || n.id || ""
      );
      const postId = String(
        n.post_id || n.relatedPostId || n.post?.id || n.comment?.post_id || n.comment?.postId || ""
      );
      if (!commentId || !postId) continue;
      if (seen.has(commentId)) continue;
      seen.add(commentId);
      const sourceId = `comment:${commentId}`;
      const author = n.actor || n.author || n.comment?.author || {};
      const authorId = String(author.id || author.agent_id || author.agentId || "");
      let authorName = author.username || author.name || "";
      if (!authorName) {
        authorName = (await resolveAuthorName(postId, commentId, n.type || n.notificationType || "", postCommentCache, postCache)) || "user";
      }
      const postTitle = n.post?.title || n.post_title || "";
      const contextText = String(n.comment?.content || n.content || n.preview || "");
      const createdAtIso = n.created_at || n.createdAt || new Date().toISOString();
      const parentCommentId = String(n.comment?.parent_id || n.parent_id || "");

      // "mention" notifications carry a synthetic commentId that doesn't
      // exist in the moltbook comment table — replying with parent_id=that
      // value 404s ("Parent comment not found"). Mark these so the CLI can
      // skip parent_id and post a top-level comment on the post instead.
      const notifType = String(n.type || n.kind || n.notificationType || "").toLowerCase();
      const kind = notifType.includes("mention") ? "mention" : "reply";

      pending.set(sourceId, { commentId, postId });

      const inboxItem = {
        commentId,
        postId,
        parentCommentId,
        kind,
        authorId,
        authorName,
        postTitle,
        postUrl: `https://www.moltbook.com/post/${postId}`,
        contextText,
        createdAt: createdAtIso,
        status: "pending",
        source: "watcher",
      };
      try {
        await writeInboxItem(inboxItem);
      } catch (error) {
        console.error(`[moltbook-watcher] inbox write failed: ${error.message}`);
      }

      try {
        await pushToBridge({
          sourceId,
          eventType: "reply_request",
          threadId: postId,
          threadLabel: postTitle ? `Moltbook · ${postTitle}`.slice(0, 80) : "Moltbook",
          title: `@${authorName} commented`,
          summary: contextText.slice(0, 200),
          contextText,
          draftReply: draftReply(),
          callbackUrl: CALLBACK_URL,
          postUrl: `https://www.moltbook.com/post/${postId}`,
          postTitle,
          createdAtMs: Date.parse(createdAtIso) || Date.now(),
        });
        console.log(`[moltbook-watcher] pushed ${sourceId}`);
      } catch (error) {
        console.error(`[moltbook-watcher] bridge push failed: ${error.message}`);
      }

      postIdsToMarkRead.add(postId);
    }

    // Mark notifications as read after processing all comments in this cycle
    for (const postId of postIdsToMarkRead) {
      try {
        await mb(`/notifications/read-by-post/${postId}`, { method: "POST" });
      } catch (error) {
        console.error(`[moltbook-watcher] mark-read failed: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`[moltbook-watcher] poll error: ${error.message}`);
  }
}

async function handleCallback(body) {
  const sourceId = String(body.sourceId || "");
  const action = String(body.action || "send");
  const text = String(body.text || "").trim();
  const ctx = pending.get(sourceId);
  if (!ctx) {
    return { ok: false, error: "unknown-sourceId" };
  }
  if (action !== "send" || !text) {
    pending.delete(sourceId);
    await updateInboxStatus(ctx.commentId, "skipped", { source: "mobile" });
    return { ok: true, skipped: true };
  }
  try {
    const result = await mb(`/posts/${ctx.postId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content: text, parent_id: ctx.commentId }),
    });
    pending.delete(sourceId);
    await updateInboxStatus(ctx.commentId, "replied", {
      source: "mobile",
      replyText: text,
      replyVerification: result?.comment?.verification || null,
    });
    console.log(`[moltbook-watcher] replied to ${sourceId}`);
    return { ok: true, verification: result?.comment?.verification || null };
  } catch (error) {
    console.error(`[moltbook-watcher] reply error: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/callback")) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const secret = req.headers["x-viveworker-hook-secret"];
  if (secret !== HOOK_SECRET) {
    res.statusCode = 401;
    res.end();
    return;
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    const out = await handleCallback(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  });
});

server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
  console.log(`[moltbook-watcher] callback listening on http://${CALLBACK_HOST}:${CALLBACK_PORT}/callback`);
  console.log(`[moltbook-watcher] inbox dir: ${DEFAULT_INBOX_DIR}`);
  console.log(`[moltbook-watcher] polling every ${POLL_MS}ms`);
});

pollOnce();
setInterval(pollOnce, POLL_MS);
