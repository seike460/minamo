/**
 * DEC-011 "plain data" 契約 — 「InMemory (structuredClone) と DynamoDB
 * (marshall→unmarshall) の両方で同一に round-trip する値」の検証・正規化。
 *
 * API shape の入口検証 (guards.ts) とは別の責務として、永続化形式の
 * backend 間 parity を担う。
 */

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
  // proto 確認済みの plain object のみ走査する (entries は own enumerable のみ)
  const entries: ReadonlyArray<readonly [string, unknown]> = Object.entries(value);
  for (const [key, v] of entries) {
    if (key === "__proto__" || v === undefined) {
      Reflect.deleteProperty(value, key);
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
  // proto 確認済みの plain object のみ走査する (entries は own enumerable のみ)
  const entries: ReadonlyArray<readonly [string, unknown]> = Object.entries(value);
  try {
    for (const [key, v] of entries) {
      // own `__proto__` key は unmarshall 時に [[Prototype]] へ吸収されて消失する
      // (marshaller.ts の pollution 防御と同根) ので書き込み側でも拒否する。
      if (key === "__proto__") fail('own "__proto__" key is dropped on DynamoDB unmarshall');
      // object の `undefined` 値は persist 経路 (normalizePlainData) で key ごと
      // strip される = DynamoDB の removeUndefinedValues と同じ永続化形式になるため
      // 受理する。array 要素の undefined は位置ずれするため array 分岐で弾く。
      if (v === undefined) continue;
      assertPlainDataValue(v, `${path}.${key}`, seen, depth + 1);
    }
  } finally {
    seen.delete(value);
  }
}
