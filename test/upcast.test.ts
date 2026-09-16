import { describe, expect, it } from "vitest";
import type { AggregateConfig, StoredEvent, Upcaster } from "../src/index.js";
import {
  executeCommand,
  InMemoryEventStore,
  InMemorySnapshotStore,
  InvalidEventStreamError,
  rehydrate,
} from "../src/index.js";

/**
 * upcasting hook (concept.md §5.11, DEC-020) — consumer 所有の transform で旧スキーマイベントを
 * 現行スキーマへ変換し rehydrate できることを検証する。minamo は配線（適用順序）だけを担う。
 */

// 現行スキーマ: "Incremented" のみ。旧スキーマ "Added" を upcast で吸収する。
type CounterEvents = { Incremented: { amount: number } };

/** 旧 "Added"({value}) → 現行 "Incremented"({amount})。メタデータ(aggregateId/version/timestamp)は保持。 */
const upcast: Upcaster<CounterEvents> = (raw) => {
  if (raw.type === "Added") {
    const { value } = raw.data as { value: number };
    return {
      aggregateId: raw.aggregateId,
      version: raw.version,
      timestamp: raw.timestamp,
      type: "Incremented",
      data: { amount: value },
    };
  }
  return raw as StoredEvent<"Incremented", { amount: number }>;
};

const configWithUpcast: AggregateConfig<number, CounterEvents> = {
  initialState: 0,
  evolve: { Incremented: (state, data) => state + data.amount },
  upcast,
};

const configNoUpcast: AggregateConfig<number, CounterEvents> = {
  initialState: 0,
  evolve: { Incremented: (state, data) => state + data.amount },
};

/** 旧スキーマと新スキーマが混在した stream (load が返す形を模擬。型は緩く扱う)。 */
const mixedStream = [
  {
    type: "Added",
    data: { value: 3 },
    aggregateId: "c1",
    version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
  },
  {
    type: "Incremented",
    data: { amount: 2 },
    aggregateId: "c1",
    version: 2,
    timestamp: "2026-01-01T00:00:01.000Z",
  },
] as unknown as ReadonlyArray<StoredEvent<"Incremented", { amount: number }>>;

