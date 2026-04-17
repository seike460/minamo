# examples/multi-aggregate-projection

複数 Aggregate を 1 Lambda (projection handler) で route する canonical パターン。`parseStreamRecord` + `eventNamesOf` を使って **型安全 + DRY + 未知 type の安全な skip** を実現する。

## 実行方法

```bash
pnpm exec tsx examples/multi-aggregate-projection/projection-handler.ts
```

期待出力:

```
Counter state after replay: 8
Wallet balance after replay: 1200 JPY
```

## 構成

| file | 役割 |
|---|---|
| `counter.ts` | Counter Aggregate 定義 (`Counter.Incremented` / `Counter.Reset`) |
| `wallet.ts` | Wallet Aggregate 定義 (`Wallet.Credited` / `Wallet.Debited`) |
| `projection-handler.ts` | 2 Aggregate の event を 1 handler で route する demo |

## 学べること

1. **DEC-009**: event 名に Aggregate プレフィックス (`Counter.` / `Wallet.`) を付けることで、同一テーブル共有時の type 衝突を回避
2. **DEC-013**: `parseStreamRecord` は type-only routing。`ignoreUnknownTypes: true` で lenient mode に切り替え可能 (複数 Aggregate 共有テーブル運用で有用)
3. **Exhaustiveness check**: `storedEvent.type` の literal narrowing + `never` switch で、新 event 追加時に type-error で気付ける
4. **`eventNamesOf(config)`**: Write 側 config から event 名配列を型安全に導出。手書き配列 / キャスト不要

## 本番への移行

本 example は `InMemoryEventStore` で append した後、DynamoDB Streams INSERT レコード互換の shape を手組みして handler に渡している。本番では:

- Write 側: `DynamoEventStore` が同一テーブルに append
- DynamoDB Streams (StreamViewType=NEW_IMAGE) が INSERT レコードを生成
- Lambda Event Source Mapping が handler に record を渡す
- consumer が `BisectBatchOnFunctionError: true` + `MaximumRetryAttempts` + OnFailure destination + `ReportBatchItemFailures` を構成して poison pill を隔離 (DEC-013 / DEC-014)

projection layer 全般の注意点は [`docs/pitfalls.md` §3](../../docs/pitfalls.md#3-the-projection-layer-is-consumer-owned) を参照。
