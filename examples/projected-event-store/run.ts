/**
 * projected-event-store example の runnable demo。
 *
 * 実行: `pnpm exec tsx examples/projected-event-store/run.ts`
 * 期待出力:
 *   Counter state after 3 commands: 9
 *   Projection total: 9
 *
 * 学べること:
 *   1. `ProjectedEventStore` Decorator で append → projection を同期連結 (本体に hook を
 *      追加せず、`EventStore<TMap>` を wrap するだけで結合できる)
 *   2. `createCommandRunner` factory で `config` / `store` / `handler` の反復を縮める
 *   3. 本 example の 2 つの util (Decorator / Runner) は minamo 本体に含めず、
 *      consumer が自プロジェクトにコピーして使う想定の recipe
 *
 * production での projection は DynamoDB Streams + Lambda + `parseStreamRecord` 経由で
 * 組むのが正道。本 example は local 開発 / テスト runtime 用の convenience recipe。
 * Streams 経由パターンは `examples/multi-aggregate-projection/` を参照。
 */
import { InMemoryEventStore } from "../../src/index.js";
import { createCommandRunner } from "./command-runner.js";
import { type CounterEvents, counterConfig, incrementCounter } from "./counter.js";
import { ProjectedEventStore } from "./event-store-decorator.js";

async function main(): Promise<void> {
  let projectionTotal = 0;

  const innerStore = new InMemoryEventStore<CounterEvents>();
  const projectedStore = new ProjectedEventStore<CounterEvents>(innerStore, (stored) => {
    for (const event of stored) {
      if (event.type === "Counter.Incremented") {
        projectionTotal += event.data.amount;
      }
    }
  });

  const increment = createCommandRunner(counterConfig, projectedStore, incrementCounter);

  await increment("counter-1", { amount: 4 });
  await increment("counter-1", { amount: 3 });
  const { aggregate } = await increment("counter-1", { amount: 2 });

  console.log(`Counter state after 3 commands: ${aggregate.state}`);
  console.log(`Projection total: ${projectionTotal}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
