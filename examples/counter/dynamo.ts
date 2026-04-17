/**
 * concept.md §4 最小コード例 (DynamoEventStore 版、DynamoDB Local 接続)。
 *
 * 事前準備: `docker run -p 8000:8000 amazon/dynamodb-local:2.5.4`
 * 実行: `pnpm exec tsx examples/counter/dynamo.ts`
 * 期待出力: `counter-dynamo state=3 version=1`
 *
 * テーブルは実行ごとに delete → create する (実行順序不問)。
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  type AggregateConfig,
  type CommandHandler,
  DynamoEventStore,
  executeCommand,
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

const TABLE_NAME = "minamo-example-counter";
const CLIENT_CONFIG: DynamoDBClientConfig = {
  region: "us-east-1",
  endpoint: "http://localhost:8000",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
};

async function ensureTable(): Promise<DynamoDBClient> {
  const client = new DynamoDBClient(CLIENT_CONFIG);
  try {
    await client.send(new DeleteTableCommand({ TableName: TABLE_NAME }));
  } catch (err) {
    if ((err as Error).name !== "ResourceNotFoundException") throw err;
  }
  await client.send(
    new CreateTableCommand({
      TableName: TABLE_NAME,
      KeySchema: [
        { AttributeName: "aggregateId", KeyType: "HASH" },
        { AttributeName: "version", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "aggregateId", AttributeType: "S" },
        { AttributeName: "version", AttributeType: "N" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  return client;
}

async function main(): Promise<void> {
  const control = await ensureTable();
  try {
    const store = new DynamoEventStore<CounterEvents>({
      tableName: TABLE_NAME,
      clientConfig: CLIENT_CONFIG,
    });
    const { aggregate } = await executeCommand({
      config: counter,
      store,
      handler: increment,
      aggregateId: "counter-dynamo",
      input: { amount: 3 },
    });
    console.log(`${aggregate.id} state=${aggregate.state} version=${aggregate.version}`);
  } finally {
    try {
      await control.send(new DeleteTableCommand({ TableName: TABLE_NAME }));
    } finally {
      control.destroy();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
