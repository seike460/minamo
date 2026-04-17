import type { StoredEvent } from "../../core/types.js";

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
  if (typeof raw.aggregateId !== "string") {
    throw new TypeError(`DynamoDB item missing string aggregateId (got ${typeof raw.aggregateId})`);
  }
  if (typeof raw.version !== "number") {
    throw new TypeError(`DynamoDB item missing numeric version (got ${typeof raw.version})`);
  }
  if (typeof raw.type !== "string") {
    throw new TypeError(`DynamoDB item missing string type (got ${typeof raw.type})`);
  }
  if (typeof raw.timestamp !== "string") {
    throw new TypeError(`DynamoDB item missing string timestamp (got ${typeof raw.timestamp})`);
  }

  const base = {
    aggregateId: raw.aggregateId,
    version: raw.version,
    type: raw.type,
    data: raw.data,
    timestamp: raw.timestamp,
  };
  return raw.correlationId !== undefined && typeof raw.correlationId === "string"
    ? { ...base, correlationId: raw.correlationId }
    : base;
}

/**
 * `StoredEvent` の JSON byte 近似サイズ。TransactWriteItems の 4MB 制約 / 400KB item 制約
 * を U8 append の pre-flight で使用する。DynamoDB の真の item size (attribute name UTF-8 含)
 * とは完全一致しないため `SIZE_SLACK_BYTES` で overshoot を防ぐ運用。
 */
export function approxItemSize(stored: StoredEvent<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(toItem(stored))).length;
}
