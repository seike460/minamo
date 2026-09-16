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
});
