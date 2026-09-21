import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  type DynamoDBClientConfig,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll } from "vitest";
import { DynamoEventStore, DynamoSnapshotStore } from "../src/index.js";
import { type CounterEvents, registerEventStoreContract } from "./contract/event-store.js";
import { registerEventStoreValidationContract } from "./contract/event-store-validation.js";
import {
  registerSnapshotStoreContract,
  type SnapshotTestState,
} from "./contract/snapshot-store.js";

const TABLE_NAME = "minamo-contract-events";
const SNAPSHOT_TABLE_NAME = "minamo-contract-snapshots";

// DynamoDB Local は credentials を検証しないため dummy 固定値でよい。
// LocalStack 等 credentials が要る向き先では env で上書きする (setup.ts と同じ方針)。
const CLIENT_CONFIG: DynamoDBClientConfig = {
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "dummy",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "dummy",
  },
};

let control: DynamoDBClient | undefined;

// `test:integration` は backend 必須の明示コマンド。endpoint が到達不能なら
// ここで throw して suite 全体を fail にする (contract を一件も実行せず
// green になる経路は作らない)。
beforeAll(async () => {
  control = new DynamoDBClient(CLIENT_CONFIG);

  // 前回実行が afterAll に届かず table が残ったケースに備え、delete → create
  try {
    await control.send(new DeleteTableCommand({ TableName: TABLE_NAME }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
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

  // Snapshot table: PK=aggregateId のみ (1 aggregate につき 1 snapshot を上書き)
  try {
    await control.send(new DeleteTableCommand({ TableName: SNAPSHOT_TABLE_NAME }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
  await control.send(
    new CreateTableCommand({
      TableName: SNAPSHOT_TABLE_NAME,
      KeySchema: [{ AttributeName: "aggregateId", KeyType: "HASH" }],
      AttributeDefinitions: [{ AttributeName: "aggregateId", AttributeType: "S" }],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
});

afterAll(async () => {
  if (control === undefined) return;
  await control.send(new DeleteTableCommand({ TableName: TABLE_NAME }));
  await control.send(new DeleteTableCommand({ TableName: SNAPSHOT_TABLE_NAME }));
  control.destroy();
});

/**
 * U4 Contract Tests (CT-01〜22) を DynamoEventStore 対象で実行。
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
registerEventStoreValidationContract({
  label: "DynamoEventStore (Local)",
  makeStore: async () =>
    new DynamoEventStore<CounterEvents>({
      tableName: TABLE_NAME,
      clientConfig: CLIENT_CONFIG,
    }),
});

/**
 * CT-SS-01〜07 を DynamoSnapshotStore 対象で実行 (DEC-019)。
 * snapshot は単一 item/aggregate を上書きするため、各 case の aggregateId が衝突しなければ
 * store instance を共有しても干渉しない。
 */
registerSnapshotStoreContract({
  label: "DynamoSnapshotStore (Local)",
  makeStore: async () =>
    new DynamoSnapshotStore<SnapshotTestState>({
      tableName: SNAPSHOT_TABLE_NAME,
      clientConfig: CLIENT_CONFIG,
    }),
});
