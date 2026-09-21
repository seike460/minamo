import type { DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { isObjectRecord } from "../../internal/guards.js";
import { requirePeer } from "../../internal/require-peer.js";

/**
 * U8 DynamoEventStore の constructor config。concept.md §5.8 逐字。
 *
 * client resolution 優先度 (DEC 対応、R5):
 * 1. `config.client` を最優先 (consumer が marshallOptions を含めて責任を持つ)
 * 2. `config.clientConfig` があれば新規 `DynamoDBClient` を生成
 * 3. 未指定なら default `new DynamoDBClient({})` (AWS SDK の default credential chain)
 */
export interface DynamoEventStoreConfig {
  /** DynamoDB table 名。PK=aggregateId (HASH) / SK=version (RANGE) schema を前提とする。 */
  readonly tableName: string;
  /**
   * 新規 `DynamoDBClient` 生成時の config (region / endpoint / credentials 等)。
   * `client` が未指定のときのみ使用される。
   */
  readonly clientConfig?: DynamoDBClientConfig;
  /**
   * consumer が持参する `DynamoDBDocumentClient`。指定されれば `clientConfig` / default より
   * 優先される。marshallOptions は consumer 側の設定が使われる (R5: docs で推奨設定を明示)。
   */
  readonly client?: DynamoDBDocumentClient;
}

/**
 * 推奨 marshallOptions (R5):
 * - `removeUndefinedValues: true` — DEC-011 に違反する undefined を防御的に除去
 * - `convertEmptyValues: false` — 空文字を NULL に変換しない (意味論が変わるため)
 * - `convertClassInstanceToMap: false` — class instance を marshal しない (plain data 強制)
 */
const RECOMMENDED_MARSHALL_OPTIONS = {
  removeUndefinedValues: true,
  convertEmptyValues: false,
  convertClassInstanceToMap: false,
} as const;

/**
 * 推奨 unmarshallOptions:
 * - `wrapNumbers: false` — version (number) を BigInt/NumberValue に wrap せず native number を返す
 */
const RECOMMENDED_UNMARSHALL_OPTIONS = {
  wrapNumbers: false,
} as const;

/**
 * U8 DynamoEventStore が使用する `DynamoDBDocumentClient` を resolve する。
 *
 * - `config.client` が指定されていればそのまま返す (consumer 責務で marshall 設定)
 * - `config.clientConfig` があれば新規 `DynamoDBClient` を生成し推奨 marshallOptions で wrap
 * - どちらも未指定なら default `DynamoDBClient` を生成し推奨 marshallOptions で wrap
 */
export function resolveDocumentClient(config: DynamoEventStoreConfig): DynamoDBDocumentClient {
  if (config.client !== undefined) {
    // `send` を持たない持参 client は初回 `.send()` 呼び出しまで設定ミスが
    // 持ち越されるため constructor 経路で弾く (tableName 検証と同じ fail-early 方針)。
    // 最小 shape のみ要求する — mock/test double が `send` のみ実装する用法を壊さない。
    if (
      config.client === null ||
      typeof (config.client as { send?: unknown }).send !== "function"
    ) {
      throw new TypeError("config.client must be a DynamoDBDocumentClient (missing send method)");
    }
    return config.client;
  }
  // 非 object の clientConfig は `?? {}` の射程外で SDK constructor に素通りし、
  // エラー有無が SDK 実装依存になるため入口で弾く。
  if (config.clientConfig !== undefined && !isObjectRecord(config.clientConfig)) {
    throw new TypeError("config.clientConfig must be a DynamoDBClientConfig object");
  }

  // AWS SDK は optional peer のため遅延解決する (DEC-027)。
  // `config.client` 持参の consumer は SDK import を一切必要としない。
  const { DynamoDBClient } = requirePeer<typeof import("@aws-sdk/client-dynamodb")>(
    "@aws-sdk/client-dynamodb",
  );
  const { DynamoDBDocumentClient } =
    requirePeer<typeof import("@aws-sdk/lib-dynamodb")>("@aws-sdk/lib-dynamodb");
  const raw = new DynamoDBClient(config.clientConfig ?? {});
  return DynamoDBDocumentClient.from(raw, {
    marshallOptions: RECOMMENDED_MARSHALL_OPTIONS,
    unmarshallOptions: RECOMMENDED_UNMARSHALL_OPTIONS,
  });
}
