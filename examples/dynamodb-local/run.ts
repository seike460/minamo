/**
 * DynamoEventStore を Docker 上の DynamoDB Local で動かす E2E demo。
 *
 * 事前準備:
 *   docker compose up -d dynamodb
 *
 * 実行:
 *   pnpm exec tsx examples/dynamodb-local/run.ts
 *
 * 期待出力 (末尾 3 行):
 *   appended 3 events for counter-local
 *   loaded 3 events, replayed state=8
 *   append conflict detected (expected): ConcurrencyError
 *
 * テーブルは実行ごとに delete → create される (実行順序不問)。
 */
import {
  type AggregateConfig,
  type CommandHandler,
  ConcurrencyError,
  DynamoEventStore,
  executeCommand,
  rehydrate,
} from "../../src/index.js";
import { createEventTable, dropEventTable, LOCAL_CLIENT_CONFIG } from "./setup.js";

type CounterEvents = {
  "Counter.Incremented": { amount: number };
};

const counter: AggregateConfig<number, CounterEvents> = {
  initialState: 0,
  evolve: {
    "Counter.Incremented": (state, data) => state + data.amount,
  },
};

const increment: CommandHandler<number, CounterEvents, { amount: number }> = (_agg, input) => {
  if (input.amount === 0) return [];
  return [{ type: "Counter.Incremented", data: { amount: input.amount } }];
};

const TABLE_NAME = "minamo-example-dynamodb-local";
const AGG_ID = "counter-local";

async function main(): Promise<void> {
  const control = await createEventTable(TABLE_NAME);
  try {
    const store = new DynamoEventStore<CounterEvents>({
      tableName: TABLE_NAME,
      clientConfig: LOCAL_CLIENT_CONFIG,
    });

    // 1) append (3 commands, 各 1 event)
    for (const amount of [5, 2, 1]) {
      await executeCommand({
        config: counter,
        store,
        handler: increment,
        aggregateId: AGG_ID,
        input: { amount },
      });
    }
    const after = await store.load(AGG_ID);
    console.log(`appended ${after.length} events for ${AGG_ID}`);

    // 2) load → rehydrate で state を復元
    const rehydrated = rehydrate(counter, AGG_ID, after);
    console.log(`loaded ${after.length} events, replayed state=${rehydrated.state}`);

    // 3) 楽観的ロック: 古い expectedVersion で append → ConcurrencyError
    try {
      await store.append(AGG_ID, [{ type: "Counter.Incremented", data: { amount: 99 } }], 0);
    } catch (err) {
      if (err instanceof ConcurrencyError) {
        console.log("append conflict detected (expected): ConcurrencyError");
      } else {
        throw err;
      }
    }
  } finally {
    await dropEventTable(control, TABLE_NAME);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
