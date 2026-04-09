// Moltbook CLI — invoked from scripts/viveworker.mjs as
// `viveworker moltbook <cmd>`. Designed to be driven by Codex/Claude Desktop
// when the operator asks the agent to handle a Moltbook notification.
//
// Commands:
//   list                                  list pending inbox items
//   list --all                            include replied/skipped items
//   show <commentId>                      print full context for one comment
//   thread <commentId>                    print comment tree (via /posts/:id/comments)
//   reply <commentId> --text "..."        post a reply; print verification challenge
//   verify <verificationCode> <answer>    solve the verification puzzle
//   mark-skip <commentId>                 mark as skipped without replying

import {
  createMoltbookClient,
  extractNotifications,
  isCommentNotification,
  listInboxItems,
  loadMoltbookEnv,
  readInboxItem,
  updateInboxStatus,
  writeInboxItem,
  ensureInboxDir,
} from "./moltbook-api.mjs";

function fail(message, code = 1) {
  console.error(`moltbook: ${message}`);
  process.exit(code);
}

async function getClient() {
  const env = await loadMoltbookEnv();
  const apiKey = env.MOLTBOOK_API_KEY;
  if (!apiKey) fail("MOLTBOOK_API_KEY missing (expected in ~/.viveworker/moltbook.env)");
  return { mb: createMoltbookClient(apiKey), env };
}

// Notify the viveworker bridge that a moltbook item is no longer pending so
// it's removed from the mobile "unhandled" list. Best-effort: silently ignore
// failures (the bridge may not be running, or the item may never have been
// pushed to the bridge in the first place).
async function resolveOnBridge(env, commentId) {
  const base = (env.VIVEWORKER_BASE_URL || "https://127.0.0.1:8810").replace(/\/+$/u, "");
  const secret = env.VIVEWORKER_HOOK_SECRET || "";
  if (!secret) return;
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (!prev) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    await fetch(`${base}/api/providers/moltbook/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-viveworker-hook-secret": secret,
      },
      body: JSON.stringify({ sourceId: `comment:${commentId}`, eventType: "resolve" }),
    });
  } catch {
    // ignore
  } finally {
    if (!prev) process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev ?? "";
  }
}

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function truncate(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

async function cmdList(flags) {
  await ensureInboxDir();
  const items = await listInboxItems();
  const filtered = flags.all ? items : items.filter((item) => item.status === "pending");
  if (filtered.length === 0) {
    console.log(flags.all ? "(no inbox items)" : "(no pending items — use --all to see replied/skipped)");
    return;
  }
  for (const item of filtered) {
    console.log(
      `${item.status.padEnd(8)} ${item.commentId}  @${item.authorName || "?"}  "${truncate(item.postTitle, 40)}"`
    );
    console.log(`         ${truncate(item.contextText, 120)}`);
    console.log(`         ${item.postUrl || ""}  ${item.createdAt || ""}`);
  }
}

async function cmdShow(commentId) {
  if (!commentId) fail("usage: viveworker moltbook show <commentId>");
  const item = await readInboxItem(commentId);
  if (!item) fail(`no inbox item for ${commentId}`);
  console.log(JSON.stringify(item, null, 2));
}

async function cmdThread(commentId) {
  if (!commentId) fail("usage: viveworker moltbook thread <commentId>");
  const item = await readInboxItem(commentId);
  if (!item) fail(`no inbox item for ${commentId}`);
  const { mb } = await getClient();
  const data = await mb(`/posts/${item.postId}/comments?sort=new&limit=50`);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdReply(commentId, flags) {
  if (!commentId) fail("usage: viveworker moltbook reply <commentId> --text \"...\"");
  const text = typeof flags.text === "string" ? flags.text : "";
  if (!text.trim()) fail("--text is required and must be non-empty");
  let item = await readInboxItem(commentId);
  if (!item) {
    // Allow replying to an ad-hoc commentId even when it's not in the inbox;
    // caller must also pass --post-id in that case.
    if (!flags["post-id"]) fail(`no inbox item for ${commentId}; pass --post-id <id> to reply anyway`);
    item = {
      commentId,
      postId: String(flags["post-id"]),
      authorName: "",
      postTitle: "",
      postUrl: `https://www.moltbook.com/posts/${flags["post-id"]}`,
      contextText: "",
      createdAt: new Date().toISOString(),
      status: "pending",
      source: "cli",
    };
    await writeInboxItem(item);
  }
  const { mb, env } = await getClient();
  const result = await mb(`/posts/${item.postId}/comments`, {
    method: "POST",
    body: JSON.stringify({ content: text, parent_id: commentId }),
  });
  const verification = result?.comment?.verification || null;
  await resolveOnBridge(env, commentId);
  await updateInboxStatus(commentId, "replied", {
    source: "cli",
    replyText: text,
    replyCommentId: result?.comment?.id || "",
    replyVerification: verification,
  });
  console.log(JSON.stringify({ ok: true, commentId, reply: result?.comment, verification }, null, 2));
  if (verification) {
    console.log("");
    console.log("VERIFICATION REQUIRED:");
    console.log(`  verification_code: ${verification.verification_code}`);
    console.log(`  challenge_text:    ${verification.challenge_text}`);
    console.log(`  expires_at:        ${verification.expires_at}`);
    console.log("");
    console.log("Solve the arithmetic problem and run:");
    console.log(`  viveworker moltbook verify ${verification.verification_code} <answer>`);
  }
}

