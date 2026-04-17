import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AggregateConfig } from "../core/aggregate.js";
import type { EventMap, StoredEvent } from "../core/types.js";
import { InvalidStreamRecordError } from "../errors.js";

/** `parseStreamRecord` の optional な挙動切替。 */
export interface ParseStreamRecordOptions {
  /**
   * 登録されていない event type の record を throw ではなく `null` として扱う。
   * デフォルト false (strict-by-default、DEC-013)。
   */
  readonly ignoreUnknownTypes?: boolean;
}

/**
 * DynamoDB Streams の 1 record を `StoredEvent` に正規化する write-read bridge。
 *
 * 仕様 (concept.md §5.7 / U9 design §6.1):
 * - `eventName` が `"INSERT"` 以外 (MODIFY / REMOVE / undefined) は `null` を返す (silent skip)
 * - `dynamodb.NewImage` が無い場合は `InvalidStreamRecordError(missing_field, "dynamodb.NewImage")`
 * - `unmarshall` (`@aws-sdk/util-dynamodb`) で AttributeValue → plain JS に変換
 *   - 失敗時は `InvalidStreamRecordError(unmarshal_failed, ...)`
 * - 必須 field (aggregateId / version / type / timestamp) の型違反は `missing_field`
 * - `eventNames` に含まれない type は strict mode で `unknown_type`、lenient mode で `null`
 * - `correlationId` が string として存在する場合のみ stored に付与 (DEC-011)
 *
 * `data` は `unknown` のまま返す。schema 検証は consumer 責務 (DEC-013)。
 *
 * @typeParam TMap - Aggregate が扱うイベント型マップ。
 * @typeParam TEventName - `eventNames` が narrow する event 名リテラル (default: `keyof TMap & string`)。
 */
export function parseStreamRecord<
  TMap extends EventMap,
  TEventName extends keyof TMap & string = keyof TMap & string,
>(
  record: unknown,
  eventNames: ReadonlyArray<TEventName>,
  options?: ParseStreamRecordOptions,
): StoredEvent<TEventName, unknown> | null {
  const rec = record as {
    eventName?: string;
    dynamodb?: { NewImage?: Record<string, unknown>; Keys?: Record<string, unknown> };
  } | null;

  if (!rec || rec.eventName !== "INSERT") return null;

  const newImage = rec.dynamodb?.NewImage;
  if (newImage === undefined || newImage === null) {
    throw new InvalidStreamRecordError(
      "missing_field",
      "DynamoDB Stream Record has no NewImage. Ensure StreamViewType=NEW_IMAGE.",
      "dynamodb.NewImage",
    );
  }

  let item: Record<string, unknown>;
  try {
    item = unmarshall(newImage as Parameters<typeof unmarshall>[0]) as Record<string, unknown>;
  } catch (err) {
    throw new InvalidStreamRecordError(
      "unmarshal_failed",
      `Failed to unmarshall NewImage: ${(err as Error).message}`,
      (err as Error).message,
    );
  }

  if (typeof item.aggregateId !== "string") {
    throw new InvalidStreamRecordError(
      "missing_field",
      "aggregateId must be a string",
      "aggregateId",
    );
  }
  if (typeof item.version !== "number") {
    throw new InvalidStreamRecordError("missing_field", "version must be a number", "version");
  }
  if (typeof item.type !== "string") {
    throw new InvalidStreamRecordError("missing_field", "type must be a string", "type");
  }
  if (typeof item.timestamp !== "string") {
    throw new InvalidStreamRecordError("missing_field", "timestamp must be a string", "timestamp");
  }

  if (!(eventNames as ReadonlyArray<string>).includes(item.type)) {
    if (options?.ignoreUnknownTypes === true) return null;
    throw new InvalidStreamRecordError(
      "unknown_type",
      `Event type "${item.type}" is not in the accepted event names`,
      item.type,
    );
  }

  const base = {
    type: item.type as TEventName,
    data: item.data as unknown,
    aggregateId: item.aggregateId,
    version: item.version,
    timestamp: item.timestamp,
  };
  return typeof item.correlationId === "string"
    ? { ...base, correlationId: item.correlationId }
    : base;
}

/**
 * `AggregateConfig.evolve` から型安全に event 名配列を取り出す DRY helper。
 *
 * `parseStreamRecord` の第 2 引数にそのまま渡せる。`Object.keys` は
 * `string[]` を返すが、`evolve` は `Evolver<TState, TMap>` の mapped type なので
 * key は `keyof TMap & string` 由来である (cast は型安全)。
 */
export function eventNamesOf<TState, TMap extends EventMap>(
  config: AggregateConfig<TState, TMap>,
): ReadonlyArray<keyof TMap & string> {
  return Object.keys(config.evolve) as Array<keyof TMap & string>;
}
