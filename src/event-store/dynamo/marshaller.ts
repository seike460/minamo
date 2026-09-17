import type { StoredEvent } from "../../core/types.js";
import { EventLimitError } from "../../errors.js";
import { normalizePlainData } from "../../internal/guards.js";

/**
 * DynamoDB item の shape。`DynamoDBDocumentClient` が marshall/unmarshall を担うため
 * この層では plain JS object 整形と `correlationId` の undefined 回避が主責務。
 *
 * PK = aggregateId / SK = version。attribute 名は concept.md §3 / C11 の合意に従う。
 */
export interface EventItem {
  readonly aggregateId: string;
  readonly version: number;
  readonly type: string;
  readonly data: unknown;
  readonly timestamp: string;
  readonly correlationId?: string;
}

/**
 * `StoredEvent` を DynamoDB item shape に整形する。
 *
 * `correlationId === undefined` のときは item に property を付けない (DEC-011 plain data)。
 * DocumentClient の marshall は `removeUndefinedValues: true` を推奨するが、防御的に
 * ライブラリ側でも undefined key を出さない。
 */
export function toItem(stored: StoredEvent<string, unknown>): EventItem {
  const base = {
    aggregateId: stored.aggregateId,
    version: stored.version,
    type: stored.type,
    data: stored.data,
    timestamp: stored.timestamp,
  };
  return stored.correlationId !== undefined
    ? { ...base, correlationId: stored.correlationId }
    : base;
}

/**
 * DynamoDB から受け取った item を `StoredEvent` に復元する。
 *
 * 最小の shape 検証を行い、primary field が欠損していれば assertion error として throw する。
 * data の shape は consumer の schema 責務 (U8 design §6.4 の方針)。
 * DynamoDB Streams の INSERT レコードを復元する U9 `parseStreamRecord` の shape validation
 * とは責務が分かれる (load path は即時書き込んだ正常な event を読むためのもの)。
 *
 * 余分な attribute は無視する (future-compat)。
 */
export function fromItem(raw: Record<string, unknown>): StoredEvent<string, unknown> {
  // `Object.hasOwn` + 型検査の両方を行う: `@aws-sdk/util-dynamodb` の unmarshall は
  // `"__proto__"` キーを持つ item を受けると返り値 object の [[Prototype]] を汚染する
  // (acc[key]= の変異が __proto__ setter を踏む)。typeof 検査だけだと prototype 経由で
  // 供給された偽装 field を受理してしまうため、own property であることを必須にする。
  if (!Object.hasOwn(raw, "aggregateId") || typeof raw.aggregateId !== "string") {
    throw new TypeError(`DynamoDB item missing string aggregateId (got ${typeof raw.aggregateId})`);
  }
  if (!Object.hasOwn(raw, "version") || typeof raw.version !== "number") {
    throw new TypeError(`DynamoDB item missing numeric version (got ${typeof raw.version})`);
  }
  if (!Number.isInteger(raw.version) || raw.version < 1) {
    throw new TypeError(`DynamoDB item has invalid version (got ${String(raw.version)})`);
  }
  if (!Object.hasOwn(raw, "type") || typeof raw.type !== "string") {
    throw new TypeError(`DynamoDB item missing string type (got ${typeof raw.type})`);
  }
  if (!Object.hasOwn(raw, "timestamp") || typeof raw.timestamp !== "string") {
    throw new TypeError(`DynamoDB item missing string timestamp (got ${typeof raw.timestamp})`);
  }
  if (!Object.hasOwn(raw, "data") || raw.data === undefined) {
    throw new TypeError("DynamoDB item missing data attribute");
  }

  let data: unknown;
  try {
    data = normalizePlainData(raw.data);
  } catch {
    // 非 cloneable な data (synthetic item での関数混入等) は生の DataCloneError
    // ではなく envelope 違反として TypeError に揃える。
    throw new TypeError("DynamoDB item has non-cloneable data attribute");
  }
  const base = {
    aggregateId: raw.aggregateId,
    version: raw.version,
    type: raw.type,
    // structuredClone + own __proto__ key の再帰除去で正規化する (unmarshall 産物は
    // ネストした map 内の __proto__ キーで [[Prototype]] が汚染されうる。
    // clone は汚染 prototype を落とすが own `__proto__` data key は保持するため
    // normalizePlainData で除去する)。
    data,
    timestamp: raw.timestamp,
  };
  // correlationId も own property を要求する: 汚染された [[Prototype]] 経由の
  // 値を stored event に載せない (値 injection 防止)。
  return Object.hasOwn(raw, "correlationId") && typeof raw.correlationId === "string"
    ? { ...base, correlationId: raw.correlationId }
    : base;
}

/**
 * `StoredEvent` の JSON byte 近似サイズ。TransactWriteItems の 4MB 制約 / 400KB item 制約
 * を U8 append の pre-flight で使用する。DynamoDB の真の item size (attribute name UTF-8 含)
 * とは完全一致しないため `SIZE_SLACK_BYTES` で overshoot を防ぐ運用。
 */
export function approxItemSize(stored: StoredEvent<string, unknown>): number {
  let json: string;
  try {
    json = JSON.stringify(toItem(stored));
  } catch (cause) {
    // BigInt / circular 参照など JSON 非直列化の入力は DEC-011 違反。raw TypeError ではなく
    // append 入力制約違反として EventLimitError に wrap して診断しやすくする。
    throw new EventLimitError(
      stored.aggregateId,
      `event data is not JSON-serializable: ${(cause as Error).message}`,
    );
  }
  return new TextEncoder().encode(json).length;
}
