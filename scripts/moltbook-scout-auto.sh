#!/usr/bin/env bash
# Automated Moltbook scout with batch scoring window + daily compose.
#
# Each 2-min cycle:
#   Step 0: Check if we should compose an original post today (once/day, needs >= 3 activities).
#   Step 1: Check if the batch window has expired. If yes → pick best → draft → propose → exit.
#   Step 2: Find a candidate post; skip if it matches avoid list.
#   Step 3: Score the candidate (0-100) against persona, add to batch.
#
# Environment:
#   SCOUT_HARNESS   — "claude" or "codex" (default: auto-detect)
#   SCOUT_FLAGS     — extra flags for scout (e.g. "--submolts builds,general --max-daily 5")
#   SCOUT_TIMEOUT   — propose timeout in seconds (default: 900)
#   SCOUT_WINDOW    — batch window in seconds (default: 1800 = 30 min)
#   COMPOSE_MAX     — max original posts per day (default: 1)
set -euo pipefail

# Portable timeout wrapper (macOS lacks GNU timeout)
portable_timeout() {
  local secs="$1"; shift
  perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
VIVEWORKER="$SCRIPT_DIR/viveworker.mjs"
PERSONA_FILE="$HOME/.viveworker/moltbook-persona.md"
WINDOW_SEC="${SCOUT_WINDOW:-1800}"

# Seconds until a given hour (local time). Used for compose slot timeouts.
seconds_until_hour() {
  local target_hour="$1"
  "$NODE" -e "const n=new Date(),t=new Date(n);t.setHours($target_hour,0,0,0);if(t<=n)t.setDate(t.getDate()+1);console.log(Math.floor((t-n)/1000))"
}
WINDOW_MS=$((WINDOW_SEC * 1000))
MAX_SKIP=5

# ── Detect harness ────────────────────────────────────────────
HARNESS="${SCOUT_HARNESS:-}"
HARNESS_BIN=""
if [ -z "$HARNESS" ]; then
  if command -v claude >/dev/null 2>&1; then
    HARNESS="claude"
  elif command -v codex >/dev/null 2>&1; then
    HARNESS="codex"
  fi
fi
if [ -n "$HARNESS" ]; then
  HARNESS_BIN=$(command -v "$HARNESS" 2>/dev/null || true)
fi

# ── Load persona & avoid keywords ─────────────────────────────
PERSONA=""
AVOID_PATTERN=""
if [ -f "$PERSONA_FILE" ]; then
  PERSONA=$(cat "$PERSONA_FILE")
  AVOID_PATTERN=$(echo "$PERSONA" | sed -n '/^## avoid/,/^## /{ /^## /d; p; }' \
    | sed 's/^- *//' \
    | sed '/^$/d' \
    | "$NODE" -e "
      let d=''; process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{
        const lines=d.trim().split('\n').filter(Boolean);
        const kws=[];
        for(const line of lines){
          for(const part of line.split(/[,\/]/)){
            const w=part.trim().toLowerCase()
              .replace(/[''\"]/g,'')
              .replace(/\s+tone$/,'')
              .replace(/\s+threads?$/,'');
            if(w && w.length>2) kws.push(w);
          }
        }
        if(kws.length) console.log(kws.join('|'));
      });
    " 2>/dev/null)
fi

[ -n "$AVOID_PATTERN" ] && echo "[scout-auto] avoid pattern: $AVOID_PATTERN"

candidate_should_skip() {
  [ -z "$AVOID_PATTERN" ] && return 1
  printf '%s\n%s' "$1" "$2" | grep -iqE "$AVOID_PATTERN"
}

# Temp file for JSON interchange
SCOUT_TMP=$(mktemp /tmp/viveworker-scout-XXXXXX.json)
trap 'rm -f "$SCOUT_TMP"' EXIT

read_field() {
  "$NODE" -e "
    const fs=require('fs');
    try{const o=JSON.parse(fs.readFileSync('$SCOUT_TMP','utf8'));console.log(o['$1']||'')}catch{}
  "
}

json_field() {
  echo "$1" | "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).$2||'')}catch{}})"
}

# ═══════════════════════════════════════════════════════════════
# Step 0: Compose an original post (slot-based: morning/noon/evening)
#   - morning (9-12): yesterday's work if not posted yesterday
#   - noon   (12-17): morning's work
#   - evening(17+):   full day's work
#   Max 3 approved posts/day. Each slot proposed at most once.
# ═══════════════════════════════════════════════════════════════
COMPOSE_MAX="${COMPOSE_MAX:-3}"
COMPOSE_JSON=$("$NODE" "$VIVEWORKER" moltbook compose --max-daily "$COMPOSE_MAX" 2>/dev/null) || true
COMPOSE_STATUS=$(json_field "$COMPOSE_JSON" "status")

if [ "$COMPOSE_STATUS" = "material" ] && [ -n "$HARNESS_BIN" ]; then
  COMPOSE_SLOT=$(json_field "$COMPOSE_JSON" "slot")
  ACTIVITY_COUNT=$(json_field "$COMPOSE_JSON" "activityCount")
  ACTIVITY_SUMMARY=$(echo "$COMPOSE_JSON" | "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(d);const e=o.activitySummary||[];console.log(e.map(x=>'- ['+x.kind+'] '+x.title+(x.summary?' — '+x.summary:'')).join('\n'))}catch{}})")
  RECENT_TITLES=$(echo "$COMPOSE_JSON" | "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(d);console.log((o.recentTitles||[]).join(', '))}catch{}})")

  echo "[scout-auto] compose ($COMPOSE_SLOT): ${ACTIVITY_COUNT} activities found"

  # Slot-specific tone instructions.
  case "$COMPOSE_SLOT" in
    morning)
      SLOT_TONE="This is a morning update about yesterday's work. Frame it as a recap: what you accomplished, what you learned, any open questions left over."
      ;;
    noon)
      SLOT_TONE="This is a midday progress update. Share what you've been working on this morning — focus on the most interesting or challenging part so far."
      ;;
    evening)
      SLOT_TONE="This is an end-of-day report. Summarize the full day's work, highlight the key achievement or insight, and mention what's next."
      ;;
    *)
      SLOT_TONE="Share what you've been working on recently."
      ;;
  esac

  COMPOSE_PROMPT="$(cat <<COMPOSE_EOF
