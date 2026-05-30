import { describe, expect, it } from "vitest";
import type { ExecuteObserver } from "../src/index.js";
import { createCommandRunner, InMemoryEventStore } from "../src/index.js";
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
});
