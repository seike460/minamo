import type { AggregateConfig } from "../core/aggregate.js";
import type { EventMap, StoredEvent } from "../core/types.js";
import { InvalidStreamRecordError } from "../errors.js";
import { clip, isObjectRecord } from "../internal/guards.js";
import { normalizePlainData } from "../internal/plain-data.js";
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
 * `item` の必須 field が own property かつ `valid` を満たすかを検査し、
 * 満たす場合に narrow 済みの値を返す。欠落・型違反は `missing_field`。
 */
function requireField<T>(
  item: Record<string, unknown>,
  field: string,
  valid: (value: unknown) => value is T,
  detail: string,
): T {
  const value = item[field];
  if (!Object.hasOwn(item, field) || !valid(value)) {
    throw new InvalidStreamRecordError("missing_field", detail, field);
  }
  return value;
}

const isString = (v: unknown): v is string => typeof v === "string";

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
  // 非 object / `eventName !== "INSERT"` (MODIFY / REMOVE / 欠落) は silent skip。
  if (!isObjectRecord(record) || record.eventName !== "INSERT") return null;

  const dynamodb = isObjectRecord(record.dynamodb) ? record.dynamodb : undefined;
  const newImage = dynamodb?.NewImage;
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
    const detail = err instanceof Error ? err.message : String(err);
    throw new InvalidStreamRecordError(
      "unmarshal_failed",
      `Failed to unmarshall NewImage: ${detail}`,
      detail,
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
  // `Object.hasOwn` + 型検査の併用: unmarshall が汚染した [[Prototype]] 経由で
  // 供給された偽装 field (item.__proto__.version 等) を typeof 検査が通してしまう
  // ことを防ぐ。own property でない必須 field は存在しないものとして扱う。
  // aggregateId の空文字は DynamoDB partition key として成立しない (write 側の
  // assertAggregateId と同じ契約) ため欠落扱いにする。
  const aggregateId = requireField(
    item,
    "aggregateId",
    (v): v is string => isString(v) && v.length > 0,
    "aggregateId must be a non-empty string",
  );
  const version = requireField(
    item,
    "version",
    (v): v is number => typeof v === "number",
    "version must be a number",
  );
  if (!Number.isInteger(version) || version < 1) {
    throw new InvalidStreamRecordError(
      "missing_field",
      `version must be an integer >= 1 (got ${version})`,
      "version",
    );
  }
  const type = requireField(item, "type", isString, "type must be a string");
  const timestamp = requireField(item, "timestamp", isString, "timestamp must be a string");
  // `data` 属性の欠落は受理する: v0.2.0 は `data: undefined` の event を
  // removeUndefinedValues で属性ごと落として永続化していたため、data 属性を持たない
  // legacy item が実在する (fromItem と同じく `data: undefined` として復元する)。

  if (!eventNames.some((name) => name === type)) {
    if (options?.ignoreUnknownTypes === true) return null;
    throw new InvalidStreamRecordError(
      "unknown_type",
      `Event type ${clip(type)} is not in the accepted event names`,
      type,
    );
  }

  // `data` も own property のみ採用する (fromItem と同じ規則): 必須 field と違い
  // optional だが、汚染 [[Prototype]] 経由の inherited data property を payload
  // として拾うと store 読み出し (`data: undefined`) と結果が食い違う。
  const rawData = Object.hasOwn(item, "data") ? item.data : undefined;
  let data: unknown;
  try {
    // unmarshall 産物はネスト map の __proto__ キーで汚染されうるため clone +
    // own `__proto__` key 除去で正規化する (fromItem と同じ normalizePlainData)。
    // `data` 属性のない legacy item 由来の undefined はそのまま通す。
    data = rawData === undefined ? undefined : normalizePlainData(rawData);
  } catch {
    // 非 cloneable な data は InvalidStreamRecordError に揃える (生 DataCloneError ではなく)。
    throw new InvalidStreamRecordError(
      "unmarshal_failed",
      "data attribute is not cloneable",
      "data",
    );
  }
  const base = {
    type: type as TEventName,
    data,
    aggregateId,
    version,
    timestamp,
  };
  // correlationId も own property のみ採用する (汚染 prototype 経由の値 injection を防ぐ)。
  return Object.hasOwn(item, "correlationId") && isString(item.correlationId)
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
  // `evolve` が非 object だと `Object.keys` は string の index 配列等の garbage を
  // 返し、結果の eventNames が全件 unknown_type 判定になる静かな破綻を生む。
  // (assertAggregateConfig ではなく evolve だけを見る: 本関数の依存は evolve のみ)
  const evolve = isObjectRecord(config) ? config.evolve : undefined;
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
      if (key !== "constructor" && !names.includes(key) && typeof evolve[key] === "function") {
        names.push(key);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return names as Array<keyof TMap & string>;
}
