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
  it("returns [] when the query response has no Items", async () => {
    const send = vi.fn().mockResolvedValue({});
    const doc = { send } as unknown as DynamoDBDocumentClient;
    const store = new DynamoEventStore<CounterEvents>({ tableName: "t", client: doc });
    expect(await store.load("a-1")).toEqual([]);
  });

  it("preserves a direct Uint8Array inside data", async () => {
    // Uint8Array は受理される plain data。stripProtoKeys は非 plain object 内部を
    // 触らないため、バイナリはそのまま clone されて返る。
    const data = { bin: new Uint8Array([1, 2, 3]) };
    const store = storeReturningItems([{ ...wellFormed, data }]);
    const loaded = await store.load("a-1");
    const out = loaded[0]?.data as unknown as { bin: Uint8Array };
    expect(out.bin).toBeInstanceOf(Uint8Array);
    expect([...out.bin]).toEqual([1, 2, 3]);
  });

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

  it("throws TypeError when data is non-cloneable (function inside)", async () => {
    // synthetic item に関数が混入した場合、生の DataCloneError ではなく
    // envelope 違反の TypeError に揃える (load は fail-loud)。
    const store = storeReturningItems([{ ...wellFormed, data: { cb: () => 1 } }]);
    await expect(store.load("a-1")).rejects.toBeInstanceOf(TypeError);
  });

  it("strips an own __proto__ data key on load (Dynamo would not round-trip it)", async () => {
    // structuredClone は own `__proto__` data key を clone に保持するため、
    // InMemory 経路との parity のため normalizePlainData で除去する。
    const data = JSON.parse('{"amount":5,"__proto__":{"x":9}}') as Record<string, unknown>;
    expect(Object.hasOwn(data, "__proto__")).toBe(true); // 前提: own key として存在
    const store = storeReturningItems([{ ...wellFormed, data }]);
    const loaded = await store.load("a-1");
    const out = loaded[0]?.data as Record<string, unknown>;
    expect(out.amount).toBe(5);
    expect(Object.hasOwn(out, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("drops a non-string correlationId (forged or malformed)", async () => {
    const store = storeReturningItems([{ ...wellFormed, correlationId: 123 }]);
    const loaded = await store.load("a-1");
    expect(Object.hasOwn(loaded[0] ?? {}, "correlationId")).toBe(false);
  });

  it("drops a correlationId reachable only via prototype", async () => {
    const item: Record<string, unknown> = Object.create({ correlationId: "forged" });
    Object.assign(item, { ...wellFormed });
    const store = storeReturningItems([item]);
    const loaded = await store.load("a-1");
    expect(Object.hasOwn(loaded[0] ?? {}, "correlationId")).toBe(false);
  });

  it("throws TypeError when an item is not an object", async () => {
    // mock client 由来の null / primitive item で `Object.hasOwn` の生 TypeError に
    // 落ちないことを確認する (malformed response の fail-loud 化)。
    for (const item of [null, 42, "item"]) {
      const store = storeReturningItems([item as never]);
      await expect(store.load("a-1")).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("throws TypeError when aggregateId is absent / non-string", async () => {
    const { aggregateId: _a, ...noId } = wellFormed;
    for (const item of [noId, { ...wellFormed, aggregateId: 7 }]) {
      const store = storeReturningItems([item]);
      await expect(store.load("a-1")).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("throws TypeError when version is absent / non-number", async () => {
    const { version: _v, ...noVersion } = wellFormed;
    for (const item of [
      noVersion,
      { ...wellFormed, version: "3" },
      { ...wellFormed, version: null },
    ]) {
      const store = storeReturningItems([item]);
      await expect(store.load("a-1")).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("throws TypeError when type or timestamp is absent / non-string", async () => {
    const { type: _t, ...noType } = wellFormed;
    const { timestamp: _ts, ...noTimestamp } = wellFormed;
    for (const item of [
      noType,
      noTimestamp,
      { ...wellFormed, type: 42 },
      { ...wellFormed, timestamp: null },
    ]) {
      const store = storeReturningItems([item]);
      await expect(store.load("a-1")).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("preserves a valid correlationId", async () => {
    const store = storeReturningItems([{ ...wellFormed, correlationId: "corr-9" }]);
    const loaded = await store.load("a-1");
    expect(loaded[0]?.correlationId).toBe("corr-9");
  });

  it("strips own __proto__ keys inside array elements (normalizePlainData array branch)", async () => {
    // stripProtoKeys の配列分岐を通す: data の配列要素内の own __proto__ も除去される。
    const inner = JSON.parse('{"x":1,"__proto__":{"bad":1}}') as Record<string, unknown>;
    const data = { list: [inner] };
    const store = storeReturningItems([{ ...wellFormed, data }]);
    const loaded = await store.load("a-1");
    const out = loaded[0]?.data as unknown as { list: Array<Record<string, unknown>> };
    expect(out.list[0]?.x).toBe(1);
    expect(Object.hasOwn(out.list[0] ?? {}, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(out.list[0])).toBe(Object.prototype);
  });
});
