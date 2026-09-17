import { describe, expect, it } from "vitest";
import type {
  AppendOptions,
  EventStore,
  EventsOf,
  ExecuteObserver,
  Snapshot,
  SnapshotStore,
  StoredEventsOf,
} from "../src/index.js";
import {
  executeCommand,
  InMemoryEventStore,
  InMemorySnapshotStore,
  InvalidEventStreamError,
  RetryExhaustedError,
} from "../src/index.js";
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

/** save が常に reject する SnapshotStore double (DEC-026: snapshot save は best-effort)。 */
class FailingSaveSnapshotStore implements SnapshotStore<number> {
  saveCalls = 0;
  async load(): Promise<Snapshot<number> | null> {
    return null;
  }
  async save(): Promise<void> {
    this.saveCalls += 1;
    throw new Error("snapshot backend unavailable");
  }
}

/** 固定の snapshot を返す store double (custom SnapshotStore の契約違反を注入する)。 */
class StubSnapshotStore implements SnapshotStore<number> {
  constructor(private readonly snap: Snapshot<number>) {}
  async load(): Promise<Snapshot<number> | null> {
    return this.snap;
  }
  async save(): Promise<void> {}
}

/** loadFrom が truthy だが関数ではない store double (型違反入力。fallback 経路の検証用)。 */
class NonFunctionLoadFromStore implements EventStore<CounterEvents> {
  readonly #inner = new InMemoryEventStore<CounterEvents>();
  loadCalls = 0;
  // interface 上は optional method だが、custom store が誤って非関数を生やすケースを模擬
  readonly loadFrom = {} as never;

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

