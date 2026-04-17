import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { ConcurrencyError, DynamoEventStore } from "../src/index.js";
import type { CounterEvents } from "./fixtures/counter.js";

/**
 * U8 design §6.2 / §11: TransactWriteItems 失敗時のエラー分類。
 *
 * - `TransactionCanceledException` で `CancellationReasons[i].Code === "ConditionalCheckFailed"`
 *   が 1 つ以上あれば → `ConcurrencyError(aggregateId, expectedVersion)` に map
 * - それ以外の SDK エラー (ThrottlingException, ProvisionedThroughputExceededException 等) は
 *   そのまま透過 (concept.md §5.5 末尾)
 */
function makeStore(sendImpl: (cmd: unknown) => Promise<unknown>) {
  const send = vi.fn().mockImplementation(sendImpl);
  const doc = { send } as unknown as DynamoDBDocumentClient;
  const store = new DynamoEventStore<CounterEvents>({ tableName: "t", client: doc });
  return { store, send };
}

function newCanceledException(codes: (string | undefined)[]): TransactionCanceledException {
  return new TransactionCanceledException({
    message: "Transaction cancelled",
    $metadata: {},
    CancellationReasons: codes.map((Code) => (Code === undefined ? {} : { Code })),
  });
}

describe("DynamoEventStore TransactionCanceledException mapping", () => {
  it("maps CancellationReasons[*].Code === ConditionalCheckFailed → ConcurrencyError", async () => {
    const { store } = makeStore(async () => {
      throw newCanceledException(["ConditionalCheckFailed"]);
    });
    await expect(
      store.append("agg-1", [{ type: "Incremented", data: { amount: 1 } }], 7),
    ).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it("preserves aggregateId and expectedVersion on the mapped ConcurrencyError", async () => {
    const { store } = makeStore(async () => {
      throw newCanceledException([undefined, "ConditionalCheckFailed"]);
    });
    try {
      await store.append("agg-2", [{ type: "Incremented", data: { amount: 2 } }], 42);
      expect.fail("expected ConcurrencyError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConcurrencyError);
      const e = err as ConcurrencyError;
      expect(e.aggregateId).toBe("agg-2");
      expect(e.expectedVersion).toBe(42);
    }
  });

  it("does not map when no CancellationReason is ConditionalCheckFailed", async () => {
    const { store } = makeStore(async () => {
      throw newCanceledException(["TransactionConflict"]);
    });
    await expect(
      store.append("agg-3", [{ type: "Incremented", data: { amount: 1 } }], 0),
    ).rejects.toBeInstanceOf(TransactionCanceledException);
  });

  it("passes non-TransactionCanceledException SDK errors through unchanged", async () => {
    class ThrottlingException extends Error {
      override readonly name = "ThrottlingException";
    }
    const thrown = new ThrottlingException("rate exceeded");
    const { store } = makeStore(async () => {
      throw thrown;
    });
    await expect(
      store.append("agg-4", [{ type: "Incremented", data: { amount: 1 } }], 0),
    ).rejects.toBe(thrown);
  });
});
