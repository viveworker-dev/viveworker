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

import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface as createReadline } from "node:readline/promises";
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
  readScoutState,
  writeScoutState,
  rollScoutDayIfNeeded,
  markPostSeen,
  recordComposeAttempt,
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
      postUrl: `https://www.moltbook.com/post/${flags["post-id"]}`,
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
      postUrl: `https://www.moltbook.com/post/${postId}`,
      contextText: String(n.comment?.content || n.content || n.preview || ""),
      createdAt: n.created_at || n.createdAt || new Date().toISOString(),
      status: "pending",
      source: "cli-poll",
    });
    written += 1;
  }
  console.log(`added ${written} new item(s)`);
}

// ---------------------------------------------------------------------------
// scout: pick one candidate post from the feed and print the context needed
// for an agent (Codex / Claude Desktop / whatever) to draft a reply.
//
// This command is intentionally LLM-free — it fetches /home, filters,
// chooses one post, and writes the full thread context to stdout as JSON.
// The calling agent is expected to draft the reply and then invoke
// `viveworker moltbook propose <postId> --text "..."`.
// ---------------------------------------------------------------------------

const DEFAULT_SUBMOLTS = ["general", "builds", "tooling", "agents", "infrastructure"];

function parseSubmolts(flag) {
  if (!flag || flag === true) return DEFAULT_SUBMOLTS;
  return String(flag)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function cmdScout(flags) {
  const maxDaily = Number(flags["max-daily"]) || 5;
  const submolts = parseSubmolts(flags.submolts);
  const dryRun = Boolean(flags["dry-run"]);

  const state = rollScoutDayIfNeeded(await readScoutState());
  if (state.sentToday >= maxDaily) {
    console.log(
      JSON.stringify(
        { status: "quota-reached", sentToday: state.sentToday, maxDaily, day: state.day },
        null,
        2
      )
    );
    await writeScoutState(state);
    return;
  }

  const { mb, env } = await getClient();
  const myAgentId = env.MOLTBOOK_AGENT_ID || "";

  // Pull the cross-submolt feed. /home is just a directory of endpoints;
  // /feed is the actual list. Fall back to /posts?sort=hot if /feed is
  // unavailable for any reason.
  let feed;
  try {
    feed = await mb(`/feed?sort=hot&limit=50`);
  } catch (error) {
    console.error(`scout: /feed failed (${error.message}); falling back to /posts?sort=hot`);
    feed = await mb(`/posts?sort=hot&limit=50`);
  }

  const posts = extractFeedPosts(feed);
  if (posts.length === 0) {
    console.log(JSON.stringify({ status: "no-posts", feedKeys: Object.keys(feed || {}) }, null, 2));
    await writeScoutState(state);
    return;
  }

  // Filter: drop self-authored, already-seen, wrong submolt, etc.
  const candidates = [];
  const skipReasons = { noId: 0, seen: 0, selfAuthor: 0, viveworker: 0, unverified: 0, submolt: 0 };
  const submoltsSeen = {};
  for (const post of posts) {
    const postId = String(post?.id || post?.post_id || "");
    if (!postId) { skipReasons.noId++; continue; }
    if (state.seenPostIds[postId]) { skipReasons.seen++; continue; }
    const authorId = String(post?.author?.id || post?.author_id || "");
    const authorName = String(post?.author?.name || post?.author?.username || "").toLowerCase();
    if (myAgentId && authorId === myAgentId) { skipReasons.selfAuthor++; continue; }
    if (authorName === "viveworker") { skipReasons.viveworker++; continue; }
    if (post?.verification_status && String(post.verification_status).toLowerCase() !== "verified") { skipReasons.unverified++; continue; }
    const submolt = String(post?.submolt?.name || post?.submolt_name || "").toLowerCase();
    submoltsSeen[submolt] = (submoltsSeen[submolt] || 0) + 1;
    // If the caller passed --submolts, enforce it. Otherwise accept any
    // submolt — the feed itself is already curated.
    if (submolts.length > 0 && !submolts.includes(submolt)) { skipReasons.submolt++; continue; }
    candidates.push({ post, postId, submolt, authorName });
  }
  if (candidates.length === 0 && process.env.SCOUT_DEBUG) {
    console.error(`scout: skip reasons: ${JSON.stringify(skipReasons)}`);
    console.error(`scout: submolts in feed: ${JSON.stringify(submoltsSeen)}`);
  }

  if (candidates.length === 0) {
    console.log(
      JSON.stringify(
        {
          status: "no-candidates",
          totalPosts: posts.length,
          submoltsFilter: submolts,
          sentToday: state.sentToday,
          maxDaily,
        },
        null,
        2
      )
    );
    await writeScoutState(state);
    return;
  }

  // Pick the top candidate (feed is already ordered). Could later add
  // scoring by recency + score + comment_count.
  const pick = candidates[0];

  // Pull the full comment tree so the agent can see existing discussion.
  let thread = null;
  try {
    thread = await mb(`/posts/${pick.postId}/comments?sort=top&limit=50`);
  } catch (error) {
    console.error(`scout: could not fetch thread (${error.message})`);
  }

  // Check whether viveworker already commented on this post — if so, mark
  // seen and skip (the caller will re-run scout to get another candidate).
  if (thread && hasViveworkerComment(thread)) {
    markPostSeen(state, pick.postId, "already-replied");
    await writeScoutState(state);
    console.log(
      JSON.stringify(
        { status: "already-engaged", postId: pick.postId, retry: true },
        null,
        2
      )
    );
    return;
  }

  // Mark as seen immediately so we do not repeatedly propose the same post
  // if the caller dies mid-flight. `propose` will update counters on
  // successful publish.
  markPostSeen(state, pick.postId, "proposed");
  await writeScoutState(state);

  const p = pick.post;
  const output = {
    status: "candidate",
    postId: pick.postId,
    postUrl: `https://www.moltbook.com/post/${pick.postId}`,
    submolt: pick.submolt,
    author: p?.author?.name || p?.author?.username || "",
    title: p?.title || "",
    content: p?.content || p?.body || "",
    score: p?.score ?? p?.upvotes ?? 0,
    commentCount: p?.comment_count ?? 0,
    createdAt: p?.created_at || p?.createdAt || "",
    thread: thread?.comments || thread?.data || thread || null,
    quota: { sentToday: state.sentToday, maxDaily, day: state.day },
    dryRun,
  };
  // Sanitize control characters that break JSON.parse in the shell pipeline.
  const json = JSON.stringify(output, (_, v) =>
    typeof v === "string" ? v.replace(/[\x00-\x1f]/g, (ch) => ch === "\n" || ch === "\t" ? ch : "") : v
  , 2);
  console.log(json);
}

function extractFeedPosts(feed) {
  if (!feed) return [];
  const buckets = [
    feed.posts,
    feed.home?.posts,
    feed.data?.posts,
    feed.feed,
    feed.data,
    feed.hot,
    feed.trending,
  ];
  for (const b of buckets) {
    if (Array.isArray(b) && b.length > 0) return b;
  }
  if (Array.isArray(feed)) return feed;
  return [];
}

function hasViveworkerComment(tree) {
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
  return flat.some((c) => {
    const a = c?.author || c?.user || {};
    return String(a.username || a.name || "").toLowerCase() === "viveworker";
  });
}

// ---------------------------------------------------------------------------
// propose: submit a draft reply to the bridge as a moltbook_draft approval
// item, long-poll for the phone's decision, and on approve actually post +
// verify the comment.
// ---------------------------------------------------------------------------

async function cmdPropose(postId, flags) {
  if (!postId) fail("usage: viveworker moltbook propose <postId> --text \"...\"");
  const text = typeof flags.text === "string" ? flags.text : "";
  if (!text.trim()) fail("--text is required and must be non-empty");
  const timeoutSec = Number(flags.timeout) || 900;
  const parentCommentId = typeof flags["parent-id"] === "string" ? flags["parent-id"] : "";
  const postTitle = typeof flags.title === "string" ? flags.title : "";
  const postBody = typeof flags["post-body"] === "string" ? flags["post-body"] : "";
  const postAuthor = typeof flags["post-author"] === "string" ? flags["post-author"] : "";
  const intent = typeof flags.intent === "string" ? flags.intent : "";
  const postUrl = `https://www.moltbook.com/post/${postId}`;

  const env = await loadMoltbookEnv();
  const base = (env.VIVEWORKER_BASE_URL || "https://127.0.0.1:8810").replace(/\/+$/u, "");
  const secret = env.VIVEWORKER_HOOK_SECRET || "";
  if (!secret) fail("VIVEWORKER_HOOK_SECRET missing (expected in ~/.viveworker/moltbook.env)");

  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (!prevTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const sourceId = `draft:${postId}:${Date.now()}`;

  // 1. Submit draft to bridge.
  let submitRes;
  try {
    const r = await fetch(`${base}/api/providers/moltbook/draft`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-viveworker-hook-secret": secret },
      body: JSON.stringify({
        sourceId,
        postId,
        postTitle,
        postAuthor,
        postBody,
        postUrl,
        parentCommentId,
        intent,
        draftText: text,
        contextSummary: truncate(intent || text, 160),
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      fail(`bridge /api/providers/moltbook/draft failed: ${r.status} ${body}`);
    }
    submitRes = await r.json();
  } catch (error) {
    fail(`bridge submit failed: ${error.message}`);
  }
  const token = submitRes?.token;
  if (!token) fail(`bridge did not return a token: ${JSON.stringify(submitRes)}`);

  console.log(`propose: draft submitted (token=${token}); waiting for phone decision (timeout=${timeoutSec}s)`);

  // 2. Long-poll decision.
  const deadline = Date.now() + timeoutSec * 1000;
  let decision = null;
  while (Date.now() < deadline && !decision) {
    const remain = Math.min(60, Math.ceil((deadline - Date.now()) / 1000));
    try {
      const r = await fetch(
        `${base}/api/providers/moltbook/draft/${encodeURIComponent(token)}/decision?wait=${remain}`,
        {
          method: "GET",
          headers: { "x-viveworker-hook-secret": secret },
        }
      );
      if (r.ok) {
        const body = await r.json();
        if (body && body.status === "decided") decision = body;
      }
    } catch {
      // transient — retry
    }
  }

  if (!decision) {
    console.log("propose: timed out waiting for phone decision — treating as deny");
    process.exit(2);
  }

  if (decision.action === "deny") {
    console.log(`propose: denied by phone${decision.reason ? ` (${decision.reason})` : ""}`);
    process.exit(1);
  }

  // 3. Approve path: use the (possibly edited) text to actually post.
  const finalText = decision.text || text;
  const { mb } = await getClient();
  const result = await mb(`/posts/${postId}/comments`, {
    method: "POST",
    body: JSON.stringify({
      content: finalText,
      ...(parentCommentId ? { parent_id: parentCommentId } : {}),
    }),
  });
  const comment = result?.comment || null;
  const verification = comment?.verification || null;

  console.log(
    JSON.stringify(
      { ok: true, postId, action: "posted", commentId: comment?.id, verification },
      null,
      2
    )
  );

  // Bump sentToday counter immediately after posting (before verification),
  // because the comment is already created and rate-limits are consumed
  // regardless of verification outcome.
  const state = rollScoutDayIfNeeded(await readScoutState());
  state.sentToday += 1;
  markPostSeen(state, postId, "published");
  await writeScoutState(state);

  if (!verification) {
    console.log("propose: no verification challenge returned — done");
    return;
  }

  // 4. Solve verification puzzle inline (try naive solver, then LLM fallback, retry once on wrong answer).
  let answer = solveVerificationPuzzle(verification.challenge_text);
  const source = answer != null ? "solver" : "skip";
  console.log(`propose: verification puzzle — solver answer: ${answer ?? "(null)"}`);

  // If solver couldn't parse, try LLM fallback.
  if (answer == null) {
    answer = await solvePuzzleWithLLM(verification.challenge_text);
    if (answer) console.log(`propose: LLM fallback answer: ${answer}`);
  }

  if (answer == null) {
    console.log("");
    console.log("VERIFICATION REQUIRED (solver + LLM both failed):");
    console.log(`  verification_code: ${verification.verification_code}`);
    console.log(`  challenge_text:    ${verification.challenge_text}`);
    console.log("");
    console.log("Solve manually and run:");
    console.log(`  viveworker moltbook verify ${verification.verification_code} <answer>`);
    return;
  }

  let verifyRes;
  try {
    verifyRes = await mb(`/verify`, {
      method: "POST",
      body: JSON.stringify({ verification_code: verification.verification_code, answer }),
    });
  } catch (verifyError) {
    // Wrong answer — retry with LLM if the first attempt was from solver.
    const isWrongAnswer = /incorrect/i.test(verifyError.message);
    if (isWrongAnswer && source === "solver") {
      console.log(`propose: solver answer ${answer} was wrong, trying LLM fallback`);
      const llmAnswer = await solvePuzzleWithLLM(verification.challenge_text);
      if (llmAnswer && llmAnswer !== answer) {
        console.log(`propose: LLM retry answer: ${llmAnswer}`);
        try {
          verifyRes = await mb(`/verify`, {
            method: "POST",
            body: JSON.stringify({ verification_code: verification.verification_code, answer: llmAnswer }),
          });
          answer = llmAnswer;
        } catch (retryError) {
          console.log(`propose: LLM retry also failed: ${retryError.message}`);
          return;
        }
      } else {
        console.log(`propose: LLM couldn't produce a different answer`);
        return;
      }
    } else {
      console.log(`propose: verify failed: ${verifyError.message}`);
      return;
    }
  }
  console.log(JSON.stringify({ ok: true, verify: verifyRes, answer }, null, 2));

  if (!prevTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls ?? "";
}

// LLM-based verification puzzle solver. Shells out to claude or codex CLI.
// Returns the answer as "XX.XX" string, or null if unavailable.
async function solvePuzzleWithLLM(challengeText) {
  if (!challengeText) return null;
  const prompt =
    `The following text is an obfuscated arithmetic word problem from Moltbook (an AI social network). ` +
    `The text has random capitalization, doubled letters, and stray punctuation — ignore all of that. ` +
    `CRITICAL: ALL symbols (/, *, ^, ~, [, ], etc.) are NOISE, NOT arithmetic operators. ` +
    `The operation is ALWAYS expressed in natural language words only. ` +
    `Extract the numbers (written as words like "thirty five" = 35), determine the operation from WORDS ONLY ` +
    `(addition: "total", "combined", "and", "plus", "gains", "new velocity"; ` +
    `subtraction: "difference", "minus", "less", "loses"; ` +
    `multiplication: "times", "product", "multiplied"; ` +
    `division: "divided by", "ratio", "per"). ` +
    `If no operation word is found, default to addition. ` +
    `Compute the result and output ONLY the number with exactly 2 decimal places (e.g. "58.00"). No other text.\n\n` +
    `Puzzle: ${challengeText}`;

  // Try claude first, then codex.
  for (const cmd of ["claude", "codex"]) {
    let bin;
    try {
      bin = await new Promise((resolve) => {
        const p = spawn("command", ["-v", cmd], { shell: "/bin/bash", stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        p.stdout.on("data", (d) => (out += d.toString()));
        p.on("exit", (code) => resolve(code === 0 ? out.trim() : ""));
        p.on("error", () => resolve(""));
      });
    } catch { bin = ""; }
    if (!bin) continue;

    const args = cmd === "claude" ? ["-p", prompt, "--output-format", "text"] : ["exec", prompt];
    try {
      const result = await new Promise((resolve, reject) => {
        const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
        let out = "";
        p.stdout.on("data", (d) => (out += d.toString()));
        p.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))));
        p.on("error", reject);
      });
      // Extract the number from output (LLM might add extra text).
      const match = result.match(/(\d+\.\d{2})/);
      if (match) return match[1];
      // Try integer and append .00
      const intMatch = result.match(/^(\d+)$/m);
      if (intMatch) return `${intMatch[1]}.00`;
    } catch {
      // try next
    }
  }
  return null;
}

// Naive verification-puzzle solver. Handles the obfuscated two-number
// arithmetic Moltbook currently uses (add / subtract / multiply). Returns
// `null` if it can't confidently solve — caller falls back to manual.
function solveVerificationPuzzle(challengeText) {
  if (!challengeText) return null;
  // Strip ALL symbolic characters as noise — operations are expressed in
  // natural language only ("and", "times", "divided by", etc.).  Previous
  // regex missed `*` and `@` which caused `/` or `*` to be mistaken for
  // arithmetic operators.
  const cleaned = String(challengeText)
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .toLowerCase();
  const numberWords = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  };
  // Tokenize loosely by collapsing whitespace. Words sometimes have stray
  // characters (e.g. "tw eLvE") so strip non-letters between word fragments.
  // Moltbook's obfuscator randomly doubles letters ("tWeNnTy" → "twennty"),
  // so try matching both the raw word and a version with collapsed runs.
  // We can't blindly collapse because natural doubles exist ("three" has "ee").
  const collapseRuns = (w) => w.replace(/([a-z])\1+/g, "$1");
  const rawTokens = cleaned
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  // The obfuscator inserts spaces mid-word (e.g. "th ree" → "three",
  // "to tal" → "total"). Greedily merge adjacent tokens if the combined
  // form (raw or collapsed) matches a known number word or operation keyword.
  const operationWords = new Set([
    "total", "combined", "force", "velocity", "speed", "gains", "plus", "and",
    "subtract", "minus", "less", "difference", "decreased", "loses", "lost", "slower", "slows", "slowed",
    "multiply", "times", "product", "multiplied",
    "divide", "divided", "ratio",
    "how", "much", "what", "exerts", "new",
  ]);
  const isKnown = (w) => numberWords[w] != null || numberWords[collapseRuns(w)] != null || operationWords.has(w) || operationWords.has(collapseRuns(w));
  const merged = [];
  let ti = 0;
  while (ti < rawTokens.length) {
    // Try merging up to 4 consecutive tokens.
    let best = rawTokens[ti];
    let bestLen = 1;
    let candidate = rawTokens[ti];
    for (let span = 2; span <= Math.min(4, rawTokens.length - ti); span++) {
      candidate += rawTokens[ti + span - 1];
      if (isKnown(candidate) || isKnown(collapseRuns(candidate))) {
        best = candidate;
        bestLen = span;
      }
    }
    merged.push(best);
    ti += bestLen;
  }

  // For each word, prefer the raw form if it's in the dictionary; otherwise try collapsed.
  const words = merged.map((w) => {
    if (/^\d+$/.test(w)) return w;
    if (numberWords[w] != null) return w;
    const collapsed = collapseRuns(w);
    if (numberWords[collapsed] != null) return collapsed;
    return collapsed; // default to collapsed for non-number words (operation keywords etc.)
  });

  // Reconstruct compound numbers like "twenty three" → 23, "one hundred
  // twenty" → 120.
  const numbers = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^\d+$/.test(w)) {
      numbers.push(Number(w));
      i += 1;
      continue;
    }
    if (numberWords[w] != null) {
      let total = numberWords[w];
      i += 1;
      while (i < words.length && numberWords[words[i]] != null) {
        const next = numberWords[words[i]];
        if (next === 100) total *= 100;
        else if (next < 100 && total < 100) total += next;
        else break;
        i += 1;
      }
      numbers.push(total);
      continue;
    }
    i += 1;
  }

  if (numbers.length < 2) return null;
  const a = numbers[0];
  const b = numbers[1];

  const hasWord = (w) => words.includes(w);
  const hasAny = (...ws) => ws.some(hasWord);
  let result;
  if (hasAny("subtract", "minus", "less", "difference", "decreased", "loses", "lost", "slower", "slows", "slowed")) {
    result = a - b;
  } else if (hasAny("multiply", "times", "product", "multiplied")) {
    result = a * b;
  } else if (hasAny("divide", "divided", "ratio")) {
    result = b !== 0 ? a / b : a;
  } else {
    // Default to addition — the Moltbook puzzles overwhelmingly ask for
    // "total force", "new speed", "combined", "gains", etc.
    result = a + b;
  }
  return result.toFixed(2);
}

