import type { DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { type DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Snapshot, SnapshotStore } from "../../snapshot/types.js";
import { resolveDocumentClient } from "./client.js";

/**
 * `DynamoSnapshotStore` の設定 (concept.md §5.10, DEC-019)。
 *
 * client resolution は `DynamoEventStore` と同一 (client > clientConfig > default)。
 * **Event Store とは別テーブルを推奨**する（snapshot は単一 item/aggregate を上書きする一方、
 * Event Store は append-only の連番ストリームで、アクセスパターンと TTL 方針が異なるため）。
 */
export interface DynamoSnapshotStoreConfig {
  /** snapshot table 名。PK=aggregateId (HASH) schema を前提とする。 */
  readonly tableName: string;
  /** 新規 `DynamoDBClient` 生成時の config。`client` 未指定時のみ使用。 */
  readonly clientConfig?: DynamoDBClientConfig;
  /** consumer 持参の `DynamoDBDocumentClient`。指定時は `clientConfig` / default より優先。 */
  readonly client?: DynamoDBDocumentClient;
}

/**
 * Amazon DynamoDB を backing store とする `SnapshotStore` 実装 (concept.md §5.10, DEC-019)。
 *
 * - テーブルスキーマ: PK (HASH) = aggregateId (string)。1 aggregate につき 1 item を保持
 * - `save`: `PutCommand` で上書き（同一 aggregateId の既存 snapshot を置き換える）
 * - `load`: `GetCommand` + `ConsistentRead: true`（直前の save を確実に観測する）
 * - `state` は plain data (DEC-011) として marshall され round-trip する
 *
 * @typeParam TState - Aggregate の状態型 (plain data)。
 */
export class DynamoSnapshotStore<TState> implements SnapshotStore<TState> {
  readonly #doc: DynamoDBDocumentClient;
  readonly #tableName: string;

  constructor(config: DynamoSnapshotStoreConfig) {
    this.#tableName = config.tableName;
    this.#doc = resolveDocumentClient(config);
  }

  async load(aggregateId: string): Promise<Snapshot<TState> | null> {
    const result = await this.#doc.send(
      new GetCommand({
        TableName: this.#tableName,
        Key: { aggregateId },
        ConsistentRead: true,
      }),
    );
    if (result.Item === undefined) return null;
    return result.Item as unknown as Snapshot<TState>;
  }

  async save(snapshot: Snapshot<TState>): Promise<void> {
    await this.#doc.send(
      new PutCommand({
        TableName: this.#tableName,
        Item: snapshot as unknown as Record<string, unknown>,
      }),
    );
  }
}