async function cmdVerify(verificationCode, answer) {
  if (!verificationCode || !answer) {
    fail("usage: viveworker moltbook verify <verificationCode> <answer>");
  }
  const { mb } = await getClient();
  const result = await mb(`/verify`, {
    method: "POST",
    body: JSON.stringify({ verification_code: verificationCode, answer }),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdMarkSkip(commentId) {
  if (!commentId) fail("usage: viveworker moltbook mark-skip <commentId>");
  const updated = await updateInboxStatus(commentId, "skipped", { source: "cli" });
  if (!updated) fail(`no inbox item for ${commentId}`);
  const env = await loadMoltbookEnv();
  await resolveOnBridge(env, commentId);
  console.log(`marked ${commentId} as skipped`);
}

async function cmdReconcile() {
  // For every pending inbox item, fetch the post's comment tree and check
  // whether viveworker has already posted a reply whose parent_id matches
  // the pending commentId. If so, mark the inbox item as replied and clear
  // it from the bridge. Useful after replies made outside the CLI.
  const { mb, env } = await getClient();
  const items = (await listInboxItems()).filter((item) => item.status === "pending");
  const postCache = new Map();
  let resolved = 0;
  for (const item of items) {
    try {
      if (!postCache.has(item.postId)) {
        const tree = await mb(`/posts/${item.postId}/comments?sort=new&limit=100`);
        postCache.set(item.postId, tree);
      }
      const tree = postCache.get(item.postId);
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
      const hasOurReply = flat.some((c) => {
        const parent = String(c?.parent_id || c?.parent?.id || "");
        if (parent !== String(item.commentId)) return false;
        const a = c?.author || c?.user || {};
        const name = String(a.username || a.name || "").toLowerCase();
        return name === "viveworker";
      });
      if (hasOurReply) {
        await updateInboxStatus(item.commentId, "replied", { source: "reconcile" });
        await resolveOnBridge(env, item.commentId);
        resolved += 1;
        console.log(`resolved ${item.commentId} (@${item.authorName})`);
      }
    } catch (error) {
      console.error(`reconcile ${item.commentId}: ${error.message}`);
    }
  }
  console.log(`reconciled ${resolved}/${items.length} pending item(s)`);
}

async function cmdPoll() {
  // Manual one-shot poll — useful when the launchd watcher isn't running or
  // when you want to refresh the inbox on demand. Mirrors watcher logic but
  // without the bridge push.
  const { mb } = await getClient();
  const data = await mb(`/notifications`);
  const notifications = extractNotifications(data);
  let written = 0;
  for (const n of notifications) {
    if (!isCommentNotification(n)) continue;
    const commentId = String(n.comment_id || n.comment?.id || n.id || "");
    const postId = String(n.post_id || n.post?.id || n.comment?.post_id || "");
    if (!commentId || !postId) continue;
    const existing = await readInboxItem(commentId);
    if (existing) continue;
    const author = n.actor || n.author || n.comment?.author || {};
    await writeInboxItem({
      commentId,
      postId,
      parentCommentId: String(n.comment?.parent_id || n.parent_id || ""),
      authorName: author.username || author.name || "user",
      postTitle: n.post?.title || n.post_title || "",
      postUrl: `https://www.moltbook.com/posts/${postId}`,
      contextText: String(n.comment?.content || n.content || n.preview || ""),
      createdAt: n.created_at || n.createdAt || new Date().toISOString(),
      status: "pending",
      source: "cli-poll",
    });
    written += 1;
  }
  console.log(`added ${written} new item(s)`);
}

export async function runMoltbookCli(argv) {
  const { positional, flags } = parseFlags(argv);
  const [cmd, ...rest] = positional;
  switch (cmd) {
    case "list":
      return cmdList(flags);
    case "show":
      return cmdShow(rest[0]);
    case "thread":
      return cmdThread(rest[0]);
    case "reply":
      return cmdReply(rest[0], flags);
    case "verify":
      return cmdVerify(rest[0], rest[1]);
    case "mark-skip":
      return cmdMarkSkip(rest[0]);
    case "poll":
      return cmdPoll();
    case "reconcile":
      return cmdReconcile();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(`Usage: viveworker moltbook <command>

Commands:
  list [--all]                          Pending items (or all with --all)
  show <commentId>                      Full inbox JSON for one comment
  thread <commentId>                    Moltbook comment tree for the post
  reply <commentId> --text "..."        Post a reply; print verification challenge
  verify <verificationCode> <answer>    Solve verification puzzle and publish
  mark-skip <commentId>                 Mark an item as skipped
  poll                                  Manual one-shot notification refresh`);
      return;
    default:
      fail(`unknown command: ${cmd}`);
  }
}