  it("snapshot save が失敗しても command は成功しイベントは commit される (best-effort, DEC-026)", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const snapshots = new FailingSaveSnapshotStore();

    // everyNEvents=1 で version 1 を跨ぐため save を試みる → reject されるが握りつぶす。
    const result = await executeCommand({
      config: counterConfig,
      store,
      handler: incrementHandler,
      aggregateId: "snap-fail",
      input: { amount: 5 },
      snapshotStore: snapshots,
      snapshotPolicy: { everyNEvents: 1 },
    });

    expect(snapshots.saveCalls).toBe(1); // save は確かに試行された
    expect(result.aggregate.state).toBe(5); // save 失敗にもかかわらず command は正常完了
    expect(result.aggregate.version).toBe(1);
    expect(result.newEvents).toHaveLength(1);
    // append は commit 済み: 再 load でイベントが残っている (= 二重書き込み hazard を防ぐ)
    expect(await store.load("snap-fail")).toHaveLength(1);
  });

  it("custom SnapshotStore が契約違反の snapshot を返したら TypeError (strict)", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    await store.append("agg-s", [{ type: "Incremented", data: { amount: 1 } }], 0);

    const cases: Array<Snapshot<number>> = [
      // 別 aggregate の snapshot → 別 state 起点の replay = silent corruption
      { aggregateId: "other", version: 1, state: 0, timestamp: "2026-01-01T00:00:00.000Z" },
      // NaN / 非整数 / 0 以下の version → loadFrom(NaN) は空を返し version が壊れる
      {
        aggregateId: "agg-s",
        version: Number.NaN,
        state: 0,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      { aggregateId: "agg-s", version: 0, state: 0, timestamp: "2026-01-01T00:00:00.000Z" },
      { aggregateId: "agg-s", version: 1.5, state: 0, timestamp: "2026-01-01T00:00:00.000Z" },
      // state 欠落 / undefined (own property 存在だけでは弾けない)
      {
        aggregateId: "agg-s",
        version: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
      } as Snapshot<number>,
      {
        aggregateId: "agg-s",
        version: 1,
        state: undefined,
        timestamp: "2026-01-01T00:00:00.000Z",
      } as unknown as Snapshot<number>,
      // null 以外の非 object (undefined) を返す契約違反
      undefined as unknown as Snapshot<number>,
    ];

    for (const snap of cases) {
      await expect(
        executeCommand({
          config: counterConfig,
          store,
          handler: incrementHandler,
          aggregateId: "agg-s",
          input: { amount: 1 },
          snapshotStore: new StubSnapshotStore(snap),
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("loadFrom が非関数 (truthy) でも full load + filter に fallback する", async () => {
    const store = new NonFunctionLoadFromStore();
    const snapshots = new InMemorySnapshotStore<number>();

    await store.seed("agg-nf", 10, 0);
    await snapshots.save({
      aggregateId: "agg-nf",
      version: 1,
      state: 10,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await store.seed("agg-nf", 5, 1);

    const result = await executeCommand({
      config: counterConfig,
      store,
      handler: incrementHandler,
      aggregateId: "agg-nf",
      input: { amount: 1 },
      snapshotStore: snapshots,
    });

    // typeof 判定で fallback → load 全件 + filter。snapshot.state(10) + tail(5) + handler(1) = 16
    expect(result.aggregate.state).toBe(16);
    expect(store.loadCalls).toBe(1);
  });

  it("snapshot.version > stream head → append の ConditionCheck が ConcurrencyError → RetryExhaustedError", async () => {
    // snapshot が stream より進んでいる破損状態: retry しても解消しないため枯渇で fail-loud。
    const store = new InMemoryEventStore<CounterEvents>();
    await store.append("agg-stale", [{ type: "Incremented", data: { amount: 1 } }], 0);
    const snapshots = new InMemorySnapshotStore<number>();
    await snapshots.save({
      aggregateId: "agg-stale",
      version: 5, // stream head (1) より進んでいる
      state: 99,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await expect(
      executeCommand({
        config: counterConfig,
        store,
        handler: incrementHandler,
        aggregateId: "agg-stale",
        input: { amount: 1 },
        snapshotStore: snapshots,
        maxRetries: 2,
      }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
  });

  it("snapshot 以降の tail に version gap がある → InvalidEventStreamError (version_gap)", async () => {
    // snapshot.version=3 の直後に version=5 が来る破損 stream (loadFrom で [5] が返る)。
    const gapTail = {
      version: 5,
      aggregateId: "agg-gap",
      type: "Incremented",
      data: { amount: 7 },
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const store = {
      load: () => Promise.resolve([gapTail]),
      loadFrom: (_id: string, _v: number) => Promise.resolve([gapTail]),
    };
    const snapshots = new InMemorySnapshotStore<number>();
    await snapshots.save({
      aggregateId: "agg-gap",
      version: 3,
      state: 30,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const err: unknown = await executeCommand({
      config: counterConfig,
      store: store as never,
      handler: incrementHandler,
      aggregateId: "agg-gap",
      input: { amount: 1 },
      snapshotStore: snapshots,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InvalidEventStreamError);
    expect((err as InvalidEventStreamError).reason).toBe("version_gap");
  });

  it("loadFrom が非配列を返す → TypeError", async () => {
    const store = {
      load: () => Promise.resolve([]),
      loadFrom: () => Promise.resolve({ length: 1 }),
    };
    const snapshots = new InMemorySnapshotStore<number>();
    await snapshots.save({
      aggregateId: "agg-na",
      version: 1,
      state: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await expect(
      executeCommand({
        config: counterConfig,
        store: store as never,
        handler: incrementHandler,
        aggregateId: "agg-na",
        input: { amount: 1 },
        snapshotStore: snapshots,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("fallback filter 経路で malformed 要素 (version 欠落) → TypeError", async () => {
    // loadFrom 未実装の store が version 欠落の要素を返すと、filter が e.version に
    // 触れる前に fail-loud する (生 TypeError や静かな drop ではなく契約違反)。
    const malformed = {
      aggregateId: "agg-mf",
      type: "Incremented",
      data: { amount: 1 },
      timestamp: "2026-01-01T00:00:00.000Z",
      // version 欠落
    };
    const store = {
      load: () => Promise.resolve([malformed]),
    };
    const snapshots = new InMemorySnapshotStore<number>();
    await snapshots.save({
      aggregateId: "agg-mf",
      version: 1,
      state: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await expect(
      executeCommand({
        config: counterConfig,
        store: store as never,
        handler: incrementHandler,
        aggregateId: "agg-mf",
        input: { amount: 1 },
        snapshotStore: snapshots,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("snapshotPolicy.everyNEvents が非有限数 → TypeError", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(
        executeCommand({
          config: counterConfig,
          store,
          handler: incrementHandler,
          aggregateId: "agg-nan",
          input: { amount: 1 },
          snapshotStore: new InMemorySnapshotStore<number>(),
          snapshotPolicy: { everyNEvents: bad },
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("onCommitted が throw しても閾値到達済みの snapshot save は試行される", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const snapshots = new InMemorySnapshotStore<number>();
    await store.append("agg-oc", [{ type: "Incremented", data: { amount: 1 } }], 0);
    // version 1→2 で everyNEvents: 2 の閾値を跨ぐ → snapshot save 対象
    await expect(
      executeCommand({
        config: counterConfig,
        store,
        handler: incrementHandler,
        aggregateId: "agg-oc",
        input: { amount: 1 },
        observer: {
          onCommitted: () => {
            throw new Error("observer exploded");
          },
        },
        snapshotStore: snapshots,
        snapshotPolicy: { everyNEvents: 2 },
      }),
    ).rejects.toThrow("observer exploded");
    // observer の失敗にもかかわらず snapshot は保存されている (finally 経路)
    expect(await snapshots.load("agg-oc")).not.toBeNull();
  });
});
