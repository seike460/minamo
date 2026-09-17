import { describe, expect, it } from "vitest";
import type { AggregateConfig } from "../src/index.js";
import {
  ConcurrencyError,
  EventLimitError,
  executeCommand,
  InMemoryEventStore,
  InMemorySnapshotStore,
  InvalidEventStreamError,
  RetryExhaustedError,
} from "../src/index.js";
import {
  AlwaysFail,
  CountingStore,
  FailOnce,
  FailOnceAndAdvance,
} from "./doubles/event-store-doubles.js";
import { type CounterEvents, counterConfig, incrementHandler } from "./fixtures/counter.js";

describe("executeCommand", () => {
  it("CT-EC-01 happy path: increments state, version, and returns new events", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const res = await executeCommand({
      config: counterConfig,
      store,
      handler: incrementHandler,
      aggregateId: "agg-1",
      input: { amount: 5 },
    });
    expect(res.aggregate.state).toBe(5);
    expect(res.aggregate.version).toBe(1);
    expect(res.newEvents.map((e) => e.data)).toEqual([{ amount: 5 }]);
  });

  it("CT-EC-02 no-op handler returns [] and does not call append", async () => {
    const inner = new InMemoryEventStore<CounterEvents>();
    const store = new CountingStore<CounterEvents>(inner);
    const res = await executeCommand({
      config: counterConfig,
      store,
      handler: incrementHandler,
      aggregateId: "agg-1",
      input: { amount: 0 },
    });
    expect(res.newEvents).toEqual([]);
    expect(res.aggregate.version).toBe(0);
    expect(store.appendCalls).toBe(0);
  });

  it("CT-EC-03 maxRetries=0 + ConcurrencyError → RetryExhaustedError without retry", async () => {
    const store = new AlwaysFail<CounterEvents>();
    let handlerCalls = 0;
    const err: unknown = await executeCommand({
      config: counterConfig,
      store,
      handler: (a, i) => {
        handlerCalls += 1;
        return incrementHandler(a, i);
      },
      aggregateId: "agg-1",
      input: { amount: 1 },
      maxRetries: 0,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetryExhaustedError);
    if (!(err instanceof RetryExhaustedError)) throw new Error("expected RetryExhaustedError");
    expect(err.attempts).toBe(1); // 1 + maxRetries(0)
    expect(err.cause).toBeInstanceOf(ConcurrencyError);
    expect(handlerCalls).toBe(1);
  });

  it("CT-EC-04 maxRetries=3 + FailOnce → succeeds on 2nd try (handler called twice)", async () => {
    const store = new FailOnce<CounterEvents>();
    let handlerCalls = 0;
    const res = await executeCommand({
      config: counterConfig,
      store,
      handler: (a, i) => {
        handlerCalls += 1;
        return incrementHandler(a, i);
      },
      aggregateId: "agg-1",
      input: { amount: 7 },
      maxRetries: 3,
    });
    expect(res.aggregate.state).toBe(7);
    expect(res.aggregate.version).toBe(1);
    expect(handlerCalls).toBe(2);
  });

  it("CT-EC-05 maxRetries=3 + AlwaysFail → RetryExhaustedError (handler called 4 times)", async () => {
    const store = new AlwaysFail<CounterEvents>();
    let handlerCalls = 0;
    const err: unknown = await executeCommand({
      config: counterConfig,
      store,
      handler: (a, i) => {
        handlerCalls += 1;
        return incrementHandler(a, i);
      },
      aggregateId: "agg-1",
      input: { amount: 1 },
      maxRetries: 3,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetryExhaustedError);
    if (!(err instanceof RetryExhaustedError)) throw new Error("expected RetryExhaustedError");
    expect(err.attempts).toBe(4); // 1 + maxRetries(3)
    expect(err.cause).toBeInstanceOf(ConcurrencyError);
    expect(err.aggregateId).toBe("agg-1");
    expect(handlerCalls).toBe(4);
  });

  for (const badValue of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY] as const) {
    it(`CT-EC-06..09 maxRetries=${String(badValue)} → RangeError before load`, async () => {
      const inner = new InMemoryEventStore<CounterEvents>();
      const store = new CountingStore<CounterEvents>(inner);
      await expect(
        executeCommand({
          config: counterConfig,
          store,
          handler: incrementHandler,
          aggregateId: "agg-1",
          input: { amount: 1 },
          maxRetries: badValue,
        }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(store.loadCalls).toBe(0);
      expect(store.appendCalls).toBe(0);
    });
  }

  it("CT-EC-10 handler throw propagates (append not called)", async () => {
    const inner = new InMemoryEventStore<CounterEvents>();
    const store = new CountingStore<CounterEvents>(inner);
    await expect(
      executeCommand({
        config: counterConfig,
        store,
        handler: incrementHandler,
        aggregateId: "agg-1",
        input: { amount: 200 },
      }),
    ).rejects.toThrow(/Counter cannot exceed 100/);
    expect(store.appendCalls).toBe(0);
  });

  it("CT-EC-11 version = initial + newEvents.length", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    await store.append(
      "agg-1",
      [
        { type: "Incremented", data: { amount: 1 } },
        { type: "Incremented", data: { amount: 2 } },
      ],
      0,
    );
    const res = await executeCommand({
      config: counterConfig,
      store,
      handler: incrementHandler,
      aggregateId: "agg-1",
      input: { amount: 4 },
    });
    expect(res.aggregate.version).toBe(3);
    expect(res.aggregate.state).toBe(1 + 2 + 4);
  });

  it("CT-EC-12 retry observes up-to-date state after a conflicting write", async () => {
    const store = new FailOnce<CounterEvents>();
    await store.inner.append("agg-1", [{ type: "Incremented", data: { amount: 10 } }], 0);
    const observedStates: number[] = [];
    const res = await executeCommand({
      config: counterConfig,
      store,
      handler: (agg, input: { amount: number }) => {
        observedStates.push(agg.state);
        return incrementHandler(agg, input);
      },
      aggregateId: "agg-1",
      input: { amount: 5 },
      maxRetries: 3,
    });
    // Both attempts see state=10 because FailOnce does not mutate stream between tries;
    // the important behavior is that the second attempt re-reads the store.
    expect(observedStates).toHaveLength(2);
    expect(observedStates[0]).toBe(10);
    expect(observedStates[1]).toBe(10);
    expect(res.aggregate.state).toBe(15);
  });

  it("CT-EC-13 retry preserves original input value", async () => {
    const store = new FailOnce<CounterEvents>();
    const seenInputs: { amount: number }[] = [];
    const input = { amount: 3 };
    await executeCommand({
      config: counterConfig,
      store,
      handler: (agg, i: { amount: number }) => {
        seenInputs.push(i);
        return incrementHandler(agg, i);
      },
      aggregateId: "agg-1",
      input,
      maxRetries: 3,
    });
    expect(seenInputs).toHaveLength(2);
    expect(seenInputs[0]).toEqual({ amount: 3 });
    expect(seenInputs[1]).toEqual({ amount: 3 });
  });

  it("CT-EC-14 correlationId round-trips to stored events", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const res = await executeCommand({
      config: counterConfig,
      store,
      handler: incrementHandler,
      aggregateId: "agg-1",
      input: { amount: 1 },
      correlationId: "corr-123",
    });
    expect(res.newEvents[0]?.correlationId).toBe("corr-123");

    const loaded = await store.load("agg-1");
    expect(loaded[0]?.correlationId).toBe("corr-123");
  });

  it("CT-EC-15 correlationId omitted → stored event has no correlationId property", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const res = await executeCommand({
      config: counterConfig,
      store,
      handler: incrementHandler,
      aggregateId: "agg-1",
      input: { amount: 1 },
    });
    expect(Object.hasOwn(res.newEvents[0] ?? {}, "correlationId")).toBe(false);
  });

  it("CT-EC-17 handler が evolve 未登録 type を emit → append 前に missing_evolve_handler (stream poison 防止)", async () => {
    const inner = new InMemoryEventStore<CounterEvents>();
    const store = new CountingStore<CounterEvents>(inner);
    const err: unknown = await executeCommand({
      config: counterConfig,
      store,
      // 型では防げない runtime 入力を cast で注入 (consumer bug の模擬)
      handler: () => [{ type: "NotRegistered", data: {} }] as never,
      aggregateId: "agg-1",
      input: { amount: 1 },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InvalidEventStreamError);
    expect((err as InvalidEventStreamError).reason).toBe("missing_evolve_handler");
    // commit 前に弾くため append は呼ばれず stream は空のまま
    expect(store.appendCalls).toBe(0);
    expect(await inner.load("agg-1")).toEqual([]);
  });

  it("CT-EC-18 post-commit (onCommitted) の ConcurrencyError は retry せず伝播する (二重 append 防止)", async () => {
    const inner = new InMemoryEventStore<CounterEvents>();
    const store = new CountingStore<CounterEvents>(inner);
    await expect(
      executeCommand({
        config: counterConfig,
        store,
        handler: incrementHandler,
        aggregateId: "agg-1",
        input: { amount: 1 },
        observer: {
          // commit 後に ConcurrencyError を投げる consumer hook。
          // append は既に成功済みなので、これを retry 捕捉すると二重 append になる。
          onCommitted: () => {
            throw new ConcurrencyError("agg-1", 0);
          },
        },
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
    expect(store.appendCalls).toBe(1); // retry しなかった = 二重 append なし
    expect(await inner.load("agg-1")).toHaveLength(1); // commit は残る
  });

  it("CT-EC-19 evolve が ConcurrencyError を投げても retry せず append も実行されない", async () => {
    const inner = new InMemoryEventStore<CounterEvents>();
    const store = new CountingStore<CounterEvents>(inner);
    // evolve が ConcurrencyError を投げる consumer bug。evolve の適用は append 前に
    // 行われる (commit 後の失敗で「書き込み済みなのに失敗に見える」状態を防ぐため) ので、
    // この ConcurrencyError は append に到達する前に伝播する。
    const config = {
      initialState: 0,
      evolve: {
        Incremented: () => {
          throw new ConcurrencyError("agg-1", 0);
        },
      },
    };
    await expect(
      executeCommand({
        config,
        store,
        handler: incrementHandler,
        aggregateId: "agg-1",
        input: { amount: 1 },
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
    expect(store.appendCalls).toBe(0); // append 未実行 = 二重 append も partial write も無し
    expect(await inner.load("agg-1")).toHaveLength(0);
  });

  it("CT-EC-16 deterministic handler produces identical events on retry", async () => {
    const store = new FailOnce<CounterEvents>();
    const produced: { amount: number }[][] = [];
    await executeCommand({
      config: counterConfig,
      store,
      handler: (agg, i: { amount: number }) => {
        const events = incrementHandler(agg, i);
        produced.push(events.map((e) => e.data));
        return events;
      },
      aggregateId: "agg-1",
      input: { amount: 9 },
      maxRetries: 3,
    });
    expect(produced).toHaveLength(2);
    expect(produced[0]).toEqual([{ amount: 9 }]);
    expect(produced[1]).toEqual([{ amount: 9 }]);
  });

  it("CT-EC-20 handler が非配列を返す → TypeError (no-op 誤認しない)", async () => {
    const inner = new InMemoryEventStore<CounterEvents>();
    const store = new CountingStore<CounterEvents>(inner);
    for (const bad of [
      { length: 0 },
      { type: "Incremented", data: { amount: 1 } }, // 単一 event オブジェクト
      Promise.resolve([]), // async handler の付け忘れ
    ]) {
      await expect(
        executeCommand({
          config: counterConfig,
          store,
          handler: (() => bad) as never,
          aggregateId: "agg-1",
          input: { amount: 1 },
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(store.appendCalls).toBe(0);
  });

  it("CT-EC-21 handler が data 無し event を返す → TypeError (commit 前)", async () => {
    const inner = new InMemoryEventStore<CounterEvents>();
    const store = new CountingStore<CounterEvents>(inner);
    await expect(
      executeCommand({
        config: counterConfig,
        store,
        handler: (() => [{ type: "Incremented" }]) as never,
        aggregateId: "agg-1",
        input: { amount: 1 },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(store.appendCalls).toBe(0);
  });

  it("CT-EC-22 evolve に undefined が登録された type の emit → missing_evolve_handler (commit 前)", async () => {
    const inner = new InMemoryEventStore<CounterEvents>();
    const store = new CountingStore<CounterEvents>(inner);
    // `{ Incremented: undefined }` のような壊れた登録: hasOwn は true だが callable でない。
    // 旧来の in 判定や hasOwn 単独では「永続化されるが state に反映されない」静かな乖離を
    // 許してしまうため、呼び出し可能であることまでを commit 前に検証する。
    const config = {
      initialState: 0,
      evolve: { Incremented: undefined },
    } as never;
    await expect(
      executeCommand({
        config,
        store,
        handler: incrementHandler,
        aggregateId: "agg-1",
        input: { amount: 1 },
      }),
    ).rejects.toBeInstanceOf(InvalidEventStreamError);
    expect(store.appendCalls).toBe(0);
    expect(await inner.load("agg-1")).toHaveLength(0);
  });

  it("CT-EC-23 EventStore.append が個数違いを返す → TypeError (postcondition)", async () => {
    const store = {
      async load() {
        return [];
      },
      async append(_id: string, events: ReadonlyArray<unknown>) {
        // 契約違反: 入力より少ない件数を返す custom store
        return events.slice(0, events.length - 1) as never;
      },
    };
    await expect(
      executeCommand({
        config: counterConfig,
        store: store as never,
        handler: incrementHandler,
        aggregateId: "agg-1",
        input: { amount: 1 },
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("CT-EC-24 EventStore.load が非配列を返す → TypeError", async () => {
    const store = {
      async load() {
        return { length: 1 } as never;
      },
      async append() {
        return [];
      },
    };
    await expect(
      executeCommand({
        config: counterConfig,
        store: store as never,
        handler: incrementHandler,
        aggregateId: "agg-1",
        input: { amount: 1 },
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("CT-EC-33 EventStore.load が malformed な event (非文字列 type / data 欠落) を返す → TypeError", async () => {
    for (const bad of [
      { aggregateId: "agg-1", version: 1, type: 42, data: {} },
      { aggregateId: "agg-1", version: 1, type: "Incremented" },
    ]) {
      const store = {
        async load() {
          return [bad] as never;
        },
        async append() {
          return [];
        },
      };
      await expect(
        executeCommand({
          config: counterConfig,
          store: store as never,
          handler: incrementHandler,
          aggregateId: "agg-1",
          input: { amount: 1 },
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("CT-EC-32 handler が空文字列 / 欠落の type を返す → TypeError (store 未到達)", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    for (const badType of ["", undefined] as const) {
      await expect(
        executeCommand({
          config: counterConfig,
          store,
          handler: () => [{ type: badType, data: { amount: 1 } }] as never,
          aggregateId: "agg-1",
          input: { amount: 1 },
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(await store.load("agg-1")).toHaveLength(0);
  });

  it("CT-EC-26 retry は stream を再読込し、競合分を含む state と進んだ expectedVersion で append する", async () => {
    // FailOnceAndAdvance: 1 回目の append で他者の書き込み (amount: 10) を commit
    // してから衝突を返す。再 load を省いた退化実装では 2 回目の handler が
    // state=0 / expectedVersion=0 を観測するため検出できる。
    const store = new FailOnceAndAdvance<CounterEvents>([
      { type: "Incremented", data: { amount: 10 } },
    ]);
    const observedStates: number[] = [];
    const res = await executeCommand({
      config: counterConfig,
      store,
      handler: (agg, input: { amount: number }) => {
        observedStates.push(agg.state);
        return incrementHandler(agg, input);
      },
      aggregateId: "agg-1",
      input: { amount: 5 },
      maxRetries: 3,
    });
    expect(store.loadCalls).toBe(2); // 各試行で再 load する
    expect(observedStates).toEqual([0, 10]); // 2 回目は競合イベント込みの state
    expect(store.seenExpectedVersions).toEqual([0, 1]); // 進んだ expectedVersion
    expect(res.aggregate.state).toBe(15);
    expect(res.aggregate.version).toBe(2);
    // 永続化結果: 競合分 + decided 分で 2 件
    expect(await store.inner.load("agg-1")).toHaveLength(2);
  });

  it("CT-EC-27 append が ConcurrencyError 以外を投げる → retry せずそのまま伝播", async () => {
    const inner = new InMemoryEventStore<CounterEvents>();
    let appendCalls = 0;
    const store = {
      load: (id: string) => inner.load(id),
      append: () => {
        appendCalls += 1;
        throw new EventLimitError("agg-1", "exceeds per-batch limit");
      },
    };
    await expect(
      executeCommand({
        config: counterConfig,
        store: store as never,
        handler: incrementHandler,
        aggregateId: "agg-1",
        input: { amount: 1 },
        maxRetries: 3,
      }),
    ).rejects.toBeInstanceOf(EventLimitError);
    expect(appendCalls).toBe(1); // retry 対象外
  });

  it("CT-EC-28 load が ConcurrencyError を投げる → retry せず伝播 (handler / append 未到達)", async () => {
    let handlerCalls = 0;
    let appendCalls = 0;
    const store = {
      load: () => {
        throw new ConcurrencyError("agg-1", 0);
      },
      append: () => {
        appendCalls += 1;
        return [] as never;
      },
    };
    await expect(
      executeCommand({
        config: counterConfig,
        store: store as never,
        handler: (a, i) => {
          handlerCalls += 1;
          return incrementHandler(a, i);
        },
        aggregateId: "agg-1",
        input: { amount: 1 },
        maxRetries: 3,
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
    expect(handlerCalls).toBe(0);
    expect(appendCalls).toBe(0);
  });

  it("CT-EC-29 multi-event batch: decided を順に fold し version は +N・連番で返る", async () => {
    // 非可換な evolve (push) で fold 順を検証する。
    const cfg = {
      initialState: [] as string[],
      evolve: {
        Appended: (s: readonly string[], d: { v: string }) => [...s, d.v],
      },
    };
    const store = new InMemoryEventStore<{ Appended: { v: string } }>();
    const res = await executeCommand({
      config: cfg,
      store,
      handler: () => [
        { type: "Appended", data: { v: "a" } },
        { type: "Appended", data: { v: "b" } },
      ],
      aggregateId: "agg-1",
      input: undefined,
    });
    expect(res.aggregate.state).toEqual(["a", "b"]); // decided 順に fold
    expect(res.aggregate.version).toBe(2);
    expect(res.newEvents.map((e) => e.version)).toEqual([1, 2]);
    expect((await store.load("agg-1")).map((e) => e.version)).toEqual([1, 2]);
  });

  it("CT-EC-30 不純な evolve が data を mutate しても永続化 payload は無傷", async () => {
    const store = new InMemoryEventStore<{ Mutating: { v: number } }>();
    const cfg = {
      initialState: 0,
      evolve: {
        Mutating: (s: number, d: { v: number }) => {
          // evolve は data の clone を受け取るので、ここでの破壊は永続化 payload に波及しない
          (d as { v: number; extra?: boolean }).extra = true;
          return s + d.v;
        },
      },
    };
    const res = await executeCommand({
      config: cfg,
      store,
      handler: () => [{ type: "Mutating", data: { v: 1 } }],
      aggregateId: "agg-1",
      input: undefined,
    });
    expect(res.newEvents[0]?.data).toEqual({ v: 1 });
    expect((await store.load("agg-1"))[0]?.data).toEqual({ v: 1 });
  });

  it("CT-EC-31 EventStore.append の postcondition 違反 → TypeError", async () => {
    const mkStored = (over: Record<string, unknown>) => ({
      type: "Incremented",
      data: { amount: 1 },
      aggregateId: "agg-1",
      version: 1,
      timestamp: new Date().toISOString(),
      ...over,
    });
    const cases: Array<[string, () => unknown]> = [
      ["version ずれ", () => [mkStored({ version: 2 })]],
      ["version 重複", () => [mkStored({ version: 0 })]],
      ["aggregateId 不一致", () => [mkStored({ aggregateId: "other" })]],
      ["非配列", () => ({ length: 1 })],
      ["null 要素", () => [null]],
      ["type 非 string", () => [mkStored({ type: 42 })]],
    ];
    for (const [name, makeResult] of cases) {
      const store = {
        load: () => Promise.resolve([]),
        append: () => Promise.resolve(makeResult()),
      };
      await expect(
        executeCommand({
          config: counterConfig,
          store: store as never,
          handler: incrementHandler,
          aggregateId: "agg-1",
          input: { amount: 1 },
        }),
        name,
      ).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("CT-EC-25 aggregateId / correlationId の契約違反 → TypeError (load 前)", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    await expect(
      executeCommand({
        config: counterConfig,
        store,
        handler: incrementHandler,
        aggregateId: "",
        input: { amount: 1 },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      executeCommand({
        config: counterConfig,
        store,
        handler: incrementHandler,
        aggregateId: "agg-1",
        input: { amount: 1 },
        correlationId: 42 as unknown as string,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("CT-EC-34 malformed config → TypeError (load 前)", async () => {
    const store = new CountingStore<CounterEvents>(new InMemoryEventStore<CounterEvents>());
    for (const bad of [
      null,
      "not-an-object",
      [], // 配列は object だが initialState/evolve を持てない
      { evolve: {} }, // initialState 欠落 → state: undefined の静かな生成を防ぐ
      { initialState: 0 }, // evolve 欠落
      { initialState: 0, evolve: [] }, // 配列 evolve → hasOwn が常に false の静かな退化
      { initialState: 0, evolve: {}, upcast: 42 }, // upcast が非関数
    ]) {
      await expect(
        executeCommand({
          config: bad as never,
          store,
          handler: incrementHandler,
          aggregateId: "agg-1",
          input: { amount: 1 },
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(store.loadCalls).toBe(0);
    expect(store.appendCalls).toBe(0);
  });

  it("CT-EC-34b params 自体が非 object → TypeError (destructure の生 TypeError を防ぐ)", async () => {
    for (const bad of [null, 42, "params", []]) {
      await expect(executeCommand(bad as never)).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("CT-EC-35 malformed 依存 (handler / store / observer / snapshotStore / snapshotPolicy) → TypeError", async () => {
    const store = new CountingStore<CounterEvents>(new InMemoryEventStore<CounterEvents>());
    const base = {
      config: counterConfig,
      store,
      handler: incrementHandler,
      aggregateId: "agg-1",
      input: { amount: 1 },
    };
    const cases: Array<[string, Record<string, unknown>]> = [
      ["handler 非関数", { handler: 42 }],
      ["store が null", { store: null }],
      ["store.load 欠落", { store: { append: async () => [] } }],
      ["store.append 欠落", { store: { load: async () => [] } }],
      // 非 object の observer は `observer?.onX` が全て silent skip になるため弾く。
      // 配列も hook field を持てず同じく silent skip になるため拒否する。
      ["observer が非 object", { observer: 42 }],
      ["observer が null", { observer: null }],
      ["observer が配列", { observer: [] }],
      ["snapshotStore が非 object", { snapshotStore: 42 }],
      ["snapshotStore に load が無い", { snapshotStore: { save: async () => {} } }],
      ["snapshotStore に save が無い", { snapshotStore: { load: async () => null } }],
      // null / 非 object / 配列の snapshotPolicy は `.everyNEvents` アクセスが
      // 生 TypeError または silent skip になるため弾く
      ["snapshotPolicy が null", { snapshotPolicy: null }],
      ["snapshotPolicy が非 object", { snapshotPolicy: 42 }],
      ["snapshotPolicy が配列", { snapshotPolicy: [] }],
    ];
    for (const [name, over] of cases) {
      await expect(executeCommand({ ...base, ...over } as never), name).rejects.toBeInstanceOf(
        TypeError,
      );
    }
    expect(store.loadCalls).toBe(0);
    expect(store.appendCalls).toBe(0);
  });

  it("CT-EC-36 evolve が undefined / Promise を返す → TypeError (commit 前、append 未到達)", async () => {
    const inner = new InMemoryEventStore<CounterEvents>();
    const store = new CountingStore<CounterEvents>(inner);
    for (const badEvolve of [() => undefined, async () => 1]) {
      const config = {
        initialState: 0,
        evolve: { Incremented: badEvolve },
      } as unknown as typeof counterConfig;
      await expect(
        executeCommand({
          config,
          store,
          handler: incrementHandler,
          aggregateId: "agg-1",
          input: { amount: 1 },
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(store.appendCalls).toBe(0);
    expect(await inner.load("agg-1")).toEqual([]);
  });

  it("CT-EC-37 snapshot 発火時に state が非 plain data → commit 前に TypeError (静かな snapshot 欠落を防ぐ)", async () => {
    // state に Date (DEC-011 違反) を混入させる evolve。post-commit の snapshot save は
    // best-effort で失敗を握りつぶすため、commit 前に弾かないと「snapshot が二度と
    // 書かれない」静かな劣化になる。
    type State = { at: unknown };
    const config = {
      initialState: { at: null },
      evolve: { Touched: () => ({ at: new Date(0) }) },
    } as unknown as AggregateConfig<State, { Touched: null }>;
    const inner = new InMemoryEventStore<{ Touched: null }>();
    const snapshots = new InMemorySnapshotStore<State>();
    await expect(
      executeCommand({
        config,
        store: inner,
        handler: () => [{ type: "Touched", data: null }],
        aggregateId: "agg-1",
        input: undefined,
        snapshotStore: snapshots,
        snapshotPolicy: { everyNEvents: 1 },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    // commit 前に弾くため stream も snapshot も空のまま
    expect(await inner.load("agg-1")).toEqual([]);
    expect(await snapshots.load("agg-1")).toBeNull();
  });

  it("CT-EC-38b handler が Proxy の data を返す → TypeError (生 DataCloneError に落とさない)", async () => {
    // Proxy は assertPlainData の検査が target に forward されるため plain-data
    // 検証をすり抜けるが、evolve 用の structuredClone は DataCloneError を投げる。
    // 契約違反 (DEC-011) として TypeError に正規化されることを固定する。
    const proxyData = new Proxy({ amount: 1 }, {});
    const store = new InMemoryEventStore<CounterEvents>();
    await expect(
      executeCommand({
        config: counterConfig,
        store,
        handler: () => [{ type: "Incremented", data: proxyData }],
        aggregateId: "agg-px",
        input: { amount: 1 },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await store.load("agg-px")).toEqual([]);
  });

  it("CT-EC-38a replayed state が非 cloneable → commit 前に TypeError (生 DataCloneError に落とさない)", async () => {
    // evolve が関数を含む state を返すと aggregate.state が非 cloneable になる。
    // updatedState の structuredClone が生 DataCloneError を投げるのを防ぎ、
    // 契約違反 (DEC-011) として TypeError に正規化する。
    const config = {
      initialState: { v: 0 },
      evolve: { Incremented: () => ({ v: 0, fn: () => 1 }) },
    } as unknown as AggregateConfig<{ v: number }, CounterEvents>;
    const store = new InMemoryEventStore<CounterEvents>();
    await store.append("agg-nc", [{ type: "Incremented", data: { amount: 1 } }], 0);
    await expect(
      executeCommand({
        config,
        store,
        handler: () => [{ type: "Incremented", data: { amount: 1 } }],
        aggregateId: "agg-nc",
        input: { amount: 1 },
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("CT-EC-38 custom SnapshotStore が __proto__ key を含む state を返す → 正規化して replay", async () => {
    // DynamoSnapshotStore.load (fromSnapshotItem) と同じ normalizePlainData が
    // custom store の state にも適用されること: own `__proto__` data key は除去され、
    // [[Prototype]] への代入として誤解釈されない。
    const polluted = JSON.parse('{"count": 5, "__proto__": {"polluted": true}}') as {
      count: number;
    };
    const snapshotStore = {
      load: async () => ({
        aggregateId: "agg-pp",
        version: 1,
        state: polluted,
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      save: async () => {},
    };
    type ObjState = { count: number };
    const config = {
      initialState: { count: 0 },
      evolve: {
        Incremented: (s: ObjState, d: { amount: number }) => ({ count: s.count + d.amount }),
      },
    } as AggregateConfig<ObjState, CounterEvents>;
    // snapshot.version=1 と整合するよう stream を version=1 まで seed する
    // (snapshot が stream より進んでいると append が ConcurrencyError になるため)。
    const store = new InMemoryEventStore<CounterEvents>();
    await store.append("agg-pp", [{ type: "Incremented", data: { amount: 5 } }], 0);
    const res = await executeCommand({
      config,
      store,
      handler: (_agg, i: { amount: number }) =>
        i.amount === 0 ? [] : [{ type: "Incremented", data: { amount: i.amount } }],
      aggregateId: "agg-pp",
      input: { amount: 1 },
      snapshotStore: snapshotStore,
    });
    expect(res.aggregate.state).toEqual({ count: 6 });
    // 正規化により own `__proto__` key は保持されない (Dynamo 経路と parity)
    expect(Object.hasOwn(res.aggregate.state, "__proto__")).toBe(false);
  });
});
