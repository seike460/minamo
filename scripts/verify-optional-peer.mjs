#!/usr/bin/env node
/**
 * optional peerDependencies の隔離 smoke test (DEC-027)。
 *
 * AWS SDK を install していない隔離ディレクトリで dist/index.js を import し、
 * - import が成功すること（静的に AWS SDK を解決しない）
 * - AWS 非依存の surface (InMemoryEventStore 等) が動作すること
 * - Dynamo 系は SDK 不在で明示的なエラーになること
 * を検証する。`pnpm run build` 後に実行すること（CI: Build 直後）。
 *
 * 隔離は OS tmpdir に dist + package.json だけをコピーして行う。リポジトリ内だと
 * node_modules の upward 解決で devDependencies の SDK が見えてしまい偽陽性になるため。
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "minamo-optional-peer-"));

cpSync(join(root, "dist"), join(dir, "dist"), { recursive: true });
cpSync(join(root, "package.json"), join(dir, "package.json"));

const entry = join(dir, "dist", "index.js").replaceAll("\\", "/");
const program = `
const m = await import(${JSON.stringify(`file://${entry}`)});
if (typeof m.InMemoryEventStore !== "function") throw new Error("missing export");
const store = new m.InMemoryEventStore();
await store.append("a", [{ type: "E", data: {} }], 0);
if ((await store.load("a")).length !== 1) throw new Error("InMemoryEventStore broken");
for (const Ctor of [m.DynamoEventStore, m.DynamoSnapshotStore]) {
  let threw = false;
  try { new Ctor({ tableName: "t" }); } catch (e) { threw = /optional peer dependency/.test(e.message); }
  if (!threw) throw new Error("Dynamo store did not fail fast without AWS SDK");
}
let bridgeThrew = false;
try {
  m.parseStreamRecord({ eventName: "INSERT", dynamodb: { NewImage: {} } }, []);
} catch (e) {
  bridgeThrew = /optional peer dependency/.test(e.message);
}
if (!bridgeThrew) throw new Error("parseStreamRecord did not fail fast without AWS SDK");
console.log("optional peer isolation verified");
`;

// 型レベルの隔離も検証する。.d.ts には @aws-sdk/* への `import type` が残るため、
// SDK 不在 + `skipLibCheck: false` では TS2307 になるが、推奨設定の `skipLibCheck: true`
// では InMemory 専用 consumer が型解決できることを保証する (docs/pitfalls.md §5)。
const pkgDir = join(dir, "pkg");
mkdirSync(pkgDir, { recursive: true });
mkdirSync(join(dir, "node_modules", "@seike460"), { recursive: true });
symlinkSync(dir, join(dir, "node_modules", "@seike460", "minamo"), "dir");
writeFileSync(
  join(pkgDir, "test.ts"),
  `import { InMemoryEventStore } from "@seike460/minamo";
const store = new InMemoryEventStore<{ E: { n: number } }>();
void store;
`,
);
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

try {
  execFileSync(process.execPath, ["--input-type=module", "-e", program], { stdio: "inherit" });
  execFileSync(
    process.execPath,
    [
      tsc,
      "--noEmit",
      "--strict",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--target",
      "es2024",
      "--skipLibCheck",
      join(pkgDir, "test.ts"),
    ],
    { stdio: "inherit" },
  );
  console.log("✓ optional peer verification passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
