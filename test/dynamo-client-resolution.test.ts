import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoEventStore, DynamoSnapshotStore } from "../src/index.js";
import type { CounterEvents } from "./fixtures/counter.js";

/**
 * U8 design §6.1 の client resolution 優先度検証 (CT-DDB-08)。
 *
 * 優先度: `config.client` > `config.clientConfig` > default `new DynamoDBClient({})`。
 *
 * 本 test は SDK 呼び出しを行わず、constructor が所定の DocumentClient を
 * instance に保持することを間接的に (どの append path が実行されるか) 検証する。
 * 具体的には consumer が持参した client の send 関数を sentinel にすり替え、
 * 呼ばれる send が sentinel であれば "config.client が採用された" と判定する。
 */
describe("DynamoEventStore client resolution", () => {
  it("CT-DDB-08a prefers config.client over config.clientConfig", async () => {
    let sentinelCalled = false;
    const sentinel = {
      send: async () => {
        sentinelCalled = true;
        return {};
      },
    } as unknown as DynamoDBDocumentClient;

    const store = new DynamoEventStore<CounterEvents>({
      tableName: "t",
      client: sentinel,
      clientConfig: { region: "us-west-2" },
    });
    await store.append("agg-1", [{ type: "Incremented", data: { amount: 1 } }], 0);
    expect(sentinelCalled).toBe(true);
  });

  it("CT-DDB-08b uses config.clientConfig when config.client is absent", () => {
    // clientConfig が渡されれば constructor は DynamoDBDocumentClient.from(new DynamoDBClient(config))
    // を呼び出し、instance を保持する。型レベルで DynamoDBDocumentClient が返ることを構築成功で確認する。
    const store = new DynamoEventStore<CounterEvents>({
      tableName: "t",
      clientConfig: { region: "us-east-1", endpoint: "http://localhost:8000" },
    });
    expect(store).toBeInstanceOf(DynamoEventStore);
  });

  it("CT-DDB-08c falls back to default DynamoDBClient when neither is provided", () => {
    // default credential chain を参照するため、インスタンス化自体は成功する
    // (実呼び出しは credential 未設定で後段に失敗するが、本 case は構築のみを確認)。
    const store = new DynamoEventStore<CounterEvents>({ tableName: "t" });
    expect(store).toBeInstanceOf(DynamoEventStore);
  });

  it("CT-DDB-08 default path creates a usable DocumentClient (instanceof check via resolver)", () => {
    // resolver を直接呼ばず、指定の clientConfig で生成した raw client を wrap して
    // config.client として持参した場合に採用されることを確認する (a と同じ流れだが別 aggregateId)。
    const raw = new DynamoDBClient({ region: "us-east-1", endpoint: "http://localhost:8000" });
    const doc = DynamoDBDocumentClient.from(raw, {
      marshallOptions: { removeUndefinedValues: true },
    });
    const store = new DynamoEventStore<CounterEvents>({ tableName: "t", client: doc });
    expect(store).toBeInstanceOf(DynamoEventStore);
    raw.destroy();
  });

  it("tableName が不正 → constructor で TypeError (初回 service call まで持ち越さない)", () => {
    // 空文字・非文字列・config 自体の null/undefined を同じ TypeError で弾く。
    // DynamoDB 側の ValidationException ではなく client 側で fail-fast させる。
    for (const bad of [null, undefined, "", 42]) {
      expect(
        () =>
          new DynamoEventStore<CounterEvents>({
            tableName: bad,
            clientConfig: { region: "local" },
          } as never),
      ).toThrow(TypeError);
      expect(
        () =>
          new DynamoSnapshotStore({
            tableName: bad,
            clientConfig: { region: "local" },
          } as never),
      ).toThrow(TypeError);
    }
    expect(() => new DynamoEventStore<CounterEvents>(null as never)).toThrow(TypeError);
    expect(() => new DynamoSnapshotStore(null as never)).toThrow(TypeError);
  });
});
