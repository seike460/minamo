import { beforeEach, describe, expect, it } from "vitest";
import type { SnapshotStore } from "../../src/index.js";

/**
 * SnapshotStore Contract Tests (CT-SS-01〜07)。
 *
 * 単一 suite を InMemorySnapshotStore と DynamoSnapshotStore の両方で実行し、
 * snapshot の save/load 振る舞い一致を構造的に保証する (DEC-019)。
 *
 * 各 test は独立した store を要求する (状態共有させない)。
 */

/** Contract で使う state shape (nested plain data の round-trip 検証用)。 */
export type SnapshotTestState = { count: number; tags: string[] };

export interface SnapshotContractContext {
  readonly label: string;
  readonly makeStore: () => Promise<SnapshotStore<SnapshotTestState>>;
  /**
   * 各 test 実行前に評価する可用性判定。`false` を返したら test を skip する。
   * DynamoDB Local 等の外部依存が無い環境で contract suite が red にならないようにする。
   */
  readonly isAvailable?: () => boolean;
}

export function registerSnapshotStoreContract(ctx: SnapshotContractContext): void {
  const { label, makeStore } = ctx;

  describe(`${label} — SnapshotStore Contract`, () => {
    beforeEach((testCtx) => {
      // backend が到達不能な環境では red ではなく skip に倒す
      if (ctx.isAvailable !== undefined && !ctx.isAvailable()) {
        testCtx.skip();
      }
    });

    it("CT-SS-01 load on a missing aggregate returns null", async () => {
      const store = await makeStore();
      expect(await store.load("ss-missing")).toBeNull();
    });

    it("CT-SS-02 save then load returns the snapshot", async () => {
      const store = await makeStore();
      await store.save({
        aggregateId: "ss-02",
        version: 3,
        state: { count: 3, tags: ["a"] },
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      const loaded = await store.load("ss-02");
      expect(loaded).toEqual({
        aggregateId: "ss-02",
        version: 3,
        state: { count: 3, tags: ["a"] },
        timestamp: "2026-01-01T00:00:00.000Z",
      });
    });

    it("CT-SS-03 save overwrites the previous snapshot for the same aggregateId", async () => {
      const store = await makeStore();
      await store.save({
        aggregateId: "ss-03",
        version: 1,
        state: { count: 1, tags: [] },
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      await store.save({
        aggregateId: "ss-03",
        version: 5,
        state: { count: 5, tags: ["x"] },
        timestamp: "2026-01-01T00:00:05.000Z",
      });
      const loaded = await store.load("ss-03");
      expect(loaded?.version).toBe(5);
      expect(loaded?.state).toEqual({ count: 5, tags: ["x"] });
    });

    it("CT-SS-04 snapshots for different aggregateIds are independent", async () => {
      const store = await makeStore();
      await store.save({
        aggregateId: "ss-04-a",
        version: 2,
        state: { count: 2, tags: ["a"] },
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      await store.save({
        aggregateId: "ss-04-b",
        version: 7,
        state: { count: 7, tags: ["b"] },
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      expect((await store.load("ss-04-a"))?.version).toBe(2);
      expect((await store.load("ss-04-b"))?.version).toBe(7);
    });

    it("CT-SS-05 nested plain-data state round-trips", async () => {
      const store = await makeStore();
      const state = { count: 42, tags: ["x", "y", "z"] };
      await store.save({
        aggregateId: "ss-05",
        version: 10,
        state,
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      const loaded = await store.load("ss-05");
      expect(loaded?.state).toEqual(state);
      // 返り値は live object と切り離されている (mutation が store に波及しない)
      if (loaded) loaded.state.tags.push("mutated");
      expect((await store.load("ss-05"))?.state.tags).toEqual(["x", "y", "z"]);
    });

    it("CT-SS-06 save rejects malformed snapshot envelopes (write-side validation)", async () => {
      const store = await makeStore();
      const base = {
        aggregateId: "ss-06",
        version: 1,
        state: { count: 1, tags: [] },
        timestamp: "2026-01-01T00:00:00.000Z",
      };
      // load 側で弾ける shape を書き込ませない (書いた snapshot は二度と読めない)
      const malformed = [
        { ...base, aggregateId: "" },
        { ...base, version: 0 },
        { ...base, version: 1.5 },
        { ...base, version: Number.NaN },
        { ...base, state: undefined },
        { aggregateId: "ss-06", version: 1, timestamp: base.timestamp }, // state 欠落
        { aggregateId: "ss-06", version: 1, state: base.state }, // timestamp 欠落
      ];
      for (const bad of malformed) {
        await expect(store.save(bad as never)).rejects.toBeInstanceOf(TypeError);
      }
      // reject された save は何も永続化していないこと
      expect(await store.load("ss-06")).toBeNull();
    });

    it("CT-SS-07 load rejects invalid aggregateId", async () => {
      const store = await makeStore();
      await expect(store.load("")).rejects.toBeInstanceOf(TypeError);
    });
  });
}
