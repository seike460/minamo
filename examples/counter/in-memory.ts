/**
 * concept.md §4 最小コード例 (InMemoryEventStore 版)。
 *
 * 実行: `pnpm exec tsx examples/counter/in-memory.ts`
 * 期待出力: `counter-1 state=5 version=1`
 */
import {
  type AggregateConfig,
  type CommandHandler,
  executeCommand,
  InMemoryEventStore,
} from "../../src/index.js";

type CounterEvents = {
  Incremented: { amount: number };
};

const counter: AggregateConfig<number, CounterEvents> = {
  initialState: 0,
  evolve: {
    Incremented: (state, data) => state + data.amount,
  },
};

const increment: CommandHandler<number, CounterEvents, { amount: number }> = (_agg, input) => {
  if (input.amount === 0) return [];
  return [{ type: "Incremented", data: { amount: input.amount } }];
};

async function main(): Promise<void> {
  const store = new InMemoryEventStore<CounterEvents>();
  const { aggregate } = await executeCommand({
    config: counter,
    store,
    handler: increment,
    aggregateId: "counter-1",
    input: { amount: 5 },
  });
  console.log(`${aggregate.id} state=${aggregate.state} version=${aggregate.version}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
