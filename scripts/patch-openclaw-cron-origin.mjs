import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = "2026.10.10";
const MARKER = "// Railway hotfix: preserve authenticated channel creator origin.";
const ANCHOR = "function resolveCronCreatorAuthorityGrantProvenance(grant, runId) {";
const CREATOR = '...scope.callerOrigin.kind === "local" ? { callerOrigin: { kind: "local" } } : {},';
const MANAGER = '...entry.scope.callerOrigin.kind === "local" ? { callerOrigin: { kind: "local" } } : {},';
const HELPER = [
  MARKER,
  "function retainAuthenticatedCronCreatorOrigin(scope) {",
  "  const origin = scope.callerOrigin;",
  '  if (origin.kind === "local") return { callerOrigin: { kind: "local" } };',
  "  const requester = channelRequestersByScope.get(scope);",
  '  if (origin.kind === "external" && requester?.channel === origin.channel) {',
  '    return { callerOrigin: { kind: "external", channel: origin.channel } };',
  "  }",
  "  return {};",
  "}",
  "",
].join("\n");

export function patchCronCreatorOrigin(input) {
  const source = input.replaceAll("\r\n", "\n");
  if (source.includes(MARKER)) return source;
  for (const [label, needle] of [["creator export", CREATOR], ["manager export", MANAGER], ["anchor", ANCHOR]]) {
    if (source.split(needle).length !== 2) {
      throw new Error("OpenClaw cron origin patch: unexpected " + label + "; review upstream code before building");
    }
  }
  return source
    .replace(ANCHOR, HELPER + ANCHOR)
    .replace(CREATOR, "...retainAuthenticatedCronCreatorOrigin(scope),")
    .replace(MANAGER, "...retainAuthenticatedCronCreatorOrigin(entry.scope),");
}

export async function applyPatchToInstallation(root) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  if (pkg.version !== VERSION) throw new Error("Cron origin hotfix requires OpenClaw " + VERSION);
  const dist = path.join(root, "dist");
  const files = (await fs.readdir(dist)).filter(name => /^cron-creator-authority-grant-.*\.mjs$/.test(name));
  if (files.length !== 1) throw new Error("Unexpected OpenClaw creator authority bundle count");
  const file = path.join(dist, files[0]);
  const before = await fs.readFile(file, "utf8");
  const after = patchCronCreatorOrigin(before);
  if (after !== before) {
    const temporary = file + ".railway-origin-patch";
    await fs.writeFile(temporary, after, { mode: (await fs.stat(file)).mode });
    await fs.rename(temporary, file);
  }
  console.log("Applied verified-creator origin hotfix to OpenClaw " + VERSION);
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.argv[2];
  if (!root) throw new Error("Usage: node patch-openclaw-cron-origin.mjs <OpenClaw installation>");
  await applyPatchToInstallation(root);
}

