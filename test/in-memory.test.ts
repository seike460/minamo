import { describe, expect, it } from "vitest";
import { InMemoryEventStore } from "../src/index.js";
import { type CounterEvents, registerEventStoreContract } from "./contract/event-store.js";

/**
 * U4 Contract Tests (CT-01〜13) を InMemoryEventStore 対象で実行。
 * 同一 suite が U8 DynamoEventStore でも走ることで concept.md §1 痛み C
 * (InMemory と本番の振る舞い差異) を構造的に抑える。
 */
registerEventStoreContract({
  label: "InMemoryEventStore",
  makeStore: async () => new InMemoryEventStore<CounterEvents>(),
});

describe("InMemoryEventStore — unit-specific tests", () => {
  it("CT-InMem-01 allEvents returns events in global insertion order across aggregates", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    await store.append("agg-A", [{ type: "Incremented", data: { amount: 1 } }], 0);
    await store.append("agg-B", [{ type: "Incremented", data: { amount: 10 } }], 0);
    await store.append("agg-A", [{ type: "Incremented", data: { amount: 2 } }], 1);

    const all = store.allEvents();
    expect(all.map((e) => `${e.aggregateId}:${e.version}`)).toEqual([
      "agg-A:1",
      "agg-B:1",
      "agg-A:2",
    ]);
  });

  it("CT-InMem-02 clear resets all streams and allEvents", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    await store.append("agg-A", [{ type: "Incremented", data: { amount: 1 } }], 0);
    await store.append("agg-B", [{ type: "Incremented", data: { amount: 5 } }], 0);

    store.clear();

    expect(await store.load("agg-A")).toEqual([]);
    expect(await store.load("agg-B")).toEqual([]);
    expect(store.allEvents()).toEqual([]);

    const reAppended = await store.append(
      "agg-A",
      [{ type: "Incremented", data: { amount: 7 } }],
      0,
    );
    expect(reAppended[0]?.version).toBe(1);
  });

  it("CT-InMem-03 omits correlationId property when options is undefined", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const [stored] = await store.append("agg-1", [{ type: "Incremented", data: { amount: 1 } }], 0);
    expect(Object.hasOwn(stored ?? {}, "correlationId")).toBe(false);

    const [loaded] = await store.load("agg-1");
    expect(Object.hasOwn(loaded ?? {}, "correlationId")).toBe(false);
  });

  it("CT-InMem-04 preserves empty string correlationId as a set value", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const [stored] = await store.append(
      "agg-1",
      [{ type: "Incremented", data: { amount: 1 } }],
      0,
      { correlationId: "" },
    );
    expect(stored?.correlationId).toBe("");
    expect(Object.hasOwn(stored ?? {}, "correlationId")).toBe(true);
  });

  it("CT-InMem-05 assigns a single timestamp to all events of the same append", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const appended = await store.append(
      "agg-1",
      [
        { type: "Incremented", data: { amount: 1 } },
        { type: "Incremented", data: { amount: 2 } },
        { type: "Incremented", data: { amount: 3 } },
        { type: "Incremented", data: { amount: 4 } },
        { type: "Incremented", data: { amount: 5 } },
      ],
      0,
    );
    const timestamps = new Set(appended.map((e) => e.timestamp));
    expect(timestamps.size).toBe(1);
  });

  it("CT-InMem-06 fresh-read: load after append observes the just-written events", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    await store.append("agg-1", [{ type: "Incremented", data: { amount: 1 } }], 0);
    await store.append("agg-1", [{ type: "Incremented", data: { amount: 2 } }], 1);
    const loaded = await store.load("agg-1");
    expect(loaded.map((e) => e.version)).toEqual([1, 2]);
  });

  it("CT-InMem-07 different aggregateIds remain independent in version sequence", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    await store.append("agg-A", [{ type: "Incremented", data: { amount: 1 } }], 0);
    await store.append("agg-A", [{ type: "Incremented", data: { amount: 2 } }], 1);

    const aLoaded = await store.load("agg-A");
    const bLoaded = await store.load("agg-B");
    expect(aLoaded.map((e) => e.version)).toEqual([1, 2]);
    expect(bLoaded).toEqual([]);
  });
});
