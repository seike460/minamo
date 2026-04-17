import { marshall } from "@aws-sdk/util-dynamodb";

/**
 * DynamoDB Streams の INSERT record を hand-craft するための minimal shape。
 * `@types/aws-lambda` への依存を避けるため独自に定義する (U9 design §4)。
 */
export interface StreamRecordFixture {
  eventName?: "INSERT" | "MODIFY" | "REMOVE";
  dynamodb?: {
    NewImage?: Record<string, unknown>;
    Keys?: Record<string, unknown>;
  };
}

/** 必須 field をすべて持つ正常な INSERT record を返す factory。 */
export function insertRecord(
  item: Record<string, unknown> = {
    aggregateId: "agg-1",
    version: 1,
    type: "Incremented",
    data: { amount: 5 },
    timestamp: "2026-04-17T00:00:00.000Z",
  },
): StreamRecordFixture {
  return {
    eventName: "INSERT",
    dynamodb: { NewImage: marshall(item) as Record<string, unknown> },
  };
}

/** eventName が MODIFY の record (INSERT 以外 → null 挙動の検証用)。 */
export const modifyRecord: StreamRecordFixture = {
  eventName: "MODIFY",
  dynamodb: { NewImage: marshall({ aggregateId: "agg-1", version: 1 }) as Record<string, unknown> },
};

/** eventName が REMOVE の record。 */
export const removeRecord: StreamRecordFixture = {
  eventName: "REMOVE",
  dynamodb: { Keys: marshall({ aggregateId: "agg-1", version: 1 }) as Record<string, unknown> },
};

/** NewImage が欠落している INSERT record。StreamViewType 設定ミスの再現。 */
export const insertWithoutNewImage: StreamRecordFixture = {
  eventName: "INSERT",
  dynamodb: {},
};

/**
 * `unmarshall` が throw する壊れた AttributeValue の record。
 * `util-dynamodb` は不明な type descriptor や循環参照で throw するが、実用上は
 * NewImage に直接 plain object を入れることで "type descriptor が無効" を再現する。
 */
export const insertWithCorruptNewImage: StreamRecordFixture = {
  eventName: "INSERT",
  // AttributeValue の descriptor ではなく生文字列を渡す → unmarshall 失敗
  dynamodb: { NewImage: { aggregateId: "not-an-attribute-value" as unknown as never } },
};
