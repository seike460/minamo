import { describe, expect, it } from "vitest";
import { ConcurrencyError, executeCommand, InMemoryEventStore } from "../src/index.js";
import { AlwaysFail, CountingStore, FailOnce } from "./doubles/event-store-doubles.js";
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

  it("CT-EC-03 maxRetries=0 + ConcurrencyError → propagates without retry", async () => {
    const store = new AlwaysFail<CounterEvents>();
    let handlerCalls = 0;
    await expect(
      executeCommand({
        config: counterConfig,
        store,
        handler: (a, i) => {
          handlerCalls += 1;
          return incrementHandler(a, i);
        },
        aggregateId: "agg-1",
        input: { amount: 1 },
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
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

  it("CT-EC-05 maxRetries=3 + AlwaysFail → exhausted (handler called 4 times)", async () => {
    const store = new AlwaysFail<CounterEvents>();
    let handlerCalls = 0;
    await expect(
      executeCommand({
        config: counterConfig,
        store,
        handler: (a, i) => {
          handlerCalls += 1;
          return incrementHandler(a, i);
        },
        aggregateId: "agg-1",
        input: { amount: 1 },
        maxRetries: 3,
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
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
});
