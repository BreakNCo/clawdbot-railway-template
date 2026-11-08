#!/usr/bin/env bash
# Packetor config-as-code. Idempotent, never fatal, safe to run any number of times.
#
# Runs on every container start (called by src/server.js before the gateway starts) and by hand:
#   bash /app/packetor-config/sync.sh
#
# What it does:
#   1. skills     keep the packetor-skills clone on the volume up to date (fast-forward only)
#   2. config     apply OpenClaw settings: skills load path, #leads-capture mention rule
#   3. agents     keep a managed routing block in the Discord agent's AGENTS.md
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
  local path="$1" want="$2" cur
  cur="$(openclaw config get "$path" 2>/dev/null | jq -S . 2>/dev/null || true)"
  if [ -n "$cur" ] && [ "$cur" = "$(printf '%s' "$want" | jq -S .)" ]; then
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
  if [ -f "$HERE/discord.json" ]; then
    local gid chans
    gid="$(jq -r .guildId "$HERE/discord.json")"
    chans="$(jq -c .channels "$HERE/discord.json")"
    set_json "channels.discord.guilds.$gid.channels" "$chans"
  fi
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
apply_agents_blocks
log "done"
exit 0
