import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoEventStore, EventLimitError } from "../src/index.js";
import type { CounterEvents } from "./fixtures/counter.js";

/**
 * DynamoEventStore の append pre-flight 検証 (R15)。
 *
 * 件数 / サイズ上限違反を DynamoDB 呼び出し前に EventLimitError で弾くことを
 * mock した DocumentClient で確認する。正常系の N=99 TransactWriteItems 成功は
 * C-23 の DynamoDB Local 統合テストで検証する。
 */
type HugeEvents = { Big: { payload: string } };

function stubbedDoc(): { send: ReturnType<typeof vi.fn>; doc: DynamoDBDocumentClient } {
  const send = vi.fn().mockResolvedValue({});
  const doc = { send } as unknown as DynamoDBDocumentClient;
  return { send, doc };
}

function counterStore() {
  const { send, doc } = stubbedDoc();
  const store = new DynamoEventStore<CounterEvents>({ tableName: "t", client: doc });
  return { store, send };
}

function hugeStore() {
  const { send, doc } = stubbedDoc();
  const store = new DynamoEventStore<HugeEvents>({ tableName: "t", client: doc });
  return { store, send };
}

describe("DynamoEventStore pre-flight", () => {
  it("throws EventLimitError when events array is empty (before send)", async () => {
    const { store, send } = counterStore();
    await expect(store.append("agg-1", [], 0)).rejects.toBeInstanceOf(EventLimitError);
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts exactly 99 events without throwing EventLimitError", async () => {
    const { store, send } = counterStore();
    const events = Array.from({ length: 99 }, (_, i) => ({
      type: "Incremented" as const,
      data: { amount: i + 1 },
    }));
    await expect(store.append("agg-1", events, 0)).resolves.toHaveLength(99);
    expect(send).toHaveBeenCalledOnce();
  });

  it("throws EventLimitError when event count exceeds 99 (before send)", async () => {
    const { store, send } = counterStore();
    const events = Array.from({ length: 100 }, (_, i) => ({
      type: "Incremented" as const,
      data: { amount: i + 1 },
    }));
    await expect(store.append("agg-1", events, 0)).rejects.toMatchObject({
      name: "EventLimitError",
      message: expect.stringMatching(/99/),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("throws EventLimitError when a single event exceeds 400KB (before send)", async () => {
    const { store, send } = hugeStore();
    const huge = "x".repeat(410 * 1024);
    await expect(
      store.append("agg-1", [{ type: "Big", data: { payload: huge } }], 0),
    ).rejects.toMatchObject({
      name: "EventLimitError",
      message: expect.stringMatching(/400KB/),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("throws EventLimitError when aggregated size exceeds 4MB (before send)", async () => {
    const { store, send } = hugeStore();
    // 50 events × ~90KB payload ≈ 4.4MB → exceeds 4MB − 16KB slack
    const big = "y".repeat(90 * 1024);
    const events = Array.from({ length: 50 }, () => ({
      type: "Big" as const,
      data: { payload: big },
    }));
    await expect(store.append("agg-1", events, 0)).rejects.toMatchObject({
      name: "EventLimitError",
      message: expect.stringMatching(/4MB/),
    });
    expect(send).not.toHaveBeenCalled();
  });
});
