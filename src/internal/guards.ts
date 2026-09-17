import { EventLimitError } from "../errors.js";
import type { AppendOptions } from "../event-store/types.js";
import type { Snapshot } from "../snapshot/types.js";

/**
 * DynamoDB partition key の上限 (2048 bytes UTF-8)。
 * concept.md §3 の schema 前提 (PK = aggregateId:S) に由来する。
 */
const MAX_AGGREGATE_ID_BYTES = 2048;

const textEncoder = new TextEncoder();

/**
 * `aggregateId` の契約検証。DynamoDB は空文字・非文字列の partition key を service
 * error で拒否するが InMemoryEventStore は受理してしまうため、両 store の入口で
 * 同じ検証を行い backend 間の振る舞い差異 (痛み C) を無くす。
 */
export function assertAggregateId(aggregateId: unknown): asserts aggregateId is string {
  if (typeof aggregateId !== "string" || aggregateId.length === 0) {
    throw new TypeError(
      `aggregateId must be a non-empty string (got ${
        typeof aggregateId === "string" ? '""' : typeof aggregateId
      })`,
    );
  }
  if (textEncoder.encode(aggregateId).length > MAX_AGGREGATE_ID_BYTES) {
    throw new TypeError(
      `aggregateId exceeds the ${MAX_AGGREGATE_ID_BYTES}-byte DynamoDB partition key limit`,
    );
  }
}

/**
 * `append` に渡される各 event の最小 envelope 検証。
 *
 * `executeCommand` 経由では pre-append 検証が走るが、`store.append` は public API で
 * ingestion / migration 等から直接呼ばれうる。`type` 欠落の event が永続化されると
 * 以後の `load` / `rehydrate` が必ず失敗し stream が復旧不能に poison されるため、
 * write 側でも read 側が要求する最小 shape を強制する。
 */
export function assertDomainEvents(aggregateId: string, events: ReadonlyArray<unknown>): void {
  if (!Array.isArray(events)) {
    throw new EventLimitError(aggregateId, "events must be an array");
  }
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as { type?: unknown } | null | undefined;
    if (e === null || e === undefined || typeof e !== "object") {
      throw new EventLimitError(aggregateId, `event at index ${i} is not an object`);
    }
    if (typeof e.type !== "string" || e.type.length === 0) {
      throw new EventLimitError(
        aggregateId,
        `event at index ${i} must have a non-empty string type`,
      );
    }
    // `data` は own property かつ非 undefined・非関数を要求する。DynamoDB 側では
    // removeUndefinedValues / convertToAttr の挙動により `undefined` や関数値は
    // 属性ごと消え、読み出し時に fromItem が missing field で失敗する = stream poison。
    // InMemory 側だけ structuredClone で保持/失敗するため write 側で統一的に弾く (痛み C)。
    const data = (e as { data?: unknown }).data;
    if (!Object.hasOwn(e, "data") || data === undefined || typeof data === "function") {
      throw new EventLimitError(aggregateId, `event at index ${i} is missing data`);
    }
  }
}

/**
 * `AppendOptions.correlationId` の契約検証。非文字列を渡すと DynamoDB 側では `N` として
 * marshall され read path で黙って落ちる (write と read で値が食い違う) ため write 側で弾く。
 */
export function assertAppendOptions(aggregateId: string, options: AppendOptions | undefined): void {
  const correlationId = options?.correlationId;
  if (correlationId !== undefined && typeof correlationId !== "string") {
    throw new TypeError(
      `correlationId for aggregate ${clip(aggregateId)} must be a string (got ${typeof correlationId})`,
    );
  }
}

/**
 * error message に埋め込む文字列を安全に整形する。
 * 改行・制御文字の escape (log injection 対策) と長大入力の truncate (log flood 対策)
 * を兼ねる。主に stream / store 由来の untrusted 値向けだが、巨大化しうる
 * consumer 指定値 (aggregateId 等) にも使ってよい — JSON 引用符が付くだけで
 * message の意味は変わらない。
 */
export function clip(value: unknown, maxLength = 256): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : String(value);
  } catch {
    // Object.create(null) や投げる toString を持つ malformed な store 由来値でも
    // 本来の検証エラー (InvalidEventStreamError 等) を隠さないよう fallback する。
    s = "<unprintable>";
  }
  return JSON.stringify(s.length > maxLength ? `${s.slice(0, maxLength)}...` : s);
}

/**
 * `loadFrom` の `afterVersion` の契約検証。非整数・負数をそのまま通すと
 * InMemory は `e.version > NaN` で静かに `[]` を返す一方 DynamoDB は
 * ValidationException で throw し、backend 間で振る舞いが乖離する (痛み C)。
 */
export function assertAfterVersion(afterVersion: unknown): asserts afterVersion is number {
  if (!Number.isInteger(afterVersion) || (afterVersion as number) < 0) {
    throw new TypeError(
      `afterVersion must be a non-negative integer (got ${String(afterVersion)})`,
    );
  }
}

/**
 * `SnapshotStore.save` の引数を store 非依存の同一ルールで検証する (両実装の parity)。
 * load 側で弾ける shape をわざわざ書き込ませない (書いた snapshot は二度と読めない)。
 */
export function assertSnapshot(snapshot: Snapshot<unknown>): void {
  if (snapshot === null || typeof snapshot !== "object") {
    throw new TypeError("snapshot must be an object");
  }
  assertAggregateId(snapshot.aggregateId);
  if (!Number.isInteger(snapshot.version) || snapshot.version < 1) {
    throw new TypeError(
      `snapshot version must be an integer >= 1 (got ${String(snapshot.version)})`,
    );
  }
  if (!Object.hasOwn(snapshot, "state") || snapshot.state === undefined) {
    throw new TypeError("snapshot missing state");
  }
  if (typeof snapshot.timestamp !== "string") {
    throw new TypeError("snapshot missing string timestamp");
  }
}
