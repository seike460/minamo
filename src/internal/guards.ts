import { EventLimitError } from "../errors.js";
import type { AppendOptions } from "../event-store/types.js";
import type { Snapshot } from "../snapshot/types.js";
import { clip } from "./clip.js";
import { assertPlainData } from "./plain-data.js";

export { clip };

/**
 * DynamoDB partition key の上限 (2048 bytes UTF-8)。
 * concept.md §3 の schema 前提 (PK = aggregateId:S) に由来する。
 */
const MAX_AGGREGATE_ID_BYTES = 2048;

const textEncoder = new TextEncoder();

/**
 * 「plain object 相当の record」判定。`typeof x === "object"` だけでは配列が
 * すり抜け、`options?.correlationId` のような property access が undefined に
 * 揃って silent skip になるため、境界検証では配列も拒否する。
 * (class instance は通す — prototype までは要求しない minimal shape 契約)
 */
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * `key` が own property、または prototype chain 上の accessor (getter) として
 * 定義されているかを返す。inherited の data property は受理しない —
 * `Object.create({ key: ... })` や `__proto__` 代入で必須 field を供給する
 * prototype 汚染の経路を塞ぐ。class instance の `get key()` は accessor として
 * prototype に載るため受理される (v0.2.0 互換)。
 */
export function hasOwnOrAccessor(obj: object, key: string): boolean {
  let cur: object | null = obj;
  // Proxy の getPrototypeOf trap が自分自身 (や循環する chain) を返す入力でも
  // 無限ループしないよう、訪問済み object を記録する。
  const seen = new Set<object>();
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const desc = Object.getOwnPropertyDescriptor(cur, key);
    if (desc !== undefined) {
      // `desc.get` は descriptor object の prototype (Object.prototype) を辿るため、
      // `Object.prototype.get` 汚染で data descriptor を accessor と誤認する。
      // own key の存在 + callable 性の両方を要求する。
      return cur === obj || (Object.hasOwn(desc, "get") && typeof desc.get === "function");
    }
    cur = Object.getPrototypeOf(cur);
  }
  return false;
}

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
 * `AggregateConfig` の最小 shape 検証。
 *
 * `config.initialState` が欠落・undefined のまま `structuredClone` に流れると
 * `state: undefined` の Aggregate が静かに生成され、`config.evolve` が非 object だと
 * `Object.hasOwn` の生 TypeError まで到達してしまう。入口で弾いて契約違反を明示する。
 * `initialState: null` は plain data として合法なため存在 + `undefined` 値の
 * 組み合わせでのみ弾く。存在判定は own property か prototype getter に限る —
 * `hasOwn` だと prototype getter で `initialState` を実装する class ベースの
 * config (v0.2.0 で受理) を拒否し、単純な `in` だと `Object.create` / `__proto__`
 * で汚染した inherited data property を受理してしまう。
 */
export function assertAggregateConfig(config: unknown): void {
  if (!isObjectRecord(config)) {
    throw new TypeError("config must be an AggregateConfig object");
  }
  if (!hasOwnOrAccessor(config, "initialState") || config.initialState === undefined) {
    throw new TypeError("config.initialState is required (undefined is not plain data)");
  }
  if (!isObjectRecord(config.evolve)) {
    throw new TypeError("config.evolve must be an object map of evolve handlers");
  }
  if (config.upcast !== undefined && typeof config.upcast !== "function") {
    throw new TypeError("config.upcast must be a function");
  }
}

/**
 * `EventStore` 実装の最小 shape 検証。
 *
 * `load` / `append` の非関数・欠落は呼び出し時の生 TypeError になるため入口で弾く。
 * `loadFrom` は optional (DEC-019) で、非関数値は「未実装」として full load + filter に
 * fallback する既存契約のためここでは検査しない (typeof 判定が呼び出し側で走る)。
 */
export function assertEventStoreShape(store: unknown): void {
  if (!isObjectRecord(store)) {
    throw new TypeError("store must be an EventStore object");
  }
  if (typeof store.load !== "function") {
    throw new TypeError("store.load must be a function");
  }
  if (typeof store.append !== "function") {
    throw new TypeError("store.append must be a function");
  }
}

/**
 * `SnapshotStore` 実装の最小 shape 検証。`load` / `save` の非関数・欠落を入口で弾く。
 */
export function assertSnapshotStoreShape(store: unknown): void {
  if (!isObjectRecord(store)) {
    throw new TypeError("snapshotStore must be a SnapshotStore object");
  }
  if (typeof store.load !== "function" || typeof store.save !== "function") {
    throw new TypeError("snapshotStore must have load and save functions");
  }
}

/**
 * DynamoDB table 名の最小検証。空文字・非文字列を constructor 時点で弾き、
 * 初回の service call まで設定ミスが持ち越されないようにする。
 * AWS の命名規則 (3-255 chars 等) までは強制しない — local / mock endpoint や
 * 将来の規則変更に対して寛容でいるため、契約上必須なのは「非空文字列」のみ。
 */
