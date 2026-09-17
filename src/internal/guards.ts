import { EventLimitError } from "../errors.js";
import type { AppendOptions } from "../event-store/types.js";
import type { Snapshot } from "../snapshot/types.js";
import { clip } from "./clip.js";

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
 * `initialState: null` は plain data として合法なため `hasOwn` + `undefined` 値の
 * 組み合わせでのみ弾く。
 */
export function assertAggregateConfig(config: unknown): void {
  if (!isObjectRecord(config)) {
    throw new TypeError("config must be an AggregateConfig object");
  }
  const c = config as { initialState?: unknown; evolve?: unknown; upcast?: unknown };
  if (!Object.hasOwn(config, "initialState") || c.initialState === undefined) {
    throw new TypeError("config.initialState is required (undefined is not plain data)");
  }
  if (!isObjectRecord(c.evolve)) {
    throw new TypeError("config.evolve must be an object map of evolve handlers");
  }
  if (c.upcast !== undefined && typeof c.upcast !== "function") {
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
  const s = store as { load?: unknown; append?: unknown };
  if (typeof s.load !== "function") {
    throw new TypeError("store.load must be a function");
  }
  if (typeof s.append !== "function") {
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
  const s = store as { load?: unknown; save?: unknown };
  if (typeof s.load !== "function" || typeof s.save !== "function") {
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
    const e = events[i] as { type?: unknown } | null | undefined;
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
    const data = (e as { data?: unknown }).data;
    if (data !== undefined) {
      assertPlainData(data, `event at index ${i} data`);
    }
  }
}

/**
 * `data` / `state` の許容ネスト深さ (root object = depth 0 として数える)。
 *
 * DynamoDB の item ネスト上限は 32 階層だが、event item / snapshot item は
 * `data` / `state` 属性で 1 段 wrap され、さらに最深部の leaf scalar も
 * 1 階層として数えられる。実測 (DynamoDB Local): payload の最深 object は
 * depth 30 まで受理、depth 31 で ValidationException — つまり
 * 1 (wrap) + 30 (object) + 1 (leaf scalar) = 32 が上限。
 * write 側検証でも同じ上限を共有する。
 */
const MAX_PLAIN_DATA_DEPTH = 30;

/**
 * `data` / `state` が DEC-011 の "plain data" 契約を満たすかを再帰検証する。
 *
 * 背景 (痛み C の残存穴): InMemory は `structuredClone` で何でも保持する一方、
 * DynamoDB 側は `marshall`/`unmarshall` で値が静かに変形・消失するケースがある
 * (own `__proto__` key・nested `undefined`・Date→`{}`・symbol key 等)。
 * 逆方向もあり、循環参照は InMemory で受理され DynamoDB では size 見積もりの
 * `JSON.stringify` が生 `TypeError` を投げる。write 側で両 store に同じ制約を
 * 課すことで backend 間の silent divergence をなくす。
 *
 * 受理は「InMemory (structuredClone) と DynamoDB (marshall→unmarshall) の両方で
 * 同一に round-trip する値」に限定する — 受理しても型が変わって戻る値は
 * reject 側に倒す (bigint→number、Map→object、Date→`{}`、ArrayBuffer→Uint8Array 等)。
 *
 * object の `undefined` 値は reject ではなく strip 扱いとする: DynamoDB の
 * `removeUndefinedValues` が属性ごと落とすのと同じ正規化を persist 経路
 * (`normalizePlainData`) で掛けるため、両 backend は同一内容を保存する。
 * 一方、array 要素の `undefined` は marshall が要素ごと落として位置がずれる
 * (`[1, undefined, 3]` → `[1, 3]`) ため reject する — strip すると data が
 * 静かに壊れる。
 *
 * 受理: null / boolean / 有限数 / string / Uint8Array / array / plain object
 *       (prototype が Object.prototype または null のもの) /
 *       object の `undefined` 値 (persist 時に key ごと strip)
 * 拒否: top-level の undefined / array 要素の undefined / function / symbol /
 *       非有限数 / bigint (N→number で型を失う) / Map (M→object で型を失う) / Set
 *       (content 型依存で unmarshall が揺れる) / Date・RegExp・class instance 等の
 *       非 plain object / ArrayBuffer・非 Uint8Array view (view 型が失われる) /
 *       own `__proto__` key / enumerable symbol key / 循環参照 /
 *       深さ 30 超過 (DynamoDB item 上限 32 − `data`/`state` wrap 1 段 −
 *       leaf scalar 1 段)
 */
export function assertPlainData(value: unknown, what: string): void {
  assertPlainDataValue(value, what, new Set(), 0);
}

/**
 * store 由来の `data` / `state` を `structuredClone` で隔離し、own `__proto__` key を
 * 再帰的に除去して正規化する。
 *
 * unmarshall は `"__proto__"` Map で返り値の [[Prototype]] を汚染する — clone が
 * [[Prototype]] を Object.prototype に戻すのは確認済みだが、own `__proto__` *data* key は
 * CreateDataProperty で clone に保持される。この key は InMemory 経路では残り
 * DynamoDB 経路では (setter 吸収→clone で) 消えるため、read 側でも揃えて除去する。
 */
export function normalizePlainData<T>(value: T): T {
  let clone: T;
  try {
    clone = structuredClone(value);
  } catch {
    // Proxy 等の非 cloneable 値が流入した場合に生の DataCloneError (DOMException)
    // ではなく契約違反の TypeError に揃える。呼び出し側は「plain data 前提の値」を
    // 渡すため、ここに到達する = 契約違反。
    throw new TypeError("value must be structured-cloneable plain data");
  }
  stripNonPortableKeys(clone, new Set());
  return clone;
}

/**
 * own `__proto__` key と `undefined` 値を持つ own key を再帰的に除去する。
 * `__proto__` は unmarshall の [[Prototype]] 汚染で消失し、`undefined` 値は
 * marshall の `removeUndefinedValues` で属性ごと落ちる — 両 backend が同じ
 * 永続化形式を持つよう write / read 両経路で同じ正規化を掛ける。
 * array 要素の `undefined` は位置ずれ ( `[1, undefined, 3]` → `[1, 3]` ) を
 * 起こすため strip せず、write 側の `assertPlainData` で reject される前提。
 */
function stripNonPortableKeys(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const v of value) stripNonPortableKeys(v, seen);
    return;
  }
  // Uint8Array 等の非 plain object は内部を触らない
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return;
  for (const key of Object.keys(value)) {
    const v = (value as Record<string, unknown>)[key];
    if (key === "__proto__" || v === undefined) {
      delete (value as Record<string, unknown>)[key];
      continue;
    }
    stripNonPortableKeys(v, seen);
  }
}

