import type { Snapshot, SnapshotStore } from "./types.js";

/**
 * テスト用 in-memory SnapshotStore 実装 (concept.md §5.10, DEC-019)。
 *
 * - `save` / `load` ともに `structuredClone` で snapshot を isolation する
 *   （DynamoDB の marshall round-trip と同じく、保存・取得のたびに live object と切り離す）
 * - DynamoSnapshotStore と同じ Contract Tests (`test/contract/snapshot-store.ts`) を通す
 *
 * 本番環境では使わないこと。`clear` はテスト専用。
 *
 * @typeParam TState - Aggregate の状態型 (plain data, DEC-011)。
 */
export class InMemorySnapshotStore<TState> implements SnapshotStore<TState> {
  readonly #snapshots: Map<string, Snapshot<TState>> = new Map();

  async load(aggregateId: string): Promise<Snapshot<TState> | null> {
    const snapshot = this.#snapshots.get(aggregateId);
    return snapshot === undefined ? null : (structuredClone(snapshot) as Snapshot<TState>);
  }

  async save(snapshot: Snapshot<TState>): Promise<void> {
    this.#snapshots.set(snapshot.aggregateId, structuredClone(snapshot) as Snapshot<TState>);
  }

  /** 全 snapshot を初期化する (テスト専用)。 */
  clear(): void {
    this.#snapshots.clear();
  }
}
