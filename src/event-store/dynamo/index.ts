import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  type DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { EventMap, EventsOf, StoredEvent, StoredEventsOf } from "../../core/types.js";
import { ConcurrencyError, EventLimitError } from "../../errors.js";
import type { AppendOptions, EventStore } from "../types.js";
import { type DynamoEventStoreConfig, resolveDocumentClient } from "./client.js";
import { approxItemSize, fromItem, toItem } from "./marshaller.js";

/** TransactWriteItems の 100 actions 上限 − ConditionCheck 1 ops 余地 (R15 / C12)。 */
const MAX_EVENTS_PER_APPEND = 99;

/** DynamoDB item の最大サイズ (concept.md §3)。 */
const MAX_ITEM_SIZE_BYTES = 400 * 1024;

/** TransactWriteItems 全体の最大サイズ (concept.md §3)。 */
const MAX_TRANSACTION_BYTES = 4 * 1024 * 1024;

/**
 * attribute name / DDB overhead を差し引く安全マージン。
 * `approxItemSize` は JSON byte 近似のため、真の item size との差を吸収する。
 */
const SIZE_SLACK_BYTES = 16 * 1024;

export type { DynamoEventStoreConfig } from "./client.js";

/**
 * Amazon DynamoDB を backing store として `EventStore<TMap>` を実装する。
 *
 * - append: `TransactWriteCommand` (N Put) でアトミック書き込み。各 Put の
 *   `ConditionExpression: "attribute_not_exists(version)"` で複合キー衝突を検出
 * - load: `QueryCommand` + `ConsistentRead: true` + `LastEvaluatedKey` pagination
 *
 * テーブル schema (C11):
 * - PK (HASH) = aggregateId : string
 * - SK (RANGE) = version : number
 *
 * consumer は本 class に `DynamoDBDocumentClient` を持参するか、`clientConfig`
 * で credential / region を指定する (DEC-014、C2 peer dependency)。
 *
 * @typeParam TMap - Aggregate が扱うイベント型マップ。
 */
export class DynamoEventStore<TMap extends EventMap> implements EventStore<TMap> {
  readonly #doc: DynamoDBDocumentClient;
  readonly #tableName: string;

  constructor(config: DynamoEventStoreConfig) {
    this.#tableName = config.tableName;
    this.#doc = resolveDocumentClient(config);
  }

  async append(
    aggregateId: string,
    events: ReadonlyArray<EventsOf<TMap>>,
    expectedVersion: number,
    options?: AppendOptions,
  ): Promise<ReadonlyArray<StoredEventsOf<TMap>>> {
    if (events.length === 0) {
      throw new EventLimitError(aggregateId, "events must not be empty");
    }
    if (events.length > MAX_EVENTS_PER_APPEND) {
      throw new EventLimitError(
        aggregateId,
        `exceeds maximum ${MAX_EVENTS_PER_APPEND} events per append (got ${events.length})`,
      );
    }

    const timestamp = new Date().toISOString();
    const stored: StoredEvent<string, unknown>[] = events.map((e, i) => {
      const base = {
        type: e.type,
        data: e.data,
        aggregateId,
        version: expectedVersion + i + 1,
        timestamp,
      } as const;
      return options?.correlationId !== undefined
        ? { ...base, correlationId: options.correlationId }
        : base;
    });

    let totalSize = 0;
    for (let i = 0; i < stored.length; i++) {
      const event = stored[i];
      if (event === undefined) continue;
      const itemSize = approxItemSize(event);
      if (itemSize > MAX_ITEM_SIZE_BYTES) {
        throw new EventLimitError(
          aggregateId,
          `event at index ${i} exceeds 400KB item size limit (approx ${itemSize} bytes)`,
        );
      }
      totalSize += itemSize;
    }
    if (totalSize + SIZE_SLACK_BYTES > MAX_TRANSACTION_BYTES) {
      throw new EventLimitError(
        aggregateId,
        `aggregated size exceeds 4MB transaction limit (approx ${totalSize} bytes)`,
      );
    }

    const transactItems: TransactWriteCommand["input"]["TransactItems"] = stored.map((e) => ({
      Put: {
        TableName: this.#tableName,
        Item: toItem(e) as unknown as Record<string, unknown>,
        ConditionExpression: "attribute_not_exists(version)",
      },
    }));

    // expectedVersion > 0 のとき、直前 version の存在を ConditionCheck で検証する。
    // これにより "expectedVersion が実際より大きい / 小さい" のどちらでも
    // TransactWriteItems 全体が ConditionalCheckFailed で rollback される。
    // expectedVersion === 0 のときは先頭 Put の `attribute_not_exists(version)` が
    // "stream が空である" ことを担保するため、追加 ConditionCheck は不要。
    if (expectedVersion > 0) {
      transactItems.unshift({
        ConditionCheck: {
          TableName: this.#tableName,
          Key: { aggregateId, version: expectedVersion },
          ConditionExpression: "attribute_exists(version)",
        },
      });
    }

    try {
      await this.#doc.send(new TransactWriteCommand({ TransactItems: transactItems }));
    } catch (err) {
      if (
        err instanceof TransactionCanceledException &&
        err.CancellationReasons?.some((r) => r.Code === "ConditionalCheckFailed")
      ) {
        throw new ConcurrencyError(aggregateId, expectedVersion);
      }
      throw err;
    }

    return stored as ReadonlyArray<StoredEventsOf<TMap>>;
  }

  async load(aggregateId: string): Promise<ReadonlyArray<StoredEventsOf<TMap>>> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await this.#doc.send(
        new QueryCommand({
          TableName: this.#tableName,
          KeyConditionExpression: "aggregateId = :id",
          ExpressionAttributeValues: { ":id": aggregateId },
          ConsistentRead: true,
          ScanIndexForward: true,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const raw of result.Items ?? []) {
        items.push(raw as Record<string, unknown>);
      }
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey !== undefined);

    return items.map((raw) => fromItem(raw)) as ReadonlyArray<StoredEventsOf<TMap>>;
  }
}
