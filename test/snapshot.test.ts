import { describe, expect, it } from "vitest";
import type {
  AppendOptions,
  EventStore,
  EventsOf,
  ExecuteObserver,
  StoredEventsOf,
} from "../src/index.js";
import { executeCommand, InMemoryEventStore, InMemorySnapshotStore } from "../src/index.js";
import { type CounterEvents, counterConfig, incrementHandler } from "./fixtures/counter.js";

/**
 * executeCommand の Snapshot 統合 (concept.md §5.10, DEC-019)。
 * - snapshotPolicy が跨いだら save する
 * - snapshot 経路で rehydration コスト (replay 件数) が減る
 * - loadFrom 実装 store では loadFrom(afterVersion) が使われ全件 load を避ける
 * - snapshot.state を起点に rehydrate する (full replay を短絡する)
 */

/** loadFrom を実装し、load / loadFrom の呼び出しを数える store double。 */
class LoadFromStore implements EventStore<CounterEvents> {
  readonly #inner = new InMemoryEventStore<CounterEvents>();
  loadCalls = 0;
  loadFromCalls = 0;
  lastAfterVersion = -1;

  append(
    aggregateId: string,
    events: ReadonlyArray<EventsOf<CounterEvents>>,
    expectedVersion: number,
    options?: AppendOptions,
  ): Promise<ReadonlyArray<StoredEventsOf<CounterEvents>>> {
    return this.#inner.append(aggregateId, events, expectedVersion, options);
  }

  async load(aggregateId: string): Promise<ReadonlyArray<StoredEventsOf<CounterEvents>>> {
    this.loadCalls += 1;
    return this.#inner.load(aggregateId);
  }

  async loadFrom(
    aggregateId: string,
    afterVersion: number,
  ): Promise<ReadonlyArray<StoredEventsOf<CounterEvents>>> {
    this.loadFromCalls += 1;
    this.lastAfterVersion = afterVersion;
    return (await this.#inner.load(aggregateId)).filter((e) => e.version > afterVersion);
  }

  /** seed 用に inner へ直接 append する。 */
  seed(aggregateId: string, amount: number, expectedVersion: number) {
    return this.#inner.append(
      aggregateId,
      [{ type: "Incremented", data: { amount } }],
      expectedVersion,
    );
  }
}

describe("executeCommand + Snapshot", () => {
  it("snapshotPolicy.everyNEvents を跨いだら snapshot を save する", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const snapshots = new InMemorySnapshotStore<number>();

    // amount=1 を 3 回。version 1,2,3。everyNEvents=2 で version 2 を跨ぐ cmd2 のとき save。
    for (let i = 0; i < 3; i++) {
      await executeCommand({
        config: counterConfig,
        store,
        handler: incrementHandler,
        aggregateId: "snap-1",
        input: { amount: 1 },
        snapshotStore: snapshots,
        snapshotPolicy: { everyNEvents: 2 },
      });
    }

    const snap = await snapshots.load("snap-1");
    expect(snap?.version).toBe(2); // 2 を跨いだ時点で save、3 は跨がない
    expect(snap?.state).toBe(2);
  });

  it("snapshot 経路で replay 件数 (onLoaded.eventCount) が減る", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const snapshots = new InMemorySnapshotStore<number>();

    // 先に 3 イベント append + snapshot(version=3, state=3) を保存
    await store.append(
      "snap-2",
      [
        { type: "Incremented", data: { amount: 1 } },
        { type: "Incremented", data: { amount: 1 } },
        { type: "Incremented", data: { amount: 1 } },
      ],
      0,
    );
    await snapshots.save({
      aggregateId: "snap-2",
      version: 3,
      state: 3,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    let observedCount = -1;
    const observer: ExecuteObserver = {
      onLoaded: (info) => {
        observedCount = info.eventCount;
      },
    };

    const result = await executeCommand({
      config: counterConfig,
      store,
      handler: incrementHandler,
      aggregateId: "snap-2",
      input: { amount: 5 },
      snapshotStore: snapshots,
      observer,
    });

    expect(observedCount).toBe(0); // snapshot(v3) 以降のイベントは無いので replay 0 件
    expect(result.aggregate.state).toBe(8); // snapshot.state(3) + 5
    expect(result.aggregate.version).toBe(4);
  });

  it("loadFrom 実装 store では loadFrom(afterVersion) が使われ全件 load を避ける", async () => {
    const store = new LoadFromStore();
    const snapshots = new InMemorySnapshotStore<number>();

    await store.seed("snap-3", 1, 0);
    await store.seed("snap-3", 1, 1);
    await store.seed("snap-3", 1, 2);
    await snapshots.save({
      aggregateId: "snap-3",
      version: 3,
      state: 3,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const loadCallsBefore = store.loadCalls;
    await executeCommand({
      config: counterConfig,
      store,
      handler: incrementHandler,
      aggregateId: "snap-3",
      input: { amount: 2 },
      snapshotStore: snapshots,
    });

    expect(store.loadFromCalls).toBe(1);
    expect(store.lastAfterVersion).toBe(3); // snapshot.version
    expect(store.loadCalls).toBe(loadCallsBefore); // 全件 load は呼ばれない
  });

  it("snapshot.state を起点に rehydrate し full replay を短絡する", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const snapshots = new InMemorySnapshotStore<number>();

    // 実イベントの合計は 3 だが、snapshot.state を意図的に 100 にする。
    // snapshot が使われていれば handler は state=100 を見る (full replay なら 3)。
    await store.append(
      "snap-4",
      [
        { type: "Incremented", data: { amount: 1 } },
        { type: "Incremented", data: { amount: 1 } },
        { type: "Incremented", data: { amount: 1 } },
      ],
      0,
    );
    await snapshots.save({
      aggregateId: "snap-4",
      version: 3,
      state: 100,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    let seenState = -1;
    const result = await executeCommand({
      config: counterConfig,
      store,
      handler: (agg, input: { amount: number }) => {
        seenState = agg.state;
        return [{ type: "Incremented", data: { amount: input.amount } }];
      },
      aggregateId: "snap-4",
      input: { amount: 1 },
      snapshotStore: snapshots,
    });

    expect(seenState).toBe(100); // snapshot.state が起点 (full replay の 3 ではない)
    expect(result.aggregate.state).toBe(101);
  });
});
