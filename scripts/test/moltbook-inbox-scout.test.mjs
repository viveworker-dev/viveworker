import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getMoltbookReplyQuotaState,
  hasPendingMoltbookDraftForInboxItem,
  isOwnMoltbookInboxItem,
  looksLikeProviderErrorText,
  pickInboxReplyCandidate,
  reconcileInboxDraftMarkers,
  todayKey,
  writeDraft,
  writeInboxItem,
} from "../moltbook-api.mjs";

const scoutAutoPath = new URL("../moltbook-scout-auto.sh", import.meta.url);
const viveworkerCliPath = new URL("../viveworker.mjs", import.meta.url);

test("pickInboxReplyCandidate prioritizes newest pending inbound comment", () => {
  const picked = pickInboxReplyCandidate([
    {
      commentId: "old",
      postId: "p1",
      status: "pending",
      authorName: "alice",
      createdAt: "2026-05-06T10:00:00.000Z",
    },
    {
      commentId: "new",
      postId: "p2",
      status: "pending",
      authorName: "bob",
      createdAt: "2026-05-06T10:05:00.000Z",
    },
  ]);

  assert.equal(picked.status, "candidate");
  assert.equal(picked.item.commentId, "new");
  assert.equal(picked.consideredCount, 2);
});

test("pickInboxReplyCandidate skips resolved self and already-drafted comments", () => {
  const env = {
    MOLTBOOK_AGENT_ID: "agent-self",
    MOLTBOOK_AGENT_NAME: "viveworker",
  };
  const picked = pickInboxReplyCandidate([
    { commentId: "replied", postId: "p1", status: "replied", authorName: "alice" },
    { commentId: "self-id", postId: "p2", status: "pending", authorId: "agent-self", authorName: "alice" },
    { commentId: "self-name", postId: "p3", status: "pending", authorName: "viveworker" },
    { commentId: "drafted", postId: "p4", status: "pending", authorName: "bob", draftStatus: "proposed" },
    { commentId: "ok", postId: "p5", status: "pending", authorName: "carol" },
  ], env);

  assert.equal(picked.item.commentId, "ok");
  assert.equal(picked.skipReasons.notPending, 1);
  assert.equal(picked.skipReasons.selfAuthor, 2);
  assert.equal(picked.skipReasons.alreadyDrafted, 1);
});

test("failed inbox drafts can be picked again", () => {
  const item = {
    commentId: "retry",
    postId: "p1",
    status: "pending",
    authorName: "alice",
    draftStatus: "failed",
    draftToken: "moltbook_draft:old",
  };

  assert.equal(hasPendingMoltbookDraftForInboxItem(item), false);
  assert.equal(pickInboxReplyCandidate([item]).item.commentId, "retry");
});

test("expired inbox draft markers can be picked again", () => {
  const item = {
    commentId: "retry-expired",
    postId: "p1",
    status: "pending",
    authorName: "alice",
    draftStatus: "expired",
    draftToken: "old",
  };

  assert.equal(hasPendingMoltbookDraftForInboxItem(item), false);
  assert.equal(pickInboxReplyCandidate([item]).item.commentId, "retry-expired");
});

