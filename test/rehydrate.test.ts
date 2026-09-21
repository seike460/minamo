import { describe, expect, it } from "vitest";
import type { AggregateConfig, StoredEvent } from "../src/index.js";
import { InvalidEventStreamError, rehydrate } from "../src/index.js";
import { invalidInput } from "./invalid-input.js";

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

/** caught error を InvalidEventStreamError に narrow する (cast ではなく検査)。 */
function assertInvalidStreamError(err: unknown): InvalidEventStreamError {
  if (!(err instanceof InvalidEventStreamError)) throw err;
  return err;
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
      const e = assertInvalidStreamError(err);
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
      const e = assertInvalidStreamError(err);
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
      const e = assertInvalidStreamError(err);
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
      const e = assertInvalidStreamError(err);
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
      rehydrate(counterConfig, "agg-1", [
        invalidInput<StoredEvent<"Incremented", { amount: number }>>(weird),
      ]);
      expect.fail("expected throw");
    } catch (err) {
      const e = assertInvalidStreamError(err);
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

  it("CT-RH-10 initialState with Function throws TypeError (非 cloneable は契約違反に正規化)", () => {
    type State = { fn: () => number };
    type Ev = Record<string, never>;
    const config = invalidInput<AggregateConfig<State, Ev>>({
      initialState: { fn: () => 1 },
      evolve: {},
    });
    // 生の DataCloneError (DOMException) ではなく TypeError に揃える
    expect(() => rehydrate(config, "agg-1", [])).toThrow(TypeError);
    expect(() => rehydrate(config, "agg-1", [])).toThrow(/structured-cloneable/);
  });

  it("CT-RH-11 aggregateId_mismatch takes precedence over version_gap at same index", () => {
    try {
      rehydrate(counterConfig, "agg-1", [
        stored("agg-1", 1, "Incremented", { amount: 1 }),
        stored("other", 5, "Incremented", { amount: 2 }),
      ]);
      expect.fail("expected throw");
    } catch (err) {
      const e = assertInvalidStreamError(err);
      expect(e.reason).toBe("aggregateId_mismatch");
    }
  });

  it("CT-RH-12 invalid_initial_version takes precedence over aggregateId-match at index 0", () => {
    try {
      rehydrate(counterConfig, "agg-1", [stored("agg-1", 5, "Incremented", { amount: 1 })]);
      expect.fail("expected throw");
    } catch (err) {
      const e = assertInvalidStreamError(err);
      expect(e.reason).toBe("invalid_initial_version");
    }
  });

  it("CT-RH-13 non-array events input throws TypeError", () => {
    expect(() => rehydrate(counterConfig, "agg-1", invalidInput("not-an-array"))).toThrow(
      TypeError,
    );
  });

  it("CT-RH-14 malformed config → TypeError (静かな state: undefined / 生 TypeError を防ぐ)", () => {
    // initialState 欠落: structuredClone(undefined) は undefined を返すため、
    // 検証がないと state: undefined の Aggregate が静かに生成されてしまう。
    for (const bad of [
      null,
      "not-an-object",
      [], // 配列は object だが initialState/evolve を持てない
      { evolve: {} }, // initialState 欠落
      { initialState: undefined, evolve: {} }, // explicit undefined も不可
      { initialState: 0 }, // evolve 欠落
      { initialState: 0, evolve: null }, // evolve が非 object
      { initialState: 0, evolve: [] }, // 配列 evolve は hasOwn が常に false で退化する
      { initialState: 0, evolve: {}, upcast: "not-a-function" }, // upcast が非関数
    ]) {
      expect(() => rehydrate(invalidInput(bad), "agg-1", [])).toThrow(TypeError);
    }
  });

  it("CT-RH-14b initialState の存在判定: class getter は受理、inherited data property は拒否", () => {
    // `get initialState()` を prototype に持つ class config は v0.2.0 互換で受理する
    // (own property 限定の hasOwn だと拒否してしまう)。
    class GetterConfig {
      get initialState(): CounterState {
        return { value: 100 };
      }
      readonly evolve = counterConfig.evolve;
    }
    const agg = rehydrate(new GetterConfig(), "agg-1", []);
    expect(agg.state).toEqual({ value: 100 });

    // `Object.create` / `__proto__` 代入で inherited data property として供給した
    // initialState は prototype 汚染の経路になるため拒否する。
    const viaCreate = Object.assign(Object.create({ initialState: { value: 0 } }), {
      evolve: counterConfig.evolve,
    });
    const viaProto = { evolve: counterConfig.evolve };
    Object.setPrototypeOf(viaProto, { initialState: { value: 0 } });
    for (const polluted of [viaCreate, viaProto]) {
      expect(() => rehydrate(invalidInput(polluted), "agg-1", [])).toThrow(TypeError);
    }

    // `Object.prototype.get` を callable に汚染しても inherited data property は拒否
    // (descriptor の `get` 参照が prototype を辿る迂回を防ぐ)。
    // 汚染中は ToPropertyDescriptor が `desc.get` を継承まで読むため
    // `Object.defineProperty` が全て壊れる — expect() 等の assertion 機構を
    // 巻き込まないよう、汚染ウィンドウ内では SUT を素の try/catch で叩く。
    const originalGet = Object.getOwnPropertyDescriptor(Object.prototype, "get");
    Object.defineProperty(Object.prototype, "get", {
      value: () => {},
      writable: true,
      configurable: true,
    });
    let pollutedError: unknown;
    try {
      rehydrate(invalidInput(viaCreate), "agg-1", []);
    } catch (e) {
      pollutedError = e;
    } finally {
      if (originalGet === undefined) {
        Reflect.deleteProperty(Object.prototype, "get");
      } else {
        Object.defineProperty(Object.prototype, "get", originalGet);
      }
    }
    expect(pollutedError).toBeInstanceOf(TypeError);
  });

  it("CT-RH-15 evolve が undefined / Promise を返す → TypeError (state の静かな破綻を防ぐ)", () => {
    // `return` 忘れや async evolve の付け忘れは `state: undefined` / `state` が
    // Promise になる静かな破綻を生む。evolve の同期純粋関数契約の違反を弾く。
    const undefinedEvolve = invalidInput<AggregateConfig<number, CounterEvents>>({
      initialState: 0,
      evolve: { Incremented: () => undefined },
    });
    const asyncEvolve = invalidInput<AggregateConfig<number, CounterEvents>>({
      initialState: 0,
      evolve: { Incremented: async () => 1 },
    });
    const events = [stored("agg-1", 1, "Incremented", { amount: 1 })];
    for (const bad of [undefinedEvolve, asyncEvolve]) {
      expect(() => rehydrate(bad, "agg-1", events)).toThrow(TypeError);
    }
  });

  it("CT-RH-16 非 object の event 要素 (null / primitive / 配列) → TypeError", () => {
    // 配列・primitive の要素は `raw.aggregateId` の生アクセスや誤った error class
    // (InvalidEventStreamError) に落ちる前に shape 違反として弾く。
    for (const bad of [null, 42, "event", []]) {
      expect(() => rehydrate(counterConfig, "agg-1", invalidInput([bad]))).toThrow(TypeError);
    }
  });
});
