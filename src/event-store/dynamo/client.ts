import { DynamoDBClient, type DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

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
  if (config.client !== undefined) return config.client;

  const raw = new DynamoDBClient(config.clientConfig ?? {});
  return DynamoDBDocumentClient.from(raw, {
    marshallOptions: RECOMMENDED_MARSHALL_OPTIONS,
    unmarshallOptions: RECOMMENDED_UNMARSHALL_OPTIONS,
  });
}
