import type { DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  assertAggregateId,
  assertSnapshot,
  assertTableName,
  normalizePlainData,
} from "../../internal/guards.js";
import { requirePeer } from "../../internal/require-peer.js";
import type { Snapshot, SnapshotStore } from "../../snapshot/types.js";
import { resolveDocumentClient } from "./client.js";

/** `@aws-sdk/lib-dynamodb` を遅延解決する (optional peer / DEC-027)。 */
function libDynamodb(): typeof import("@aws-sdk/lib-dynamodb") {
  return requirePeer("@aws-sdk/lib-dynamodb");
}

/**
 * DynamoDB から取得した item を `Snapshot<TState>` に復元する際の最小 envelope 検証 (DEC-026)。
 *
 * `fromItem`（event marshaller）/ `parseStreamRecord`（stream bridge）と同じく、primary field の
 * 欠損・型違反を沈黙させず `TypeError` として throw する。malformed snapshot は consumer の table が
 * 壊れている兆候であり、`as unknown as` で盲信すると `version` 欠損が `baseVersion + 1 = NaN` のような
 * 沈黙した rehydration 破綻を招く。`state` の中身の shape は consumer schema 責務のまま（`fromItem` の
 * `data` と同方針）。余分な attribute は無視する。
 */
function fromSnapshotItem<TState>(item: Record<string, unknown>): Snapshot<TState> {
  // `fromItem` (marshaller.ts) と同じく `Object.hasOwn` + 型検査を併用する:
  // unmarshall の __proto__ 汚染で prototype 経由に供給された偽装 field を弾く。
  if (item === null || typeof item !== "object") {
    // mock client 由来の非 object item で生 TypeError に落ちないよう防御する。
    throw new TypeError("DynamoDB snapshot item is not an object");
  }
  if (!Object.hasOwn(item, "aggregateId") || typeof item.aggregateId !== "string") {
    throw new TypeError(
      `DynamoDB snapshot item missing string aggregateId (got ${typeof item.aggregateId})`,
    );
  }
  if (!Object.hasOwn(item, "version") || typeof item.version !== "number") {
    throw new TypeError(
      `DynamoDB snapshot item missing numeric version (got ${typeof item.version})`,
    );
  }
  if (!Number.isInteger(item.version) || item.version < 1) {
    throw new TypeError(`DynamoDB snapshot item has invalid version (got ${String(item.version)})`);
  }
  if (!Object.hasOwn(item, "timestamp") || typeof item.timestamp !== "string") {
    throw new TypeError(
      `DynamoDB snapshot item missing string timestamp (got ${typeof item.timestamp})`,
    );
  }
  if (!Object.hasOwn(item, "state") || item.state === undefined) {
    throw new TypeError("DynamoDB snapshot item missing state attribute");
  }
  let state: TState;
  try {
    // unmarshall 産物のネスト map は __proto__ 汚染されうるため clone + own `__proto__`
    // key 除去で正規化する (fromItem と同じ normalizePlainData)。
    state = normalizePlainData(item.state) as TState;
  } catch {
    // 非 cloneable な state は生の DataCloneError ではなく envelope 違反の TypeError に揃える。
    throw new TypeError("DynamoDB snapshot item has non-cloneable state");
  }
  return {
    aggregateId: item.aggregateId,
    version: item.version,
    state,
    timestamp: item.timestamp,
  };
}

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
    // DynamoEventStore と同じく constructor 時点で tableName を検証する。
    assertTableName(config?.tableName);
    this.#tableName = config.tableName;
    this.#doc = resolveDocumentClient(config);
  }

  async load(aggregateId: string): Promise<Snapshot<TState> | null> {
    assertAggregateId(aggregateId);
    const { GetCommand } = libDynamodb();
    const result = await this.#doc.send(
      new GetCommand({
        TableName: this.#tableName,
        Key: { aggregateId },
        ConsistentRead: true,
      }),
    );
    if (result.Item === undefined) return null;
    return fromSnapshotItem<TState>(result.Item as Record<string, unknown>);
  }

  async save(snapshot: Snapshot<TState>): Promise<void> {
    assertSnapshot(snapshot);
    const { PutCommand } = libDynamodb();
    // marshall は send の middleware 内で非同期に走るため、caller が参照を
    // 保持する `snapshot` をそのまま渡すと await 窓での mutation が書き込みに
    // 混入しうる。Proxy 等の非 cloneable な snapshot (assertPlainData は Proxy を
    // 検出できない) も生の DataCloneError ではなく TypeError に揃える。
    let item: Snapshot<TState>;
    try {
      item = structuredClone(snapshot);
    } catch {
      throw new TypeError("snapshot is not structured-cloneable");
    }
    await this.#doc.send(
      new PutCommand({
        TableName: this.#tableName,
        Item: item as unknown as Record<string, unknown>,
      }),
    );
  }
}
