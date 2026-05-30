import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { EventMap } from "../../core/types.js";
import { type DynamoEventStoreConfig, resolveDocumentClient } from "./client.js";
import { DynamoEventStore } from "./index.js";

/**
 * 1 つの DynamoDB テーブル (= 1 つの DocumentClient) を共有しつつ、Aggregate ごとに型を
 * narrow した `EventStore` を発行する facade の返り値 (concept.md §5.13, DEC-023)。
 */
export interface EventStoreTable {
  /**
   * 指定した `TMap` に narrow された `DynamoEventStore<TMap>` を返す。
   * heterogeneous union ではなく単一 Aggregate のストアを返すため、`rehydrate` が依存する
   * 単一ストリーム不変条件と per-Aggregate `TMap` narrowing が保たれる。
   */
  for<TMap extends EventMap>(): DynamoEventStore<TMap>;
}

/**
 * 共有 DocumentClient を持つ `EventStoreTable` を生成する (concept.md §5.13, DEC-023)。
 *
 * `client` resolution は `DynamoEventStore` と同一 (client > clientConfig > default)。
 * resolve は 1 回だけ行い、以降の `.for<TMap>()` は同じ client を再利用する。
 * 複数 Aggregate を 1 テーブルで運用する際の store 構築 boilerplate を解消する。
 *
 * @example
 * ```ts
 * const table = createEventStoreTable({ tableName: "events", client });
 * const orders = table.for<OrderEvents>();
 * const inventory = table.for<InventoryEvents>();
 * ```
 */
export function createEventStoreTable(config: DynamoEventStoreConfig): EventStoreTable {
  const client: DynamoDBDocumentClient = resolveDocumentClient(config);
  const { tableName } = config;
  return {
    for<TMap extends EventMap>(): DynamoEventStore<TMap> {
      return new DynamoEventStore<TMap>({ tableName, client });
    },
  };
}
