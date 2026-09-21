import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  type DynamoDBClientConfig,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DynamoEventStore, EventLimitError } from "../src/index.js";
import type { CounterEvents } from "./fixtures/counter.js";

const TABLE_NAME = "minamo-ddb-specific";

// DynamoDB Local 向けの dummy credentials。LocalStack 等では env で上書きする
// (dynamodb.integration.test.ts と同じ方針)。
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
// ここで throw して suite 全体を fail にする (skip で green にしない)。
beforeAll(async () => {
  control = new DynamoDBClient(CLIENT_CONFIG);
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
});

afterAll(async () => {
  if (control === undefined) return;
  await control.send(new DeleteTableCommand({ TableName: TABLE_NAME }));
  control.destroy();
});

/**
 * U8 design §8.2 の DynamoDB 固有 integration tests。
 *
 * Contract Tests と重複する case は C-22 (dynamodb.integration.test.ts) に委任:
 * - CT-DDB-07 ConsistentRead fresh-read ← CT-12 で cover 済
 * - CT-DDB-09/10 correlationId round-trip ← CT-10/11 で cover 済
 * - CT-DDB-11 timestamp ISO 8601 ← CT-08 で cover 済
 *
 * pre-flight は unit (test/dynamo-preflight.test.ts, C-20) / cancellation mapping は
 * unit (test/dynamo-cancellation.test.ts, C-21) / client resolution は unit
 * (test/dynamo-client-resolution.test.ts, C-23) で cover 済のため、本 file は
 * DynamoDB Local への実書き込みが必要なケースに絞る。
 */
describe("DynamoEventStore — DDB-specific integration", () => {
  it("CT-DDB-01 append N=99 succeeds with continuous version 1..99", async () => {
    const store = new DynamoEventStore<CounterEvents>({
      tableName: TABLE_NAME,
      clientConfig: CLIENT_CONFIG,
    });
    const events = Array.from({ length: 99 }, (_, i) => ({
      type: "Incremented" as const,
      data: { amount: i + 1 },
    }));
    const appended = await store.append("agg-n99", events, 0);
    expect(appended).toHaveLength(99);
    expect(appended[0]?.version).toBe(1);
    expect(appended[98]?.version).toBe(99);

    const loaded = await store.load("agg-n99");
    expect(loaded).toHaveLength(99);
    expect(loaded.map((e) => e.version)).toEqual(events.map((_, i) => i + 1));
  });

  it("CT-DDB-02 append N=100 throws EventLimitError before DDB call", async () => {
    const store = new DynamoEventStore<CounterEvents>({
      tableName: TABLE_NAME,
      clientConfig: CLIENT_CONFIG,
    });
    const events = Array.from({ length: 100 }, (_, i) => ({
      type: "Incremented" as const,
      data: { amount: i + 1 },
    }));
    await expect(store.append("agg-n100", events, 0)).rejects.toBeInstanceOf(EventLimitError);
  });

  it("CT-DDB-06 load works across multiple QueryCommand pages", async () => {
    // 大 payload event を 50 件 append して Query の 1MB/page を超える。
    // DynamoDB Local も LastEvaluatedKey pagination を忠実に再現する。
    type BigEvents = { Bloat: { padding: string } };
    const store = new DynamoEventStore<BigEvents>({
      tableName: TABLE_NAME,
      clientConfig: CLIENT_CONFIG,
    });
    // 50 events × ~30KB = ~1.5MB, forces >1 page
    const payload = "x".repeat(30 * 1024);
    const events = Array.from({ length: 50 }, () => ({
      type: "Bloat" as const,
      data: { padding: payload },
    }));
    await store.append("agg-pagination", events, 0);

    const loaded = await store.load("agg-pagination");
    expect(loaded).toHaveLength(50);
    expect(loaded.map((e) => e.version)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});
