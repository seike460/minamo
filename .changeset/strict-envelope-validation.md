---
"@seike460/minamo": patch
---

fix: store / stream 境界の入力検証を強化し、DynamoDB との parity と二重 append hazard を解消

- `DynamoEventStore` が cancellation reason `TransactionConflict` を `ConcurrencyError` に map するように修正。同一 aggregate への並行 transaction 競合が未分類エラーとして漏れ、`executeCommand` の自動リトライを素通りしていた
- `executeCommand` が evolve 適用を `store.append` 前に移動。commit 後の clone/evolve 失敗で「書き込み済みなのに失敗に見える」状態 (caller の再実行で二重 append) を防ぐ
- 両 `EventStore` の `append` で event envelope (非空 `type` / own `data` / 非 `undefined`) と `aggregateId` (非空文字列・2048 byte 上限)・`correlationId` (文字列) を検証。`data: undefined` は `removeUndefinedValues` で Dynamo 側の属性ごと消失し読み出し不能になるため、write 側で `EventLimitError` として弾く
- `executeCommand` が `EventStore` / `SnapshotStore` / handler の返り値契約を実行時検証 (load の配列性・append 返り値の件数・aggregateId 一致・version 連番・snapshot の aggregateId/version/state)。契約違反の custom store を `TypeError` で fail-loud 化
- `rehydrate` / `loadFrom` の引数検証を追加 (`aggregateId`・`events` 配列性・`afterVersion` 非負整数) — InMemory が `version > NaN` で静かに `[]` を返す parity ギャップを解消
- `fromItem` / `fromSnapshotItem` / `parseStreamRecord` が `Object.hasOwn` + 型検査を併用し、`util-dynamodb` unmarshall の `__proto__` prototype 汚染による偽装フィールド (必須 field に加え `correlationId` の値 injection も) を拒否。`data` / `state` は `structuredClone` で正規化
- `DynamoEventStore.append` の返り値 clone を transaction send 前に移動 — 非 cloneable な `data` で post-commit の `DataCloneError` が発生し「commit 済みなのに失敗に見える」状態になるのを防止
- `evolve` には `data` の clone を渡し、snapshot 用の state clone を best-effort ブロック内に移動 — 不純な evolve による永続化 payload 汚染と post-commit の clone 失敗を遮断
- evolve handler の登録判定を own property かつ callable に限定 (`{ X: undefined }` や Object.prototype 由来名の黙った skip を拒否 — 従来黙過されていた壊れた登録が `missing_evolve_handler` として可視化される挙動変更)
- `version` の整数性 (>= 1) を Dynamo item / snapshot item / stream record の各 load path で検証
- `InMemoryEventStore` / `DynamoEventStore` の append 返り値を clone し、caller の input mutation が返り値に波及しない isolation を統一
- per-item 400KB preflight に slack を適用 (transaction 合計チェックと同じ近似マージン)
- `validate` が Standard Schema 非準拠の結果 (非配列 issues / value・issues 両欠落) を `TypeError` で弾く