export function assertTableName(tableName: unknown): asserts tableName is string {
  if (typeof tableName !== "string" || tableName.length === 0) {
    throw new TypeError(
      `tableName must be a non-empty string (got ${
        typeof tableName === "string" ? '""' : typeof tableName
      })`,
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
    const e = events[i];
    if (!isObjectRecord(e)) {
      throw new EventLimitError(aggregateId, `event at index ${i} is not an object`);
    }
    if (typeof e.type !== "string" || e.type.length === 0) {
      throw new EventLimitError(
        aggregateId,
        `event at index ${i} must have a non-empty string type`,
      );
    }
    // `data` は optional: v0.2.0 は `data: undefined` (または key 欠落) の event を受理し、
    // DynamoDB 側は removeUndefinedValues で `data` 属性ごと落として永続化していた。
    // 読み出しは `data: undefined` として復元されるため、ここでは拒否せず「undefined は
    // 属性ごと落ちる」 DynamoDB と同じ正規化を永続化側 (normalizePlainData) に任せる。
    // data が存在する場合のみ plain data を要求する。
    if (e.data !== undefined) {
      assertPlainData(e.data, `event at index ${i} data`);
    }
  }
}

/**
 * `AppendOptions.correlationId` の契約検証。非文字列を渡すと DynamoDB 側では `N` として
 * marshall され read path で黙って落ちる (write と read で値が食い違う) ため write 側で弾く。
 * `options` 自体が非 object の場合 `options?.correlationId` は undefined に揃って静かに
 * 無視されるため、ここでも入口で弾く。
 */
export function assertAppendOptions(aggregateId: string, options: AppendOptions | undefined): void {
  if (options !== undefined && !isObjectRecord(options)) {
    throw new TypeError(
      `options for aggregate ${clip(aggregateId)} must be an object (got ${
        options === null ? "null" : typeof options
      })`,
    );
  }
  const correlationId = options?.correlationId;
  if (correlationId !== undefined && typeof correlationId !== "string") {
    throw new TypeError(
      `correlationId for aggregate ${clip(aggregateId)} must be a string (got ${typeof correlationId})`,
    );
  }
}

/**
 * `loadFrom` の `afterVersion` の契約検証。非整数・負数をそのまま通すと
 * InMemory は `e.version > NaN` で静かに `[]` を返す一方 DynamoDB は
 * ValidationException で throw し、backend 間で振る舞いが乖離する (痛み C)。
 */
export function assertAfterVersion(afterVersion: unknown): asserts afterVersion is number {
  if (typeof afterVersion !== "number" || !Number.isInteger(afterVersion) || afterVersion < 0) {
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
  if (!isObjectRecord(snapshot)) {
    throw new TypeError("snapshot must be an object");
  }
  // 必須 field はすべて own property を要求する。inherited の data property は
  // `structuredClone` / marshall で key ごと落ちるため、受理すると書いた瞬間に
  // 二度と読めない snapshot を永続化してしまう (load 側は accessor を許容するが、
  // save 側は永続化可能な plain envelope のみ受理する)。
  if (!Object.hasOwn(snapshot, "aggregateId")) {
    throw new TypeError("snapshot missing aggregateId");
  }
  assertAggregateId(snapshot.aggregateId);
  if (
    !Object.hasOwn(snapshot, "version") ||
    !Number.isInteger(snapshot.version) ||
    snapshot.version < 1
  ) {
    throw new TypeError(
      `snapshot version must be an integer >= 1 (got ${String(snapshot.version)})`,
    );
  }
  if (!Object.hasOwn(snapshot, "state") || snapshot.state === undefined) {
    throw new TypeError("snapshot missing state");
  }
  if (!Object.hasOwn(snapshot, "timestamp") || typeof snapshot.timestamp !== "string") {
    throw new TypeError("snapshot missing string timestamp");
  }
  // state だけでなく snapshot の各 field を検証する。consumer 側の extra attribute
  // (TTL 用の数値等) は認めるが、Date / Map 等の非 plain な extra は
  // InMemory では clone で保持され DynamoDB では marshall が空 object に
  // 退化させる (または throw する) ため backend 間で保存結果が食い違う。
  // 各 field は独立した root として検証する: DynamoDB item では各 attribute が
  // 同じ 1 段 wrap を受けるため、envelope 全体を 1 つの root として数えると
  // `state` が event の `data` より 1 段厳しくなり実機の許容量と食い違う。
  const fields = snapshot as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    // own `__proto__` key は assertPlainData の object 走査が key 側を弾くが、
    // ここでは値側しか見ないため envelope 直置きの __proto__ を別途弾く。
    if (key === "__proto__") {
      throw new TypeError('snapshot must be plain data: own "__proto__" key is not persistable');
    }
    const v = fields[key];
    // `undefined` 値の extra attribute は永続化時に normalizePlainData が key ごと
    // strip する (removeUndefinedValues と同じ形式) ため受理する。`state` の
    // undefined は上の必須検査で既に弾かれている。
    if (v === undefined) continue;
    assertPlainData(v, `snapshot.${key}`);
  }
}
