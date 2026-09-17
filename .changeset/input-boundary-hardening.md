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
- `createCommandRunner` が `deps`・`config`・`store`・`defaults`（`observer`/`snapshotStore`/`snapshotPolicy`）の shape と `defaults.maxRetries`/`defaults.snapshotPolicy.everyNEvents` の値域を factory 生成時点で検証し、初回 `run()` まで設定ミスを持ち越さない。`run()` の非 object `args` も `TypeError` で弾く
- `EventStore.append` の `options` と `parseStreamRecord` の `options` が非 object の場合に `TypeError` で弾く（`options?.x` の silent skip を防止）
- `eventNamesOf` が `config.evolve` の非 object を `TypeError` で弾く（`Object.keys("ab")` が index 配列を返す静かな破綻を防止）
- `normalizePlainData` が非 cloneable 値（`Proxy` 等）を `TypeError` に正規化し、全呼び出し経路で生 `DataCloneError` が漏れない契約に統一
- `validate` が schema 結果の `issues` を own property で判定（prototype chain 由来の `issues` で成功結果が failure に誤分類されるのを防止）
- 境界の object 検査を `isObjectRecord`（null・配列・primitive を拒否する record 判定）に統一。`config`/`evolve`/`options`/`observer`/`snapshotPolicy`/`defaults`/DynamoDB item 等に配列や関数を渡した際の silent skip（`options?.x` が undefined に揃う・`Object.keys([])` が `[]` を返す等）を `TypeError` で一貫して reject
- `config.client`（持参 `DynamoDBDocumentClient`）に `send` method を要求し、非 object の `config.clientConfig` を `TypeError` で弾く（初回 `.send()` まで設定ミスを持ち越さない）

新しい public API は追加していない（API Extractor gate で surface 不変を保証）。
