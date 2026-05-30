/**
 * Snapshot 機構の型定義 (concept.md §5.10, DEC-019)。
 *
 * Snapshot は EventStore とは独立した interface であり、`executeCommand` に渡したときのみ
 * snapshot 経路が有効になる。EventStore の最小契約 (DEC-006) を汚さないための分離。
 */

/**
 * Aggregate 状態の Snapshot。
 *
 * `state` は plain data (DEC-011: structured-cloneable かつ DynamoDB marshallable)。
 * `version` は snapshot に含まれる最後のイベントの version を表す (この version までの状態)。
 *
 * @typeParam TState - Aggregate の状態型。
 */
export interface Snapshot<TState> {
  /** 対象 Aggregate の ID。 */
  readonly aggregateId: string;
  /** snapshot が反映している最後のイベントの version (0 はあり得ない: 空ストリームは snapshot しない)。 */
  readonly version: number;
  /** version までを反映した状態 (plain data)。 */
  readonly state: TState;
  /** snapshot 作成時の ISO 8601 UTC timestamp。 */
  readonly timestamp: string;
}

/**
 * Snapshot の永続化と読み込みの契約。EventStore とは独立 (DEC-019)。
 *
 * @typeParam TState - Aggregate の状態型。
 */
export interface SnapshotStore<TState> {
  /** aggregateId の最新 snapshot を返す。無ければ null。 */
  load(aggregateId: string): Promise<Snapshot<TState> | null>;
  /** snapshot を保存する。同一 aggregateId の既存 snapshot は上書きしてよい。 */
  save(snapshot: Snapshot<TState>): Promise<void>;
}

/**
 * append 成功後に snapshot を save するかを決める閾値ポリシー。
 *
 * minamo は閾値を強制せず、consumer が指定した policy に従うだけ (DEC-019, CTO dissent への折衷)。
 */
export interface SnapshotPolicy {
  /**
   * append 後の version がこの倍数を「跨いだ」ら save する。
   * 例: `everyNEvents: 100` のとき、append で version が 98 → 101 に進んだら save (100 を跨いだ)。
   * 1 未満は無効 (save しない)。
   */
  readonly everyNEvents: number;
}
