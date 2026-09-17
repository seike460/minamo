import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoSnapshotStore } from "../src/index.js";

/**
 * DynamoSnapshotStore.load の envelope 検証 (DEC-026, Hybrid: malformed load は throw)。
 *
 * `fromItem`(event) / `parseStreamRecord`(stream) と同じ strict 方針で、取得 item の primary field
 * 欠損・型違反を `TypeError` で弾く。`version` 欠損が `baseVersion + 1 = NaN` のような沈黙した
 * rehydration 破綻になるのを防ぐ。well-formed item の round-trip と正常系は mock client で確認する。
 */
type SnapState = { count: number };

function storeReturning(response: Record<string, unknown>): {
  store: DynamoSnapshotStore<SnapState>;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue(response);
  const doc = { send } as unknown as DynamoDBDocumentClient;
  return {
    store: new DynamoSnapshotStore<SnapState>({ tableName: "t", client: doc }),
    send,
  };
}

const wellFormed = {
  aggregateId: "a-1",
  version: 3,
  state: { count: 3 },
  timestamp: "2026-01-01T00:00:00.000Z",
};

describe("DynamoSnapshotStore.load envelope validation (DEC-026)", () => {
  it("returns null when the item does not exist", async () => {
    const { store } = storeReturning({});
    expect(await store.load("a-1")).toBeNull();
  });

  it("returns the snapshot for a well-formed item", async () => {
    const { store } = storeReturning({ Item: { ...wellFormed } });
    expect(await store.load("a-1")).toEqual(wellFormed);
  });

  it("drops extraneous attributes and returns only the Snapshot envelope", async () => {
    const { store } = storeReturning({
      Item: { ...wellFormed, ttl: 99999, _gsi: "x" },
    });
    const snap = await store.load("a-1");
    expect(Object.keys(snap ?? {}).sort()).toEqual([
      "aggregateId",
      "state",
      "timestamp",
      "version",
    ]);
  });

  it("throws TypeError when the item is not an object", async () => {
    // `Item: null` (mock や非標準 backend 由来) で `Object.hasOwn` の生 TypeError に
    // 落ちないことを確認する。
    for (const item of [null, 42, "item"]) {
      const { store } = storeReturning({ Item: item as never });
      await expect(store.load("a-1")).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("throws TypeError when aggregateId is missing", async () => {
    const { aggregateId: _omit, ...rest } = wellFormed;
    const { store } = storeReturning({ Item: rest });
    await expect(store.load("a-1")).rejects.toBeInstanceOf(TypeError);
  });

  it("throws TypeError when version is non-numeric", async () => {
    const { store } = storeReturning({ Item: { ...wellFormed, version: "3" } });
    await expect(store.load("a-1")).rejects.toBeInstanceOf(TypeError);
  });

  it("throws TypeError when timestamp is missing", async () => {
    const { timestamp: _omit, ...rest } = wellFormed;
    const { store } = storeReturning({ Item: rest });
    await expect(store.load("a-1")).rejects.toBeInstanceOf(TypeError);
  });

  it("throws TypeError when the state attribute is absent", async () => {
    const { state: _omit, ...rest } = wellFormed;
    const { store } = storeReturning({ Item: rest });
    await expect(store.load("a-1")).rejects.toBeInstanceOf(TypeError);
  });

  it.each([0, -1, 1.5])(
    "throws TypeError when version is %s (non-positive/non-integer)",
    async (v) => {
      const { store } = storeReturning({ Item: { ...wellFormed, version: v } });
      await expect(store.load("a-1")).rejects.toBeInstanceOf(TypeError);
    },
  );

  it("rejects fields forged through [[Prototype]] (util-dynamodb __proto__ pollution)", async () => {
    // unmarshall は "__proto__" キーで返り値の [[Prototype]] を汚染する。
    // 必須 field を汚染 prototype 経由で見せかける item は own-property 検査で弾く。
    const proto = { version: 9, aggregateId: "a-1", timestamp: "t" };
    const forged = Object.create(proto) as Record<string, unknown>;
    forged.state = { count: 1 };
    const { store } = storeReturning({ Item: forged });
    await expect(store.load("a-1")).rejects.toBeInstanceOf(TypeError);
  });

  it("normalizes a polluted [[Prototype]] inside state via structuredClone", async () => {
    const state = JSON.parse('{"count":1,"__proto__":{"x":9}}') as SnapState;
    const { store } = storeReturning({ Item: { ...wellFormed, state } });
    const snap = await store.load("a-1");
    // structuredClone + own __proto__ key 除去で正規化されるため、
    // own "__proto__" キーも汚染 prototype も残らない
    expect(snap?.state).toEqual({ count: 1 });
    expect(Object.hasOwn(snap?.state ?? {}, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(snap?.state)).toBe(Object.prototype);
  });

  it("throws TypeError when state is non-cloneable (function inside)", async () => {
    // synthetic item の state に関数が混入した場合、生 DataCloneError ではなく
    // envelope 違反の TypeError に揃える。
    const state = { count: 1, cb: () => 1 } as unknown as SnapState;
    const { store } = storeReturning({ Item: { ...wellFormed, state } });
    await expect(store.load("a-1")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("DynamoSnapshotStore.save", () => {
  it("sends a PutCommand with the snapshot as item", async () => {
    const { store, send } = storeReturning({});
    await store.save({
      aggregateId: "a-1",
      version: 3,
      state: { count: 3 },
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("rejects a malformed snapshot before send (assertSnapshot)", async () => {
    const { store, send } = storeReturning({});
    for (const bad of [
      { version: 3, state: { count: 1 }, timestamp: "t" }, // aggregateId 欠落
      { aggregateId: "a-1", version: 0, state: { count: 1 }, timestamp: "t" }, // version <= 0
      { aggregateId: "a-1", version: 1, timestamp: "t" }, // state 欠落
      { aggregateId: "a-1", version: 1, state: { cb: () => 1 }, timestamp: "t" }, // 非 plain state
    ]) {
      await expect(store.save(bad as never)).rejects.toBeInstanceOf(TypeError);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a Proxy snapshot before send (structuredClone normalized to TypeError)", async () => {
    const { store, send } = storeReturning({});
    // Proxy は assertSnapshot の検査が target に forward されるため plain-data
    // 検証をすり抜けるが、marshall 前の structuredClone は失敗する。生の
    // DataCloneError ではなく TypeError に揃える。
    const proxySnapshot = new Proxy(
      {
        aggregateId: "a-1",
        version: 1,
        state: { count: 1 },
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {},
    );
    await expect(store.save(proxySnapshot as never)).rejects.toBeInstanceOf(TypeError);
    expect(send).not.toHaveBeenCalled();
  });
});
