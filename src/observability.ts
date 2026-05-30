/**
 * `executeCommand` の実行ライフサイクルを観測するための optional callback 群 (concept.md §5.12, DEC-021)。
 *
 * 設計原則:
 * - 全 callback は optional・同期・戻り値なし
 * - minamo は特定の telemetry 実装 (OpenTelemetry 等) に依存しない (C2)。consumer が hook を
 *   自身の telemetry へ配線する
 * - timing は consumer が hook の前後で計測する (library 側で `Date.now()` を観測値に含めない =
 *   再試行の決定性に影響を与えない)
 * - callback が throw した場合、`executeCommand` の制御フローを壊さないために throw はそのまま伝播する
 *   （observer の副作用は consumer 責務。hook を安全に保つのは consumer 側の責任）
 *
 * concept.md §8 が監視を推奨する指標 (`ConcurrencyError` 発生率 / retry 枯渇 / rehydration コスト) を
 * emit できるよう設計されている。
 */
export interface ExecuteObserver {
  /** 各試行 (初回 + 各 retry) の開始時。`attempt` は 0 始まり。 */
  onAttempt?(info: { readonly aggregateId: string; readonly attempt: number }): void;
  /**
   * load + rehydrate 完了時。`eventCount` は rehydration コストの proxy
   * (snapshot 経路では snapshot 以降に replay したイベント数)。`version` は rehydrate 後の version。
   */
  onLoaded?(info: {
    readonly aggregateId: string;
    readonly eventCount: number;
    readonly version: number;
  }): void;
  /** append が `ConcurrencyError` で失敗したとき (retry の直前)。 */
  onConcurrencyConflict?(info: {
    readonly aggregateId: string;
    readonly expectedVersion: number;
    readonly attempt: number;
  }): void;
  /** append が成功し state が確定したとき。no-op command (空配列) では呼ばれない。 */
  onCommitted?(info: {
    readonly aggregateId: string;
    readonly newEventCount: number;
    readonly version: number;
  }): void;
  /** `1 + maxRetries` 回の試行でも競合が解消せず `RetryExhaustedError` を throw する直前。 */
  onRetryExhausted?(info: { readonly aggregateId: string; readonly attempts: number }): void;
}
