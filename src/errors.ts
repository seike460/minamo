import type { StandardSchemaIssue } from "./standard-schema.js";

/**
 * EventStore への append で楽観的ロックが失敗したことを示すエラー。
 *
 * `expectedVersion` が EventStore 上の最新 version と一致しない場合に throw される。
 * executeCommand は既定で即時リトライし、rehydrate → handler 再実行で救済する (§5.6 参照)。
 *
 * @example
 * ```ts
 * try {
 *   await eventStore.append(aggregateId, events, expectedVersion);
 * } catch (err) {
 *   if (err instanceof ConcurrencyError) {
 *     // 他の書き手と衝突した。rehydrate してリトライ
 *   }
 * }
 * ```
 */
export class ConcurrencyError extends Error {
  /** Error サブクラスを識別するための literal name (minifier 耐性)。 */
  readonly name = "ConcurrencyError" as const;

  constructor(
    /** 衝突した Aggregate の ID。 */
    readonly aggregateId: string,
    /** append 時に呼び出し側が想定していた version。 */
    readonly expectedVersion: number,
  ) {
    super(`Concurrency conflict on aggregate ${aggregateId} at version ${expectedVersion}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Standard Schema の validate 失敗時に throw されるエラー。
 *
 * `issues` には vendor (Zod / Valibot / ArkType 等) が提供した構造化された違反情報が
 * そのままの参照で保持される。`message` は issues の path を `.` 区切りで整形した human-readable 形。
 *
 * @example
 * ```ts
 * try {
 *   const input = await validate(schema, raw);
 * } catch (err) {
 *   if (err instanceof ValidationError) {
 *     for (const issue of err.issues) {
 *       console.error(issue.path, issue.message);
 *     }
 *   }
 * }
 * ```
 */
export class ValidationError extends Error {
  /** Error サブクラスを識別するための literal name (minifier 耐性)。 */
  readonly name = "ValidationError" as const;

  constructor(
    /** Standard Schema vendor が返した構造化された違反情報の配列。 */
    readonly issues: readonly StandardSchemaIssue[],
  ) {
    super(`Validation failed: ${issues.map(formatIssue).join("; ")}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function formatIssue(issue: StandardSchemaIssue): string {
  if (!issue.path || issue.path.length === 0) return issue.message;
  const path = issue.path
    .map((seg) => (typeof seg === "object" && seg !== null ? String(seg.key) : String(seg)))
    .join(".");
  return `${path}: ${issue.message}`;
}

/**
 * `EventStore.append` の入力制約違反を示すエラー。
 *
 * 空配列の append、実装固有の件数 / サイズ制約違反 (DynamoDB の 99 件 / 400KB / 4MB) で throw される。
 * `message` には具体的な違反内容が埋め込まれる。
 *
 * @example
 * ```ts
 * try {
 *   await store.append(aggregateId, [], 0);
 * } catch (err) {
 *   if (err instanceof EventLimitError) {
 *     // events が空 / 件数超過 / サイズ超過
 *   }
 * }
 * ```
 */
export class EventLimitError extends Error {
  /** Error サブクラスを識別するための literal name (minifier 耐性)。 */
  readonly name = "EventLimitError" as const;

  constructor(
    /** 制約違反を起こした append の対象 Aggregate ID。 */
    readonly aggregateId: string,
    message: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * `rehydrate` の入力イベント列の不正要因。
 *
 * - `aggregateId_mismatch`: events[i].aggregateId !== rehydrate(id, ...) の id
 * - `non_monotonic_version`: version が増加していない
 * - `version_gap`: version が 1 ずつ増えていない
 * - `invalid_initial_version`: 最初のイベントの version が 1 でない
 * - `missing_evolve_handler`: event.type に対応する evolve がない
 */
export type InvalidEventStreamReason =
  | "aggregateId_mismatch"
  | "non_monotonic_version"
  | "version_gap"
  | "invalid_initial_version"
  | "missing_evolve_handler";

/**
 * `InvalidEventStreamError` の追加診断情報。壊れた stream を再現しやすくするための構造化情報。
 *
 * 全フィールド optional。必要なフィールドのみが埋められ、未指定のフィールドは property 自体が
 * 存在しない (DEC-011 plain data)。
 */
export interface InvalidEventStreamDetails {
  /** 違反が検出された events 配列のインデックス。 */
  readonly eventIndex?: number;
  /** rehydrate に渡された aggregateId (expected)。 */
  readonly expectedAggregateId?: string;
  /** event が保持する aggregateId (actual)。 */
  readonly actualAggregateId?: string;
  /** 期待される version (非負整数)。 */
  readonly expectedVersion?: number;
  /** event が保持する version (actual)。 */
  readonly actualVersion?: number;
  /** `missing_evolve_handler` で観測された event.type。 */
  readonly eventType?: string;
}

/**
 * `rehydrate` の入力イベント列が `aggregateId` / `version` / `evolve` 契約に違反していることを示すエラー。
 *
 * `reason` で違反種別を、`details` で違反箇所の index / expected / actual を取得できる。
 * `details` は必要なフィールドのみ optional として持ち、未指定のフィールドはプロパティ自体が存在しない
 * (DEC-011 の plain data 制約に沿う)。
 */
export class InvalidEventStreamError extends Error {
  /** Error サブクラスを識別するための literal name (minifier 耐性)。 */
  readonly name = "InvalidEventStreamError" as const;
  /**
   * 違反箇所の diagnostic (optional)。
   *
   * `declare` で runtime field initializer を発生させず、details が未指定のとき
   * `Object.hasOwn(err, "details") === false` を保つ (DEC-011 plain data)。
   */
  declare readonly details?: InvalidEventStreamDetails;

  constructor(
    /** 違反 stream の Aggregate ID。 */
    readonly aggregateId: string,
    /** 違反種別 (5 つの literal union)。 */
    readonly reason: InvalidEventStreamReason,
    message: string,
    details?: InvalidEventStreamDetails,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    if (details !== undefined) {
      (this as { -readonly [K in keyof this]: this[K] }).details = details;
    }
  }
}

/** `InvalidStreamRecordError` の違反種別。 */
export type InvalidStreamRecordReason = "missing_field" | "unmarshal_failed" | "unknown_type";

/**
 * DynamoDB Streams の INSERT レコードを `StoredEvent` に復元する際に不正を検出したことを示すエラー。
 *
 * - `missing_field`: `NewImage` / `aggregateId` / `version` / `type` / `timestamp` が欠落している
 * - `unmarshal_failed`: `@aws-sdk/util-dynamodb` の `unmarshall` が throw した
 * - `unknown_type`: strict モード時に `eventNames` に含まれない `type` を観測した
 *
 * consumer が `BisectBatchOnFunctionError` + OnFailure destination + `ReportBatchItemFailures` で
 * poison pill を隔離する構成を推奨する (DEC-013)。minamo はこの構成をラップしない (DEC-014)。
 */
export class InvalidStreamRecordError extends Error {
  /** Error サブクラスを識別するための literal name (minifier 耐性)。 */
  readonly name = "InvalidStreamRecordError" as const;
  /**
   * 違反箇所の詳細文字列 (optional)。
   *
   * `missing_field` では欠落した field path、`unknown_type` では観測した type、
   * `unmarshal_failed` では unmarshall が投げたエラーの message が入る。
   * `declare` で runtime field initializer を発生させず、detail が未指定のとき
   * `Object.hasOwn(err, "detail") === false` を保つ (DEC-011)。
   */
  declare readonly detail?: string;

  constructor(
    /** 違反種別 (3 つの literal union)。 */
    readonly reason: InvalidStreamRecordReason,
    message: string,
    detail?: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    if (detail !== undefined) {
      (this as { -readonly [K in keyof this]: this[K] }).detail = detail;
    }
  }
}
