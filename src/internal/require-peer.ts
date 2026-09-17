import { createRequire } from "node:module";

/**
 * optional peer dependency を遅延解決する内部ヘルパー (DEC-027)。
 *
 * `@aws-sdk/*` は optional peerDependencies のため install されていない consumer が存在しうる。
 * flat な root entry (`import "@seike460/minamo"`) は ESM の静的解決で AWS SDK 参照を巻き込む
 * ため、静的 import のままでは SDK 不在環境で `ERR_MODULE_NOT_FOUND` になり、
 * 「InMemoryEventStore のみ使う consumer に AWS SDK を強制しない」設計意図が壊れる。
 *
 * `createRequire` による lazy require で解決を利用時点まで遅延させる:
 * - `import "@seike460/minamo"` は SDK なしで成功する
 * - Dynamo 系 (`DynamoEventStore` / `DynamoSnapshotStore` / `createEventStoreTable`) や
 *   `parseStreamRecord` の利用時に限り、SDK 不在なら明示的な Error で fail する
 *
 * `require` 識別子を直接使わないのは、bundler (rolldown/esbuild) が literal `require("spec")`
 * を静的に辿って解決・同梱しようとするのを避けるため (呼び出しの形で lazy 性を保つ)。
 * 結果は specifier ごとに cache する (同一モジュールの二重 require による instanceof 分岐を避ける)。
 */
const requireModule = createRequire(import.meta.url);
const cache = new Map<string, unknown>();

/** optional peer を遅延 require する。未 install なら導線を示す Error を throw する。 */
export function requirePeer<T>(specifier: string): T {
  if (cache.has(specifier)) return cache.get(specifier) as T;
  let mod: unknown;
  try {
    mod = requireModule(specifier);
  } catch (cause) {
    throw new Error(
      `minamo: optional peer dependency "${specifier}" is not installed. ` +
        "Install the AWS SDK v3 packages to use the DynamoDB-backed EventStore / SnapshotStore / stream bridge.",
      { cause },
    );
  }
  cache.set(specifier, mod);
  return mod as T;
}
