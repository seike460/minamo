---
"@seike460/minamo": patch
---

fix: 入力境界の fail-loud 化と clone 経路のエラー正規化で backend parity を完遂

- `executeCommand` / `rehydrate` の入口で `AggregateConfig`（`initialState` 必須・`evolve` が object・`upcast` が関数）と依存オブジェクトの shape を検証。`handler` 非関数・`store.load`/`append` 欠落・非 object の `observer`/`snapshotStore`/`snapshotPolicy` を `TypeError` で弾き、`state: undefined` の静かな生成や silent skip を防ぐ。`loadFrom` が非関数でも full load + filter に fallback する既存契約は維持
- `evolve` の戻り値を検証し、`undefined`（return 忘れ）と thenable（async evolve の付け忘れ）を `TypeError` で弾く。`state` が Promise になる静かな破綻を防止
- 両 `EventStore.append` で非配列・null の `events` を `events.length` の生 TypeError ではなく `EventLimitError` で弾く
- `assertSnapshot` を snapshot 全体の plain-data 検証に強化。`Date`/`Map`/関数等の非 plain な extra attribute が InMemory では保持され DynamoDB では marshall が退化/失敗する backend 間乖離を write 側で統一的に reject
- `structuredClone` 失敗を全経路で契約違反のエラーに正規化。`Proxy` 入力は plain-data 検査をすり抜ける（検査が target に forward される）ため、残存していた生 `DataCloneError` の経路（`executeCommand` の evolve data clone・両 store の `append`・両 `SnapshotStore.save`）を `TypeError`/`EventLimitError` に揃えた
- `DynamoEventStore.append` は `structuredClone` 済みの `out` を size 検証・marshall・返り値のすべてに使用し、検証内容と書き込み内容の一致を保証（async 窓での caller mutation hazard を遮断）
- `DynamoSnapshotStore.save` が `structuredClone(snapshot)` を `Item` に渡し、async marshall 窓での mutation を遮断
- `DynamoEventStore` / `DynamoSnapshotStore` / `createEventStoreTable` が空・非文字列の `tableName` を constructor 時点で `TypeError` で reject（初回 service call まで設定ミスを持ち越さない）
- `parseStreamRecord` が非配列の `eventNames` を `TypeError` で弾き、unmarshall 結果が非 object の場合と空 `aggregateId` を `missing_field` で弾く
- `validate` が `~standard`/`validate` 欠落の malformed Standard Schema を `TypeError` で弾く。`ValidationError` の message を 2048 文字に truncate（issue 数 suffix 付き、全情報は `err.issues` に保持）
- `executeCommand` が snapshot 発火時に保存対象 state の plain-data 検証を commit 前に実行（post-commit save は best-effort のため、「snapshot が二度と書かれない」静かな劣化を防止）
- custom `SnapshotStore.load` の `state` を `normalizePlainData` で正規化し、own `__proto__` key を除去（`DynamoSnapshotStore.load` との parity）
- `EventStore.append` 返り値の postcondition に `type` の string 検査を追加
- `fromItem` / `fromSnapshotItem` が非 object の item（mock/非標準 backend 由来の null・primitive）を `TypeError` で弾く

新しい public API は追加していない（API Extractor gate で surface 不変を保証）。
