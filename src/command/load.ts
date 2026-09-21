import type { Aggregate, AggregateConfig } from "../core/aggregate.js";
import type { EventMap } from "../core/types.js";
import type { EventStore } from "../event-store/types.js";
import { clip, hasOwnOrAccessor, isObjectRecord } from "../internal/guards.js";
import { normalizePlainData } from "../internal/plain-data.js";
import type { SnapshotStore } from "../snapshot/types.js";
import { rehydrate, replayEvents } from "./rehydrate.js";

/**
 * load → rehydrate を実行する。snapshotStore があれば snapshot 経路を使い、
 * snapshot 以降のイベントだけを replay して rehydration コストを抑える (DEC-019)。
 *
 * - snapshot 経路: snapshotStore.load → (loadFrom があれば部分ロード、無ければ load 全件 + filter)
 *   → snapshot.state を起点に replay
 * - 非 snapshot 経路: store.load 全件 → rehydrate
 *
 * 返り値 `replayedCount` は実際に replay したイベント数 (observer.onLoaded の eventCount)。
 */
export async function loadAndRehydrate<TState, TMap extends EventMap>(
  config: AggregateConfig<TState, TMap>,
  store: EventStore<TMap>,
  aggregateId: string,
  snapshotStore: SnapshotStore<TState> | undefined,
): Promise<{ aggregate: Aggregate<TState>; replayedCount: number }> {
  if (snapshotStore !== undefined) {
    const snapshot = await snapshotStore.load(aggregateId);
    if (snapshot !== null) {
      // null 以外の非 object (undefined 含む) を返す custom store の契約違反を
      // プロパティアクセスの生 TypeError ではなく明示的に弾く。
      if (!isObjectRecord(snapshot)) {
        throw new TypeError(
          `SnapshotStore.load must return Snapshot | null (got ${
            Array.isArray(snapshot) ? "array" : typeof snapshot
          })`,
        );
      }
      // custom SnapshotStore の契約違反を弾く (strict 方針): 別 aggregate の snapshot や
      // 不正 version を起点に replay すると silent corruption / RetryExhaustedError への
      // 誤分類になる (snapshot が stream より進んでいる破損ケースは append の
      // ConditionCheck が ConcurrencyError として検出する = fail-loud)。
      // 各 field の存在判定は own property か prototype getter (accessor) に限る:
      // `hasOwn` だと `get state()` を持つ class instance の Snapshot (公開型を
      // 満たす v0.2.0 互換の返り値) を拒否し、単純な `in` だと Object.create /
      // `__proto__` 代入で汚染した inherited data property を受理してしまう。
      if (!hasOwnOrAccessor(snapshot, "aggregateId")) {
        throw new TypeError(
          `SnapshotStore.load returned snapshot missing aggregateId for "${aggregateId}"`,
        );
      }
      if (snapshot.aggregateId !== aggregateId) {
        throw new TypeError(
          `SnapshotStore.load returned snapshot for ${clip(snapshot.aggregateId)}, expected ${clip(aggregateId)}`,
        );
      }
      if (!hasOwnOrAccessor(snapshot, "version")) {
        throw new TypeError(
          `SnapshotStore.load returned snapshot missing version for "${aggregateId}"`,
        );
      }
      if (!Number.isInteger(snapshot.version) || snapshot.version < 1) {
        throw new TypeError(
          `SnapshotStore.load returned invalid version ${String(snapshot.version)} for "${aggregateId}"`,
        );
      }
      // state の欠落・undefined は DEC-011 (plain data 制約) 違反として弾く。
      if (!hasOwnOrAccessor(snapshot, "state") || snapshot.state === undefined) {
        throw new TypeError(
          `SnapshotStore.load returned snapshot missing state for "${aggregateId}"`,
        );
      }
      // save 側 (assertSnapshot) と対称に timestamp も検証する。
      if (!hasOwnOrAccessor(snapshot, "timestamp") || typeof snapshot.timestamp !== "string") {
        throw new TypeError(
          `SnapshotStore.load returned snapshot missing string timestamp for "${aggregateId}"`,
        );
      }
      const loaded =
        typeof store.loadFrom === "function"
          ? await store.loadFrom(aggregateId, snapshot.version)
          : await store.load(aggregateId);
      if (!Array.isArray(loaded)) {
        throw new TypeError("EventStore.loadFrom/load must return an array");
      }
      let tail = loaded;
      if (typeof store.loadFrom !== "function") {
        // filter は replayEvents の shape 検証より先に e.version に触れるため、
        // malformed 要素 (null / version 欠落) をここで fail-loud に弾く。
        for (const e of loaded) {
          if (!isObjectRecord(e) || typeof e.version !== "number") {
            throw new TypeError(
              "EventStore.load returned a malformed event (missing numeric version)",
            );
          }
        }
        tail = loaded.filter((e) => e.version > snapshot.version);
      }
      let baseState: TState;
      try {
        // DynamoSnapshotStore.load (fromSnapshotItem) と同じ正規化を custom store の
        // state にも適用する: clone による隔離に加え、own `__proto__` data key を
        // 再帰的に除去して backend 間の parity を保つ (痛み C)。
        baseState = normalizePlainData(snapshot.state) as TState;
      } catch {
        // custom SnapshotStore が非 cloneable な state (関数・Symbol 等) を返した場合、
        // 生の DataCloneError (DOMException) ではなく契約違反として TypeError に正規化する。
        throw new TypeError(
          `SnapshotStore.load returned non-cloneable state for ${clip(aggregateId)}`,
        );
      }
      const aggregate = replayEvents(config, aggregateId, baseState, snapshot.version, tail);
      return { aggregate, replayedCount: tail.length };
    }
  }

  const events = await store.load(aggregateId);
  if (!Array.isArray(events)) {
    throw new TypeError("EventStore.load must return an array");
  }
  return { aggregate: rehydrate(config, aggregateId, events), replayedCount: events.length };
}
