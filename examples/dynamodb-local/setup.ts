/**
 * DynamoDB Local に minamo Event Store 互換のテーブルを create/delete する helper。
 *
 * schema (concept.md §3 / C11):
 *   PK (HASH)  = aggregateId : string
 *   SK (RANGE) = version     : number
 *
 * `StreamSpecification` は NEW_IMAGE を有効化。本番で Projection Lambda の
 * Event Source Mapping が読む前提 (DynamoDB Local では trigger は動かないが
 * 表明として設定を残す)。
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";

export const LOCAL_CLIENT_CONFIG: DynamoDBClientConfig = {
  region: "us-east-1",
  endpoint: "http://localhost:8000",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
};

export async function createEventTable(tableName: string): Promise<DynamoDBClient> {
  const client = new DynamoDBClient(LOCAL_CLIENT_CONFIG);
  // 前回実行で残った table があれば delete してから create (実行順序不問)
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch (err) {
    if ((err as Error).name !== "ResourceNotFoundException") throw err;
  }
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      KeySchema: [
        { AttributeName: "aggregateId", KeyType: "HASH" },
        { AttributeName: "version", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "aggregateId", AttributeType: "S" },
        { AttributeName: "version", AttributeType: "N" },
      ],
      BillingMode: "PAY_PER_REQUEST",
      StreamSpecification: {
        StreamEnabled: true,
        StreamViewType: "NEW_IMAGE",
      },
    }),
  );
  return client;
}

export async function dropEventTable(client: DynamoDBClient, tableName: string): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } finally {
    client.destroy();
  }
}
