import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// OpenClaw's gateway claims a row (scope "gateway-owner", key "global") in
// <state>/state/openclaw.sqlite with a 5 min TTL kept alive by a heartbeat. A new
// gateway reclaims a leftover row immediately only if the recorded owner host
// equals its own hostname AND the pid is dead. Railway gives every deployment a
// new container hostname, so after a redeploy the old row is "unknown" and the new
// gateway has to wait out the TTL (observed 5-8 min of downtime per deploy).
//
// The wrapper is the only thing that spawns the gateway in this container, and a
// Railway service with a volume never runs two containers on it at once, so a row
// owned by a different host cannot belong to a live gateway. Same-host rows are
// left alone: OpenClaw handles those itself (dead pid -> reclaim, live pid -> real).

export const GATEWAY_LEASE_SCOPE = "gateway-owner";
export const GATEWAY_LEASE_KEY = "global";

export async function reclaimForeignGatewayLease({
  stateDir,
  hostname = os.hostname(),
  log = console.log,
} = {}) {
  const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
  if (!fs.existsSync(dbPath)) return { reclaimed: false, reason: "no-db" };

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return { reclaimed: false, reason: "no-node-sqlite" };
  }

  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    const table = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='state_leases'")
      .get();
    if (!table) return { reclaimed: false, reason: "no-table" };

    const row = db
      .prepare("SELECT owner, payload_json, heartbeat_at FROM state_leases WHERE scope = ? AND lease_key = ?")
      .get(GATEWAY_LEASE_SCOPE, GATEWAY_LEASE_KEY);
    if (!row) return { reclaimed: false, reason: "no-lease" };

    let ownerHost = null;
    try {
      ownerHost = JSON.parse(row.payload_json)?.owner?.host ?? null;
    } catch {
      // unparseable payload: leave it for OpenClaw to deal with
    }
    if (!ownerHost || ownerHost === hostname) {
      return { reclaimed: false, reason: "same-or-unknown-host" };
    }

    db.prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ? AND owner = ?").run(
      GATEWAY_LEASE_SCOPE,
      GATEWAY_LEASE_KEY,
      row.owner,
    );
    log(
      `[wrapper] reclaimed stale gateway lease from previous container host=${ownerHost} (heartbeat ${Math.round((Date.now() - Number(row.heartbeat_at)) / 1000)}s ago)`,
    );
    return { reclaimed: true, ownerHost };
  } catch (err) {
    return { reclaimed: false, reason: `error: ${String(err)}` };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}
