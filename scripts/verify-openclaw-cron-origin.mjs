import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const argument = process.argv[2];
let modulePath;
if (argument === "--module") {
  modulePath = path.resolve(process.argv[3]);
} else {
  if (!argument) throw new Error("Usage: node verify-openclaw-cron-origin.mjs <installation> | --module <bundle>");
  const dist = path.join(path.resolve(argument), "dist");
  const names = (await fs.readdir(dist)).filter(name => /^cron-creator-authority-grant-.*\.mjs$/.test(name));
  assert.equal(names.length, 1);
  modulePath = path.join(dist, names[0]);
}
const source = await fs.readFile(modulePath, "utf8");
const api = await import(pathToFileURL(modulePath).href);
function named(namespace, name) {
  const value = Object.values(namespace).find(value => typeof value === "function" && value.name === name);
  assert.ok(value, "Missing real bundled function: " + name);
  return value;
}
const create = named(api, "createCronCreatorAuthorityRunScope");
const mint = named(api, "mintCronCreatorAuthorityGrant");
const resolve = named(api, "resolveCronCreatorAuthorityGrantProvenance");
const revoke = named(api, "revokeCronCreatorAuthorityRunScope");
const manage = named(api, "withCronManagementGrant");
const managementOrigin = named(api, "getCronManagementCallerOrigin");
const managementRequester = named(api, "getCronManagementChannelRequester");
const registryImport = source.match(/from "(\.\/agent-run-registry-[^"]+\.mjs)"/);
assert.ok(registryImport, "Real host authority registry import missing");
const registry = await import(new URL(registryImport[1], pathToFileURL(modulePath)).href);
const claim = named(registry, "claimAgentRunDelegatedAuthority");
const release = named(registry, "releaseAgentRunDelegatedAuthority");
const requester = { version: 1, channel: "discord", accountId: "test-account", senderId: "test-sender" };
let passed = 0;
function creator(origin, nativeRequester, expected) {
  const runId = "cron-origin-regression-" + randomUUID();
  const scope = create(runId, origin, undefined, undefined, nativeRequester);
  try {
    const grant = mint(scope, undefined, undefined, undefined, "requester");
    const provenance = resolve(grant, runId);
    assert.deepEqual(provenance?.callerOrigin, expected);
    if (nativeRequester) assert.deepEqual(provenance.channelRequester, nativeRequester);
    assert.equal(provenance.capturesRuntimeAuthority, false);
    assert.equal(resolve(grant, runId + "-other"), undefined);
    if (provenance.callerOrigin) {
      provenance.callerOrigin.kind = "unknown";
      assert.deepEqual(resolve(grant, runId).callerOrigin, expected, "No mutation through exported origin");
    }
    revoke(scope);
    assert.equal(resolve(grant, runId), undefined, "Revocation still blocks provenance");
    passed++;
  } finally { revoke(scope); }
}
creator({ kind: "external", channel: "discord" }, requester, { kind: "external", channel: "discord" });
creator({ kind: "local" }, undefined, { kind: "local" });
creator({ kind: "unknown" }, requester, undefined);
creator({ kind: "external", channel: "slack" }, requester, undefined);
{
  const scope = create("cron-origin-unverified-" + randomUUID(), { kind: "external", channel: "discord" });
  try {
    assert.throws(() => mint(scope, undefined, undefined, undefined, "requester"), /authenticated creator facts/);
    passed++;
  } finally { revoke(scope); }
}
{
  let current = true;
  const runId = "cron-origin-revoked-owner-" + randomUUID();
  const scope = create(runId, { kind: "external", channel: "discord" },
    { source: "channel-owner", isCurrent: () => current }, undefined, requester);
  try {
    const grant = mint(scope, undefined, undefined, undefined, "requester");
    current = false;
    assert.equal(resolve(grant, runId), undefined);
    assert.throws(() => mint(scope, undefined, undefined, undefined, "requester"), /no longer active/);
    passed++;
  } finally { revoke(scope); }
}
async function manager(origin, nativeRequester, expected) {
  const runId = "cron-origin-manager-" + randomUUID();
  const instance = Object.freeze({ instanceId: randomUUID(), runId });
  const authority = claim(instance);
  let ownerCurrent = true;
  const scope = create(runId, origin, { source: "channel-owner", isCurrent: () => ownerCurrent }, undefined, nativeRequester);
  const operation = new AbortController();
  const identity = { kind: "agentRuntime", agentId: "origin-regression", sessionKey: "agent:origin-regression:discord:channel:test",
    operationalRunInstance: instance, delegatedAuthority: { kind: "local", ...authority } };
  try {
    const grant = mint(scope, operation.signal, undefined, { method: "cron.update", authority });
    await assert.rejects(() => manage(grant, identity, "cron.remove", async () => {}), /missing, expired/);
    await manage(grant, identity, "cron.update", async () => {
      assert.deepEqual(managementOrigin(identity), expected);
      assert.deepEqual(managementRequester(identity), nativeRequester);
      assert.equal(managementOrigin({ ...identity }), undefined, "Identity substitution stays blocked");
      ownerCurrent = false;
      assert.throws(() => managementOrigin(identity), /missing, expired/, "Owner revocation stays enforced");
    });
    assert.equal(managementOrigin(identity), undefined);
    await assert.rejects(() => manage(grant, identity, "cron.update", async () => {}), /missing, expired/);
    passed++;
  } finally {
    revoke(scope);
    release(authority);
  }
}
await manager({ kind: "external", channel: "discord" }, requester, { kind: "external", channel: "discord" });
await manager({ kind: "local" }, undefined, { kind: "local" });
await manager({ kind: "unknown" }, requester, undefined);
await manager({ kind: "external", channel: "slack" }, requester, undefined);
console.log("Cron creator-origin regression: " + passed + " scenarios passed against the real authority bundle.");

