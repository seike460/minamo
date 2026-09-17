import { describe, expect, expectTypeOf, it } from "vitest";
import type { EventStore } from "../src/index.js";
import { createEventStoreTable, DynamoEventStore } from "../src/index.js";

/**
 * createEventStoreTable facade (concept.md §5.13, DEC-023)。
 *
 * CFO/CTO dissent gate: `.for<TMap>()` が heterogeneous union ではなく単一 Aggregate の
 * DynamoEventStore<TMap> を返し、per-Aggregate TMap narrowing が保たれることを型レベルで検証する。
 */

type OrderEvents = { Placed: { orderId: string }; Shipped: { trackingId: string } };
type InventoryEvents = { Reserved: { sku: string; qty: number } };

describe("createEventStoreTable", () => {
  it(".for<TMap>() は DynamoEventStore<TMap> のインスタンスを返す", () => {
    const table = createEventStoreTable({
      tableName: "events",
      clientConfig: { region: "local", endpoint: "http://localhost:8000" },
    });

    const orders = table.for<OrderEvents>();
    const inventory = table.for<InventoryEvents>();

    expect(orders).toBeInstanceOf(DynamoEventStore);
    expect(inventory).toBeInstanceOf(DynamoEventStore);
    expect(orders).not.toBe(inventory); // Aggregate ごとに別インスタンス
  });

  it("型レベル: 各 .for<TMap>() が別 TMap に narrow される（union にならない）", () => {
    const table = createEventStoreTable({ tableName: "events", clientConfig: { region: "local" } });

    const orders = table.for<OrderEvents>();
    const inventory = table.for<InventoryEvents>();

    expectTypeOf(orders).toEqualTypeOf<DynamoEventStore<OrderEvents>>();
    expectTypeOf(inventory).toEqualTypeOf<DynamoEventStore<InventoryEvents>>();
    // EventStore<TMap> として扱える（契約一致）
    expectTypeOf(orders).toMatchTypeOf<EventStore<OrderEvents>>();
  });

  it("tableName が不正 → facade 生成時点で TypeError (.for() まで遅延させない)", () => {
    for (const bad of [null, undefined, "", 42]) {
      expect(() =>
        createEventStoreTable({
          tableName: bad,
          clientConfig: { region: "local" },
        } as never),
      ).toThrow(TypeError);
    }
    // config 自体が null/undefined でも同じ TypeError に揃える
    expect(() => createEventStoreTable(null as never)).toThrow(TypeError);
    expect(() => createEventStoreTable(undefined as never)).toThrow(TypeError);
  });
});
