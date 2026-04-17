import { describe, expectTypeOf, it } from "vitest";
import type { Aggregate, AggregateConfig, ReadonlyDeep } from "../src/index.js";

describe("AggregateConfig", () => {
  it("requires initialState as ReadonlyDeep<TState>", () => {
    type Config = AggregateConfig<number, { Incremented: { amount: number } }>;
    expectTypeOf<Config["initialState"]>().toEqualTypeOf<ReadonlyDeep<number>>();
  });

  it("requires evolve handler for every EventMap key", () => {
    type Events = { A: { x: 1 }; B: { y: 2 } };
    const config: AggregateConfig<number, Events> = {
      initialState: 0,
      evolve: {
        A: (state, _data) => state + 1,
        B: (state, _data) => state + 2,
      },
    };
    void config;
  });

  it("reports compile error for missing evolve handler", () => {
    type Events = { A: { x: 1 }; B: { y: 2 } };
    const config: AggregateConfig<number, Events> = {
      initialState: 0,
      // @ts-expect-error — missing handler for "B"
      evolve: {
        A: (state, _data) => state,
      },
    };
    void config;
  });

  it("passes ReadonlyDeep state/data to evolve handlers", () => {
    type Events = { Ev: { items: number[] } };
    const config: AggregateConfig<{ xs: number[] }, Events> = {
      initialState: { xs: [] },
      evolve: {
        Ev: (state, data) => {
          expectTypeOf(state).toEqualTypeOf<ReadonlyDeep<{ xs: number[] }>>();
          expectTypeOf(data).toEqualTypeOf<ReadonlyDeep<{ items: number[] }>>();
          return { xs: [...state.xs, ...data.items] };
        },
      },
    };
    void config;
  });

  it("accepts null / 0 / empty-object as initialState (plain-data primitives)", () => {
    const nullConfig: AggregateConfig<null, { A: { x: 1 } }> = {
      initialState: null,
      evolve: { A: (_s, _d) => null },
    };
    const zero: AggregateConfig<number, { A: { x: 1 } }> = {
      initialState: 0,
      evolve: { A: (s, _d) => s + 1 },
    };
    const empty: AggregateConfig<Record<string, never>, { A: { x: 1 } }> = {
      initialState: {},
      evolve: { A: (_s, _d) => ({}) },
    };
    void nullConfig;
    void zero;
    void empty;
  });
});

describe("Aggregate", () => {
  it("exposes id / state (ReadonlyDeep) / version", () => {
    type A = Aggregate<{ n: number }>;
    expectTypeOf<A["id"]>().toEqualTypeOf<string>();
    expectTypeOf<A["state"]>().toEqualTypeOf<ReadonlyDeep<{ n: number }>>();
    expectTypeOf<A["version"]>().toEqualTypeOf<number>();
  });

  it("narrows state to deep readonly view", () => {
    const agg: Aggregate<{ xs: number[] }> = {
      id: "agg-1",
      state: { xs: [1, 2, 3] },
      version: 3,
    };
    // @ts-expect-error — ReadonlyDeep disallows mutation at compile time
    agg.state.xs.push(4);
    // @ts-expect-error — id is readonly
    agg.id = "other";
    void agg;
  });

  it("allows version = 0 for empty stream (DEC-007)", () => {
    const empty: Aggregate<number> = {
      id: "agg-empty",
      state: 0,
      version: 0,
    };
    expectTypeOf(empty.version).toEqualTypeOf<number>();
  });
});
