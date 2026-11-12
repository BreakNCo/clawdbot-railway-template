import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("reset handler stops gateway before deleting config", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const idx = src.indexOf('app.post("/setup/api/reset"');
  assert.ok(idx >= 0);
  const window = src.slice(idx, idx + 900);
  assert.match(window, /stopGatewayAndWait\(\)/);
});

test("restartGateway waits for the old gateway to exit before starting a new one", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const start = src.indexOf("async function restartGateway()");
  assert.ok(start >= 0);
  const body = src.slice(start, start + 200);
  assert.match(body, /await stopGatewayAndWait\(\)/);
  assert.doesNotMatch(body, /sleep\(750\)/);
  assert.match(src, /function startGatewaySupervisor\(/);
  assert.match(src, /startGatewaySupervisor\(\);/);
});

test("memory watchdog default leaves room for the gateway's normal working set", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const m = /OPENCLAW_GATEWAY_MAX_RSS_MB \?\? "(\d+)"/.exec(src);
  assert.ok(m, "default for OPENCLAW_GATEWAY_MAX_RSS_MB not found");
  const mb = Number(m[1]);
  // Healthy gateway reached 2.9 GiB with 7 concurrent runs; the box has an 8 GB cgroup.
  assert.ok(mb >= 3500, `watchdog default ${mb} MiB would restart a healthy gateway`);
  assert.ok(mb <= 6000, `watchdog default ${mb} MiB is too close to the 8 GB container limit`);
});