${PERSONA:+You are composing an original post on Moltbook (an AI agent social network) on behalf of the agent described below.

CRITICAL RULES:
1. Follow this persona EXACTLY — use the same voice, tone, and interests described below.
2. Only write about activities that overlap with the persona expertise ("i can talk substantively about"). Skip unrelated work entirely.
3. Respect the "avoid" list — do not mention any avoided topics even if they appear in the activity log.
4. The post must sound like the persona wrote it naturally, not like a generated summary.

-----8<----- persona -----8<-----
$PERSONA
-----8<----- end persona -----8<-----

}$SLOT_TONE

Work activity:
$ACTIVITY_SUMMARY

${RECENT_TITLES:+Recent post titles (avoid repeating similar topics): $RECENT_TITLES

}Available submolts: general, builds, tooling, agents, infrastructure

Instructions:
- Filter the activity list through the persona lens — only include work that the persona would genuinely find interesting or worth sharing.
- If none of the activities match the persona expertise, output only: NO_MATCH
- Write in the persona authentic voice. Do not summarize mechanically.
- 2-4 paragraphs. End with a question or open thought to invite discussion.

Output format (no markdown fences, no extra text):

SUBMOLT: (one of the available submolts)
TITLE: (concise title, max 300 chars)
INTENT: (1-2 sentences in Japanese: why this is worth posting from this persona perspective)
---
(post body in persona voice)
COMPOSE_EOF
  )"

  COMPOSE_DRAFT=""
  if [ "$HARNESS" = "claude" ]; then
    COMPOSE_DRAFT=$(portable_timeout 60 "$HARNESS_BIN" -p "$COMPOSE_PROMPT" --output-format text 2>/dev/null) || true
  elif [ "$HARNESS" = "codex" ]; then
    COMPOSE_DRAFT=$(portable_timeout 60 "$HARNESS_BIN" exec "$COMPOSE_PROMPT" 2>/dev/null) || true
  fi

  if [ -n "$COMPOSE_DRAFT" ]; then
    # Check for NO_MATCH signal (persona doesn't align with today's work).
    if echo "$COMPOSE_DRAFT" | grep -q "NO_MATCH"; then
      echo "[scout-auto] compose ($COMPOSE_SLOT): persona has no match with current activities — skipping"
    else
      # Parse SUBMOLT, TITLE, INTENT, and body.
      C_SUBMOLT=$(echo "$COMPOSE_DRAFT" | sed -n 's/^SUBMOLT: *//p' | head -1)
      C_TITLE=$(echo "$COMPOSE_DRAFT" | sed -n 's/^TITLE: *//p' | head -1)
      C_INTENT=""
      C_BODY=""
      if echo "$COMPOSE_DRAFT" | grep -q "^---$"; then
        C_INTENT=$(echo "$COMPOSE_DRAFT" | sed -n 's/^INTENT: *//p' | head -1)
        C_BODY=$(echo "$COMPOSE_DRAFT" | sed '1,/^---$/d')
      else
        C_BODY=$(echo "$COMPOSE_DRAFT" | sed '/^SUBMOLT:/d;/^TITLE:/d;/^INTENT:/d')
      fi
      C_SUBMOLT=${C_SUBMOLT:-general}
      C_TITLE=$(echo "$C_TITLE" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
      C_INTENT=$(echo "$C_INTENT" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
      C_BODY=$(echo "$C_BODY" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

      if [ -n "$C_TITLE" ] && [ -n "$C_BODY" ]; then
        # Timeout = seconds until current slot ends.
        case "$COMPOSE_SLOT" in
          morning) COMPOSE_TIMEOUT=$(seconds_until_hour 12) ;;
          noon)    COMPOSE_TIMEOUT=$(seconds_until_hour 17) ;;
          evening) COMPOSE_TIMEOUT=$(seconds_until_hour 24) ;;
          *)       COMPOSE_TIMEOUT=1800 ;;
        esac
        echo "[scout-auto] compose ($COMPOSE_SLOT): title='$C_TITLE' submolt=$C_SUBMOLT (${#C_BODY} chars, timeout=${COMPOSE_TIMEOUT}s)"

        "$NODE" "$VIVEWORKER" moltbook compose-propose \
          --title "$C_TITLE" \
          --content "$C_BODY" \
          --submolt "$C_SUBMOLT" \
          --intent "${C_INTENT:-auto-compose: $COMPOSE_SLOT update}" \
          --timeout "$COMPOSE_TIMEOUT"

        exit 0
      else
        echo "[scout-auto] compose ($COMPOSE_SLOT): draft parsing failed (title='$C_TITLE', body=${#C_BODY} chars)"
      fi
    fi
  else
    echo "[scout-auto] compose ($COMPOSE_SLOT): harness returned empty draft"
  fi
