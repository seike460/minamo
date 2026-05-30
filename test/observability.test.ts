import { describe, expect, it } from "vitest";
import type { ExecuteObserver } from "../src/index.js";
import { executeCommand, InMemoryEventStore } from "../src/index.js";
import { AlwaysFail, FailOnce } from "./doubles/event-store-doubles.js";
import { type CounterEvents, counterConfig, incrementHandler } from "./fixtures/counter.js";

/**
 * ExecuteObserver hooks (concept.md §5.12, DEC-021) の発火条件を deterministic test double で検証する。
 * timing は観測値に含めない設計なので、ここでは発火順序と payload のみを assert する。
 */

/** 各 hook の呼び出しを記録する recording observer を作る。 */
function recordingObserver() {
  const calls: Array<{ hook: string; info: unknown }> = [];
  const observer: ExecuteObserver = {
    onAttempt: (info) => calls.push({ hook: "onAttempt", info }),
    onLoaded: (info) => calls.push({ hook: "onLoaded", info }),
    onConcurrencyConflict: (info) => calls.push({ hook: "onConcurrencyConflict", info }),
    onCommitted: (info) => calls.push({ hook: "onCommitted", info }),
    onRetryExhausted: (info) => calls.push({ hook: "onRetryExhausted", info }),
  };
  return { calls, observer };
}

describe("ExecuteObserver", () => {
  it("成功時に onAttempt → onLoaded → onCommitted を発火する", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const { calls, observer } = recordingObserver();

    await executeCommand({
      config: counterConfig,
      store,
      handler: incrementHandler,
      aggregateId: "obs-1",
      input: { amount: 5 },
      observer,
    });

    expect(calls.map((c) => c.hook)).toEqual(["onAttempt", "onLoaded", "onCommitted"]);
    expect(calls[0]?.info).toEqual({ aggregateId: "obs-1", attempt: 0 });
    expect(calls[1]?.info).toEqual({ aggregateId: "obs-1", eventCount: 0, version: 0 });
    expect(calls[2]?.info).toEqual({ aggregateId: "obs-1", newEventCount: 1, version: 1 });
  });

  it("既存 stream を load したとき onLoaded の eventCount/version が反映される", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    await store.append("obs-2", [{ type: "Incremented", data: { amount: 1 } }], 0);
    const { calls, observer } = recordingObserver();

    await executeCommand({
      config: counterConfig,
      store,
      handler: incrementHandler,
      aggregateId: "obs-2",
      input: { amount: 2 },
      observer,
    });

    expect(calls.find((c) => c.hook === "onLoaded")?.info).toEqual({
      aggregateId: "obs-2",
      eventCount: 1,
      version: 1,
    });
    expect(calls.find((c) => c.hook === "onCommitted")?.info).toEqual({
      aggregateId: "obs-2",
      newEventCount: 1,
      version: 2,
    });
  });

  it("no-op command では onCommitted を発火しない", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const { calls, observer } = recordingObserver();

    await executeCommand({
      config: counterConfig,
      store,
      handler: incrementHandler,
      aggregateId: "obs-3",
      input: { amount: 0 }, // no-op
      observer,
    });

    expect(calls.map((c) => c.hook)).toEqual(["onAttempt", "onLoaded"]);
    expect(calls.some((c) => c.hook === "onCommitted")).toBe(false);
  });

  it("ConcurrencyError → retry 時に onConcurrencyConflict を発火し、再試行後に onCommitted", async () => {
    const store = new FailOnce<CounterEvents>();
    const { calls, observer } = recordingObserver();

    await executeCommand({
      config: counterConfig,
      store,
      handler: incrementHandler,
      aggregateId: "obs-4",
      input: { amount: 3 },
      observer,
    });

    const conflict = calls.find((c) => c.hook === "onConcurrencyConflict");
    expect(conflict?.info).toEqual({ aggregateId: "obs-4", expectedVersion: 0, attempt: 0 });
    // attempt 0 で衝突 → attempt 1 で成功
    expect(calls.filter((c) => c.hook === "onAttempt")).toHaveLength(2);
    expect(calls.some((c) => c.hook === "onCommitted")).toBe(true);
  });

  it("retry 枯渇時に onRetryExhausted を attempts=1+maxRetries で発火する", async () => {
    const store = new AlwaysFail<CounterEvents>();
    const { calls, observer } = recordingObserver();

    await expect(
      executeCommand({
        config: counterConfig,
        store,
        handler: incrementHandler,
        aggregateId: "obs-5",
        input: { amount: 1 },
        maxRetries: 2,
        observer,
      }),
    ).rejects.toThrow();

    expect(calls.filter((c) => c.hook === "onAttempt")).toHaveLength(3); // 1 + maxRetries
    expect(calls.find((c) => c.hook === "onRetryExhausted")?.info).toEqual({
      aggregateId: "obs-5",
      attempts: 3,
    });
  });
});
