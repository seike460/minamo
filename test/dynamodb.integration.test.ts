import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, it } from "vitest";
import { DynamoEventStore } from "../src/index.js";
import { type CounterEvents, registerEventStoreContract } from "./contract/event-store.js";

const TABLE_NAME = "minamo-contract-events";
const ENDPOINT = "http://localhost:8000";

const CLIENT_CONFIG: DynamoDBClientConfig = {
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
};

let control: DynamoDBClient;
let available = false;

async function pingDynamo(): Promise<boolean> {
  const probe = new DynamoDBClient(CLIENT_CONFIG);
  try {
    // DeleteTable on a non-existent table is cheap and returns 400 quickly;
    // the point is only to verify the endpoint is reachable.
    await probe.send(new DeleteTableCommand({ TableName: "__minamo_ping__" }));
    return true;
  } catch (err) {
    if ((err as Error).name === "ResourceNotFoundException") return true;
    return false;
  } finally {
    probe.destroy();
  }
}

beforeAll(async () => {
  available = await pingDynamo();
  if (!available) return;

  control = new DynamoDBClient(CLIENT_CONFIG);

  // 前回実行が afterAll に届かず table が残ったケースに備え、delete → create
  try {
    await control.send(new DeleteTableCommand({ TableName: TABLE_NAME }));
  } catch (err) {
    if ((err as Error).name !== "ResourceNotFoundException") throw err;
  }

  await control.send(
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
});

afterAll(async () => {
  if (!available) return;
  await control.send(new DeleteTableCommand({ TableName: TABLE_NAME }));
  control.destroy();
});

describe("DynamoDB Local availability", () => {
  it.skipIf(!available)("is reachable at http://localhost:8000", () => {
    // the mere invocation of this test confirms beforeAll succeeded
  });
});

/**
 * U4 Contract Tests (CT-01〜13) を DynamoEventStore 対象で実行。
 *
 * 同 aggregateId で append → concurrent write 衝突を避けるため、各 case の
 * `makeStore` は新しい (aggregateId 空間を共有する) store instance を返す。
 * vitest は順次実行で race しないため、case 間の collision は発生しない。
 *
 * Docker の DynamoDB Local が起動していない環境では beforeAll で接続に
 * 失敗するため、CI 以外の local 実行では `test:integration` を起動前に
 * `docker run -p 8000:8000 amazon/dynamodb-local:2.5.4` することが前提。
 */
registerEventStoreContract({
  label: "DynamoEventStore (Local)",
  makeStore: async () =>
    new DynamoEventStore<CounterEvents>({
      tableName: TABLE_NAME,
      clientConfig: CLIENT_CONFIG,
    }),
});
