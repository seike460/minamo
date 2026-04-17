import { describe, expect, expectTypeOf, it } from "vitest";
import type { Aggregate, CommandHandler, CommandResult, DomainEvent } from "../src/index.js";
import { type CounterEvents, counterConfig, incrementHandler } from "./fixtures/counter.js";

describe("CommandHandler type", () => {
  it("resolves to sync (aggregate, input) => readonly event union", () => {
    type H = CommandHandler<number, CounterEvents, { amount: number }>;
    expectTypeOf<H>().parameters.toEqualTypeOf<[Aggregate<number>, { amount: number }]>();
    expectTypeOf<H>().returns.toEqualTypeOf<
      ReadonlyArray<DomainEvent<"Incremented", { amount: number }>>
    >();
  });

  it("rejects async handler at compile time", () => {
    type H = CommandHandler<number, CounterEvents, { amount: number }>;
    const asyncImpl = async (_aggregate: Aggregate<number>, _input: { amount: number }) => [];
    // @ts-expect-error — Promise return is not assignable to sync CommandResult
    const bad: H = asyncImpl;
    void bad;
  });

  it("rejects state mutation inside handler", () => {
    type State = { n: number };
    type Events = { A: { x: 1 } };
    const handler: CommandHandler<State, Events, { x: 1 }> = (aggregate, _input) => {
      // @ts-expect-error — aggregate.state is ReadonlyDeep
      aggregate.state.n = 5;
      return [];
    };
    void handler;
  });
});

describe("CommandResult type", () => {
  it("is discriminated union over EventMap", () => {
    type R = CommandResult<{ A: { x: 1 }; B: { y: 2 } }>;
    expectTypeOf<R>().toEqualTypeOf<
      ReadonlyArray<DomainEvent<"A", { x: 1 }> | DomainEvent<"B", { y: 2 }>>
    >();
  });

  it("reduces to readonly never[] for empty EventMap", () => {
    // biome-ignore lint/complexity/noBannedTypes: test-only empty map
    type R = CommandResult<{}>;
    expectTypeOf<R>().toEqualTypeOf<ReadonlyArray<never>>();
  });
});

describe("counter fixture (concept.md §4 最小コード例)", () => {
  it("incrementHandler returns [] when amount=0 (no-op)", () => {
    const aggregate: Aggregate<number> = { id: "c-1", state: 5, version: 1 };
    const events = incrementHandler(aggregate, { amount: 0 });
    expect(events).toEqual([]);
  });

  it("incrementHandler returns Incremented event when amount>0 and within cap", () => {
    const aggregate: Aggregate<number> = { id: "c-1", state: 5, version: 1 };
    const events = incrementHandler(aggregate, { amount: 10 });
    expect(events).toHaveLength(1);
    const [head] = events;
    expect(head).toEqual({ type: "Incremented", data: { amount: 10 } });
  });

  it("incrementHandler throws when state + amount exceeds 100", () => {
    const aggregate: Aggregate<number> = { id: "c-1", state: 95, version: 5 };
    expect(() => incrementHandler(aggregate, { amount: 10 })).toThrow(/cannot exceed 100/);
  });

  it("counterConfig.evolve['Incremented'] is pure state + amount", () => {
    const next = counterConfig.evolve.Incremented(5, { amount: 10 });
    expect(next).toBe(15);
  });
});
