# minamo

## 0.3.0

### Minor Changes

- [#41](https://github.com/seike460/minamo/pull/41) [`348ce5e`](https://github.com/seike460/minamo/commit/348ce5edc96a3374bc15dcc211aa47de96293035) Thanks [@seike460](https://github.com/seike460)! - `InMemoryEventStore` に `loadFrom` を実装し、Contract Test を InMemory / Dynamo で対称化する。

  `EventStore` interface の optional method `loadFrom`（concept.md §5.4 / DEC-019）はこれまで `DynamoEventStore` のみが実装し、`InMemoryEventStore` は未実装だった。そのため Contract Test CT-14（`version > N` の部分ロード）が InMemory ではスキップされ、Snapshot からの部分 rehydration の振る舞いが InMemory と本番 DynamoDB で検証上非対称だった。

  `InMemoryEventStore.loadFrom` を追加し（`DynamoEventStore` の `version > :v` query と同一セマンティクス）、CT-14 が InMemory でも実行されるようにした。これにより痛み C（InMemory ↔ 本番の振る舞い差異）が loadFrom 経路でも閉じる。additive（既存 surface 非破壊）。

### Patch Changes

- [#41](https://github.com/seike460/minamo/pull/41) [`348ce5e`](https://github.com/seike460/minamo/commit/348ce5edc96a3374bc15dcc211aa47de96293035) Thanks [@seike460](https://github.com/seike460)! - fix: 入力境界の fail-loud 化と clone 経路のエラー正規化で backend parity を完遂

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
  - snapshot 保存対象の `state` は `normalizePlainData` で clone + 正規化してから best-effort save に渡す。state が非 plain data の場合は save が `TypeError` で skip されるが、command 自体は成功する (snapshot は最適化層 — DEC-026。commit 前に弾くと v0.2.0 で動いていた aggregate が閾値到達ごとに throw して恒久 stuck するため、commit をブロックしない)
  - custom `SnapshotStore.load` の `state` を `normalizePlainData` で正規化し、own `__proto__` key を除去（`DynamoSnapshotStore.load` との parity）
  - `EventStore.append` 返り値の postcondition に `type` の string 検査を追加
  - `fromItem` / `fromSnapshotItem` が非 object の item（mock/非標準 backend 由来の null・primitive）を `TypeError` で弾く
  - `createCommandRunner` が `deps`・`config`・`store`・`defaults`（`observer`/`snapshotStore`/`snapshotPolicy`）の shape と `defaults.maxRetries`/`defaults.snapshotPolicy.everyNEvents` の値域を factory 生成時点で検証し、初回 `run()` まで設定ミスを持ち越さない。`run()` の非 object `args` も `TypeError` で弾く
  - `EventStore.append` の `options` と `parseStreamRecord` の `options` が非 object の場合に `TypeError` で弾く（`options?.x` の silent skip を防止）
  - `eventNamesOf` が `config.evolve` の非 object を `TypeError` で弾く（`Object.keys("ab")` が index 配列を返す静かな破綻を防止）
  - `normalizePlainData` が非 cloneable 値（`Proxy` 等）を `TypeError` に正規化し、全呼び出し経路で生 `DataCloneError` が漏れない契約に統一
  - `validate` が schema 結果の `issues` を `!== undefined` で判定（own property に限定すると prototype chain 由来の `issues` で非準拠の失敗結果を成功に誤分類するため、定義済みなら常に失敗側に倒す）
  - 境界の object 検査を `isObjectRecord`（null・配列・primitive を拒否する record 判定）に統一。`config`/`evolve`/`options`/`observer`/`snapshotPolicy`/`defaults`/DynamoDB item 等に配列や関数を渡した際の silent skip（`options?.x` が undefined に揃う・`Object.keys([])` が `[]` を返す等）を `TypeError` で一貫して reject
  - `config.client`（持参 `DynamoDBDocumentClient`）に `send` method を要求し、非 object の `config.clientConfig` を `TypeError` で弾く（初回 `.send()` まで設定ミスを持ち越さない）
  - `InMemorySnapshotStore.load` が envelope field（`aggregateId`/`version`/`state`/`timestamp`）のみを再構成して返すように修正。`save` で受理した extra attribute（TTL 等）が InMemory では load に残り DynamoDB では落ちる読み出し差異を解消
  - 境界の必須 field 存在判定（`SnapshotStore.load` 返り値・`config.initialState`・schema 結果の `value`）は own property または prototype 上の getter に限定し、prototype 上の data property は欠落として拒否（`Object.create` / `__proto__` 代入による prototype 汚染経路を塞ぐ）。`SnapshotStore.save` は永続化可能な plain envelope のみ受理するため、必須 field すべてに own property を要求する

  この changeset の変更は公開 API を追加・変更しない（additive の `InMemoryEventStore.loadFrom` は別 changeset で管理）。

- [#41](https://github.com/seike460/minamo/pull/41) [`348ce5e`](https://github.com/seike460/minamo/commit/348ce5edc96a3374bc15dcc211aa47de96293035) Thanks [@seike460](https://github.com/seike460)! - fix: plain-data 契約の再帰検証と永続化正規化で InMemory / DynamoDB の parity を確定

  - `assertPlainData` を追加し、両 `EventStore.append` / `SnapshotStore.save` で event `data`・snapshot `state` を再帰検証する。関数・symbol・非有限数・bigint・`Map`/`Set`・`Date`/`RegExp`・class instance・`ArrayBuffer`/非 `Uint8Array` view・循環参照・own `__proto__` key・enumerable symbol key・**配列要素の `undefined`**・深さ 30 超過 (DynamoDB item 上限 32 階層 − `data`/`state` wrap 1 段 − leaf scalar 1 段) は `TypeError` で reject。これらは InMemory の `structuredClone` と DynamoDB の marshall/unmarshall で結果が食い違い、静かなデータ損失・型変化の温床だった
  - object プロパティの `undefined` 値は reject ではなく正規化する: 永続化経路 (`normalizePlainData`) が DynamoDB の `removeUndefinedValues` と同じく key ごと strip するため、両 backend は同一内容を保存し `data`/`state` の読み出しが一致する (v0.2.0 が受理していた `{ a: { b: undefined } }` のような入力を維持)。配列要素の `undefined` は marshall が要素を落として位置がずれる (`[1, undefined, 3]` → `[1, 3]`) ため reject のままとし、静かな data 破壊を防ぐ
  - DynamoDB 由来の unmarshal 産物の正規化を `normalizePlainData`（`structuredClone` + own `__proto__` key と `undefined` 値 key の再帰除去）に統一。`structuredClone` は汚染 `[[Prototype]]` を落とすが own `__proto__` data key は保持するため、InMemory 経路との parity のため除去する（`fromItem` / `fromSnapshotItem` / `parseStreamRecord` の 3 経路）
  - `executeCommand` の retry 判定に `name === "ConcurrencyError"` fallback を追加。dual-package install（`pnpm link` 等で 2 コピー存在）や cross-realm 由来の同名エラーも retry 対象にするが、誤分類を防ぐため `aggregateId: string` と `expectedVersion: number` の field を持つものに限定する。`store.append` 直発以外のエラーはこれまで通り retry しない
  - `onCommitted` が throw しても `finally` で snapshot save を試行する。observer 失敗で snapshot 層の save が skip される経路を塞ぐ
  - snapshot 用の state `structuredClone` 失敗を `TypeError` に正規化し、`Snapshot` envelope に `timestamp` の文字列検査を追加（save 側 `assertSnapshot` と load 側の対称性）。`snapshotPolicy.everyNEvents` の非有限数を `TypeError` で reject
  - `loadFrom` fallback の filter が未検証要素の `e.version` を参照しないよう、検証を filter より先に実行
  - `CancellationReasons` の防御を強化（非配列・null 要素・malformed reason object）
  - `ConcurrencyError` / `RetryExhaustedError` の message に含まれる `aggregateId` を `clip()` で整形（改行・制御文字 injection 対策）
  - `formatIssue` が malformed issue（null 要素・非配列 `path`）で生 TypeError を投げないよう防御
  - 公開型は v0.2.0 のまま維持する (`EventsOf` / `StoredEventsOf` / `Evolver` / `EventStoreTable.for` の型引数)。runtime の入力契約緩和 (data optional / object の `undefined` 値受理) は v0.2.0 で受理されていた入力の互換性維持であり、型の変更を伴わない

- [#41](https://github.com/seike460/minamo/pull/41) [`348ce5e`](https://github.com/seike460/minamo/commit/348ce5edc96a3374bc15dcc211aa47de96293035) Thanks [@seike460](https://github.com/seike460)! - 出荷後の残存品質レビューで検出した correctness 修正と、optional peer の実装乖離を解消する（DEC-027）。公開 API は不変。

  - **AWS SDK optional peer の lazy 解決（DEC-027）**: `@aws-sdk/*` が static import だったため、AWS SDK を install していない consumer は `import "@seike460/minamo"` 自体が `ERR_MODULE_NOT_FOUND` で失敗していた。全ての runtime 参照を `createRequire` ベースの遅延解決に変更し、InMemory-only consumer は SDK なしで import・利用できる。Dynamo 系 / `parseStreamRecord` は利用時点で未 install なら「optional peer dependency ... is not installed」の明示的エラーになる。
  - **rehydrate の `evolve` lookup を「own property または prototype 上の callable method」に修正**: `in` 演算子は prototype chain 上の data property まで辿るため、`type: "toString"` のようなイベントが `missing_evolve_handler` を素通りして state を静かに破壊しえた。builtin 参照との同一性比較で Object.prototype の builtin 名を除外しつつ、class instance の method は受理する (v0.2.0 互換)。
  - **upcast 適用順を §5.11 / DEC-020 に一致**: raw イベントの `aggregateId` / `version` 検証を upcast より先に行い、consumer の upcast が壊れていても stream 破損（他 aggregate 混入 / version gap）を正しく報告する。upcast 戻り値の shape 検証と malformed 要素の fail-loud も追加。
  - **retry 捕捉を `store.append` に限定**: post-commit 処理（evolve 再適用 / `onCommitted` / snapshot save）で投げられた `ConcurrencyError` が retry catch に飲み込まれて二重 append しうる経路を塞いだ。post-commit のエラーはそのまま伝播する。
  - **handler が `evolve` 未登録 type を emit した場合に commit 前で `missing_evolve_handler`**: これまでは append 後の evolve 再適用で失敗し、poison イベントが stream に残った。pre-append 検証で fail-fast する。
  - **custom `SnapshotStore` の契約違反を `TypeError` で fail-loud**: 別 aggregateId / `version` が非整数・0 以下 / `state` 欠落の snapshot は `fromItem` 系と同じ strict 方針で弾く。`loadFrom` が非関数（truthy 非関数）の custom store は full load + filter に fallback する。
  - **`InMemoryEventStore` の mutation 隔離**: append 入力と `load` / `loadFrom` / `allEvents` の返り値を `structuredClone` で切り離し、caller の改変が stored event に及ばない DynamoDB と同じ隔離性にした。
  - **`expectedVersion` の入力検証**: 両 store で非負整数以外（負数・小数・NaN・Infinity）を `EventLimitError` で reject する。
  - **`TransactionCanceledException` の判定を name + instanceof 併用に**: consumer 持参 client が別コピーの SDK（pnpm link / npm link の二重インスタンス）由来の例外を投げる場合でも `ConditionalCheckFailed` → `ConcurrencyError` 変換が働く。SDK が解決不能な環境では instanceof 側を安全に false に倒す。
  - **非直列化可能な event data のエラー報告を改善**: `JSON.stringify` が失敗する入力（circular 参照・BigInt 等）を raw の TypeError ではなく `EventLimitError` で報告する。

- [#41](https://github.com/seike460/minamo/pull/41) [`348ce5e`](https://github.com/seike460/minamo/commit/348ce5edc96a3374bc15dcc211aa47de96293035) Thanks [@seike460](https://github.com/seike460)! - snapshot 最適化層の異常時セマンティクスを Hybrid（失敗の性質で使い分け）に確定する（DEC-026）。公開 API は不変。

  - **snapshot save は best-effort 化**: `executeCommand` の snapshot save は append 成功（イベント commit 済み）の後に走るため、save 失敗で command 全体を reject すると呼び出し側の再実行が二重 append を招きえた。save 失敗を伝播させず握りつぶし、command は正常に完了する。snapshot は rehydration の最適化であり、save が失敗しても次回は直近の snapshot か full replay から状態を復元する。
  - **非 plain data の state でも command は成功する**: state が plain-data 契約を満たさない場合（`Date` 混入等の DEC-011 違反）、snapshot の `save` は `TypeError` で skip されるが event の commit と command の成功は妨げない。閾値到達のたびに command が throw して aggregate が恒久的に操作不能になる事態を防ぐ（v0.2.0 では command は成功していた）。
  - **`DynamoSnapshotStore.load` の envelope 検証**: これまで取得 item を無検証で cast しており、`version` 欠損等が `baseVersion + 1 = NaN` のような沈黙した rehydration 破綻になりえた。`fromItem`(event) / `parseStreamRecord`(stream) と同じ strict 方針で primary field（`aggregateId` / `version` / `timestamp` の型と `state` の存在）を検証し、違反時は `TypeError` を throw する。

  新しい public API（observer hook / error class / config）は追加していない（API Extractor gate で surface 不変を保証）。

- [#41](https://github.com/seike460/minamo/pull/41) [`348ce5e`](https://github.com/seike460/minamo/commit/348ce5edc96a3374bc15dcc211aa47de96293035) Thanks [@seike460](https://github.com/seike460)! - fix: store / stream 境界の入力検証を強化し、DynamoDB との parity と二重 append hazard を解消

  - `DynamoEventStore` が cancellation reason `TransactionConflict` を `ConcurrencyError` に map するように修正。同一 aggregate への並行 transaction 競合が未分類エラーとして漏れ、`executeCommand` の自動リトライを素通りしていた
  - `executeCommand` が evolve 適用を `store.append` 前に移動。commit 後の clone/evolve 失敗で「書き込み済みなのに失敗に見える」状態 (caller の再実行で二重 append) を防ぐ
  - 両 `EventStore` の `append` で event envelope (非空 `type`) と `aggregateId` (非空文字列・2048 byte 上限)・`correlationId` (文字列) を検証。`data` は optional (v0.2.0 互換): `data: undefined` / key 欠落の event は受理され、DynamoDB では `removeUndefinedValues` で属性ごと落ちる従来どおりの形式で永続化され、両 backend の読み出しは `data: undefined` に揃う
  - `executeCommand` が `EventStore` / `SnapshotStore` / handler の返り値契約を実行時検証 (load の配列性・append 返り値の件数・aggregateId 一致・version 連番・snapshot の aggregateId/version/state)。契約違反の custom store を `TypeError` で fail-loud 化
  - `rehydrate` / `loadFrom` の引数検証を追加 (`aggregateId`・`events` 配列性・`afterVersion` 非負整数) — InMemory が `version > NaN` で静かに `[]` を返す parity ギャップを解消
  - `fromItem` / `fromSnapshotItem` / `parseStreamRecord` が `Object.hasOwn` + 型検査を併用し、`util-dynamodb` unmarshall の `__proto__` prototype 汚染による偽装フィールド (必須 field に加え `correlationId` の値 injection も) を拒否。`data` / `state` は `structuredClone` で正規化
  - `DynamoEventStore.append` の返り値 clone を transaction send 前に移動 — 非 cloneable な `data` で post-commit の `DataCloneError` が発生し「commit 済みなのに失敗に見える」状態になるのを防止
  - `evolve` には `data` の clone を渡し、snapshot 用の state clone を best-effort ブロック内に移動 — 不純な evolve による永続化 payload 汚染と post-commit の clone 失敗を遮断
  - evolve handler の登録判定に callable 性を要求 (`{ X: undefined }` のような壊れた登録が `missing_evolve_handler` として可視化される挙動変更)。own property に加えて consumer 定義 prototype 上の callable method も認める (class instance を evolve map にする v0.2.0 互換の構成を維持) が、Object.prototype の builtin 名 (`toString` 等) は handler にならない。`eventNamesOf` も同じく prototype method を拾う
  - `version` の整数性 (>= 1) を Dynamo item / snapshot item / stream record の各 load path で検証
  - `InMemoryEventStore` / `DynamoEventStore` の append 返り値を clone し、caller の input mutation が返り値に波及しない isolation を統一
  - 4MB transaction 合計チェックに slack を適用 (per-item 400KB は近似誤差で受理上限を下げないよう厳密な閾値を維持)
  - `validate` が Standard Schema 非準拠の結果 (非配列 issues / value・issues 両欠落) を `TypeError` で弾く

## 0.2.0

### Minor Changes

- [#23](https://github.com/seike460/minamo/pull/23) [`0b8607d`](https://github.com/seike460/minamo/commit/0b8607dff9fc3719a36c3b0daf2e0172f271f142) Thanks [@seike460](https://github.com/seike460)! - v1 に向けた機能拡充（2026-05-30 の v1 設計レビューに基づくスコープ拡大。docs/roadmap-v1.md / DEC-018〜025）。

  すべて additive（既存 surface への breaking change なし）。retry 枯渇時の throw 型のみ変更（1 リリース deprecation を経た DEC-022）。

  **Developer ergonomics + observability:**

  - `createCommandRunner` — `config` / `store` を固定する first-party runner（DEC-023）
  - `createEventStoreTable` — 1 DocumentClient を共有しつつ per-Aggregate に型 narrow する facade（DEC-023）
  - `ExecuteObserver` — `executeCommand` のライフサイクル観測 hook（OTel 非依存。DEC-021）
  - `NoInfer<TInput>` を `executeCommand` / runner に適用（handler の期待型が input で広がらない）

  **retry 観測性:**

  - `RetryExhaustedError { aggregateId, attempts, cause }` — retry 枯渇時に throw（v0.1.x は生の `ConcurrencyError`。DEC-022）

  **スキーマ進化:**

  - `AggregateConfig.upcast`（`Upcaster<TMap>`）— consumer 所有の transform で旧スキーマイベントを現行スキーマへ変換（DEC-020）

  **長寿命 Aggregate:**

  - `SnapshotStore<TState>` / `Snapshot<TState>` / `SnapshotPolicy` interface（EventStore とは独立。DEC-019）
  - `InMemorySnapshotStore` / `DynamoSnapshotStore` 実装
  - `EventStore.loadFrom?`（optional method）— snapshot からの部分 rehydration
  - `executeCommand` に `snapshotStore` / `snapshotPolicy` を追加（snapshot 起点で rehydration を短縮）

  **Tooling:**

  - coverage 閾値を CI ゲート化

  InMemory / Dynamo は Snapshot を含め同じ Contract Tests を通る。`files: ["dist"]` のため docs / examples の追加は npm tarball に影響しない。

  > NOTE: v1 機能は単一 v0.2.0 で一括リリースする（DEC-025）。当初 roadmap-v1.md が想定した v0.2(ergonomics) → v0.3(upcasting) → v0.4(snapshot) の機能別段階リリースは、機能群が相互依存して実装・検証済みであることと運用負荷を踏まえ採らない。以後の v0.2 → v0.3 → v0.4 は「既存 surface 非破壊」を実証する安定性窓とする。

## 0.1.6

### Patch Changes

- [#21](https://github.com/seike460/minamo/pull/21) [`8a64398`](https://github.com/seike460/minamo/commit/8a64398f179d2e40037f106e9ecae8307c9288d0) Thanks [@seike460](https://github.com/seike460)! - ドキュメントの鮮度更新と開発ツールの整備。本体 API は変更なし。

  - README (英日) の Status 表記を版固定しない表現に更新し、CI status バッジを追加。`CLAUDE.md` の phase 記述を実態 (Released / v0.1.x maintenance) に合わせ、DynamoEventStore 実装済みの事実を反映。
  - vitest の coverage 計測 (`@vitest/coverage-v8`) を導入し、CI の unit test を coverage 付きに。型のみファイルは計測対象から除外。
  - `docs/concept.md` §7 Alternatives を再検証し最新化 (castore は core/adapter とも v2.4.2、@ocoda は v3.0.0)。事実が変わった差別化論点を「DynamoDB 専用設計 vs マルチ adapter」という構造的な軸に再構成。
  - `biome.json` の `$schema` を導入済み biome バージョンに同期。`CONTRIBUTING.md` に dependabot 運用フローを明記。

  npm tarball (`files: ["dist"]`) には影響しない docs + tooling の変更。

## 0.1.5

### Patch Changes

- [`3861f12`](https://github.com/seike460/minamo/commit/3861f122bc303227be71a94de2fabf6deab848b7) Thanks [@seike460](https://github.com/seike460)! - 「設計の境界」ドキュメントと projected-event-store recipe を追加。

  `README.md` / `README.ja.md` に "Design Boundaries" セクションを追加し、minamo 本体がやらないこと (projection 層のラッピング / event type 命名規約の enforce / immer 等 draft proxy への依存) と、その理由を明文化。v0.2.x 以降の検討項目 (Aggregate 横断 `EventStoreTable` facade / first-party `createCommandRunner`) は `docs/roadmap.md` に集約。

  `examples/projected-event-store/` を新設し、append 成功後に projection callback を同期実行する `EventStore<TMap>` Decorator と、`executeCommand` を Aggregate 別に curry する `createCommandRunner` の 2 つの consumer-side recipe を runnable + test 付きで提供。本体 API は変更なし。

  npm tarball (`files: ["dist"]`) には影響しない docs + examples + test の追加。

## 0.1.4

### Patch Changes

- [`3f2f518`](https://github.com/seike460/minamo/commit/3f2f51819f427b046bd55048c2bf9ae78d0a1587) Thanks [@seike460](https://github.com/seike460)! - `examples/` を tsc 型チェック対象に追加（DX 改善）。

  `tsconfig.test.json` の `include` に `"examples"` を追加し、`@types/node` を devDependency として加えることで、`pnpm run type-check` と CI が examples/ の型を自動検証するようになった。v0.1.3 開発中に `EventStore.append` の引数順違反と DynamoDB Stream record の marshal shape 違反を runtime まで検出できなかった反省に対応。

  npm tarball (`files: ["dist"]`) には影響しない repo 内部 DX 変更。

## 0.1.3

### Patch Changes

- [`678228b`](https://github.com/seike460/minamo/commit/678228bfab6056429bc24ba3e67048e56e990f35) Thanks [@seike460](https://github.com/seike460)! - `examples/` を 2 本追加し、pitfalls.md / README から導線を張る。

  - `examples/multi-aggregate-projection/` — 複数 Aggregate を 1 Lambda で route する canonical パターン。`parseStreamRecord` + `eventNamesOf` による type-only routing (DEC-009 + DEC-013) の具体実装。Counter + Wallet の 2 Aggregate を同一 Stream に流した状態から read model を組み立てる。
  - `examples/dynamodb-local/` — `DynamoEventStore` を Docker 上の DynamoDB Local で append → load → `rehydrate` → 楽観的ロック衝突 (`ConcurrencyError`) まで E2E 検証する cookbook。テーブル create / delete は `setup.ts` に集約。

  docs/pitfalls.md §3 (英日) と README (英日) の Design セクションに example への導線を追加。

## 0.1.2

### Patch Changes

- [`30ac21a`](https://github.com/seike460/minamo/commit/30ac21a1fc3a0f0e0ad1d5758a963b60bc27997d) Thanks [@seike460](https://github.com/seike460)! - `docs/pitfalls.md` (英日) を追加。11 Aggregate の production 利用から得られた躓き事例を体系化:

  - `ReadonlyDeep<TState>` と array state の型衝突 → `ReadonlyArray<T>` 宣言推奨
  - 空 event payload は `Record<string, never>` ではなく optional field で
  - Projection layer の consumer 責務範囲と `ProjectedEventStore` wrapper パターン
  - 非決定値 (時刻 / UUID / seq) の `input` 注入
  - `@aws-sdk/*` peer dep ポリシーと `pnpm link:` 時の SDK drift 回避
  - Contract Tests のカバー範囲と projection timing の境界
  - `executeCommand` 自動リトライが `ConcurrencyError` 限定であること

## 0.1.1

### Patch Changes

- [`c0589e6`](https://github.com/seike460/minamo/commit/c0589e685ee2cc13b23869ac0d493d8666c92c6d) Thanks [@seike460](https://github.com/seike460)! - README を英訳し、日本語版を `README.ja.md` に分離。GitHub / npm 上で English / 日本語 両方の導線を提供。

## 0.1.0

### Minor Changes

- [`4fba532`](https://github.com/seike460/minamo/commit/4fba5329961e6d0a49a6098dd1932be44771250b) Thanks [@seike460](https://github.com/seike460)! - v0.1.0 initial release.

  Type-safe CQRS + Event Sourcing for AWS Serverless。minamo の公開 API は [`docs/concept.md`](../docs/concept.md) §5 API Design に逐字従属する。

  同梱する公開 symbol:

  - **Core types** — `DomainEvent` / `StoredEvent` / `EventMap` / `EventsOf` / `StoredEventsOf` / `Evolver` / `ReadonlyDeep`
  - **Aggregate** — `Aggregate<TState>` / `AggregateConfig<TState, TMap>`
  - **Command** — `CommandHandler<TState, TMap, TInput>` / `CommandResult<TMap>`
  - **EventStore interface** — `EventStore<TMap>` / `AppendOptions`
  - **InMemoryEventStore** — `EventStore` の Map-based 実装 (テスト / ローカル学習用)
  - **DynamoEventStore** — `EventStore` の DynamoDB 実装 (`DynamoEventStoreConfig`)
  - **rehydrate / executeCommand** — Load → Rehydrate → Decide → Append の全サイクルと再試行管理
  - **Errors** — `ConcurrencyError` / `EventLimitError` / `InvalidEventStreamError` / `InvalidStreamRecordError` / `ValidationError`
  - **Projection Bridge** — `parseStreamRecord` / `eventNamesOf` / `ParseStreamRecordOptions`
  - **Standard Schema v1** interface + `validate` helper

  主な設計原則:

  - concept.md §5 の型シグネチャと `src/` 実装が逐字一致
  - 新規 runtime 依存ゼロ (AWS SDK v3 は optional peer dependency)
  - Contract Tests が InMemoryEventStore / DynamoEventStore の両方で green
  - ESM only、Node ≥ 24、TypeScript strict + `verbatimModuleSyntax`

  Design docs:

  - [`docs/concept.md`](../docs/concept.md) — 設計思想と公開 API 仕様 (§5 / §11 Decisions)
  - [`docs/design/v0.1.0/`](../docs/design/v0.1.0/) — unit 別 detailed design (U1〜U9)
  - [`docs/design/v0.1.0.md`](../docs/design/v0.1.0.md) — implementation order + module structure
