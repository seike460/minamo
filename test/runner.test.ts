import { describe, expect, it } from "vitest";
import type { ExecuteObserver } from "../src/index.js";
import {
  ConcurrencyError,
  createCommandRunner,
  InMemoryEventStore,
  InMemorySnapshotStore,
} from "../src/index.js";
import { type CounterEvents, counterConfig, incrementHandler } from "./fixtures/counter.js";

/**
 * createCommandRunner (concept.md §5.13, DEC-023) — executeCommand の薄いラッパー。
 * config/store の固定、defaults のマージ、呼び出し時引数の優先を検証する。
 */
describe("createCommandRunner", () => {
  it("config/store を固定し handler+aggregateId+input だけで実行できる", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const run = createCommandRunner({ config: counterConfig, store });

    const { aggregate, newEvents } = await run({
      handler: incrementHandler,
      aggregateId: "run-1",
      input: { amount: 5 },
    });

    expect(aggregate.state).toBe(5);
    expect(aggregate.version).toBe(1);
    expect(newEvents).toHaveLength(1);
  });

  it("defaults.observer が呼び出し時 observer 未指定なら使われる", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const committed: number[] = [];
    const observer: ExecuteObserver = {
      onCommitted: (info) => committed.push(info.version),
    };
    const run = createCommandRunner({ config: counterConfig, store, defaults: { observer } });

    await run({ handler: incrementHandler, aggregateId: "run-2", input: { amount: 1 } });
    await run({ handler: incrementHandler, aggregateId: "run-2", input: { amount: 1 } });

    expect(committed).toEqual([1, 2]);
  });

  it("呼び出し時 observer が defaults.observer を上書きする", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const fromDefaults: string[] = [];
    const fromCall: string[] = [];
    const run = createCommandRunner({
      config: counterConfig,
      store,
      defaults: { observer: { onCommitted: () => fromDefaults.push("default") } },
    });

    await run({
      handler: incrementHandler,
      aggregateId: "run-3",
      input: { amount: 1 },
      observer: { onCommitted: () => fromCall.push("call") },
    });

    expect(fromDefaults).toEqual([]); // default は使われない
    expect(fromCall).toEqual(["call"]); // 呼び出し時が優先
  });

  it("connects to the same store across calls (no-op はバージョンを進めない)", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const run = createCommandRunner({ config: counterConfig, store });

    await run({ handler: incrementHandler, aggregateId: "run-4", input: { amount: 3 } });
    const noop = await run({
      handler: incrementHandler,
      aggregateId: "run-4",
      input: { amount: 0 },
    });

    expect(noop.aggregate.version).toBe(1);
    expect(noop.newEvents).toHaveLength(0);
  });

  it("呼び出し時の maxRetries / correlationId が executeCommand へ転送される", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const run = createCommandRunner({ config: counterConfig, store });

    const { newEvents } = await run({
      handler: incrementHandler,
      aggregateId: "run-6",
      input: { amount: 2 },
      maxRetries: 3,
      correlationId: "corr-runner",
    });

    expect(newEvents[0]?.correlationId).toBe("corr-runner");
  });

  it("defaults の snapshotStore/snapshotPolicy が executeCommand へ転送される", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const snapshots = new InMemorySnapshotStore<number>();
    const run = createCommandRunner({
      config: counterConfig,
      store,
      defaults: { snapshotStore: snapshots, snapshotPolicy: { everyNEvents: 1 } },
    });

    await run({ handler: incrementHandler, aggregateId: "run-5", input: { amount: 4 } });

    // everyNEvents: 1 なので v1 で snapshot が保存される → defaults 経由で配線された証拠
    const snap = await snapshots.load("run-5");
    expect(snap?.version).toBe(1);
    expect(snap?.state).toBe(4);
  });

  it("malformed deps → factory 生成時点で TypeError (初回 run() まで持ち越さない)", () => {
    const store = new InMemoryEventStore<CounterEvents>();
    for (const bad of [
      null,
      "deps",
      {}, // config / store 欠落
      { store }, // config 欠落
      { config: counterConfig }, // store 欠落
      { config: counterConfig, store: null },
      { config: counterConfig, store: { load: async () => [] } }, // append 欠落
      { config: { evolve: {} }, store }, // initialState 欠落
    ]) {
      expect(() => createCommandRunner(bad as never)).toThrow(TypeError);
    }
  });

  it("malformed defaults → factory 生成時点で TypeError (silent skip を防ぐ)", () => {
    const store = new InMemoryEventStore<CounterEvents>();
    for (const badDefaults of [
      null,
      42,
      "defaults", // string でも `?.` が silent skip する
      [], // 配列は object だが defaults field を持てない
      { observer: 42 }, // 非 object の observer は全 hook が silent skip になる
      { observer: [] },
      { snapshotStore: { save: async () => {} } }, // load 欠落
      { snapshotPolicy: 42 }, // 非 object の policy は everyNEvents アクセスが生 TypeError
      { snapshotPolicy: [] },
    ]) {
      expect(() =>
        createCommandRunner({ config: counterConfig, store, defaults: badDefaults as never }),
      ).toThrow(TypeError);
    }
  });

  it("defaults.maxRetries の値域違反 → factory 生成時点で RangeError", () => {
    const store = new InMemoryEventStore<CounterEvents>();
    // executeCommand の `maxRetries` 検証 (RangeError) と同じ契約を factory で先に弾く。
    for (const bad of [-1, 1.5, Number.NaN, "3"]) {
      expect(() =>
        createCommandRunner({
          config: counterConfig,
          store,
          defaults: { maxRetries: bad as never },
        }),
      ).toThrow(RangeError);
    }
  });

  it("defaults.snapshotPolicy.everyNEvents の非有限値 → factory 生成時点で TypeError", () => {
    const store = new InMemoryEventStore<CounterEvents>();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "2"]) {
      expect(() =>
        createCommandRunner({
          config: counterConfig,
          store,
          defaults: { snapshotPolicy: { everyNEvents: bad as never } },
        }),
      ).toThrow(TypeError);
    }
  });

  it("defaults.maxRetries が executeCommand へ転送される", async () => {
    // append が必ず衝突する deterministic store: defaults.maxRetries=0 なら
    // 初回試行だけで RetryExhaustedError (attempts=1) になる。forwarding が
    // 効いていなければ default の 3 retry で attempts=4 になるため転送を直接検証できる。
    const conflictingStore = {
      load: async () => [],
      append: async () => {
        throw new ConcurrencyError("run-7", 0);
      },
    };
    const run = createCommandRunner({
      config: counterConfig,
      store: conflictingStore,
      defaults: { maxRetries: 0 },
    });
    await expect(
      run({ handler: incrementHandler, aggregateId: "run-7", input: { amount: 1 } }),
    ).rejects.toMatchObject({ name: "RetryExhaustedError", attempts: 1 });
  });

  it("run() の非 object args → TypeError (silent skip / 生 TypeError を防ぐ)", () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const run = createCommandRunner({ config: counterConfig, store });
    // run は非 async のため sync throw する (await 呼び出し側では同じく捕捉可能)。
    for (const bad of [null, 42, "args", []]) {
      expect(() => run(bad as never)).toThrow(TypeError);
    }
  });
});