fi

# ═══════════════════════════════════════════════════════════════
# Step 1: Check if the batch window has expired → pick & draft
# ═══════════════════════════════════════════════════════════════
PICK_JSON=$("$NODE" "$VIVEWORKER" moltbook batch-pick --window-ms "$WINDOW_MS" 2>/dev/null) || true
PICK_STATUS=$(json_field "$PICK_JSON" "status")

if [ "$PICK_STATUS" = "picked" ]; then
  BEST_POST_ID=$(json_field "$PICK_JSON" "postId")
  BEST_TITLE=$(json_field "$PICK_JSON" "title")
  BEST_AUTHOR=$(json_field "$PICK_JSON" "author")
  BEST_SCORE=$(json_field "$PICK_JSON" "score")
  CONSIDERED=$(json_field "$PICK_JSON" "consideredCount")

  echo "[scout-auto] batch complete: picked '$BEST_TITLE' by @$BEST_AUTHOR (score=$BEST_SCORE, considered=$CONSIDERED)"

  # Fetch post content from Moltbook API
  POST_DATA=$("$NODE" --input-type=module -e "
    import { readFileSync } from 'fs';
    const env = readFileSync(process.env.HOME + '/.viveworker/moltbook.env', 'utf8');
    for(const line of env.split('\n')){
      const m = line.match(/^(\w+)=(.*)\$/);
      if(m) process.env[m[1]] = m[2];
    }
    const { createMoltbookClient } = await import('./scripts/moltbook-api.mjs');
    const { client: mb } = await createMoltbookClient();
    try {
      const post = await mb('/posts/${BEST_POST_ID}');
      const p = post?.post || post;
      console.log(JSON.stringify({ content: p?.content || p?.body || '' }));
    } catch(e) {
      console.log(JSON.stringify({ content: '' }));
    }
  " 2>/dev/null) || echo '{"content":""}'
  POST_CONTENT=$(json_field "$POST_DATA" "content")
  POST_URL="https://www.moltbook.com/post/$BEST_POST_ID"

  # ── Draft via LLM ────────────────────────────────────────
  if [ -z "$HARNESS_BIN" ]; then
    echo "[scout-auto] error: neither 'claude' nor 'codex' CLI found"
    exit 1
  fi

  DRAFT_PROMPT="$(cat <<PROMPT_EOF
${PERSONA:+You are drafting a reply on behalf of the agent described below. Follow this persona precisely.
-----8<----- persona -----8<-----
$PERSONA
-----8<----- end persona -----8<-----

}You are replying to the following post on Moltbook (an AI agent social network).

Title: $BEST_TITLE
Author: @$BEST_AUTHOR
URL: $POST_URL

Post body:
$POST_CONTENT

Draft a reply in the persona voice (or, if no persona is set, informal lowercase, 2-3 paragraphs, technically substantive, no signature). Prefer ending on one concrete question or a conceded open problem.

Output in this exact format — no markdown fences, no extra text:

INTENT: (1-2 sentences in Japanese: why this post caught your attention and what angle your reply takes — this is shown to the human operator for approval context)
---
(your reply text here)
PROMPT_EOF
  )"

  echo "[scout-auto] drafting via $HARNESS for '$BEST_TITLE'"
  DRAFT_TEXT=""
  if [ "$HARNESS" = "claude" ]; then
    DRAFT_TEXT=$("$HARNESS_BIN" -p "$DRAFT_PROMPT" --output-format text) || true
  elif [ "$HARNESS" = "codex" ]; then
    DRAFT_TEXT=$("$HARNESS_BIN" exec "$DRAFT_PROMPT") || true
  fi

  if [ -z "$DRAFT_TEXT" ]; then
    echo "[scout-auto] error: harness returned empty draft"
    exit 1
  fi

  # Parse INTENT and reply body
  INTENT=""
  REPLY_BODY=""
  if echo "$DRAFT_TEXT" | grep -q "^---$"; then
    INTENT=$(echo "$DRAFT_TEXT" | sed -n '1,/^---$/p' | sed '/^---$/d' | sed 's/^INTENT: *//')
    REPLY_BODY=$(echo "$DRAFT_TEXT" | sed '1,/^---$/d')
  else
    REPLY_BODY="$DRAFT_TEXT"
    INTENT="auto-scout: responding to @${BEST_AUTHOR}'s post (score=$BEST_SCORE)"
  fi
  INTENT=$(echo "$INTENT" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  REPLY_BODY=$(echo "$REPLY_BODY" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

  if [ -z "$REPLY_BODY" ]; then
    echo "[scout-auto] error: parsed draft body is empty"
    exit 1
  fi

  echo "[scout-auto] intent: $INTENT"
  echo "[scout-auto] draft ready (${#REPLY_BODY} chars), submitting propose"

  # ── Propose ──────────────────────────────────────────────
  "$NODE" "$VIVEWORKER" moltbook propose "$BEST_POST_ID" \
    --title "$BEST_TITLE" \
    --post-author "$BEST_AUTHOR" \
    --post-body "$POST_CONTENT" \
    --intent "$INTENT" \
    --text "$REPLY_BODY" \
    --timeout "$WINDOW_SEC"

  exit 0
fi

# ═══════════════════════════════════════════════════════════════
# Step 2 & 3: Find a candidate, score, add to batch
# ═══════════════════════════════════════════════════════════════
echo "[scout-auto] collecting candidates (window: ${WINDOW_SEC}s)"
SKIP_COUNT=0

while [ $SKIP_COUNT -lt $MAX_SKIP ]; do
  "$NODE" "$VIVEWORKER" moltbook scout ${SCOUT_FLAGS:-} > "$SCOUT_TMP" 2>/dev/null || true

  STATUS=$("$NODE" -e "
    const fs=require('fs');
    try{console.log(JSON.parse(fs.readFileSync('$SCOUT_TMP','utf8')).status)}catch{console.log('error')}
  ")

  if [ "$STATUS" = "already-engaged" ]; then
    SKIP_COUNT=$((SKIP_COUNT + 1))
    echo "[scout-auto] already engaged, retrying [$SKIP_COUNT/$MAX_SKIP]"
    continue
  fi

  if [ "$STATUS" != "candidate" ]; then
    echo "[scout-auto] no candidate (status=$STATUS)"
    exit 0
  fi

  POST_ID=$(read_field postId)
  POST_TITLE=$(read_field title)
  POST_AUTHOR=$(read_field author)
  POST_CONTENT=$(read_field content)
  POST_URL=$(read_field postUrl)
  POST_SUBMOLT=$(read_field submolt)

  # Keyword filter
  if candidate_should_skip "$POST_TITLE" "$POST_CONTENT"; then
    SKIP_COUNT=$((SKIP_COUNT + 1))
    echo "[scout-auto] skipping (avoid keyword): $POST_TITLE (by @$POST_AUTHOR) [$SKIP_COUNT/$MAX_SKIP]"
    "$NODE" "$VIVEWORKER" moltbook mark-scout-seen "$POST_ID" 2>/dev/null || true
    continue
  fi

  # LLM scoring (0-100)
  SCORE=0
  if [ -n "$PERSONA" ] && [ -n "$HARNESS_BIN" ]; then
    SCORE_PROMPT="You are scoring Moltbook posts for an AI agent. Rate how well this post matches the agent's expertise and interests on a scale of 0-100.

Score 0: post matches the avoid list, or is completely outside the agent's domain.
Score 1-30: tangentially related but the agent has little to add.
Score 31-60: relevant topic, the agent could contribute meaningfully.
Score 61-80: strong match with the agent's core expertise.
Score 81-100: excellent match — the agent has direct experience and a unique angle.

Persona:
$PERSONA

Post title: $POST_TITLE
Post author: @$POST_AUTHOR
Post body (first 500 chars): ${POST_CONTENT:0:500}

Reply with ONLY a number from 0 to 100. Nothing else."

    SCORE_RAW=""
    if [ "$HARNESS" = "claude" ]; then
      SCORE_RAW=$(portable_timeout 30 "$HARNESS_BIN" -p "$SCORE_PROMPT" --output-format text 2>/dev/null) || true
    elif [ "$HARNESS" = "codex" ]; then
      SCORE_RAW=$(portable_timeout 30 "$HARNESS_BIN" exec "$SCORE_PROMPT" 2>/dev/null) || true
    fi

    SCORE=$(echo "$SCORE_RAW" | tr -dc '0-9\n' | head -1)
    SCORE=${SCORE:-0}

    if [ "$SCORE" -eq 0 ] 2>/dev/null; then
      SKIP_COUNT=$((SKIP_COUNT + 1))
      echo "[scout-auto] skipping (score=0): $POST_TITLE (by @$POST_AUTHOR) [$SKIP_COUNT/$MAX_SKIP]"
      "$NODE" "$VIVEWORKER" moltbook mark-scout-seen "$POST_ID" 2>/dev/null || true
      continue
    fi

    if [ -z "$SCORE_RAW" ]; then
      SKIP_COUNT=$((SKIP_COUNT + 1))
      echo "[scout-auto] skipping (score failed): $POST_TITLE (by @$POST_AUTHOR) [$SKIP_COUNT/$MAX_SKIP]"
      continue
    fi
  else
    SCORE=50
  fi

  echo "[scout-auto] scored $SCORE: $POST_TITLE (by @$POST_AUTHOR)"

  # Add to batch
  "$NODE" "$VIVEWORKER" moltbook batch-add "$POST_ID" \
    --score "$SCORE" \
    --title "$POST_TITLE" \
    --author "$POST_AUTHOR" \
    --post-url "$POST_URL" \
    --submolt "$POST_SUBMOLT" \
    --window-ms "$WINDOW_MS" 2>/dev/null || true

  break
done

if [ $SKIP_COUNT -ge $MAX_SKIP ]; then
  echo "[scout-auto] all $MAX_SKIP candidates skipped this cycle"
fi

echo "[scout-auto] cycle done — waiting for next invocation"
