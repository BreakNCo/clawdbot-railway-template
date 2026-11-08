# packetor-config

Checked-in, idempotent setup for the Packetor deployment. `sync.sh` runs on every container
start (from `src/server.js`, before the gateway starts, never fatal) and can be run by hand:

```bash
railway ssh -- bash /app/packetor-config/sync.sh
```

| Step | What | Source of truth |
|---|---|---|
| skills | clone/fast-forward `BreakNCo/packetor-skills` (`main`) into `/data/workspace/packetor-skills`; skips if the clone has local changes or is on another branch. Needs `GITHUB_PAT_TOKEN` (read-only, never written to disk) | env `PACKETOR_SKILLS_*` |
| config | `skills.load.extraDirs`/`watch`, and the Discord channel map: reply without a mention in `#leads-capture`, mention required everywhere else | `discord.json` |
| agents | managed routing block in the Discord agent's `AGENTS.md` (between `packetor-config:<name>` markers) | `agents-blocks/*.md` |

Config steps are skipped until OpenClaw is onboarded (`/setup`); restart or re-run afterwards.
Set `PACKETOR_CONFIG_SYNC=0` in Railway to switch the whole thing off. Manual edits to the keys above
or inside the managed block are overwritten on the next start: change this directory instead.

To replicate elsewhere: new Railway service + volume at `/data`, set `SETUP_PASSWORD`, `GITHUB_PAT_TOKEN`,
`DISCORD_BOT_TOKEN`, run `/setup`, restart. Adding another block = drop a `.md` in `agents-blocks/`.