async function cmdMarkScoutSeen(postId) {
  if (!postId) fail("usage: viveworker moltbook mark-scout-seen <postId>");
  const state = rollScoutDayIfNeeded(await readScoutState());
  markPostSeen(state, postId, "avoid-skipped");
  await writeScoutState(state);
  console.log(`marked ${postId} as seen (avoid-skipped)`);
}

// ── Batch scoring ────────────────────────────────────────────
//
// Instead of drafting the first acceptable candidate, the auto-scout
// accumulates scored candidates in state.batch over a configurable
// window (default 30 min). When the window expires the best candidate
// is picked and drafted.

const DEFAULT_BATCH_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

async function cmdBatchAdd(flags) {
  const postId = flags._?.[0] || flags.postId || "";
  const score = Number(flags.score) || 0;
  const title = flags.title || "";
  const author = flags.author || "";
  const postUrl = flags.postUrl || flags["post-url"] || "";
  const submolt = flags.submolt || "";
  const windowMs = Number(flags["window-ms"]) || DEFAULT_BATCH_WINDOW_MS;

  if (!postId) fail("usage: viveworker moltbook batch-add <postId> --score N --title ... --author ...");

  const state = rollScoutDayIfNeeded(await readScoutState());

  // Initialize or validate batch window
  const now = Date.now();
  if (!state.batch || (now - state.batch.startedAt) >= windowMs) {
    // Start a new window
    state.batch = { startedAt: now, windowMs, candidates: [] };
  }

  // Don't add duplicates
  if (state.batch.candidates.some((c) => c.postId === postId)) {
    console.log(JSON.stringify({ status: "duplicate", postId }));
    await writeScoutState(state);
    return;
  }

  state.batch.candidates.push({ postId, score, title, author, postUrl, submolt, addedAt: now });
  await writeScoutState(state);

  const elapsed = Math.round((now - state.batch.startedAt) / 1000);
  const remaining = Math.max(0, Math.round((state.batch.startedAt + windowMs - now) / 1000));
  console.log(JSON.stringify({
    status: "added",
    postId,
    score,
    batchSize: state.batch.candidates.length,
    elapsedSeconds: elapsed,
    remainingSeconds: remaining,
  }, null, 2));
}

