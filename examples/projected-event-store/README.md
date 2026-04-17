# examples/projected-event-store

append 完了後に projection callback を同期実行する Decorator パターン、および
`executeCommand` をドメイン別に curry する factory の canonical recipe。

minamo 本体は **projection 層を契約しない**。本 example は「本体 API に hook を
追加せずに、consumer 側で append → projection を結合する」方法を実コードで示す。
設計の境界について詳細は [本体 README](../../README.md#design-boundaries) を参照。

## 実行方法

```bash
pnpm exec tsx examples/projected-event-store/run.ts
```

期待出力:

```
Counter state after 3 commands: 9
Projection total: 9
```

## 構成

| file | 役割 |
|---|---|
| `event-store-decorator.ts` | `ProjectedEventStore<TMap>` — `EventStore<TMap>` を wrap し、append 後に projection callback を同期呼び出しする |
| `command-runner.ts` | `createCommandRunner(config, store, handler)` — `executeCommand` の `config` / `store` / `handler` を固定する consumer-side factory |
| `counter.ts` | demo 用の最小 Counter Aggregate (`Counter.Incremented`) |
| `run.ts` | Decorator と factory の実使用例 |

## 学べること

1. **Decorator パターンで projection を結合**: `EventStore<TMap>` を実装したまま
   append 後の hook を差し込める。`InMemoryEventStore` でも `DynamoEventStore` でも
   透過的に wrap できる
2. **projection 失敗は swallow する設計**: `onAppended` が throw しても append は
   roll back しない。DynamoDB Streams の非同期セマンティクス (projection 失敗は
   append を巻き戻さない) と揃えるための判断。観測したい場合は `onAppendedError` を渡す
3. **factory で executeCommand をドメイン特化**: `createCommandRunner` は 3 行の
   consumer-side factory。`config` / `store` / `handler` を毎回渡すボイラープレートを
   縮められる。本体の object params は optional 拡張の resilience のために維持

## 使い分け

| ケース | 推奨パターン |
|---|---|
| local 開発 / ユニットテスト / read model の即時確認 | 本 example の `ProjectedEventStore` |
| production (複数 Lambda / 高スループット / poison pill 隔離) | `DynamoEventStore` + DynamoDB Streams + Projection Lambda ([`examples/multi-aggregate-projection/`](../multi-aggregate-projection/)) |

同期 projection は DynamoDB Streams のレイテンシ (数百ms〜数秒) を再現しないため、
production 挙動を模倣するテストには向かない。あくまで consumer 内のテスト runtime や
local 開発用の convenience recipe として使う。
