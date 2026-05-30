# examples/snapshot

Snapshot (concept.md §5.10, DEC-019) と Observability hooks (§5.12, DEC-021) の最小例。

長寿命 Aggregate で全イベントの replay が重くなる問題に対し、`SnapshotStore` を `executeCommand` に渡すと
snapshot 起点で rehydration を短縮できる。閾値は `snapshotPolicy` で consumer が指定し、minamo は機構のみ提供する。
`ExecuteObserver.onLoaded.eventCount` で replay 件数の減少を観測できる。

## 実行方法

```bash
pnpm exec tsx examples/snapshot/in-memory.ts
```

`everyNEvents: 3` で version 3 を跨いだ時点で snapshot(v3) が save され、以降の command の
`onLoaded` の replay 件数が小さくなる様子が出力される。

## ポイント

- `SnapshotStore` は EventStore とは独立した interface（DEC-019）。snapshot 不要な consumer は影響を受けない
- 本番は `DynamoSnapshotStore`（PK=aggregateId の別テーブル推奨）に差し替える。`InMemoryEventStore` ⇄
  `InMemorySnapshotStore` と同じ Contract Tests を通る
- `EventStore.loadFrom?` を実装した store（`DynamoEventStore`）では snapshot 以降だけを部分ロードする。
  未実装の store は `load` 全件 + filter にフォールバックする
- 閾値 (`everyNEvents`) は consumer が決める。minamo は「何件で snapshot すべきか」を強制しない

## npm publish

`package.json` の `files` は `["dist"]` なので examples/ は npm publish に含まれない。