async function cmdBatchPick(flags) {
  const windowMs = Number(flags["window-ms"]) || DEFAULT_BATCH_WINDOW_MS;
  const state = rollScoutDayIfNeeded(await readScoutState());

  if (!state.batch || !state.batch.candidates?.length) {
    console.log(JSON.stringify({ status: "empty" }));
    return;
  }

  const now = Date.now();
  const elapsed = now - state.batch.startedAt;

  if (elapsed < windowMs) {
    const remaining = Math.max(0, Math.round((state.batch.startedAt + windowMs - now) / 1000));
    console.log(JSON.stringify({
      status: "waiting",
      batchSize: state.batch.candidates.length,
      elapsedSeconds: Math.round(elapsed / 1000),
      remainingSeconds: remaining,
      topScore: Math.max(...state.batch.candidates.map((c) => c.score)),
    }, null, 2));
    return;
  }

  // Window expired — pick the best candidate
  const sorted = [...state.batch.candidates].sort((a, b) => b.score - a.score);
  const best = sorted[0];

  // Clear the batch
  state.batch = null;
  await writeScoutState(state);

  console.log(JSON.stringify({
    status: "picked",
    postId: best.postId,
    score: best.score,
    title: best.title,
    author: best.author,
    postUrl: best.postUrl,
    submolt: best.submolt,
    consideredCount: sorted.length,
    scores: sorted.map((c) => ({ postId: c.postId, score: c.score, title: c.title })),
  }, null, 2));
}

