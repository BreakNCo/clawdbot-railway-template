#!/usr/bin/env bash
# Packetor config-as-code. Idempotent, never fatal, safe to run any number of times.
#
# Runs on every container start (called by src/server.js before the gateway starts) and by hand:
#   bash /app/packetor-config/sync.sh
#
# What it does:
#   1. skills     keep the packetor-skills clone on the volume up to date (fast-forward only)
#   2. config     apply OpenClaw settings: skills load path, #leads-capture mention rule
#   2b. mcporter  add missing MCP servers (Firecrawl) to the Discord agent's mcporter.json
#   3. agents     keep a managed routing block in the Discord agent's AGENTS.md
#                 (text from <skills>/<name>/agents-block.md, else agents-blocks/<name>.md)
#
# Env (all optional):
#   GITHUB_PAT_TOKEN            read-only token for the private skills repo (never written to disk)
#   PACKETOR_SKILLS_DIR         default /data/workspace/packetor-skills
#   PACKETOR_SKILLS_REPO        default https://github.com/BreakNCo/packetor-skills.git
#   PACKETOR_SKILLS_REF         default main
#   PACKETOR_DISCORD_WORKSPACE  default /data/workspace-discord-ops
#   OPENCLAW_STATE_DIR          default /data/.openclaw
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="${PACKETOR_SKILLS_DIR:-/data/workspace/packetor-skills}"
SKILLS_REPO="${PACKETOR_SKILLS_REPO:-https://github.com/BreakNCo/packetor-skills.git}"
SKILLS_REF="${PACKETOR_SKILLS_REF:-main}"
DISCORD_WS="${PACKETOR_DISCORD_WORKSPACE:-/data/workspace-discord-ops}"
STATE_DIR="${OPENCLAW_STATE_DIR:-/data/.openclaw}"

log() { echo "[packetor-config] $*"; }

# ---------------------------------------------------------------- 1. skills
sync_skills() {
  if ! command -v git >/dev/null 2>&1; then log "skills: git missing, skipped"; return; fi
  local askpass="" rc=0
  if [ -n "${GITHUB_PAT_TOKEN:-}" ]; then
    askpass="$(mktemp)"; chmod 700 "$askpass"
    # The script only echoes the env var at run time; the token is not stored in the file.
    printf '#!/bin/sh\necho "$GITHUB_PAT_TOKEN"\n' > "$askpass"
    export GIT_ASKPASS="$askpass"
  fi
  export GIT_TERMINAL_PROMPT=0
  local g=(git -c credential.helper= -c credential.username=x-access-token)

  if [ ! -d "$SKILLS_DIR/.git" ]; then
    if [ -z "${GITHUB_PAT_TOKEN:-}" ]; then
      log "skills: $SKILLS_DIR missing and GITHUB_PAT_TOKEN not set, cannot clone"
    else
      mkdir -p "$(dirname "$SKILLS_DIR")"
      if "${g[@]}" clone --quiet --branch "$SKILLS_REF" "$SKILLS_REPO" "$SKILLS_DIR" 2>&1 | sed 's/^/[packetor-config] git: /'; then
        log "skills: cloned $SKILLS_REPO@$SKILLS_REF"
      fi
    fi
  else
    # Keep the remote free of credentials.
    git -C "$SKILLS_DIR" remote set-url origin "$SKILLS_REPO" 2>/dev/null
    if [ -z "${GITHUB_PAT_TOKEN:-}" ]; then
      log "skills: GITHUB_PAT_TOKEN not set, leaving $SKILLS_DIR as is"
    elif [ -n "$(git -C "$SKILLS_DIR" status --porcelain 2>/dev/null)" ]; then
      log "skills: $SKILLS_DIR has local changes, not touching it"
    elif [ "$(git -C "$SKILLS_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)" != "$SKILLS_REF" ]; then
      log "skills: $SKILLS_DIR is not on $SKILLS_REF, not touching it"
    else
      if "${g[@]}" -C "$SKILLS_DIR" fetch --quiet origin "$SKILLS_REF" 2>&1 | sed 's/^/[packetor-config] git: /' \
         && git -C "$SKILLS_DIR" merge --ff-only --quiet FETCH_HEAD 2>&1 | sed 's/^/[packetor-config] git: /'; then
        log "skills: $SKILLS_DIR at $(git -C "$SKILLS_DIR" rev-parse --short HEAD)"
      else
        log "skills: update failed, keeping $(git -C "$SKILLS_DIR" rev-parse --short HEAD 2>/dev/null)"
      fi
    fi
  fi
  [ -n "$askpass" ] && rm -f "$askpass"
  return 0
}

# ---------------------------------------------------------------- 2. config
# set_json <path> <json>: only writes when the value differs (a write triggers a config reload).
set_json() {
  local path="$1" want="$2" cur raw wantraw
  cur="$(openclaw config get "$path" 2>/dev/null | jq -S . 2>/dev/null || true)"
  # `config get` prints plain strings unquoted (room_event), so compare those raw as well.
  raw="$(openclaw config get "$path" 2>/dev/null | tr -d '\n' || true)"
  wantraw="$(printf '%s' "$want" | jq -r 'if type=="string" then . else empty end' 2>/dev/null || true)"
  if { [ -n "$cur" ] && [ "$cur" = "$(printf '%s' "$want" | jq -S .)" ]; } || { [ -n "$wantraw" ] && [ "$raw" = "$wantraw" ]; }; then
    log "config: $path already set"
    return 0
  fi
  if openclaw config set --json "$path" "$want" >/dev/null 2>&1; then
    log "config: set $path"
  else
    log "config: FAILED to set $path"
  fi
}

