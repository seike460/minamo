import type { AggregateConfig, CommandHandler } from "../../src/index.js";

/**
 * Counter Aggregate のイベントマップ。
 *
 * concept.md §4 最小コード例に登場する Counter の `Incremented` イベントを
 * そのまま再現する。U3 以降の test 全体で共有するフィクスチャ。
 */
export type CounterEvents = {
  Incremented: { amount: number };
};

/** Counter state: 非負の数値。初期値 0。 */
export type CounterState = number;

/** concept.md §4 最小コード例の Aggregate 定義そのまま。 */
export const counterConfig: AggregateConfig<CounterState, CounterEvents> = {
  initialState: 0,
  evolve: {
    Incremented: (state, data) => state + data.amount,
  },
};

/** concept.md §4 最小コード例の Command Handler。 */
export const incrementHandler: CommandHandler<CounterState, CounterEvents, { amount: number }> = (
  aggregate,
  input,
) => {
  if (input.amount === 0) return [];
  if (aggregate.state + input.amount > 100) {
    throw new Error(
      `Counter cannot exceed 100 (current: ${aggregate.state}, adding: ${input.amount})`,
    );
  }
  return [{ type: "Incremented", data: { amount: input.amount } }];
};