async function cmdBatchStatus() {
  const state = rollScoutDayIfNeeded(await readScoutState());
  if (!state.batch || !state.batch.candidates?.length) {
    console.log(JSON.stringify({ status: "empty" }));
    return;
  }
  const now = Date.now();
  const elapsed = now - state.batch.startedAt;
  const windowMs = state.batch.windowMs || DEFAULT_BATCH_WINDOW_MS;
  const remaining = Math.max(0, Math.round((state.batch.startedAt + windowMs - now) / 1000));
  const sorted = [...state.batch.candidates].sort((a, b) => b.score - a.score);
  console.log(JSON.stringify({
    status: elapsed >= windowMs ? "ready" : "collecting",
    batchSize: state.batch.candidates.length,
    elapsedSeconds: Math.round(elapsed / 1000),
    remainingSeconds: remaining,
    candidates: sorted.map((c) => ({ postId: c.postId, score: c.score, title: c.title, author: c.author })),
  }, null, 2));
}

const PERSONA_FILE = path.join(os.homedir(), ".viveworker", "moltbook-persona.md");

async function askPrompt(rl, question) {
  const answer = await rl.question(`${question}\n> `);
  return answer.trim();
}

async function cmdPersonaInit() {
  const rl = createReadline({ input: process.stdin, output: process.stdout });
  console.log("");
  console.log("Moltbook persona setup — answer each question or press Enter to skip.");
  console.log("Results will be saved to:", PERSONA_FILE);
  console.log("");

  try {
    const name = await askPrompt(rl, "1) Agent name and first-person pronoun (e.g. 'viveworker, i'):");
    const bio = await askPrompt(rl, "2) 1–2 sentence bio — who is this agent?");
    const expertRaw = await askPrompt(
      rl,
      "3) Topics you can speak on with authority (comma or newline separated, 3–5 items):"
    );
    const curiousRaw = await askPrompt(
      rl,
      "4) Topics you're curious about but not an expert in (optional):"
    );
    const avoidRaw = await askPrompt(rl, "5) Topics/styles to avoid (optional, e.g. 'emojis, marketing tone'):");
    const voice = await askPrompt(
      rl,
      "6) Voice rules (default: 'informal lowercase, 2–3 paragraphs, no signature, prefer ending on one concrete question'):"
    );
    const sample = await askPrompt(rl, "7) One sample reply in your ideal voice (optional — paste a short paragraph):");

    const toList = (raw) =>
      raw
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => `- ${s}`)
        .join("\n");

    const body = [
      "# moltbook persona",
      "",
      name ? `## who i am\n${name}\n${bio || ""}`.trim() : bio ? `## who i am\n${bio}` : "",
      expertRaw ? `## i can talk substantively about\n${toList(expertRaw)}` : "",
      curiousRaw ? `## i'm curious about but not an expert in\n${toList(curiousRaw)}` : "",
      avoidRaw ? `## avoid\n${toList(avoidRaw)}` : "",
      `## voice\n${
        voice ||
        "informal lowercase, 2–3 paragraphs, no signature, prefer ending on one concrete question or conceded open problem"
      }`,
      sample ? `## sample reply\n${sample}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim() + "\n";

    await fsp.mkdir(path.dirname(PERSONA_FILE), { recursive: true });
    await fsp.writeFile(PERSONA_FILE, body, { mode: 0o600 });
    await fsp.chmod(PERSONA_FILE, 0o600);
    console.log("");
    console.log(`Persona saved: ${PERSONA_FILE}`);
    console.log("It will be inlined into the scout prompt on the next auto-scout run.");
    console.log("Edit later with: viveworker moltbook persona edit");
  } finally {
    rl.close();
  }
}

async function cmdPersonaShow() {
  try {
    const body = await fsp.readFile(PERSONA_FILE, "utf8");
    console.log(body);
  } catch {
    fail(`no persona file at ${PERSONA_FILE}. Run: viveworker moltbook persona init`);
  }
}

async function cmdPersonaEdit() {
  try {
    await fsp.access(PERSONA_FILE);
  } catch {
    await fsp.mkdir(path.dirname(PERSONA_FILE), { recursive: true });
    await fsp.writeFile(PERSONA_FILE, "# moltbook persona\n\n", { mode: 0o600 });
  }
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  await new Promise((resolve, reject) => {
    const p = spawn(editor, [PERSONA_FILE], { stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${editor} exited ${code}`))));
    p.on("error", reject);
  });
  console.log(`Persona saved: ${PERSONA_FILE}`);
}

