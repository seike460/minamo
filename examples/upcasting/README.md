# examples/upcasting

イベントスキーマ進化 (upcasting / concept.md §5.11, DEC-020) の最小例。
`AggregateConfig.upcast` に consumer 所有の transform を渡し、永続化済みの旧スキーマイベントを
現行スキーマへ変換してから `rehydrate` する。minamo は配線（適用順序）だけを担い、変換ロジックは持たない。

## 実行方法

```bash
pnpm exec tsx examples/upcasting/in-memory.ts
```

期待出力:

```
wallet-1 balance=150 version=2
```

旧 type `"Credited"({ value })` の永続化済みイベントを `upcast` で `"Deposited"({ amount })` に変換し、
現行 `evolve` で状態復元している。`upcast` 未指定なら identity（変換なし）で v0.1.x と完全後方互換。

## ポイント

- `upcast` は **決定的・副作用なし**であること（`rehydrate` は複数回呼ばれうる）
- `aggregateId` / `version` / `timestamp` などのメタデータは保持すること（version 検証は変換後に走る）
- minamo は upcaster エンジン（version 管理・連鎖変換・registry）を持たない（thin / DEC-020）

## npm publish

`package.json` の `files` は `["dist"]` なので examples/ は npm publish に含まれない。
