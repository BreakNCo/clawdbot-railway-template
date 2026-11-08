import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SYNC = path.resolve("packetor-config", "sync.sh");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "packetor-config-"));
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  const ws = path.join(dir, "discord-ws");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(state, "openclaw.json"), "{}");
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "# Discord Ops\n\nExisting rules.\n");
  // Fake openclaw: records `config set` calls, returns "unset" for `config get`.
  const calls = path.join(dir, "calls.log");
  fs.writeFileSync(
    path.join(bin, "openclaw"),
    `#!/bin/sh\nif [ "$2" = "set" ]; then echo "$@" >> "${calls}"; exit 0; fi\nexit 1\n`,
    { mode: 0o755 },
  );
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    OPENCLAW_STATE_DIR: state,
    PACKETOR_SKILLS_DIR: path.join(dir, "skills"),
    PACKETOR_DISCORD_WORKSPACE: ws,
  };
  return { dir, ws, calls, env };
}

const run = (env) => childProcess.spawnSync("bash", [SYNC], { env, encoding: "utf8" });

test("sync.sh exits 0 without a token and applies config + one managed AGENTS.md block", () => {
  const { ws, calls, env } = setup();
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /GITHUB_PAT_TOKEN not set|cannot clone/);
  const agents = fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8");
  assert.equal(agents.split("packetor-config:leads-capture:begin").length - 1, 1);
  assert.match(agents, /Existing rules\./);
  assert.match(agents, /1566350552269328506/);
  assert.match(agents, /NO_REPLY/);
  assert.match(agents, /bigin\.py/);
  assert.ok(!agents.includes("__SKILLS_DIR__"));
  assert.ok(fs.existsSync(path.join(ws, "AGENTS.md.pre-packetor-config")));
  const log = fs.readFileSync(calls, "utf8");
  assert.match(log, /skills\.load\.extraDirs/);
  assert.match(log, /channels\.discord\.guilds\.1447134676366921783\.channels/);
  assert.match(log, /"requireMention":false/);
  assert.match(log, /messages\.groupChat\.unmentionedInbound "room_event"/);
  assert.match(log, /agents\.entries\.discord-ops\.typingMode "instant"/);
});

test("sync.sh is idempotent for the AGENTS.md block", () => {
  const { ws, env } = setup();
  run(env);
  const first = fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8");
  const r = run(env);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /block already current/);
  assert.equal(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8"), first);
});

test("sync.sh skips config when OpenClaw is not onboarded yet", () => {
  const { dir, calls, env } = setup();
  fs.rmSync(path.join(dir, "state", "openclaw.json"));
  const r = run(env);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /not onboarded yet/);
  assert.ok(!fs.existsSync(calls));
});

test("a block in the skills clone overrides the bundled one", () => {
  const { dir, ws, env } = setup();
  const skills = path.join(dir, "skills", "leads-capture");
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(skills, "agents-block.md"), "## from skills clone\nread __SKILLS_DIR__/x\n");
  fs.mkdirSync(path.join(dir, "skills", ".git"));
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  const agents = fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8");
  assert.match(agents, /## from skills clone/);
  assert.ok(agents.includes(`read ${path.join(dir, "skills")}/x`));
  assert.ok(!agents.includes("NO_REPLY"));
});

test("sync.sh adds missing mcporter servers without touching existing ones", () => {
  const { ws, env } = setup();
  fs.mkdirSync(path.join(ws, "config"));
  const cfg = path.join(ws, "config", "mcporter.json");
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { "zoho-bigin": { baseUrl: "https://example.invalid/mcp" } } }));
  assert.equal(run(env).status, 0);
  const after = JSON.parse(fs.readFileSync(cfg, "utf8"));
  assert.equal(after.mcpServers["zoho-bigin"].baseUrl, "https://example.invalid/mcp");
  assert.equal(after.mcpServers.firecrawl.command, "npx");
  assert.equal(after.mcpServers.firecrawl.env.FIRECRAWL_API_KEY, "${FIRECRAWL_API_KEY}");
  const again = run(env);
  assert.match(again.stdout, /mcporter: servers already present/);
});

test("sync.sh does not rewrite string settings that `config get` prints unquoted", () => {
  const { dir, calls, env } = setup();
  fs.writeFileSync(
    path.join(dir, "bin", "openclaw"),
    `#!/bin/sh\nif [ "$2" = "set" ]; then echo "$@" >> "${calls}"; exit 0; fi\nif [ "$3" = "messages.groupChat.unmentionedInbound" ]; then echo room_event; exit 0; fi\nexit 1\n`,
    { mode: 0o755 },
  );
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /config: messages\.groupChat\.unmentionedInbound already set/);
  assert.doesNotMatch(fs.readFileSync(calls, "utf8"), /unmentionedInbound/);
});
