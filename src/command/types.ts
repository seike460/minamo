import type { Aggregate } from "../core/aggregate.js";
import type { EventMap, EventsOf } from "../core/types.js";

/**
 * Command の実行結果: 0 個以上の `DomainEvent`。
 *
 * 空配列は no-op (何もしない) を意味し、`executeCommand` では `append` を呼ばない。
 *
 * @typeParam TMap - Aggregate が扱うイベント型マップ。
 */
export type CommandResult<TMap extends EventMap> = ReadonlyArray<EventsOf<TMap>>;

/**
 * Command Handler: 現在の Aggregate と input からイベントを決める同期の純粋関数。
 *
 * - `executeCommand` の再試行で複数回呼ばれうる (DEC-005)
 * - 副作用 (外部 API 呼び出し / I/O) を含めてはならない
 * - 非同期バリデーションが必要な場合は `executeCommand` の外で行い、結果を `input` に含める
 * - ビジネスルール違反時は例外を throw する
 * - 空配列を返すと「何もしない」を意味する (no-op command)
 * - 非決定的要素 (時刻 / UUID 等) は `input` 経由で注入する (DEC-010)
 *
 * 戻り値を同期 `ReadonlyArray` に固定することで、`Promise` を型レベルで排除する。
 *
 * @typeParam TState - Aggregate の状態型。
 * @typeParam TMap - Aggregate が扱うイベント型マップ。
 * @typeParam TInput - Command の入力型。
 */
export type CommandHandler<TState, TMap extends EventMap, TInput> = (
  aggregate: Aggregate<TState>,
  input: TInput,
) => CommandResult<TMap>;
