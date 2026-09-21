import { describe, expect, it } from "vitest";
import { EventLimitError } from "../../src/index.js";
import { isObjectRecord } from "../../src/internal/guards.js";
import { invalidInput } from "../invalid-input.js";
import type { ContractContext, CounterEvents } from "./event-store.js";

/**
 * Event Store Contract Tests — 入力拒否系 (CT-16 〜 CT-24 + 派生ケース)。
 *
 * 振る舞い系 (CT-01〜15) は contract/event-store.ts。異常入力の reject 契約は
 * backend 間で完全に一致させる必要があるため、ここも両 store で同一 suite を走らせる。
 * 登録方法は registerEventStoreContract と同じ。
 */

/** `depth` 階層のネストした plain object を作る (深さ上限検証用)。 */
function makeNested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < depth; i++) value = { next: value };
  return value;
}

/**
 * 入力拒否系の Contract Test suite を登録する。呼び出し側は describe の外 (module top-level)
 * から呼ぶ。
 */
export function registerEventStoreValidationContract(ctx: ContractContext<CounterEvents>): void {
  const { label, makeStore } = ctx;

  describe(`${label} — Contract Tests (input rejection)`, () => {
    for (const badVersion of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY] as const) {
      it(`CT-16 expectedVersion=${String(badVersion)} (非負整数でない) → EventLimitError`, async () => {
        const store = await makeStore();
        await expect(
          store.append("agg-16", [{ type: "Incremented", data: { amount: 1 } }], badVersion),
        ).rejects.toBeInstanceOf(EventLimitError);
      });
    }

    it("CT-17 malformed event envelope → EventLimitError (append は直接呼ばれうる)", async () => {
      const store = await makeStore();
      const malformed = [
        { data: { amount: 1 } }, // type 欠落
        { type: "", data: { amount: 1 } }, // 空 type
        { type: 42, data: { amount: 1 } }, // 非 string type
        null, // 非 object 要素
        "Incremented", // 非 object 要素
      ];
      for (const [i, bad] of malformed.entries()) {
        await expect(store.append(`agg-17-${i}`, [invalidInput(bad)], 0)).rejects.toBeInstanceOf(
          EventLimitError,
        );
      }
      // reject された append は何も永続化していないこと
      expect(await store.load("agg-17-0")).toEqual([]);
    });

    it("CT-17b `data` 欠落・`data: undefined` の event は受理され、read 側は data === undefined に正規化される (v0.2.0 互換)", async () => {
      // v0.2.0 は `data: undefined` / data key 欠落の event を受理し、DynamoDB 側は
      // removeUndefinedValues で `data` 属性ごと落として永続化していた。この形式の
      // item は実在するため、両 store で受理して `data: undefined` として読み出す
      // (write strict / read lenient ではなく write 側も v0.2.0 互換を維持する)。
      const store = await makeStore();
      await store.append(
        "agg-17b",
        [
          invalidInput({ type: "Incremented" }),
          invalidInput({ type: "Incremented", data: undefined }),
        ],
        0,
      );
      const loaded = await store.load("agg-17b");
      expect(loaded).toHaveLength(2);
      expect(loaded[0]?.data).toBeUndefined();
      expect(loaded[1]?.data).toBeUndefined();
      // `data` own property の存在は両 backend で揃える (envelope 契約)
      expect(Object.hasOwn(loaded[0] ?? {}, "data")).toBe(true);
    });

    it("CT-18 invalid aggregateId → TypeError (append / load / loadFrom 共通)", async () => {
      const store = await makeStore();
      await expect(
        store.append("", [{ type: "Incremented", data: { amount: 1 } }], 0),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        // 2048 byte の DynamoDB partition key 上限超過
        store.append("x".repeat(2049), [{ type: "Incremented", data: { amount: 1 } }], 0),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(store.load("")).rejects.toBeInstanceOf(TypeError);
      // 非文字列 (数値) も TypeError。ちょうど 2048 byte は受理される境界値。
      await expect(store.load(invalidInput(123))).rejects.toBeInstanceOf(TypeError);
      const boundary = "x".repeat(2048);
      expect(await store.load(boundary)).toEqual([]);
      expect(store.loadFrom).toBeTypeOf("function");
      if (typeof store.loadFrom === "function") {
        await expect(store.loadFrom("", 0)).rejects.toBeInstanceOf(TypeError);
        // afterVersion の非整数・負数も backend 非依存に TypeError で弾く
        // (InMemory は version > NaN で静かに [] になりうるため契約として固定する)
        await expect(store.loadFrom("agg-18", 1.5)).rejects.toBeInstanceOf(TypeError);
        await expect(store.loadFrom("agg-18", -1)).rejects.toBeInstanceOf(TypeError);
        await expect(store.loadFrom("agg-18", Number.NaN)).rejects.toBeInstanceOf(TypeError);
      }
    });

    it("CT-19 non-string correlationId → TypeError", async () => {
      const store = await makeStore();
      await expect(
        store.append("agg-19", [{ type: "Incremented", data: { amount: 1 } }], 0, {
          correlationId: invalidInput<string>(42),
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(await store.load("agg-19")).toEqual([]);
    });

    it("CT-19b non-object options → TypeError (silent skip を防ぐ)", async () => {
      const store = await makeStore();
      // `options: 42` 等は `options?.correlationId` が undefined に揃って静かに
      // 無視されるため、両 store の入口で同じ TypeError に揃える。配列・関数も
      // `correlationId` を持てないため同じく拒否する。
      for (const bad of [null, 42, "options", [], () => {}]) {
        await expect(
          store.append(
            "agg-19b",
            [{ type: "Incremented", data: { amount: 1 } }],
            0,
            invalidInput(bad),
          ),
        ).rejects.toBeInstanceOf(TypeError);
      }
      expect(await store.load("agg-19b")).toEqual([]);
    });

    it("CT-20 append の返り値は入力 event と参照を共有しない", async () => {
      const store = await makeStore();
      const aggregateId = "agg-20";
      const data = { amount: 5 };
      const appended = await store.append(aggregateId, [{ type: "Incremented", data }], 0);
      // 返り値を改変しても永続化内容・caller の入力オブジェクトの双方に波及しないこと
      const appendedData = appended[0]?.data;
      if (appendedData === undefined) throw new Error("expected stored data");
      appendedData.amount = -1;
      expect(data.amount).toBe(5);
      expect((await store.load(aggregateId))[0]?.data).toEqual({ amount: 5 });
    });

    it("CT-21 非 plain data (DEC-011 違反) は両 store で TypeError (backend 間の silent divergence を塞ぐ)", async () => {
      const store = await makeStore();
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const protoKeyed = invalidInput<Record<string, unknown>>(
        JSON.parse('{"__proto__":{"polluted":true}}'),
      );
      const cases: Array<[string, unknown]> = [
        ["循環参照", circular],
        ["Date (marshall で {} に退化)", new Date(0)],
        ["own __proto__ key (unmarshall で消失)", protoKeyed],
        // array 要素の undefined は marshall が要素ごと落として位置がずれる
        // ([1, undefined, 3] → [1, 3]) ため reject する — strip は data を壊す。
        ["array element undefined (位置ずれ)", { a: [1, undefined, 3] }],
        ["非有限数 NaN", Number.NaN],
        [
          "class instance (prototype が失われる)",
          new (class Foo {
            x = 1;
          })(),
        ],
        ["nested function", { cb: () => 1 }],
        ["enumerable symbol key (marshall が落とす)", { [Symbol("k")]: 1 }],
        ["深さ 32 超過 (DynamoDB 上限)", makeNested(40)],
      ];
      for (const [name, data] of cases) {
        await expect(
          store.append("agg-21", [{ type: "Incremented", data: invalidInput(data) }], 0),
          name,
        ).rejects.toBeInstanceOf(TypeError);
      }
      expect(await store.load("agg-21")).toEqual([]); // reject 分は永続化しない
    });

    it("CT-21b round-trip で型が失われる値 (bigint / Map / Set / ArrayBuffer / 非 Uint8Array view) も両 store で TypeError", async () => {
      const store = await makeStore();
      // marshall→unmarshall で型が変わって戻る値は受理すると backend 間で読み出し結果が
      // 食い違う (bigint→number, Map→object, ArrayBuffer→Uint8Array) ため reject 側に倒す。
      const cases: Array<[string, unknown]> = [
        ["bigint (N→number で型喪失)", 9007199254740993n],
        ["Map (M→object で型喪失)", new Map([["k", 1]])],
        ["Set (unmarshall が content 型依存)", new Set(["a"])],
        ["ArrayBuffer (→Uint8Array で型喪失)", new ArrayBuffer(4)],
        ["DataView (→Uint8Array で型喪失)", new DataView(new ArrayBuffer(4))],
        // Buffer は Uint8Array subclass だが DEC-011 で明示的に禁止 (unmarshall は
        // Uint8Array を返し型が変わる。JSON.stringify でも {"type":"Buffer"} に変化)。
        ["Buffer (Uint8Array subclass、DEC-011 禁止)", Buffer.from([1, 2])],
        ["Uint8Array subclass", new (class extends Uint8Array {})([1])],
        // constructor を持たない null-proto object を prototype に持つ非 plain object。
        // 診断 message の `?? "unknown prototype"` 経路も通ることを確認する。
        ["object with null-prototype prototype", Object.create(Object.create(null))],
      ];
      for (const [name, data] of cases) {
        await expect(
          store.append("agg-21b", [{ type: "Incremented", data: invalidInput(data) }], 0),
          name,
        ).rejects.toBeInstanceOf(TypeError);
      }
      expect(await store.load("agg-21b")).toEqual([]);
    });

    it("CT-22 plain data の受理範囲 (Uint8Array / array / 深いネスト / null-proto object) は両 store で round-trip", async () => {
      const store = await makeStore();
      const aggregateId = "agg-22";
      const nullProto: Record<string, unknown> = Object.create(null);
      nullProto.v = 1;
      // 宣言された data 型 {amount:number} を超える正常な plain data。変数経由なら
      // excess property check が掛からず、width subtyping でそのまま渡せる。
      const payload: {
        amount: number;
        bin: Uint8Array;
        nested: { a: Array<{ b: null; c: Array<number | string | boolean> }> };
        nullProto: Record<string, unknown>;
      } = {
        amount: 1,
        bin: new Uint8Array([1, 2, 3]),
        nested: { a: [{ b: null, c: [1, "two", true] }] },
        nullProto,
      };
      await store.append(
        aggregateId,
        [
          {
            type: "Incremented",
            data: payload,
          },
        ],
        0,
      );
      const loaded = await store.load(aggregateId);
      const raw: unknown = loaded[0]?.data;
      // 宣言された data 型 ({amount}) を超える payload のため、cast ではなく
      // 存在 + `in` で narrow して読む (正常な取得値の型を invalidInput で隠さない)
      if (
        raw === null ||
        typeof raw !== "object" ||
        !("bin" in raw) ||
        !("nested" in raw) ||
        !("nullProto" in raw)
      ) {
        throw new Error("expected enriched plain data payload");
      }
      expect(raw.bin).toBeInstanceOf(Uint8Array);
      expect(raw.nested).toEqual({ a: [{ b: null, c: [1, "two", true] }] });
      expect(raw.nullProto).toEqual({ v: 1 });
    });

    it("CT-22b object の undefined 値は受理され、persist 時に key ごと strip される (removeUndefinedValues と同じ)", async () => {
      // `{ a: { b: undefined } }` のような nested undefined は v0.2.0 でも両 backend で
      // 受理されていた (InMemory は保持、DynamoDB は marshall が落とす = 読み出しが
      // 食い違っていた)。write 側で reject せず、永続化側で「undefined 値の own key を
      // 落とす」正規化を掛けて両 backend の保存内容を一致させる。
      const store = await makeStore();
      // nested undefined を含む正常な plain data。宣言 data 型 {amount:number} を
      // 含める形の型付き fixture として渡す (excess property は変数経由で受理)。
      const payload: { amount: number } & Record<string, unknown> = {
        amount: 0,
        a: { b: undefined },
        c: 1,
      };
      await store.append("agg-22b", [{ type: "Incremented", data: payload }], 0);
      const loaded = await store.load("agg-22b");
      // `b` は strip され、両 backend で同じ `{ amount: 0, a: {}, c: 1 }` が読める
      expect(loaded[0]?.data).toEqual({ amount: 0, a: {}, c: 1 });
      // `toEqual` は undefined 値の key を無視するため、strip の実効は
      // own key の欠落で確かめる (b: undefined が残っていても toEqual は通る)。
      const data: unknown = loaded[0]?.data;
      const a = isObjectRecord(data) ? data.a : undefined;
      expect(isObjectRecord(a) && !Object.hasOwn(a, "b")).toBe(true);
    });

    it("CT-21c plain-data の深さ境界を固定する (makeNested(30) 受理 / 31 で reject)", async () => {
      // DynamoDB の item ネスト上限は 32 階層。event item は `data` 属性で 1 段
      // wrap され、最深部の leaf scalar も 1 階層に数えられるため、payload の最深
      // object は depth 30 まで受理、depth 31 で ValidationException (実測で固定)。
      // minamo の深さカウントは root object を depth 0 として数えるため、
      // makeNested(30) が受理される境界、makeNested(31) が reject 側。
      const store = await makeStore();
      // 宣言 data 型 {amount:number} を含めた型付き fixture。`amount` は root の
      // scalar で深さを増やさないため、next チェーンの深さ境界は変わらない。
      const payload30: { amount: number } & Record<string, unknown> = {
        amount: 0,
        ...makeNested(30),
      };
      const payload31: { amount: number } & Record<string, unknown> = {
        amount: 0,
        ...makeNested(31),
      };
      await expect(
        store.append("agg-21c-ok", [{ type: "Incremented", data: payload30 }], 0),
      ).resolves.toHaveLength(1);
      await expect(
        store.append("agg-21c-ng", [{ type: "Incremented", data: payload31 }], 0),
      ).rejects.toBeInstanceOf(TypeError);
    });

    it("CT-23 events が非配列・null → EventLimitError (raw TypeError に落とさない)", async () => {
      const store = await makeStore();
      // `events.length` のアクセスで生 TypeError になる前に、assertDomainEvents の
      // isArray 検査で EventLimitError に揃える (backend 非依存の契約として固定)。
      for (const bad of [null, undefined, "events", 42, { length: 2 }]) {
        await expect(
          store.append("agg-23", invalidInput(bad), 0),
          String(bad),
        ).rejects.toBeInstanceOf(EventLimitError);
      }
      expect(await store.load("agg-23")).toEqual([]);
    });

    it("CT-24 event data が Proxy → EventLimitError (生 DataCloneError に落とさない)", async () => {
      const store = await makeStore();
      // Proxy は assertPlainData の検査 (prototype/keys/symbol) がすべて target に
      // forward されるため検出不能だが、structuredClone は失敗する。clone 失敗を
      // append 入力制約違反として両 store で同じ error type に揃える。
      const proxyData = new Proxy({ amount: 1 }, {});
      await expect(
        store.append("agg-24", invalidInput([{ type: "Incremented", data: proxyData }]), 0),
      ).rejects.toBeInstanceOf(EventLimitError);
      expect(await store.load("agg-24")).toEqual([]);
    });
  });
}
