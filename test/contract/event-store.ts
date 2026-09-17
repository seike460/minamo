import { beforeEach, describe, expect, it } from "vitest";
import type { EventMap, EventStore } from "../../src/index.js";
import { ConcurrencyError, EventLimitError } from "../../src/index.js";

/**
 * Event Store Contract Tests (CT-01 〜 CT-22)。
 *
 * 単一 suite を InMemoryEventStore と DynamoEventStore の両方で実行し、
 * concept.md §1 痛み C (InMemory と本番の振る舞い差異) を構造的に抑え込む。
 *
 * 呼び出し側が以下を提供する:
 * - `label`: describe ブロックの識別名 (例: "InMemoryEventStore", "DynamoEventStore")
 * - `makeStore(): Promise<EventStore<CounterEvents>>`: 各 test 開始時に新規ストアを返す factory
 *
 * 各 test は独立した store を要求する (状態共有させない)。
 */

const ISO_8601_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type CounterEvents = {
  Incremented: { amount: number };
};

export interface ContractContext<TMap extends EventMap> {
  readonly label: string;
  readonly makeStore: () => Promise<EventStore<TMap>>;
  /**
   * 各 test 実行前に評価する可用性判定。`false` を返したら test を skip する。
   * DynamoDB Local 等の外部依存が無い環境で contract suite が red にならないようにする。
   */
  readonly isAvailable?: () => boolean;
}

/** `depth` 階層のネストした plain object を作る (深さ上限検証用)。 */
function makeNested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < depth; i++) value = { next: value };
  return value;
}

/**
 * Contract Test suite を登録する。呼び出し側は describe の外 (module top-level) から呼ぶ。
 *
 * `TMap` は `CounterEvents` 固定で受ける (Aggregate 毎の型差は Contract Tests の
 * 対象ではないため)。Store 実装が `EventStore<CounterEvents>` を満たせば全 case 通過する。
 */
