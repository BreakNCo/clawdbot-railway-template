import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { reclaimForeignGatewayLease } from "../src/gateway-lease.js";

function makeState(host) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-test-"));
  fs.mkdirSync(path.join(stateDir, "state"));
  const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
  db.exec(
    "CREATE TABLE state_leases (scope TEXT, lease_key TEXT, owner TEXT, expires_at INTEGER, heartbeat_at INTEGER, payload_json TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY (scope, lease_key))",
  );
  if (host !== undefined) {
    const now = Date.now();
    db.prepare("INSERT INTO state_leases VALUES (?,?,?,?,?,?,?,?)").run(
      "gateway-owner",
      "global",
      "uuid-1",
      now + 200_000,
      now - 100_000,
      JSON.stringify({ owner: { pid: 553, host, startedAt: 1 }, port: 18789, mode: "foreground", supervisor: null }),
      now,
      now,
    );
  }
  db.close();
  return stateDir;
}

const count = (stateDir) => {
  const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
  const n = db.prepare("SELECT COUNT(*) AS n FROM state_leases").get().n;
  db.close();
  return n;
};

test("reclaims a lease owned by a different container host", async () => {
  const stateDir = makeState("old-container");
  const r = await reclaimForeignGatewayLease({ stateDir, hostname: "new-container", log: () => {} });
  assert.equal(r.reclaimed, true);
  assert.equal(count(stateDir), 0);
});

test("leaves a lease owned by this host alone", async () => {
  const stateDir = makeState("same-host");
  const r = await reclaimForeignGatewayLease({ stateDir, hostname: "same-host", log: () => {} });
  assert.equal(r.reclaimed, false);
  assert.equal(count(stateDir), 1);
});

test("no-ops when there is no lease, no table, or no database", async () => {
  const empty = makeState(undefined);
  assert.equal((await reclaimForeignGatewayLease({ stateDir: empty, hostname: "x", log: () => {} })).reason, "no-lease");
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), "lease-test-"));
  assert.equal((await reclaimForeignGatewayLease({ stateDir: missing, hostname: "x", log: () => {} })).reason, "no-db");
});
