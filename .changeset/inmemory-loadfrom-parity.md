---
"@seike460/minamo": minor
---

`InMemoryEventStore` に `loadFrom` を実装し、Contract Test を InMemory / Dynamo で対称化する。

`EventStore` interface の optional method `loadFrom`（concept.md §5.4 / DEC-019）はこれまで `DynamoEventStore` のみが実装し、`InMemoryEventStore` は未実装だった。そのため Contract Test CT-14（`version > N` の部分ロード）が InMemory ではスキップされ、Snapshot からの部分 rehydration の振る舞いが InMemory と本番 DynamoDB で検証上非対称だった。

`InMemoryEventStore.loadFrom` を追加し（`DynamoEventStore` の `version > :v` query と同一セマンティクス）、CT-14 が InMemory でも実行されるようにした。これにより痛み C（InMemory ↔ 本番の振る舞い差異）が loadFrom 経路でも閉じる。additive（既存 surface 非破壊）。