export function registerEventStoreContract(ctx: ContractContext<CounterEvents>): void {
  const { label, makeStore } = ctx;

  describe(`${label} — Contract Tests`, () => {
    beforeEach((testCtx) => {
      // backend が到達不能な環境では red ではなく skip に倒す
      if (ctx.isAvailable !== undefined && !ctx.isAvailable()) {
        testCtx.skip();
      }
    });

    it("CT-01 load on an empty stream returns []", async () => {
      const store = await makeStore();
      const events = await store.load("agg-01");
      expect(events).toEqual([]);
    });

    it("CT-02 append 1 event then load returns it with version=1", async () => {
      const store = await makeStore();
      const aggregateId = "agg-02";
      const appended = await store.append(
        aggregateId,
        [{ type: "Incremented", data: { amount: 5 } }],
        0,
      );
      expect(appended).toHaveLength(1);
      const [head] = appended;
      expect(head?.version).toBe(1);
      expect(head?.aggregateId).toBe(aggregateId);
      expect(head?.type).toBe("Incremented");
      expect(head?.data).toEqual({ amount: 5 });

      const loaded = await store.load(aggregateId);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.version).toBe(1);
    });

    it("CT-03 append 3 events in a single call produces version=[1,2,3]", async () => {
      const store = await makeStore();
      const aggregateId = "agg-03";
      const appended = await store.append(
        aggregateId,
        [
          { type: "Incremented", data: { amount: 1 } },
          { type: "Incremented", data: { amount: 2 } },
          { type: "Incremented", data: { amount: 3 } },
        ],
        0,
      );
      expect(appended.map((e) => e.version)).toEqual([1, 2, 3]);
      expect(appended.map((e) => e.data)).toEqual([{ amount: 1 }, { amount: 2 }, { amount: 3 }]);
      const loaded = await store.load(aggregateId);
      expect(loaded.map((e) => e.version)).toEqual([1, 2, 3]);
    });

    it("CT-04 append with expectedVersion ahead of real stream throws ConcurrencyError", async () => {
      const store = await makeStore();
      const aggregateId = "agg-04";
      await store.append(aggregateId, [{ type: "Incremented", data: { amount: 1 } }], 0);
      await expect(
        store.append(aggregateId, [{ type: "Incremented", data: { amount: 2 } }], 5),
      ).rejects.toBeInstanceOf(ConcurrencyError);
      // 失敗した append は stream に何も残さない (atomicity)
      expect(await store.load(aggregateId)).toHaveLength(1);
    });

    it("CT-05 append with expectedVersion behind real stream throws ConcurrencyError", async () => {
      const store = await makeStore();
      const aggregateId = "agg-05";
      await store.append(aggregateId, [{ type: "Incremented", data: { amount: 1 } }], 0);
      await store.append(aggregateId, [{ type: "Incremented", data: { amount: 2 } }], 1);
      await expect(
        store.append(aggregateId, [{ type: "Incremented", data: { amount: 3 } }], 0),
      ).rejects.toBeInstanceOf(ConcurrencyError);
      expect(await store.load(aggregateId)).toHaveLength(2);
    });

    it("CT-06 append with empty events array throws EventLimitError", async () => {
      const store = await makeStore();
      await expect(store.append("agg-06", [], 0)).rejects.toBeInstanceOf(EventLimitError);
    });

    it("CT-07 two sequential appends are observed as one contiguous version sequence", async () => {
      const store = await makeStore();
      const aggregateId = "agg-07";
      await store.append(aggregateId, [{ type: "Incremented", data: { amount: 1 } }], 0);
      await store.append(
        aggregateId,
        [
          { type: "Incremented", data: { amount: 2 } },
          { type: "Incremented", data: { amount: 3 } },
        ],
        1,
      );
      const loaded = await store.load(aggregateId);
      expect(loaded.map((e) => e.version)).toEqual([1, 2, 3]);
    });

    it("CT-08 timestamps are ISO 8601 UTC with millisecond precision", async () => {
      const store = await makeStore();
      const appended = await store.append(
        "agg-08",
        [{ type: "Incremented", data: { amount: 1 } }],
        0,
      );
      expect(appended[0]?.timestamp).toMatch(ISO_8601_UTC_RE);
    });

    it("CT-09 every stored event carries the passed aggregateId", async () => {
      const store = await makeStore();
      const aggregateId = "agg-09";
      const appended = await store.append(
        aggregateId,
        [
          { type: "Incremented", data: { amount: 1 } },
          { type: "Incremented", data: { amount: 2 } },
        ],
        0,
      );
      for (const ev of appended) {
        expect(ev.aggregateId).toBe(aggregateId);
      }
    });

    it("CT-10 correlationId option is persisted on every stored event", async () => {
      const store = await makeStore();
      const aggregateId = "agg-10";
      const cid = "corr-abc";
      const appended = await store.append(
        aggregateId,
        [
          { type: "Incremented", data: { amount: 1 } },
          { type: "Incremented", data: { amount: 2 } },
        ],
        0,
        { correlationId: cid },
      );
      // batch 内の全 stored event に付くこと (一部だけ付ける実装でも pass しないよう)
      for (const ev of appended) {
        expect(ev.correlationId).toBe(cid);
      }
      const loaded = await store.load(aggregateId);
      for (const ev of loaded) {
        expect(ev.correlationId).toBe(cid);
      }
    });

    it("CT-11 append without options omits correlationId (property absent)", async () => {
      const store = await makeStore();
      const aggregateId = "agg-11";
      const appended = await store.append(
        aggregateId,
        [
          { type: "Incremented", data: { amount: 1 } },
          { type: "Incremented", data: { amount: 2 } },
        ],
        0,
      );
      for (const ev of appended) {
        expect(Object.hasOwn(ev, "correlationId")).toBe(false);
      }
      const loaded = await store.load(aggregateId);
      for (const ev of loaded) {
        expect(Object.hasOwn(ev, "correlationId")).toBe(false);
      }
    });

    it("CT-12 fresh-read: load observes the just-completed append", async () => {
      const store = await makeStore();
      const aggregateId = "agg-12";
      await store.append(aggregateId, [{ type: "Incremented", data: { amount: 1 } }], 0);
      const loaded = await store.load(aggregateId);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.version).toBe(1);
    });

    it("CT-13 different aggregateIds are independent streams", async () => {
      const store = await makeStore();
      await store.append("agg-A", [{ type: "Incremented", data: { amount: 1 } }], 0);
      await store.append("agg-A", [{ type: "Incremented", data: { amount: 2 } }], 1);
      await store.append("agg-B", [{ type: "Incremented", data: { amount: 10 } }], 0);
      const a = await store.load("agg-A");
      const b = await store.load("agg-B");
      expect(a.map((e) => e.version)).toEqual([1, 2]);
      expect(b.map((e) => e.version)).toEqual([1]);
    });

    it("CT-14 loadFrom returns only events after the given version (when supported)", async () => {
      const store = await makeStore();
      // loadFrom は optional method (DEC-019)。組み込み両実装は提供するため、
      // 未実装のまま黙って pass しないよう存在自体も assert する。
      expect(store.loadFrom).toBeTypeOf("function");
      if (typeof store.loadFrom !== "function") return;
      const aggregateId = "agg-14";
      await store.append(
        aggregateId,
        [
          { type: "Incremented", data: { amount: 1 } },
          { type: "Incremented", data: { amount: 2 } },
          { type: "Incremented", data: { amount: 3 } },
        ],
        0,
      );
      expect((await store.loadFrom(aggregateId, 0)).map((e) => e.version)).toEqual([1, 2, 3]);
      expect((await store.loadFrom(aggregateId, 1)).map((e) => e.version)).toEqual([2, 3]);
      expect((await store.loadFrom(aggregateId, 3)).map((e) => e.version)).toEqual([]);
    });

    it("CT-15 mutation isolation: caller 側の変更が stored event に及ばない", async () => {
      const store = await makeStore();
      const aggregateId = "agg-15";
      const data = { amount: 5 };
      await store.append(aggregateId, [{ type: "Incremented", data }], 0);
      // append に渡したオブジェクトを caller 側で改変 → stored event に影響しないこと
      data.amount = 999;
      expect((await store.load(aggregateId))[0]?.data).toEqual({ amount: 5 });
      // load 結果を改変しても再 load で元の値が返ること (live 参照を共有しない)
      const loaded = await store.load(aggregateId);
      (loaded[0]?.data as { amount: number }).amount = -1;
      expect((await store.load(aggregateId))[0]?.data).toEqual({ amount: 5 });
    });

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
        { type: "Incremented" }, // data 欠落
        { type: "Incremented", data: undefined }, // data undefined (marshall で属性ごと消失する)
        { type: "", data: { amount: 1 } }, // 空 type
        { type: 42, data: { amount: 1 } }, // 非 string type
        null, // 非 object 要素
        "Incremented", // 非 object 要素
      ];
      for (const [i, bad] of malformed.entries()) {
        await expect(store.append(`agg-17-${i}`, [bad as never], 0)).rejects.toBeInstanceOf(
          EventLimitError,
        );
      }
      // reject された append は何も永続化していないこと
      expect(await store.load("agg-17-0")).toEqual([]);
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
      await expect(store.load(123 as never)).rejects.toBeInstanceOf(TypeError);
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
          correlationId: 42 as unknown as string,
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(await store.load("agg-19")).toEqual([]);
    });

    it("CT-20 append の返り値は入力 event と参照を共有しない", async () => {
      const store = await makeStore();
      const aggregateId = "agg-20";
      const data = { amount: 5 };
      const appended = await store.append(aggregateId, [{ type: "Incremented", data }], 0);
      // 返り値を改変しても永続化内容・caller の入力オブジェクトの双方に波及しないこと
      (appended[0]?.data as { amount: number }).amount = -1;
      expect(data.amount).toBe(5);
      expect((await store.load(aggregateId))[0]?.data).toEqual({ amount: 5 });
    });

    it("CT-21 非 plain data (DEC-011 違反) は両 store で TypeError (backend 間の silent divergence を塞ぐ)", async () => {
      const store = await makeStore();
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const protoKeyed = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
      const cases: Array<[string, unknown]> = [
        ["循環参照", circular],
        ["Date (marshall で {} に退化)", new Date(0)],
        ["own __proto__ key (unmarshall で消失)", protoKeyed],
        ["nested undefined (marshall が field ごと落とす)", { a: { b: undefined } }],
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
          store.append("agg-21", [{ type: "Incremented", data: data as never }], 0),
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
          store.append("agg-21b", [{ type: "Incremented", data: data as never }], 0),
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
      await store.append(
        aggregateId,
        [
          {
            type: "Incremented",
            data: {
              amount: 1,
              bin: new Uint8Array([1, 2, 3]),
              nested: { a: [{ b: null, c: [1, "two", true] }] },
              nullProto,
            } as never,
          },
        ],
        0,
      );
      const loaded = await store.load(aggregateId);
      const data = loaded[0]?.data as Record<string, unknown>;
      expect(data.bin).toBeInstanceOf(Uint8Array);
      expect(data.nested).toEqual({ a: [{ b: null, c: [1, "two", true] }] });
      expect(data.nullProto).toEqual({ v: 1 });
    });
  });
}