apply_config() {
  command -v openclaw >/dev/null 2>&1 || { log "config: openclaw not on PATH, skipped"; return; }
  command -v jq >/dev/null 2>&1 || { log "config: jq missing, skipped"; return; }
  if [ ! -f "$STATE_DIR/openclaw.json" ]; then
    log "config: not onboarded yet ($STATE_DIR/openclaw.json missing), skipped; re-run after /setup"
    return
  fi
  set_json skills.load.extraDirs "$(jq -cn --arg d "$SKILLS_DIR" '[$d]')"
  set_json skills.load.watch true
  # Un-mentioned posts (only #leads-capture accepts them) become quiet room events, so a bare
  # NO_REPLY is honoured instead of being reported as a failed run. Replies need the message tool.
  set_json messages.groupChat.unmentionedInbound '"room_event"'
  # Typing indicator from the first second for the Discord agent (does not change who it answers).
  set_json agents.entries.discord-ops.typingMode '"instant"'
  # each #leads-capture post runs in its own thread session, so several can run at once
  set_json agents.defaults.maxConcurrent 10
  if [ -f "$HERE/discord.json" ]; then
    local gid chans
    gid="$(jq -r .guildId "$HERE/discord.json")"
    chans="$(jq -c .channels "$HERE/discord.json")"
    set_json "channels.discord.guilds.$gid.channels" "$chans"
  fi
}

# ---------------------------------------------------------------- 2b. mcporter servers
# Adds servers from mcporter-servers.json to the Discord agent's mcporter config when missing.
# Never overwrites or removes an existing server (zoho-bigin etc. are managed by hand).
apply_mcporter() {
  local cfg="$DISCORD_WS/config/mcporter.json" add="$HERE/mcporter-servers.json" tmp
  [ -f "$cfg" ] && [ -f "$add" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  tmp="$(mktemp)"
  if jq --slurpfile add "$add" '.mcpServers = (($add[0]) + (.mcpServers // {}))' "$cfg" > "$tmp" 2>/dev/null; then
    if [ "$(jq -S . "$tmp")" = "$(jq -S . "$cfg")" ]; then
      log "mcporter: servers already present"
    else
      cp -a "$cfg" "$cfg.pre-packetor-config" 2>/dev/null
      cat "$tmp" > "$cfg" && log "mcporter: added missing servers from mcporter-servers.json"
    fi
  else
    log "mcporter: FAILED to merge servers"
  fi
  rm -f "$tmp"
}

# ---------------------------------------------------------------- 3. agents
apply_agents_blocks() {
  local f="$DISCORD_WS/AGENTS.md"
  [ -f "$f" ] || { log "agents: $f missing, skipped"; return; }
  command -v python3 >/dev/null 2>&1 || { log "agents: python3 missing, skipped"; return; }
  local blk name
  for blk in "$HERE"/agents-blocks/*.md; do
    [ -f "$blk" ] || continue
    name="$(basename "$blk" .md)"
    # The skills repo owns the wording: <skills>/<name>/agents-block.md wins over the bundled copy,
    # so routing changes ship with a skills update. The bundled file is the fallback.
    if [ -f "$SKILLS_DIR/$name/agents-block.md" ]; then
      log "agents: $name block source = $SKILLS_DIR/$name/agents-block.md"
      blk="$SKILLS_DIR/$name/agents-block.md"
    fi
    python3 -I - "$f" "$blk" "$name" "$SKILLS_DIR" <<'PY'
import os, shutil, sys
agents, block_file, name, skills_dir = sys.argv[1:5]
begin = f"<!-- packetor-config:{name}:begin (managed by packetor-config/sync.sh, edit the repo not this block) -->"
end = f"<!-- packetor-config:{name}:end -->"
body = open(block_file).read().replace("__SKILLS_DIR__", skills_dir).strip("\n")
managed = f"{begin}\n{body}\n{end}\n"
text = open(agents).read()
marker = f"<!-- packetor-config:{name}:begin"
if marker in text:
    i = text.index(marker)
    j = text.index(end, i) + len(end)
    j = j + 1 if text[j:j+1] == "\n" else j
    new = text[:i] + managed + text[j:]
    action = "updated"
else:
    new = text.rstrip("\n") + "\n\n" + managed
    action = "added"
if new == text:
    print(f"[packetor-config] agents: {name} block already current")
else:
    bak = agents + ".pre-packetor-config"
    if not os.path.exists(bak):
        shutil.copy2(agents, bak)
    open(agents, "w").write(new)
    print(f"[packetor-config] agents: {name} block {action}")
PY
  done
}

log "start (skills=$SKILLS_DIR@$SKILLS_REF)"
sync_skills
apply_config
apply_mcporter
apply_agents_blocks
log "done"
exit 0