// ---------- Compose (original post) ----------

// Determine the current compose slot based on local hour.
function currentComposeSlot() {
  const hour = new Date().getHours();
  if (hour >= 9 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "noon";
  if (hour >= 17) return "evening";
  return null; // too early
}

// Yesterday as YYYY-MM-DD (local time).
function yesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function cmdCompose(flags) {
  const env = await loadMoltbookEnv();
  const base = (env.VIVEWORKER_BASE_URL || "https://127.0.0.1:8810").replace(/\/+$/u, "");
  const secret = env.VIVEWORKER_HOOK_SECRET || "";
  if (!secret) fail("VIVEWORKER_HOOK_SECRET missing");

  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (!prevTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const state = rollScoutDayIfNeeded(await readScoutState());
  const maxCompose = Number(flags["max-daily"]) || 3;
  if (state.composedToday >= maxCompose) {
    console.log(JSON.stringify({ status: "quota-reached", composedToday: state.composedToday, maxComposeDaily: maxCompose }));
    return;
  }

  // Determine current slot.
  const slot = currentComposeSlot();
  if (!slot) {
    console.log(JSON.stringify({ status: "too-early" }));
    return;
  }

  const attempted = Array.isArray(state.composeSlotsAttempted) ? state.composeSlotsAttempted : [];
  if (attempted.includes(slot)) {
    console.log(JSON.stringify({ status: "slot-attempted", slot }));
    return;
  }

  // Build query params for activity-summary.
  const params = new URLSearchParams({ slot });
  if (slot === "morning") params.set("date", yesterdayKey());
  // For morning, also check that there were no posts yesterday.
  if (slot === "morning" && state.recentComposeTitles?.length && state.lastComposeDay === yesterdayKey()) {
    console.log(JSON.stringify({ status: "morning-already-posted-yesterday" }));
    return;
  }

  // Fetch activity summary from bridge.
  let summary;
  try {
    const r = await fetch(`${base}/api/providers/moltbook/activity-summary?${params}`, {
      headers: { "x-viveworker-hook-secret": secret },
    });
    if (!r.ok) fail(`activity-summary: ${r.status}`);
    summary = await r.json();
  } catch (error) {
    fail(`activity-summary fetch failed: ${error.message}`);
  }

  if (!summary.entries || summary.entries.length < 3) {
    console.log(JSON.stringify({ status: "no-material", slot, activityCount: summary.entries?.length || 0 }));
    return;
  }

  // Mark slot as attempted (even before drafting, to avoid re-proposal on deny).
  state.composeSlotsAttempted = [...attempted, slot];
  await writeScoutState(state);

  // Load persona.
  let persona = "";
  try {
    persona = await fsp.readFile(PERSONA_FILE, "utf8");
  } catch { /* no persona */ }

  console.log(JSON.stringify({
    status: "material",
    slot,
    date: summary.date,
    activityCount: summary.entries.length,
    activitySummary: summary.entries,
    persona: persona ? "(loaded)" : "(none)",
    recentTitles: state.recentComposeTitles || [],
    composedToday: state.composedToday,
    maxComposeDaily: maxCompose,
  }));

  if (!prevTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls ?? "";
}

async function cmdComposePropose(flags) {
  const title = typeof flags.title === "string" ? flags.title : "";
  const content = typeof flags.content === "string" ? flags.content : "";
  const submolt = typeof flags.submolt === "string" ? flags.submolt : "general";
  const intent = typeof flags.intent === "string" ? flags.intent : "";
  const slot = typeof flags.slot === "string" ? flags.slot : "";
  const timeoutSec = Number(flags.timeout) || 900;
  if (!title.trim()) fail("--title is required");
  if (!content.trim()) fail("--content is required");

  const env = await loadMoltbookEnv();
  const base = (env.VIVEWORKER_BASE_URL || "https://127.0.0.1:8810").replace(/\/+$/u, "");
  const secret = env.VIVEWORKER_HOOK_SECRET || "";
  if (!secret) fail("VIVEWORKER_HOOK_SECRET missing");

  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (!prevTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const sourceId = `compose:${Date.now()}`;

  // 1. Submit draft to bridge.
  let submitRes;
  try {
    const r = await fetch(`${base}/api/providers/moltbook/draft`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-viveworker-hook-secret": secret },
      body: JSON.stringify({
        sourceId,
        postId: "",
        postTitle: title,
        draftText: content,
        draftType: "original_post",
        submoltName: submolt,
        intent,
        slot,
        contextSummary: truncate(intent || content, 160),
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      fail(`bridge draft submit failed: ${r.status} ${body}`);
    }
    submitRes = await r.json();
  } catch (error) {
    fail(`bridge submit failed: ${error.message}`);
  }
  const token = submitRes?.token;
  if (!token) fail(`bridge did not return a token: ${JSON.stringify(submitRes)}`);

  console.log(`compose-propose: draft submitted (token=${token}); waiting for decision (timeout=${timeoutSec}s)`);

  // 2. Long-poll decision.
  const deadline = Date.now() + timeoutSec * 1000;
  let decision = null;
  while (Date.now() < deadline && !decision) {
    const remain = Math.min(60, Math.ceil((deadline - Date.now()) / 1000));
    try {
      const r = await fetch(
        `${base}/api/providers/moltbook/draft/${encodeURIComponent(token)}/decision?wait=${remain}`,
        { method: "GET", headers: { "x-viveworker-hook-secret": secret } }
      );
      if (r.ok) {
        const body = await r.json();
        if (body && body.status === "decided") decision = body;
      }
    } catch { /* transient — retry */ }
  }

  if (!decision) {
    console.log("compose-propose: timed out — treating as deny");
    process.exit(2);
  }
  if (decision.action === "deny") {
    console.log("compose-propose: denied by phone");
    process.exit(1);
  }

  // 3. Approve path: create original post.
  const finalTitle = decision.title || title;
  const finalContent = decision.text || content;
  const { mb } = await getClient();
  const result = await mb(`/posts`, {
    method: "POST",
    body: JSON.stringify({
      submolt_name: submolt,
      submolt,
      title: finalTitle,
      content: finalContent,
    }),
  });
  const post = result?.post || null;
  const verification = post?.verification || null;

  console.log(JSON.stringify({ ok: true, action: "posted", postId: post?.id, verification }, null, 2));

  if (!verification) {
    console.log("compose-propose: no verification — done");
  } else {
    // Solve verification puzzle inline (try naive solver, then LLM fallback, retry once on wrong answer).
    let answer = solveVerificationPuzzle(verification.challenge_text);
    const source = answer != null ? "solver" : "skip";
    console.log(`compose-propose: verification puzzle — solver answer: ${answer ?? "(null)"}`);

    if (answer == null) {
      answer = await solvePuzzleWithLLM(verification.challenge_text);
      if (answer) console.log(`compose-propose: LLM fallback answer: ${answer}`);
    }

    if (answer == null) {
      console.log(`VERIFICATION REQUIRED (solver + LLM both failed):\n  verification_code: ${verification.verification_code}\n  challenge_text: ${verification.challenge_text}`);
    } else {
      try {
        const verifyRes = await mb(`/verify`, {
          method: "POST",
          body: JSON.stringify({ verification_code: verification.verification_code, answer }),
        });
        console.log(JSON.stringify({ ok: true, verify: verifyRes, answer }, null, 2));
      } catch (verifyError) {
        const isWrongAnswer = /incorrect/i.test(verifyError.message);
        if (isWrongAnswer && source === "solver") {
          console.log(`compose-propose: solver answer ${answer} was wrong, trying LLM fallback`);
          const llmAnswer = await solvePuzzleWithLLM(verification.challenge_text);
          if (llmAnswer && llmAnswer !== answer) {
            console.log(`compose-propose: LLM retry answer: ${llmAnswer}`);
            try {
              const verifyRes2 = await mb(`/verify`, {
                method: "POST",
                body: JSON.stringify({ verification_code: verification.verification_code, answer: llmAnswer }),
              });
              console.log(JSON.stringify({ ok: true, verify: verifyRes2, answer: llmAnswer }, null, 2));
            } catch (retryError) {
              console.log(`compose-propose: LLM retry also failed: ${retryError.message}`);
            }
          } else {
            console.log(`compose-propose: LLM couldn't produce a different answer`);
          }
        } else {
          console.log(`compose-propose: verify failed: ${verifyError.message}`);
        }
      }
    }
  }

  // 4. Bump compose counter.
  const state = rollScoutDayIfNeeded(await readScoutState());
  recordComposeAttempt(state, finalTitle, post?.id);
  await writeScoutState(state);

  if (!prevTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls ?? "";
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
    case "scout":
      return cmdScout(flags);
    case "propose":
      return cmdPropose(rest[0], flags);
    case "mark-scout-seen":
      return cmdMarkScoutSeen(rest[0]);
    case "batch-add":
      return cmdBatchAdd({ ...flags, _: rest });
    case "batch-pick":
      return cmdBatchPick(flags);
    case "batch-status":
      return cmdBatchStatus();
    case "compose":
      return cmdCompose(flags);
    case "compose-propose":
      return cmdComposePropose(flags);
    case "persona": {
      const sub = rest[0] || "show";
      if (sub === "init") return cmdPersonaInit();
      if (sub === "edit") return cmdPersonaEdit();
      if (sub === "show") return cmdPersonaShow();
      fail(`unknown persona subcommand: ${sub} (expected init|edit|show)`);
      return;
    }
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
  poll                                  Manual one-shot notification refresh
  reconcile                             Mark inbox items already replied to as resolved
  scout [--max-daily N] [--submolts a,b] [--dry-run]
                                        Pick one feed candidate and print context
  propose <postId> --text "..." [--timeout 900] [--parent-id <commentId>]
                                        Submit draft for phone approval, then post on approve
  compose [--max-daily N]               Check activity & return compose material (JSON)
  compose-propose --title "..." --content "..." [--submolt general] [--timeout 900]
                                        Submit original post draft for phone approval, then publish
  persona init|edit|show                Manage ~/.viveworker/moltbook-persona.md (inlined into scout prompt)`);
      return;
    default:
      fail(`unknown command: ${cmd}`);
  }
}
