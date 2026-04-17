/**
 * Counter Aggregate — projected-event-store example の demo 用。
 *
 * event 名に `Counter.` prefix を付けているのは、共有テーブルで複数 Aggregate が
 * 同居したときの type 名衝突を避ける命名規約。本 example 単独では不要だが、
 * recipe を自プロジェクトに移植する際のテンプレートとしてこの形を採用する。
 */
import type { AggregateConfig, CommandHandler } from "../../src/index.js";

export type CounterEvents = {
  "Counter.Incremented": { amount: number };
};

export type CounterState = number;

export const counterConfig: AggregateConfig<CounterState, CounterEvents> = {
  initialState: 0,
  evolve: {
    "Counter.Incremented": (state, data) => state + data.amount,
  },
};

export const incrementCounter: CommandHandler<CounterState, CounterEvents, { amount: number }> = (
  _agg,
  input,
) => {
  if (input.amount === 0) return [];
  return [{ type: "Counter.Incremented", data: { amount: input.amount } }];
};
