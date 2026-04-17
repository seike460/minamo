/**
 * Counter Aggregate。multi-aggregate-projection example 内で Wallet と共存する。
 *
 * event 名には Aggregate プレフィックスを付ける (DEC-009)。複数 Aggregate が
 * 同一 DynamoDB テーブル (= Stream) を共有する際に type 名の衝突を避けるため。
 */
import type { AggregateConfig, CommandHandler } from "../../src/index.js";

export type CounterEvents = {
  "Counter.Incremented": { amount: number };
  "Counter.Reset": { reason: string };
};

export type CounterState = number;

export const counterConfig: AggregateConfig<CounterState, CounterEvents> = {
  initialState: 0,
  evolve: {
    "Counter.Incremented": (state, data) => state + data.amount,
    "Counter.Reset": () => 0,
  },
};

export const incrementCounter: CommandHandler<CounterState, CounterEvents, { amount: number }> = (
  _agg,
  input,
) => {
  if (input.amount === 0) return [];
  return [{ type: "Counter.Incremented", data: { amount: input.amount } }];
};
