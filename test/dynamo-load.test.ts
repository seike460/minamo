import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoEventStore } from "../src/index.js";
import type { CounterEvents } from "./fixtures/counter.js";

/**
 * `DynamoEventStore.load` / `loadFrom` の item envelope 検証 (`fromItem`)。
 *
 * mock DocumentClient が返す unmarshalled item を検証対象にする:
 * - 必須 field (aggregateId / version / type / timestamp / data) は own property かつ
 *   型一致を要求する (prototype 経由で供給された偽装 field を弾く)
 * - `version` は整数かつ >= 1
 * - `data` は structuredClone で [[Prototype]] を正規化して返す
 */
function storeReturningItems(items: ReadonlyArray<Record<string, unknown>>) {
  const send = vi.fn().mockResolvedValue({ Items: items });
  const doc = { send } as unknown as DynamoDBDocumentClient;
  return new DynamoEventStore<CounterEvents>({ tableName: "t", client: doc });
}

const wellFormed: Record<string, unknown> = {
  aggregateId: "a-1",
  version: 1,
  type: "Incremented",
  data: { amount: 5 },
  timestamp: "2026-01-01T00:00:00.000Z",
};

describe("DynamoEventStore.load item envelope validation (fromItem)", () => {
  it("returns the stored event for a well-formed item", async () => {
    const store = storeReturningItems([{ ...wellFormed }]);
    const loaded = await store.load("a-1");
    expect(loaded).toEqual([wellFormed]);
  });

  it("throws TypeError when data attribute is absent", async () => {
    const { data: _omit, ...rest } = wellFormed;
    const store = storeReturningItems([rest]);
    await expect(store.load("a-1")).rejects.toBeInstanceOf(TypeError);
  });

  for (const badVersion of [0, 1.5, Number.NaN, -3] as const) {
    it(`throws TypeError when version is ${String(badVersion)}`, async () => {
      const store = storeReturningItems([{ ...wellFormed, version: badVersion }]);
      await expect(store.load("a-1")).rejects.toBeInstanceOf(TypeError);
    });
  }

  it("throws TypeError when required fields are only reachable via a polluted prototype", async () => {
    // util-dynamodb の unmarshall は `"__proto__"` キーを持つ Map で結果 object の
    // [[Prototype]] を汚染する。version を own property として持たず prototype
    // 経由で偽装する item を再現する (Object.prototype は汚さない)。
    const item: Record<string, unknown> = Object.create({ version: 1 });
    Object.assign(item, {
      aggregateId: "a-1",
      type: "Incremented",
      data: { amount: 5 },
      timestamp: "t",
    });
    expect(item.version).toBe(1); // prototype 経由で見える
    expect(Object.hasOwn(item, "version")).toBe(false); // しかし own ではない
    const store = storeReturningItems([item]);
    await expect(store.load("a-1")).rejects.toBeInstanceOf(TypeError);
  });

  it("normalizes a polluted [[Prototype]] inside data via structuredClone", async () => {
    // data のネスト map が汚染された [[Prototype]] を持つ item (unmarshall 産物の再現)。
    const poisonedProto = { injected: "yes" };
    const data: Record<string, unknown> = Object.create(poisonedProto);
    data.amount = 5;
    const store = storeReturningItems([{ ...wellFormed, data }]);
    const loaded = await store.load("a-1");
    // clone 後の data は通常の [[Prototype]] を持ち、汚染 proto 由来のプロパティは
    // 到達不能になる
    const out = loaded[0]?.data as Record<string, unknown>;
    expect(out.amount).toBe(5);
    expect(out.injected).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("loadFrom applies the same envelope validation", async () => {
    const { data: _omit, ...rest } = wellFormed;
    const store = storeReturningItems([rest]);
    await expect(store.loadFrom("a-1", 0)).rejects.toBeInstanceOf(TypeError);
  });
});
