/**
 * 複数 Aggregate を 1 Lambda で route する canonical パターン。
 *
 * DEC-009 (Aggregate プレフィックス命名) + DEC-013 (type-only routing,
 * strict-by-default) の具体実装例。Counter と Wallet が同一テーブル / 同一 Stream
 * を共有するケースを想定し、以下を示す:
 *
 *   1. `eventNamesOf(config)` で Write 側の config から受理する event 名を
 *      型安全に導出する (手書き配列やキャスト不要)
 *   2. `parseStreamRecord(...)` に eventNames を渡し、未知 type を strict/lenient
 *      どちらで扱うかを選択する
 *   3. `storedEvent.type` の literal narrowing で Aggregate 別の projection 関数に
 *      dispatch する
 *
 * 実行: `pnpm exec tsx examples/multi-aggregate-projection/projection-handler.ts`
 * 期待出力:
 *   Counter state after replay: 8
 *   Wallet balance after replay: 1200 JPY
 */
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  eventNamesOf,
  executeCommand,
  InMemoryEventStore,
  parseStreamRecord,
  type StoredEvent,
} from "../../src/index.js";
import { type CounterEvents, counterConfig, incrementCounter } from "./counter.js";
import { creditWallet, type WalletEvents, walletConfig } from "./wallet.js";

type AllEvents = CounterEvents & WalletEvents;
type AllEventName = keyof AllEvents & string;

// projection side state (consumer が read model として管理する)
let counterProjection = 0;
let walletBalance = 0;
let walletCurrency = "JPY";

function applyToProjection(stored: StoredEvent<AllEventName, unknown>): void {
  switch (stored.type) {
    case "Counter.Incremented": {
      const data = stored.data as AllEvents["Counter.Incremented"];
      counterProjection += data.amount;
      return;
    }
    case "Counter.Reset": {
      counterProjection = 0;
      return;
    }
    case "Wallet.Credited": {
      const data = stored.data as AllEvents["Wallet.Credited"];
      walletBalance += data.amount;
      walletCurrency = data.currency;
      return;
    }
    case "Wallet.Debited": {
      const data = stored.data as AllEvents["Wallet.Debited"];
      walletBalance -= data.amount;
      walletCurrency = data.currency;
      return;
    }
    default: {
      // exhaustiveness check — 新しい event 型を追加したら type error になる
      const _exhaustive: never = stored.type;
      throw new Error(`unexpected event type: ${_exhaustive as string}`);
    }
  }
}

/**
 * Lambda handler の雛形 (DynamoDBStreamEvent に相当)。
 *
 * `@types/aws-lambda` に依存せず `record: unknown` で受ける。型は
 * parseStreamRecord 側で narrow される (U9 design §4)。
 */
function projectionHandler(records: ReadonlyArray<unknown>, opts: { lenient: boolean }): void {
  // Write 側 config から event 名を合成 (DRY、キャスト不要)
  const counterNames = eventNamesOf(counterConfig);
  const walletNames = eventNamesOf(walletConfig);
  const allNames: ReadonlyArray<AllEventName> = [...counterNames, ...walletNames];

  for (const record of records) {
    const stored = parseStreamRecord<AllEvents>(record, allNames, {
      ignoreUnknownTypes: opts.lenient,
    });
    if (stored === null) {
      // MODIFY / REMOVE / (lenient モード時の) 未登録 type は null で安全に skip
      continue;
    }
    applyToProjection(stored);
  }
}

/**
 * demo: InMemoryEventStore を使って append → 手組みの Stream レコードで handler
 * を駆動する。本番では DynamoEventStore + DynamoDB Streams + Lambda Event Source
 * Mapping が handler を自動起動する。
 */
async function main(): Promise<void> {
  const counterStore = new InMemoryEventStore<CounterEvents>();
  const walletStore = new InMemoryEventStore<WalletEvents>();

  await executeCommand({
    config: counterConfig,
    store: counterStore,
    handler: incrementCounter,
    aggregateId: "counter-A",
    input: { amount: 5 },
  });
  await executeCommand({
    config: counterConfig,
    store: counterStore,
    handler: incrementCounter,
    aggregateId: "counter-A",
    input: { amount: 3 },
  });
  await executeCommand({
    config: walletConfig,
    store: walletStore,
    handler: creditWallet,
    aggregateId: "wallet-B",
    input: { amount: 1200, currency: "JPY" },
  });

  // Stream record を DynamoDB Streams INSERT レコード互換の shape で構築する。
  // 本番では Event Source Mapping から渡される record をそのまま parseStreamRecord に渡す。
  const insertRecord = (stored: {
    type: string;
    data: unknown;
    aggregateId: string;
    version: number;
    timestamp: string;
    correlationId?: string;
  }) => ({
    eventID: `${stored.aggregateId}-${stored.version}`,
    eventName: "INSERT",
    dynamodb: {
      // `@aws-sdk/util-dynamodb` の marshall で JS object を AttributeValue 化。
      // 本番では Event Source Mapping が同じ shape で record を渡してくる。
      NewImage: marshall({
        aggregateId: stored.aggregateId,
        version: stored.version,
        type: stored.type,
        data: stored.data,
        timestamp: stored.timestamp,
        ...(stored.correlationId ? { correlationId: stored.correlationId } : {}),
      }),
    },
  });

  const records: unknown[] = [
    ...counterStore.allEvents().map((e) =>
      insertRecord({
        type: e.type,
        data: e.data,
        aggregateId: e.aggregateId,
        version: e.version,
        timestamp: e.timestamp,
      }),
    ),
    ...walletStore.allEvents().map((e) =>
      insertRecord({
        type: e.type,
        data: e.data,
        aggregateId: e.aggregateId,
        version: e.version,
        timestamp: e.timestamp,
      }),
    ),
    // 第三者 Aggregate の event が同一 Stream に来るケース (未登録 type)
    insertRecord({
      type: "Unknown.Event",
      data: { note: "some other aggregate" },
      aggregateId: "other-C",
      version: 1,
      timestamp: new Date().toISOString(),
    }),
    // DynamoDB Streams 仕様の MODIFY/REMOVE は parseStreamRecord が null を返し無視する
    { eventName: "MODIFY", dynamodb: { NewImage: {} } },
  ];

  // 本例では unknown type を silently skip したい (複数 Aggregate 共有テーブル運用)
  projectionHandler(records, { lenient: true });

  console.log(`Counter state after replay: ${counterProjection}`);
  console.log(`Wallet balance after replay: ${walletBalance} ${walletCurrency}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
