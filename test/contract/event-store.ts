import { describe, expect, it } from "vitest";
import type { EventMap, EventStore } from "../../src/index.js";
import { ConcurrencyError, EventLimitError } from "../../src/index.js";

/**
 * Event Store Contract Tests (CT-01 〜 CT-15: 振る舞い系)。
 *
 * 単一 suite を InMemoryEventStore と DynamoEventStore の両方で実行し、
 * concept.md §1 痛み C (InMemory と本番の振る舞い差異) を構造的に抑え込む。
 * 入力拒否系 (CT-16〜24) は contract/event-store-validation.ts に分離。
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
      // batch 内の全 stored event に付くこと (一部だけ付ける実装でも pass しないよう)。
      // 件数も確認する — append が空配列を返す不具合では loop 内 assertion が
      // 一度も実行されず green になる。
      expect(appended).toHaveLength(2);
      for (const ev of appended) {
        expect(ev.correlationId).toBe(cid);
      }
      const loaded = await store.load(aggregateId);
      expect(loaded).toHaveLength(2);
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
      expect(appended).toHaveLength(2);
      for (const ev of appended) {
        expect(Object.hasOwn(ev, "correlationId")).toBe(false);
      }
      const loaded = await store.load(aggregateId);
      expect(loaded).toHaveLength(2);
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
      const loadedData = loaded[0]?.data;
      if (loadedData === undefined) throw new Error("expected stored data");
      loadedData.amount = -1;
      expect((await store.load(aggregateId))[0]?.data).toEqual({ amount: 5 });
    });
  });
}
