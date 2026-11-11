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
