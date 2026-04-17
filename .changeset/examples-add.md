---
"@seike460/minamo": patch
---

`examples/` を 2 本追加し、pitfalls.md / README から導線を張る。

- `examples/multi-aggregate-projection/` — 複数 Aggregate を 1 Lambda で route する canonical パターン。`parseStreamRecord` + `eventNamesOf` による type-only routing (DEC-009 + DEC-013) の具体実装。Counter + Wallet の 2 Aggregate を同一 Stream に流した状態から read model を組み立てる。
- `examples/dynamodb-local/` — `DynamoEventStore` を Docker 上の DynamoDB Local で append → load → `rehydrate` → 楽観的ロック衝突 (`ConcurrencyError`) まで E2E 検証する cookbook。テーブル create / delete は `setup.ts` に集約。

docs/pitfalls.md §3 (英日) と README (英日) の Design セクションに example への導線を追加。