function assertPlainDataValue(
  value: unknown,
  path: string,
  seen: Set<object>,
  depth: number,
): void {
  const fail = (reason: string): never => {
    throw new TypeError(`${path} must be plain data: ${reason}`);
  };
  if (value === null || typeof value !== "object") {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (Number.isFinite(value)) return;
      fail("non-finite number is not DynamoDB marshallable");
    }
    if (typeof value === "bigint") {
      fail("bigint is written as N but read back as number (type is lost)");
    }
    // fail() 経由の never はここでは CFA に効かないため直接 throw で終端する
    throw new TypeError(
      `${path} must be plain data: ${
        value === undefined
          ? "undefined is dropped by DynamoDB marshall"
          : `${typeof value} is not persistable`
      }`,
    );
  }
  // 以降 value は object
  if (depth > MAX_PLAIN_DATA_DEPTH) fail(`exceeds ${MAX_PLAIN_DATA_DEPTH}-level nesting limit`);
  if (seen.has(value)) fail("circular reference");
  if (Array.isArray(value)) {
    seen.add(value);
    try {
      for (let i = 0; i < value.length; i++) {
        assertPlainDataValue(value[i], `${path}[${i}]`, seen, depth + 1);
      }
    } finally {
      seen.delete(value);
    }
    return;
  }
  // バイナリは Uint8Array のみ受理: marshall は各種 ArrayBuffer/view を B に
  // 畳み込み、unmarshall は常に Uint8Array を返すため、それ以外の型は
  // round-trip で型が失われる。prototype 一致で絞るのは Buffer (Uint8Array subclass、
  // DEC-011 で明示的に禁止) やユーザ定義 subclass を弾くため。
  if (value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype) return;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    fail("binary must be Uint8Array (other views lose their type on unmarshall)");
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(
      `non-plain object (${proto?.constructor?.name ?? "unknown prototype"}) loses its type on DynamoDB round-trip`,
    );
  }
  if (
    Object.getOwnPropertySymbols(value).some(
      (s) => Object.getOwnPropertyDescriptor(value, s)?.enumerable,
    )
  ) {
    fail("enumerable symbol keys are dropped by DynamoDB marshall");
  }
  seen.add(value);
  try {
    for (const key of Object.keys(value)) {
      // own `__proto__` key は unmarshall 時に [[Prototype]] へ吸収されて消失する
      // (marshaller.ts の pollution 防御と同根) ので書き込み側でも拒否する。
      if (key === "__proto__") fail('own "__proto__" key is dropped on DynamoDB unmarshall');
      // object の `undefined` 値は persist 経路 (normalizePlainData) で key ごと
      // strip される = DynamoDB の removeUndefinedValues と同じ永続化形式になるため
      // 受理する。array 要素の undefined は位置ずれするため array 分岐で弾く。
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      assertPlainDataValue(v, `${path}.${key}`, seen, depth + 1);
    }
  } finally {
    seen.delete(value);
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
  if (!isObjectRecord(snapshot)) {
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
  // state だけでなく snapshot の各 field を検証する。consumer 側の extra attribute
  // (TTL 用の数値等) は認めるが、Date / Map 等の非 plain な extra は
  // InMemory では clone で保持され DynamoDB では marshall が空 object に
  // 退化させる (または throw する) ため backend 間で保存結果が食い違う。
  // 各 field は独立した root として検証する: DynamoDB item では各 attribute が
  // 同じ 1 段 wrap を受けるため、envelope 全体を 1 つの root として数えると
  // `state` が event の `data` より 1 段厳しくなり実機の許容量と食い違う。
  for (const key of Object.keys(snapshot)) {
    // own `__proto__` key は assertPlainData の object 走査が key 側を弾くが、
    // ここでは値側しか見ないため envelope 直置きの __proto__ を別途弾く。
    if (key === "__proto__") {
      throw new TypeError('snapshot must be plain data: own "__proto__" key is not persistable');
    }
    const v = (snapshot as Record<string, unknown>)[key];
    // `undefined` 値の extra attribute は永続化時に normalizePlainData が key ごと
    // strip する (removeUndefinedValues と同じ形式) ため受理する。`state` の
    // undefined は上の必須検査で既に弾かれている。
    if (v === undefined) continue;
    assertPlainData(v, `snapshot.${key}`);
  }
}
