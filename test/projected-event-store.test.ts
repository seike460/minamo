import { describe, expect, it, vi } from "vitest";
import { createCommandRunner } from "../examples/projected-event-store/command-runner.js";
import {
  type CounterEvents,
  counterConfig,
  incrementCounter,
} from "../examples/projected-event-store/counter.js";
import {
  ProjectedEventStore,
  type ProjectionCallback,
} from "../examples/projected-event-store/event-store-decorator.js";
import {
  ConcurrencyError,
  type EventStore,
  InMemoryEventStore,
  type StoredEventsOf,
} from "../src/index.js";

describe("ProjectedEventStore", () => {
  it("invokes onAppended with stored events after a successful append", async () => {
    const inner = new InMemoryEventStore<CounterEvents>();
    const captured: StoredEventsOf<CounterEvents>[] = [];
    const store = new ProjectedEventStore<CounterEvents>(inner, (stored) => {
      captured.push(...stored);
    });

    const increment = createCommandRunner(counterConfig, store, incrementCounter);
    const { aggregate } = await increment("counter-1", { amount: 5 });

    expect(aggregate.state).toBe(5);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.type).toBe("Counter.Incremented");
    expect(captured[0]?.version).toBe(1);
    expect(captured[0]?.aggregateId).toBe("counter-1");
  });

  it("does not call onAppended when the inner append throws", async () => {
    const throwingInner: EventStore<CounterEvents> = {
      append: () => Promise.reject(new ConcurrencyError("counter-1", 0)),
      load: () => Promise.resolve([]),
    };
    const onAppended = vi.fn<ProjectionCallback<CounterEvents>>();
    const store = new ProjectedEventStore<CounterEvents>(throwingInner, onAppended);

    await expect(
      store.append("counter-1", [{ type: "Counter.Incremented", data: { amount: 1 } }], 0),
    ).rejects.toBeInstanceOf(ConcurrencyError);
    expect(onAppended).not.toHaveBeenCalled();
  });

  it("swallows onAppended errors so projection failure does not roll back the append", async () => {
    const inner = new InMemoryEventStore<CounterEvents>();
    const failing: ProjectionCallback<CounterEvents> = () => {
      throw new Error("projection boom");
    };
    const errors: unknown[] = [];
    const store = new ProjectedEventStore<CounterEvents>(inner, failing, (err) => {
      errors.push(err);
    });

    const stored = await store.append(
      "counter-1",
      [{ type: "Counter.Incremented", data: { amount: 1 } }],
      0,
    );

    expect(stored).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("projection boom");

    const reloaded = await store.load("counter-1");
    expect(reloaded).toHaveLength(1);
  });

  it("guards against onAppendedError itself throwing after a successful append", async () => {
    const inner = new InMemoryEventStore<CounterEvents>();
    const failingProjection: ProjectionCallback<CounterEvents> = () => {
      throw new Error("projection boom");
    };
    const brokenObserver = () => {
      throw new Error("observer boom");
    };
    const store = new ProjectedEventStore<CounterEvents>(inner, failingProjection, brokenObserver);

    const stored = await store.append(
      "counter-1",
      [{ type: "Counter.Incremented", data: { amount: 1 } }],
      0,
    );

    expect(stored).toHaveLength(1);
    const reloaded = await store.load("counter-1");
    expect(reloaded).toHaveLength(1);
  });

  it("delegates load to the inner store", async () => {
    const inner = new InMemoryEventStore<CounterEvents>();
    await inner.append("counter-1", [{ type: "Counter.Incremented", data: { amount: 2 } }], 0);
    const store = new ProjectedEventStore<CounterEvents>(inner, () => {});

    const loaded = await store.load("counter-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.data).toEqual({ amount: 2 });
  });
});

describe("createCommandRunner", () => {
  it("fixes config/store/handler and accepts aggregateId + input per call", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const increment = createCommandRunner(counterConfig, store, incrementCounter);

    const first = await increment("counter-1", { amount: 3 });
    const second = await increment("counter-1", { amount: 4 });

    expect(first.aggregate.state).toBe(3);
    expect(second.aggregate.state).toBe(7);
    expect(second.aggregate.version).toBe(2);
  });

  it("forwards maxRetries and correlationId when provided", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const increment = createCommandRunner(counterConfig, store, incrementCounter);

    const { newEvents } = await increment(
      "counter-1",
      { amount: 1 },
      { correlationId: "corr-123", maxRetries: 0 },
    );

    expect(newEvents[0]?.correlationId).toBe("corr-123");
  });
});