test("reconcileInboxDraftMarkers clears stale proposed inbox drafts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "moltbook-inbox-scout-"));
  const inboxDir = path.join(root, "inbox");
  const draftsDir = path.join(root, "drafts");
  try {
    const nowMs = Date.parse("2026-05-08T00:00:00.000Z");
    await writeInboxItem({
      commentId: "stale",
      postId: "p1",
      status: "pending",
      authorName: "alice",
      draftStatus: "proposed",
      draftToken: "missing-token",
      createdAt: "2026-05-07T00:00:00.000Z",
    }, inboxDir);
    await writeInboxItem({
      commentId: "active",
      postId: "p2",
      status: "pending",
      authorName: "bob",
      draftStatus: "proposed",
      draftToken: "active-token",
      createdAt: "2026-05-07T00:01:00.000Z",
    }, inboxDir);
    await writeDraft({
      token: "active-token",
      createdAtMs: nowMs - 60_000,
      ttlMs: 86_400_000,
      decision: null,
    }, draftsDir);

    const items = [
      JSON.parse(await readFile(path.join(inboxDir, "stale.json"), "utf8")),
      JSON.parse(await readFile(path.join(inboxDir, "active.json"), "utf8")),
    ];
    const reconciled = await reconcileInboxDraftMarkers(items, { inboxDir, draftsDir, nowMs });

    assert.equal(reconciled.resetCount, 1);
    const stale = reconciled.items.find((item) => item.commentId === "stale");
    const active = reconciled.items.find((item) => item.commentId === "active");
    assert.equal(stale.draftStatus, "expired");
    assert.equal(stale.draftToken, "");
    assert.equal(active.draftStatus, "proposed");
    assert.equal(pickInboxReplyCandidate(reconciled.items).item.commentId, "stale");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("own author detection supports agent id and configured agent name", () => {
  assert.equal(isOwnMoltbookInboxItem(
    { authorId: "self-id", authorName: "other" },
    { MOLTBOOK_AGENT_ID: "self-id" },
  ), true);
  assert.equal(isOwnMoltbookInboxItem(
    { authorName: "@my-agent" },
    { MOLTBOOK_AGENT_NAME: "my-agent" },
  ), true);
  assert.equal(isOwnMoltbookInboxItem(
    { authorName: "someone-else" },
    { MOLTBOOK_AGENT_NAME: "my-agent" },
  ), false);
});

test("auto scout runs inbox reply lane before compose and discovery", async () => {
  const source = await readFile(scoutAutoPath, "utf8");

  const inboxIndex = source.indexOf("moltbook inbox-pick");
  const composeIndex = source.indexOf("Step 0: Compose");
  const discoveryIndex = source.indexOf("Step 2 & 3: Find a candidate");

  assert.ok(inboxIndex > 0, "inbox-pick command should be present");
  assert.ok(composeIndex > inboxIndex, "compose should run after inbox lane");
  assert.ok(discoveryIndex > composeIndex, "discovery scout should run after compose");
  assert.match(source, /moltbook inbox-pick \$\{SCOUT_FLAGS:-\}/);
  assert.match(source, /moltbook batch-pick --window-ms "\$WINDOW_MS" \$\{SCOUT_FLAGS:-\}/);
  assert.match(source, /--parent-id "\$INBOX_COMMENT_ID"/);
  assert.match(source, /--source-id "inbox-comment:\$INBOX_COMMENT_ID"/);
});

test("auto scout proposes drafts with a 24 hour default TTL", async () => {
  const source = await readFile(scoutAutoPath, "utf8");

  assert.match(source, /SCOUT_TIMEOUT:-86400/);
  assert.match(source, /PROPOSE_TIMEOUT_SEC="\$\{SCOUT_TIMEOUT:-86400\}"/);
  assert.match(source, /COMPOSE_TIMEOUT="\$PROPOSE_TIMEOUT_SEC"/);
});

test("provider authentication errors are detected before drafting", async () => {
  assert.equal(looksLikeProviderErrorText("Failed to authenticate. API Error: 401"), true);
  assert.equal(
    looksLikeProviderErrorText(
      '{"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
    ),
    true,
  );
  assert.equal(looksLikeProviderErrorText("this reply mentions a 401 status as an example"), false);

  const source = await readFile(scoutAutoPath, "utf8");
  assert.match(source, /looks_like_harness_error\(\)/);
  assert.match(source, /abort_if_harness_error "score" "\$SCORE_RAW"/);
  assert.match(source, /abort_if_harness_error "draft" "\$DRAFT_TEXT"/);
});

test("auto scout can use a harness binary outside launchd PATH", async () => {
  const scoutSource = await readFile(scoutAutoPath, "utf8");
  const cliSource = await readFile(viveworkerCliPath, "utf8");

  assert.match(scoutSource, /CONFIGURED_HARNESS_BIN="\$\{SCOUT_HARNESS_BIN:-\}"/);
  assert.match(scoutSource, /resolve_harness_bin "\$HARNESS" "\$CONFIGURED_HARNESS_BIN"/);
  assert.match(scoutSource, /\/Applications\/ChatGPT\.app\/Contents\/Resources\/codex/);
  assert.match(scoutSource, /\/Applications\/Codex\.app\/Contents\/Resources\/codex/);
  assert.match(scoutSource, /COMPOSE_ACTIVITY_LIMIT="\$\{SCOUT_COMPOSE_ACTIVITY_LIMIT:-30\}"/);
  assert.match(scoutSource, /run_harness_prompt "\$DRAFT_TIMEOUT_SEC" "\$COMPOSE_PROMPT"/);
  assert.match(scoutSource, /-C "\$SCRIPT_DIR\/\.\."/);
  assert.match(scoutSource, /--sandbox read-only/);
  assert.match(scoutSource, /--ephemeral/);
  assert.match(cliSource, /SCOUT_HARNESS_BIN=\$\{shellQuote\(harness\.bin\)\}/);
});

test("auto scout does not consume candidates when harness scoring fails", async () => {
  const source = await readFile(scoutAutoPath, "utf8");
  const emptyScoreCheck = source.indexOf('if [ -z "$SCORE_RAW" ]');
  const parsedScoreCheck = source.indexOf('if [ "$SCORE" -eq 0 ]');

  assert.ok(emptyScoreCheck > 0, "empty harness output should be handled");
  assert.ok(parsedScoreCheck > emptyScoreCheck, "empty output must be handled before score=0");
});

test("reply quota counts active pending reply drafts as reserved slots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "moltbook-quota-"));
  const draftsDir = path.join(root, "drafts");
  try {
    const nowMs = Date.now();
    await writeDraft({
      token: "reply-1",
      draftType: "reply",
      createdAtMs: nowMs - 60_000,
      ttlMs: 86_400_000,
      decision: null,
    }, draftsDir);
    await writeDraft({
      token: "reply-2",
      draftType: "reply",
      createdAtMs: nowMs - 120_000,
      ttlMs: 86_400_000,
      decision: null,
    }, draftsDir);
    await writeDraft({
      token: "post-1",
      draftType: "original_post",
      createdAtMs: nowMs - 60_000,
      ttlMs: 86_400_000,
      decision: null,
    }, draftsDir);
    await writeDraft({
      token: "old-reply",
      draftType: "reply",
      createdAtMs: nowMs - 90_000_000,
      ttlMs: 86_400_000,
      decision: null,
    }, draftsDir);
    await writeDraft({
      token: "decided-reply",
      draftType: "reply",
      createdAtMs: nowMs - 60_000,
      ttlMs: 86_400_000,
      decision: { action: "deny" },
    }, draftsDir);

    const quota = await getMoltbookReplyQuotaState({
      state: {
        day: todayKey(nowMs),
        sentToday: 3,
        seenPostIds: {},
        batch: null,
        lastComposeDay: "",
        composedToday: 0,
        composeSlotsAttempted: [],
        recentComposeTitles: [],
      },
      maxDaily: 5,
      draftsDir,
      nowMs,
    });

    assert.equal(quota.sentToday, 3);
    assert.equal(quota.pendingToday, 2);
    assert.equal(quota.usedToday, 5);
    assert.equal(quota.quotaReached, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
