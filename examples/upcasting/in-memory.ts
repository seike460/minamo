/**
 * upcasting (concept.md §5.11, DEC-020) — 永続化済みの旧スキーマイベントを現行スキーマへ
 * 変換してから rehydrate する。minamo は配線（適用順序）だけを担い、変換ロジックは consumer 所有。
 *
 * 実行: `pnpm exec tsx examples/upcasting/in-memory.ts`
 * 期待出力: `wallet-1 balance=150 version=2`（旧イベント 1 件 + 新規 1 件）
 */
import {
  type AggregateConfig,
  type CommandHandler,
  executeCommand,
  InMemoryEventStore,
  type StoredEvent,
  type Upcaster,
} from "../../src/index.js";

// 現行スキーマ: 入金は "Deposited"({ amount })。
// 過去には "Credited"({ value }) という旧 type で記録していた時期があったとする。
type WalletEvents = {
  Deposited: { amount: number };
};

/** 旧 "Credited"({ value }) → 現行 "Deposited"({ amount })。メタデータは保持する。 */
const upcast: Upcaster<WalletEvents> = (raw) => {
  if (raw.type === "Credited") {
    const { value } = raw.data as { value: number };
    return {
      aggregateId: raw.aggregateId,
      version: raw.version,
      timestamp: raw.timestamp,
      type: "Deposited",
      data: { amount: value },
    };
  }
  return raw as StoredEvent<"Deposited", { amount: number }>;
};

const wallet: AggregateConfig<number, WalletEvents> = {
  initialState: 0,
  evolve: {
    Deposited: (balance, data) => balance + data.amount,
  },
  upcast,
};

const deposit: CommandHandler<number, WalletEvents, { amount: number }> = (_agg, input) => {
  if (input.amount <= 0) return [];
  return [{ type: "Deposited", data: { amount: input.amount } }];
};

async function main(): Promise<void> {
  const store = new InMemoryEventStore<WalletEvents>();

  // 旧スキーマのイベントが既に永続化されている状況を模擬する（type="Credited"）。
  // 通常は本番 DynamoDB に過去から残っているレコード。
  await store.append("wallet-1", [{ type: "Credited", data: { value: 100 } }] as never, 0);

  // 現行スキーマで追加コマンドを実行。load → upcast(Credited→Deposited=100) → balance=100 → +50。
  const { aggregate } = await executeCommand({
    config: wallet,
    store,
    handler: deposit,
    aggregateId: "wallet-1",
    input: { amount: 50 },
  });

  console.log(`${aggregate.id} balance=${aggregate.state} version=${aggregate.version}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
