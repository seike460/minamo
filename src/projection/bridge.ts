import type { AggregateConfig } from "../core/aggregate.js";
import type { EventMap, StoredEvent } from "../core/types.js";
import { InvalidStreamRecordError } from "../errors.js";
import { clip } from "../internal/guards.js";
import { requirePeer } from "../internal/require-peer.js";

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
 *   - unmarshall は `"__proto__"` キーを持つ Map で [[Prototype]] を汚染するため、
 *     必須 field は `Object.hasOwn` で検査し、`data` は `structuredClone` で正規化する
 * - 必須 field (aggregateId / version / type / timestamp / data) の型違反は `missing_field`
 * - `version` は整数かつ >= 1 を要求 (不正な値は `missing_field`)
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

  // `@aws-sdk/util-dynamodb` は optional peer のため利用時点で遅延解決する (DEC-027)。
  // SDK 不在環境でも `import "minamo"` 自体は成功する。
  const { unmarshall } =
    requirePeer<typeof import("@aws-sdk/util-dynamodb")>("@aws-sdk/util-dynamodb");

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

  // `Object.hasOwn` + 型検査の併用: unmarshall が汚染した [[Prototype]] 経由で
  // 供給された偽装 field (item.__proto__.version 等) を typeof 検査が通してしまう
  // ことを防ぐ。own property でない必須 field は存在しないものとして扱う。
  if (!Object.hasOwn(item, "aggregateId") || typeof item.aggregateId !== "string") {
    throw new InvalidStreamRecordError(
      "missing_field",
      "aggregateId must be a string",
      "aggregateId",
    );
  }
  if (!Object.hasOwn(item, "version") || typeof item.version !== "number") {
    throw new InvalidStreamRecordError("missing_field", "version must be a number", "version");
  }
  if (!Number.isInteger(item.version) || item.version < 1) {
    throw new InvalidStreamRecordError(
      "missing_field",
      `version must be an integer >= 1 (got ${String(item.version)})`,
      "version",
    );
  }
  if (!Object.hasOwn(item, "type") || typeof item.type !== "string") {
    throw new InvalidStreamRecordError("missing_field", "type must be a string", "type");
  }
  if (!Object.hasOwn(item, "timestamp") || typeof item.timestamp !== "string") {
    throw new InvalidStreamRecordError("missing_field", "timestamp must be a string", "timestamp");
  }
  if (!Object.hasOwn(item, "data") || item.data === undefined) {
    throw new InvalidStreamRecordError("missing_field", "data attribute is required", "data");
  }

  if (!(eventNames as ReadonlyArray<string>).includes(item.type)) {
    if (options?.ignoreUnknownTypes === true) return null;
    throw new InvalidStreamRecordError(
      "unknown_type",
      `Event type ${clip(item.type)} is not in the accepted event names`,
      item.type,
    );
  }

  const base = {
    type: item.type as TEventName,
    // unmarshall 産物はネスト map の __proto__ キーで汚染されうるため clone で正規化する。
    data: structuredClone(item.data) as unknown,
    aggregateId: item.aggregateId,
    version: item.version,
    timestamp: item.timestamp,
  };
  // correlationId も own property のみ採用する (汚染 prototype 経由の値 injection を防ぐ)。
  return Object.hasOwn(item, "correlationId") && typeof item.correlationId === "string"
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