describe("upcasting (AggregateConfig.upcast)", () => {
  it("旧スキーマイベントを upcast して rehydrate できる", () => {
    const agg = rehydrate(configWithUpcast, "c1", mixedStream);
    expect(agg.state).toBe(5); // Added(3) → Incremented(3), then Incremented(2)
    expect(agg.version).toBe(2);
  });

  it("upcast 未指定なら identity で、未知 type は missing_evolve_handler", () => {
    expect(() => rehydrate(configNoUpcast, "c1", mixedStream)).toThrow(InvalidEventStreamError);
  });

  it("upcast はメタデータ (aggregateId/version) を保持し version 検証を通す", () => {
    // version/aggregateId 検証は upcast 前の raw イベントに対して走る (DEC-020)。
    // upcast がメタデータを保持する限り、変換後のイベントは evolve へ到達する
    const agg = rehydrate(configWithUpcast, "c1", mixedStream);
    expect(agg.id).toBe("c1");
  });

  it("executeCommand の load 経路にも upcast が効く", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    // 旧スキーマイベントを直接 append（cast で legacy を注入）
    await store.append("c1", [{ type: "Added", data: { value: 10 } }] as never, 0);

    const result = await executeCommand({
      config: configWithUpcast,
      store,
      handler: (_agg, input: { amount: number }) => [
        { type: "Incremented", data: { amount: input.amount } },
      ],
      aggregateId: "c1",
      input: { amount: 5 },
    });

    // load → upcast(Added→Incremented=10) → state=10 → +5 → 15
    expect(result.aggregate.state).toBe(15);
    expect(result.aggregate.version).toBe(2);
  });

  it("raw イベントの aggregateId/version は upcast より先に検証される (DEC-020 の適用順序)", () => {
    // aggregateId を「修正」してしまう buggy upcast。spec (§5.11) は
    // 「version/aggregateId 検証の後、evolve/type 検証の前に適用」を固定しているため、
    // 他 aggregate 混入は変換前に aggregateId_mismatch として検出されなければならない。
    const rewritingUpcast: Upcaster<CounterEvents> = (raw) =>
      ({ ...raw, aggregateId: "c1" }) as StoredEvent<"Incremented", { amount: number }>;
    const config: AggregateConfig<number, CounterEvents> = {
      ...configNoUpcast,
      upcast: rewritingUpcast,
    };
    const foreignStream = [
      {
        type: "Incremented",
        data: { amount: 1 },
        aggregateId: "other-agg",
        version: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ] as unknown as ReadonlyArray<StoredEvent<"Incremented", { amount: number }>>;

    const err = (() => {
      try {
        rehydrate(config, "c1", foreignStream);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidEventStreamError);
    expect((err as InvalidEventStreamError).reason).toBe("aggregateId_mismatch");
  });

  it("version_gap は upcast の throw より先に報告される (raw 検証が先行)", () => {
    // gap のある 2 件目でだけ throw する upcast。旧順序 (upcast 一括適用が先)
    // なら "upcast exploded" が、現行順序 (raw 検証が先) なら version_gap が出る。
    const throwingUpcast: Upcaster<CounterEvents> = (raw) => {
      if (raw.version >= 3) throw new Error("upcast exploded");
      return raw as StoredEvent<"Incremented", { amount: number }>;
    };
    const config: AggregateConfig<number, CounterEvents> = {
      ...configNoUpcast,
      upcast: throwingUpcast,
    };
    const gapped = [
      {
        type: "Incremented",
        data: { amount: 1 },
        aggregateId: "c1",
        version: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "Incremented",
        data: { amount: 2 },
        aggregateId: "c1",
        version: 3, // gap (2 が欠落)
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ] as unknown as ReadonlyArray<StoredEvent<"Incremented", { amount: number }>>;

    const err = (() => {
      try {
        rehydrate(config, "c1", gapped);
      } catch (e) {
        return e;
      }
    })();
    // upcast が呼ばれる前に stream 破損を報告する
    expect(err).toBeInstanceOf(InvalidEventStreamError);
    expect((err as InvalidEventStreamError).reason).toBe("version_gap");
  });

  it("Object.prototype 由来の type 名 (toString 等) は missing_evolve_handler で弾く", () => {
    const prototypeNamed = [
      {
        type: "toString",
        data: {},
        aggregateId: "c1",
        version: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ] as unknown as ReadonlyArray<StoredEvent<"Incremented", { amount: number }>>;

    // `in` 演算子は prototype chain を辿り "toString" を素通りさせてしまう。
    // own-property 限定で missing_evolve_handler として fail-loud する。
    const err = (() => {
      try {
        rehydrate(configNoUpcast, "c1", prototypeNamed);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidEventStreamError);
    expect((err as InvalidEventStreamError).reason).toBe("missing_evolve_handler");
  });

  it("stream の malformed 要素 (undefined / null / 非 object) は TypeError で fail-loud", () => {
    for (const bad of [undefined, null, 42] as const) {
      expect(() => rehydrate(configNoUpcast, "c1", [bad] as never)).toThrow(TypeError);
    }
  });

  it("upcast が不正な値を返したら TypeError (consumer の upcast バグを fail-loud)", () => {
    const config: AggregateConfig<number, CounterEvents> = {
      ...configNoUpcast,
      upcast: (() => undefined) as never,
    };
    const valid = [
      {
        type: "Incremented",
        data: { amount: 1 },
        aggregateId: "c1",
        version: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ] as unknown as ReadonlyArray<StoredEvent<"Incremented", { amount: number }>>;
    expect(() => rehydrate(config, "c1", valid)).toThrow(TypeError);
  });

  it("snapshot 経路の tail イベントにも upcast が効く (upcast × snapshot)", async () => {
    const store = new InMemoryEventStore<CounterEvents>();
    const snapshots = new InMemorySnapshotStore<number>();

    // version 1: 現行 "Incremented"(10) を append
    await store.append("c-snap", [{ type: "Incremented", data: { amount: 10 } }], 0);
    // snapshot(version=1, state=10) を保存
    await snapshots.save({
      aggregateId: "c-snap",
      version: 1,
      state: 10,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    // version 2: 旧スキーマ "Added"({value:7}) を tail として append（cast で legacy を注入）
    await store.append("c-snap", [{ type: "Added", data: { value: 7 } }] as never, 1);

    const result = await executeCommand({
      config: configWithUpcast,
      store,
      handler: (_agg, input: { amount: number }) => [
        { type: "Incremented", data: { amount: input.amount } },
      ],
      aggregateId: "c-snap",
      input: { amount: 1 },
      snapshotStore: snapshots,
    });

    // snapshot.state(10) を起点に loadFrom(v1) の tail = [Added(7)] を upcast→Incremented(7) で replay
    // → 17、handler の +1 で 18。snapshot 短絡経路でも upcast 配線が保たれることを確認する。
    expect(result.aggregate.state).toBe(18);
    expect(result.aggregate.version).toBe(3);
  });
});
