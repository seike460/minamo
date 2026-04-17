import { describe, expectTypeOf, it } from "vitest";
import type {
  DomainEvent,
  EventsOf,
  Evolver,
  ReadonlyDeep,
  StoredEvent,
  StoredEventsOf,
} from "../src/index.js";

describe("EventsOf", () => {
  it("produces discriminated union of DomainEvent from EventMap", () => {
    type Map = { A: { x: 1 }; B: { y: 2 } };
    expectTypeOf<EventsOf<Map>>().toEqualTypeOf<
      DomainEvent<"A", { x: 1 }> | DomainEvent<"B", { y: 2 }>
    >();
  });

  it("is never for empty EventMap", () => {
    // biome-ignore lint/complexity/noBannedTypes: test-only empty map
    expectTypeOf<EventsOf<{}>>().toEqualTypeOf<never>();
  });

  it("extracts only string-keyed entries (symbol keys are dropped)", () => {
    const sym: unique symbol = Symbol("x") as never;
    type Map = { A: { x: 1 }; [sym]: { z: 3 } };
    // `[K in keyof TMap & string]` で symbol key は除外される
    type Result = EventsOf<Map>;
    expectTypeOf<Result>().toEqualTypeOf<DomainEvent<"A", { x: 1 }>>();
    void sym;
  });
});

describe("StoredEventsOf", () => {
  it("produces discriminated union of StoredEvent from EventMap", () => {
    type Map = { A: { x: 1 } };
    expectTypeOf<StoredEventsOf<Map>>().toEqualTypeOf<StoredEvent<"A", { x: 1 }>>();
  });

  it("each member carries aggregateId / version / timestamp / optional correlationId", () => {
    type Map = { A: { x: 1 } };
    type M = StoredEventsOf<Map>;
    const sample: M = {
      type: "A",
      data: { x: 1 },
      aggregateId: "agg-1",
      version: 1,
      timestamp: "2026-04-17T00:00:00.000Z",
    };
    expectTypeOf(sample.aggregateId).toEqualTypeOf<string>();
    expectTypeOf(sample.version).toEqualTypeOf<number>();
    expectTypeOf(sample.timestamp).toEqualTypeOf<string>();
    expectTypeOf(sample.correlationId).toEqualTypeOf<string | undefined>();
  });
});

describe("Evolver", () => {
  it("requires a handler for every event type in the EventMap", () => {
    type Map = { Incremented: { amount: number }; Reset: { reason: string } };
    const evolver: Evolver<number, Map> = {
      Incremented: (state, data) => state + data.amount,
      Reset: (_state, _data) => 0,
    };
    expectTypeOf(evolver.Incremented).parameters.toEqualTypeOf<
      [ReadonlyDeep<number>, ReadonlyDeep<{ amount: number }>]
    >();
    expectTypeOf(evolver.Incremented).returns.toEqualTypeOf<number>();
  });

  it("passes ReadonlyDeep state and data to each handler", () => {
    type Map = { Ev: { nested: { x: number[] } } };
    const evolver: Evolver<{ arr: number[] }, Map> = {
      Ev: (state, data) => {
        expectTypeOf(state).toEqualTypeOf<ReadonlyDeep<{ arr: number[] }>>();
        expectTypeOf(data).toEqualTypeOf<ReadonlyDeep<{ nested: { x: number[] } }>>();
        return { arr: [...state.arr, ...data.nested.x] };
      },
    };
    // exercised only at compile time; no runtime assertion needed
    void evolver;
  });

  it("reports compile error for missing handler key", () => {
    type Map = { A: { x: 1 }; B: { y: 2 } };
    // @ts-expect-error — missing handler for "B"
    const bad: Evolver<number, Map> = {
      A: (state, _data) => state,
    };
    void bad;
  });

  it("reports compile error when handler tries to mutate state", () => {
    type Map = { Ev: { x: number } };
    const evolver: Evolver<{ n: number }, Map> = {
      Ev: (state, _data) => {
        // @ts-expect-error — readonly state cannot be mutated
        state.n = 42;
        return { n: state.n };
      },
    };
    void evolver;
  });
});

describe("DomainEvent / StoredEvent defaults", () => {
  it("DomainEvent default generics are string / unknown", () => {
    expectTypeOf<DomainEvent>().toEqualTypeOf<DomainEvent<string, unknown>>();
  });

  it("StoredEvent extends DomainEvent", () => {
    const stored: StoredEvent<"A", { x: number }> = {
      type: "A",
      data: { x: 1 },
      aggregateId: "agg",
      version: 1,
      timestamp: "2026-04-17T00:00:00.000Z",
    };
    const event: DomainEvent<"A", { x: number }> = stored;
    expectTypeOf(event.type).toEqualTypeOf<"A">();
  });
});
