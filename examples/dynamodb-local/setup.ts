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
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";

/**
 * DynamoDB Local は credentials を検証しないため dummy 固定値でよい。
 * 本番 AWS や LocalStack 等 credentials が要る向き先では env で上書きする。
 */
export const LOCAL_CLIENT_CONFIG: DynamoDBClientConfig = {
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "dummy",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "dummy",
  },
};

export async function createEventTable(tableName: string): Promise<DynamoDBClient> {
  const client = new DynamoDBClient(LOCAL_CLIENT_CONFIG);
  // 前回実行で残った table があれば delete してから create (実行順序不問)
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
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
