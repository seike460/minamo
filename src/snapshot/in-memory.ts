import { assertAggregateId, assertSnapshot, normalizePlainData } from "../internal/guards.js";
import type { Snapshot, SnapshotStore } from "./types.js";

/**
 * テスト用 in-memory SnapshotStore 実装 (concept.md §5.10, DEC-019)。
 *
 * - `save` / `load` ともに clone で snapshot を isolation する
 *   （DynamoDB の marshall round-trip と同じく、保存・取得のたびに live object と切り離す）
 * - `save` は `normalizePlainData` で `__proto__`・`undefined` 値 key を除去し、
 *   `load` は envelope field のみを再構成して返す (DynamoSnapshotStore の
 *   `fromSnapshotItem` と同じ形 — extra attribute の読み出し差異をなくす parity)
 * - DynamoSnapshotStore と同じ Contract Tests (`test/contract/snapshot-store.ts`) を通す
 *
 * 本番環境では使わないこと。`clear` はテスト専用。
 *
 * @typeParam TState - Aggregate の状態型 (plain data, DEC-011)。
 */
export class InMemorySnapshotStore<TState> implements SnapshotStore<TState> {
  readonly #snapshots: Map<string, Snapshot<TState>> = new Map();

  async load(aggregateId: string): Promise<Snapshot<TState> | null> {
    assertAggregateId(aggregateId);
    const snapshot = this.#snapshots.get(aggregateId);
    if (snapshot === undefined) return null;
    const clone = structuredClone(snapshot) as Snapshot<TState>;
    // fromSnapshotItem (DynamoSnapshotStore.load) は envelope field のみを再構成して
    // 返すため、consumer の extra attribute (TTL 等) はここでも落として parity を取る。
    return {
      aggregateId: clone.aggregateId,
      version: clone.version,
      state: clone.state,
      timestamp: clone.timestamp,
    };
  }

  async save(snapshot: Snapshot<TState>): Promise<void> {
    assertSnapshot(snapshot);
    // Proxy 等の非 cloneable な snapshot (assertPlainData は Proxy を検出できない) を
    // 生の DataCloneError ではなく TypeError に揃える。normalizePlainData で
    // `__proto__`・`undefined` 値 key を除去し、Dynamo 側と同一の永続化形式に揃える。
    let clone: Snapshot<TState>;
    try {
      clone = normalizePlainData(snapshot);
    } catch {
      throw new TypeError("snapshot is not structured-cloneable");
    }
    this.#snapshots.set(snapshot.aggregateId, clone);
  }

  /** 全 snapshot を初期化する (テスト専用)。 */
  clear(): void {
    this.#snapshots.clear();
  }
}
