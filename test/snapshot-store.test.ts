import { describe, expect, it } from "vitest";
import { InMemorySnapshotStore } from "../src/index.js";
import {
  registerSnapshotStoreContract,
  type SnapshotTestState,
} from "./contract/snapshot-store.js";

/**
 * SnapshotStore Contract Tests (CT-SS-01〜07) を InMemorySnapshotStore 対象で実行。
 * DynamoSnapshotStore 側は test/dynamodb.integration.test.ts で同 suite を走らせる。
 */
registerSnapshotStoreContract({
  label: "InMemorySnapshotStore",
  makeStore: async () => new InMemorySnapshotStore<SnapshotTestState>(),
});

describe("InMemorySnapshotStore (test-only helpers)", () => {
  it("clear() removes all snapshots", async () => {
    const store = new InMemorySnapshotStore<SnapshotTestState>();
    await store.save({
      aggregateId: "a",
      version: 1,
      state: { count: 1, tags: [] },
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    store.clear();
    expect(await store.load("a")).toBeNull();
  });
});
