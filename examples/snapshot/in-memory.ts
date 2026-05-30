/**
 * Snapshot (concept.md §5.10, DEC-019) + Observability hooks (§5.12, DEC-021)。
 *
 * snapshotPolicy で閾値を跨いだら snapshot を save し、以降の rehydration は snapshot 起点で
 * 短縮される。ExecuteObserver の onLoaded.eventCount で replay 件数の減少を観測する。
 *
 * 実行: `pnpm exec tsx examples/snapshot/in-memory.ts`
 */
import {
  type AggregateConfig,
  type CommandHandler,
  type ExecuteObserver,
  executeCommand,
  InMemoryEventStore,
  InMemorySnapshotStore,
} from "../../src/index.js";

type CounterEvents = { Incremented: { amount: number } };

const counter: AggregateConfig<number, CounterEvents> = {
  initialState: 0,
  evolve: { Incremented: (state, data) => state + data.amount },
};

const increment: CommandHandler<number, CounterEvents, { amount: number }> = (_agg, input) => [
  { type: "Incremented", data: { amount: input.amount } },
];

async function main(): Promise<void> {
  const store = new InMemoryEventStore<CounterEvents>();
  const snapshots = new InMemorySnapshotStore<number>();

  // replay 件数を観測する hook。snapshot 前後で eventCount の変化を見る。
  const observer: ExecuteObserver = {
    onLoaded: (info) =>
      console.log(`  load: replayed ${info.eventCount} event(s), version=${info.version}`),
    onCommitted: (info) => console.log(`  commit: version=${info.version}`),
  };

  // everyNEvents=3: version が 3 の倍数を跨いだら snapshot を save する。
  for (let i = 1; i <= 5; i++) {
    console.log(`command #${i} (amount=10):`);
    await executeCommand({
      config: counter,
      store,
      handler: increment,
      aggregateId: "counter-1",
      input: { amount: 10 },
      snapshotStore: snapshots,
      snapshotPolicy: { everyNEvents: 3 },
      observer,
    });
  }

  const snap = await snapshots.load("counter-1");
  console.log(`\nsnapshot: version=${snap?.version} state=${snap?.state}`);
  // version 3 を跨いだ command #3 で snapshot(v3, state=30) を save。
  // command #4 以降は snapshot 起点で replay 件数が 0,1,... と少なくなる。
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
