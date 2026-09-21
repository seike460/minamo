import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * `send` だけを実装した DynamoDBDocumentClient の最小スタブ。
 *
 * SDK client の全 method surface を持たない test double を constructor の
 * `client` 引数に注入するため、型上の cast はこの helper 内に集約する。
 * 「意図的に不正な client」(`send` 欠落等) の注入はここではなく
 * `invalidInput` を使う。
 */
export function stubDocumentClient(
  send: (command: unknown) => Promise<unknown>,
): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}
