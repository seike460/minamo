import { describe, expect, it } from "vitest";
import type { AggregateConfig, StoredEvent } from "../src/index.js";
import { InvalidEventStreamError, rehydrate } from "../src/index.js";

type CounterState = { value: number };

type CounterEvents = {
  Incremented: { amount: number };
  Reset: { to: number };
};

const counterConfig: AggregateConfig<CounterState, CounterEvents> = {
  initialState: { value: 0 },
  evolve: {
    Incremented: (s, d) => ({ value: s.value + d.amount }),
    Reset: (_s, d) => ({ value: d.to }),
  },
};

function stored<K extends keyof CounterEvents & string>(
  aggregateId: string,
  version: number,
  type: K,
  data: CounterEvents[K],
): StoredEvent<K, CounterEvents[K]> {
  return { aggregateId, version, type, data, timestamp: "2026-04-17T00:00:00.000Z" };
}

describe("rehydrate", () => {
  it("CT-RH-01 empty events returns version=0 Aggregate with cloned initialState", () => {
    const agg = rehydrate(counterConfig, "agg-1", []);
    expect(agg).toEqual({ id: "agg-1", state: { value: 0 }, version: 0 });
    expect(agg.state).not.toBe(counterConfig.initialState);
  });

  it("CT-RH-02 single event evolves state and reports version=1", () => {
    const agg = rehydrate(counterConfig, "agg-1", [
      stored("agg-1", 1, "Incremented", { amount: 5 }),
    ]);
    expect(agg).toEqual({ id: "agg-1", state: { value: 5 }, version: 1 });
  });

  it("CT-RH-03 folds multiple events in order", () => {
    const agg = rehydrate(counterConfig, "agg-1", [
      stored("agg-1", 1, "Incremented", { amount: 1 }),
      stored("agg-1", 2, "Incremented", { amount: 2 }),
      stored("agg-1", 3, "Reset", { to: 100 }),
    ]);
    expect(agg).toEqual({ id: "agg-1", state: { value: 100 }, version: 3 });
  });

  it("CT-RH-04 first event version != 1 throws invalid_initial_version", () => {
    try {
      rehydrate(counterConfig, "agg-1", [stored("agg-1", 2, "Incremented", { amount: 1 })]);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidEventStreamError);
      const e = err as InvalidEventStreamError;
      expect(e.reason).toBe("invalid_initial_version");
      expect(e.details).toEqual({ eventIndex: 0, expectedVersion: 1, actualVersion: 2 });
    }
  });

  it("CT-RH-05 version gap throws version_gap", () => {
    try {
      rehydrate(counterConfig, "agg-1", [
        stored("agg-1", 1, "Incremented", { amount: 1 }),
        stored("agg-1", 3, "Incremented", { amount: 2 }),
      ]);
      expect.fail("expected throw");
    } catch (err) {
      const e = err as InvalidEventStreamError;
      expect(e.reason).toBe("version_gap");
      expect(e.details).toEqual({ eventIndex: 1, expectedVersion: 2, actualVersion: 3 });
    }
  });

  it("CT-RH-06 non-monotonic version throws non_monotonic_version", () => {
    try {
      rehydrate(counterConfig, "agg-1", [
        stored("agg-1", 1, "Incremented", { amount: 1 }),
        stored("agg-1", 1, "Incremented", { amount: 2 }),
      ]);
      expect.fail("expected throw");
    } catch (err) {
      const e = err as InvalidEventStreamError;
      expect(e.reason).toBe("non_monotonic_version");
      expect(e.details).toEqual({ eventIndex: 1, expectedVersion: 2, actualVersion: 1 });
    }
  });

  it("CT-RH-07 aggregateId mismatch throws aggregateId_mismatch", () => {
    try {
      rehydrate(counterConfig, "agg-1", [
        stored("agg-1", 1, "Incremented", { amount: 1 }),
        stored("other", 2, "Incremented", { amount: 2 }),
      ]);
      expect.fail("expected throw");
    } catch (err) {
      const e = err as InvalidEventStreamError;
      expect(e.reason).toBe("aggregateId_mismatch");
      expect(e.details).toEqual({
        eventIndex: 1,
        expectedAggregateId: "agg-1",
        actualAggregateId: "other",
      });
    }
  });

  it("CT-RH-08 unknown event type throws missing_evolve_handler", () => {
    const weird = { ...stored("agg-1", 1, "Incremented", { amount: 1 }), type: "Unknown" };
    try {
      rehydrate(counterConfig, "agg-1", [weird as StoredEvent<"Incremented", { amount: number }>]);
      expect.fail("expected throw");
    } catch (err) {
      const e = err as InvalidEventStreamError;
      expect(e.reason).toBe("missing_evolve_handler");
      expect(e.details).toEqual({ eventIndex: 0, eventType: "Unknown" });
    }
  });

  it("CT-RH-09 initialState with structured-cloneable Date survives structuredClone", () => {
    type StateWithDate = { created: Date; count: number };
    type Ev = { Touched: Record<string, never> };
    const config: AggregateConfig<StateWithDate, Ev> = {
      initialState: { created: new Date("2026-01-01T00:00:00.000Z"), count: 0 },
      evolve: { Touched: (s) => ({ ...s, count: s.count + 1 }) },
    };
    const agg = rehydrate(config, "agg-1", []);
    expect(agg.state.created).toBeInstanceOf(Date);
    expect(agg.state.created).not.toBe(config.initialState.created);
  });

  it("CT-RH-10 initialState with Function throws DataCloneError (structuredClone)", () => {
    type State = { fn: () => number };
    type Ev = Record<string, never>;
    const config = {
      initialState: { fn: () => 1 },
      evolve: {},
    } as unknown as AggregateConfig<State, Ev>;
    expect(() => rehydrate(config, "agg-1", [])).toThrow();
  });

  it("CT-RH-11 aggregateId_mismatch takes precedence over version_gap at same index", () => {
    try {
      rehydrate(counterConfig, "agg-1", [
        stored("agg-1", 1, "Incremented", { amount: 1 }),
        stored("other", 5, "Incremented", { amount: 2 }),
      ]);
      expect.fail("expected throw");
    } catch (err) {
      const e = err as InvalidEventStreamError;
      expect(e.reason).toBe("aggregateId_mismatch");
    }
  });

  it("CT-RH-12 invalid_initial_version takes precedence over aggregateId-match at index 0", () => {
    try {
      rehydrate(counterConfig, "agg-1", [stored("agg-1", 5, "Incremented", { amount: 1 })]);
      expect.fail("expected throw");
    } catch (err) {
      const e = err as InvalidEventStreamError;
      expect(e.reason).toBe("invalid_initial_version");
    }
  });
});
