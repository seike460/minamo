import { describe, expect, it } from "vitest";
import type { SnapshotStore } from "../../src/index.js";
import { invalidInput } from "../invalid-input.js";

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
}

export function registerSnapshotStoreContract(ctx: SnapshotContractContext): void {
  const { label, makeStore } = ctx;

  describe(`${label} — SnapshotStore Contract`, () => {
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
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const malformed = [
        null,
        "not-an-object",
        { ...base, aggregateId: "" },
        { ...base, version: 0 },
        { ...base, version: 1.5 },
        { ...base, version: Number.NaN },
        { ...base, state: undefined },
        { aggregateId: "ss-06", version: 1, timestamp: base.timestamp }, // state 欠落
        { aggregateId: "ss-06", version: 1, state: base.state }, // timestamp 欠落
        // envelope field が prototype 上の data property の場合、structuredClone /
        // marshall が key ごと落とすため、受理すると二度と読めない snapshot になる。
        // inherited data property は欠落として弾く (load 側の accessor 受理とは非対称)。
        Object.create(base), // 全 field が inherited
        Object.assign(Object.create({ aggregateId: "ss-06" }), {
          version: 1,
          state: base.state,
          timestamp: base.timestamp,
        }), // aggregateId のみ inherited (値は読めるが clone 対象外)
        Object.assign(Object.create({ version: 1 }), {
          aggregateId: "ss-06",
          state: base.state,
          timestamp: base.timestamp,
        }), // version のみ inherited
        Object.assign(Object.create({ timestamp: base.timestamp }), {
          aggregateId: "ss-06",
          version: 1,
          state: base.state,
        }), // timestamp のみ inherited
        // state の非 plain data も write 側で弾く (assertPlainData と同じ契約)
        { ...base, state: { at: new Date(0) } },
        { ...base, state: circular },
      ];
      for (const bad of malformed) {
        await expect(store.save(invalidInput(bad))).rejects.toBeInstanceOf(TypeError);
      }
      // reject された save は何も永続化していないこと
      expect(await store.load("ss-06")).toBeNull();
    });

    it("CT-SS-07 load rejects invalid aggregateId", async () => {
      const store = await makeStore();
      await expect(store.load("")).rejects.toBeInstanceOf(TypeError);
    });

    it("CT-SS-08 snapshot の extra attribute も plain data を要求 (backend 間の silent divergence を塞ぐ)", async () => {
      const store = await makeStore();
      const base = {
        aggregateId: "ss-08",
        version: 1,
        state: { count: 1, tags: [] },
        timestamp: "2026-01-01T00:00:00.000Z",
      };
      // plain data の extra key (TTL 用 epoch 等) は受理される。
      // 変数経由なら excess property check が掛からずそのまま渡せる。
      const withTtl = { ...base, ttl: 1735689600 };
      await store.save(withTtl);
      // ただし load は両 store で envelope field のみ返す (fromSnapshotItem parity):
      // extra attribute は保存時に受理されても読み出しでは再構成されない。
      const loaded = await store.load("ss-08");
      expect(loaded).toMatchObject({ aggregateId: "ss-08", version: 1 });
      expect(Object.hasOwn(loaded ?? {}, "ttl")).toBe(false);
      // 非 plain な extra は InMemory では保持され DynamoDB では marshall が
      // 空 object に退化/失敗するため、write 側で統一的に弾く。
      for (const extra of [
        { expiresAt: new Date(0) },
        { meta: new Map([["k", 1]]) },
        { callback: () => 1 },
      ]) {
        await expect(
          store.save(invalidInput({ ...base, ...extra })),
          Object.keys(extra)[0],
        ).rejects.toBeInstanceOf(TypeError);
      }
    });

    it("CT-SS-09 snapshot が Proxy → TypeError (生 DataCloneError に落とさない)", async () => {
      const store = await makeStore();
      // Proxy は assertSnapshot の検査が target に forward されるため plain-data
      // 検証をすり抜けるが、structuredClone は失敗する。両 store で同じ error type
      // (TypeError) に揃える。
      const proxySnapshot = new Proxy(
        {
          aggregateId: "ss-09",
          version: 1,
          state: { count: 1 },
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {},
      );
      await expect(store.save(invalidInput(proxySnapshot))).rejects.toBeInstanceOf(TypeError);
      expect(await store.load("ss-09")).toBeNull();
    });
  });
}
