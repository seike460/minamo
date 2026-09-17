import type { AggregateConfig } from "../core/aggregate.js";
import type { EventMap, StoredEvent } from "../core/types.js";
import { InvalidStreamRecordError } from "../errors.js";
import { clip, isObjectRecord, normalizePlainData } from "../internal/guards.js";
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
 * - 必須 field (aggregateId / version / type / timestamp) の型違反は `missing_field`
 *   (`data` は optional — `data: undefined` で永続化された legacy item が実在する)
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
  // `eventNames` が非配列だと `includes` 呼び出しが生 TypeError になるため入口で弾く。
  if (!Array.isArray(eventNames)) {
    throw new TypeError("eventNames must be an array");
  }
  // 非 object の options は `options?.ignoreUnknownTypes` が undefined に揃って
  // strict mode として静かに無視されるため入口で弾く。
  if (options !== undefined && !isObjectRecord(options)) {
    throw new TypeError("options must be an object");
  }
  const rec = record as {
    eventName?: string;
    dynamodb?: { NewImage?: Record<string, unknown>; Keys?: Record<string, unknown> };
  } | null;

  if (rec?.eventName !== "INSERT") return null;

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

  let item: unknown;
  try {
    item = unmarshall(newImage as Parameters<typeof unmarshall>[0]);
  } catch (err) {
    throw new InvalidStreamRecordError(
      "unmarshal_failed",
      `Failed to unmarshall NewImage: ${(err as Error).message}`,
      (err as Error).message,
    );
  }
  // NewImage が `{ NULL: true }` 等だと unmarshall は null を返す。
  // `Object.hasOwn(null, ...)` は生 TypeError になるため missing_field に揃える。
  if (!isObjectRecord(item)) {
    throw new InvalidStreamRecordError(
      "missing_field",
      "NewImage did not unmarshall to an item object",
      "dynamodb.NewImage",
    );
  }
  const itemRecord = item as Record<string, unknown>;

  // `Object.hasOwn` + 型検査の併用: unmarshall が汚染した [[Prototype]] 経由で
  // 供給された偽装 field (item.__proto__.version 等) を typeof 検査が通してしまう
  // ことを防ぐ。own property でない必須 field は存在しないものとして扱う。
  // aggregateId の空文字は DynamoDB partition key として成立しない (write 側の
  // assertAggregateId と同じ契約) ため欠落扱いにする。
  if (
    !Object.hasOwn(itemRecord, "aggregateId") ||
    typeof itemRecord.aggregateId !== "string" ||
    itemRecord.aggregateId.length === 0
  ) {
    throw new InvalidStreamRecordError(
      "missing_field",
      "aggregateId must be a string",
      "aggregateId",
    );
  }
  if (!Object.hasOwn(itemRecord, "version") || typeof itemRecord.version !== "number") {
    throw new InvalidStreamRecordError("missing_field", "version must be a number", "version");
  }
  if (!Number.isInteger(itemRecord.version) || itemRecord.version < 1) {
    throw new InvalidStreamRecordError(
      "missing_field",
      `version must be an integer >= 1 (got ${String(itemRecord.version)})`,
      "version",
    );
  }
  if (!Object.hasOwn(itemRecord, "type") || typeof itemRecord.type !== "string") {
    throw new InvalidStreamRecordError("missing_field", "type must be a string", "type");
  }
  if (!Object.hasOwn(itemRecord, "timestamp") || typeof itemRecord.timestamp !== "string") {
    throw new InvalidStreamRecordError("missing_field", "timestamp must be a string", "timestamp");
  }
  // `data` 属性の欠落は受理する: v0.2.0 は `data: undefined` の event を
  // removeUndefinedValues で属性ごと落として永続化していたため、data 属性を持たない
  // legacy item が実在する (fromItem と同じく `data: undefined` として復元する)。

  if (!(eventNames as ReadonlyArray<string>).includes(itemRecord.type)) {
    if (options?.ignoreUnknownTypes === true) return null;
    throw new InvalidStreamRecordError(
      "unknown_type",
      `Event type ${clip(itemRecord.type)} is not in the accepted event names`,
      itemRecord.type,
    );
  }

  let data: unknown;
  try {
    // unmarshall 産物はネスト map の __proto__ キーで汚染されうるため clone +
    // own `__proto__` key 除去で正規化する (fromItem と同じ normalizePlainData)。
    // `data` 属性のない legacy item 由来の undefined はそのまま通す。
    data = itemRecord.data === undefined ? undefined : normalizePlainData(itemRecord.data);
  } catch {
    // 非 cloneable な data は InvalidStreamRecordError に揃える (生 DataCloneError ではなく)。
    throw new InvalidStreamRecordError(
      "unmarshal_failed",
      "data attribute is not cloneable",
      "data",
    );
  }
  const base = {
    type: itemRecord.type as TEventName,
    data,
    aggregateId: itemRecord.aggregateId,
    version: itemRecord.version,
    timestamp: itemRecord.timestamp,
  };
  // correlationId も own property のみ採用する (汚染 prototype 経由の値 injection を防ぐ)。
  return Object.hasOwn(itemRecord, "correlationId") && typeof itemRecord.correlationId === "string"
    ? { ...base, correlationId: itemRecord.correlationId }
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
  // `evolve` が非 object だと `Object.keys` は string の index 配列等の garbage を
  // 返し、結果の eventNames が全件 unknown_type 判定になる静かな破綻を生む。
  // (assertAggregateConfig ではなく evolve だけを見る: 本関数の依存は evolve のみ)
  const evolve = (config as { evolve?: unknown } | null | undefined)?.evolve;
  if (!isObjectRecord(evolve)) {
    throw new TypeError("config.evolve must be an object map of evolve handlers");
  }
  // own enumerable key に加えて prototype chain 上の callable method も拾う —
  // class instance を evolve map にする構成 (v0.2.0 で動いていた) では method が
  // prototype 上にあり `Object.keys` だけでは `[]` になってしまう。Object.prototype
  // には到達しない (builtin 名は handler にならない)。
  const names = [...Object.keys(evolve)];
  const seenProtos = new Set<object>();
  let proto: object | null = Object.getPrototypeOf(evolve);
  // Proxy 経由で循環する prototype chain を返されても無限ループしないよう seen で防御。
  while (proto !== null && proto !== Object.prototype && !seenProtos.has(proto)) {
    seenProtos.add(proto);
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (
        key !== "constructor" &&
        !names.includes(key) &&
        typeof (evolve as Record<string, unknown>)[key] === "function"
      ) {
        names.push(key);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return names as Array<keyof TMap & string>;
}
