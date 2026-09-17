---
"@seike460/minamo": patch
---

fix: plain-data 契約の再帰検証と型レベル強化で InMemory / DynamoDB の parity を確定

- `assertPlainData` を追加し、両 `EventStore.append` / `SnapshotStore.save` で event `data`・snapshot `state` を再帰検証する。`undefined`・関数・symbol・非有限数・bigint・`Map`/`Set`・`Date`/`RegExp`・class instance・`ArrayBuffer`/非 `Uint8Array` view・循環参照・own `__proto__` key・enumerable symbol key・深さ 32 超過は `TypeError` で reject。これらは InMemory の `structuredClone` と DynamoDB の marshall/unmarshall で結果が食い違い、静かなデータ損失・型変化の温床だった
- DynamoDB 由来の unmarshal 産物の正規化を `normalizePlainData`（`structuredClone` + own `__proto__` key の再帰除去）に統一。`structuredClone` は汚染 `[[Prototype]]` を落とすが own `__proto__` data key は保持するため、InMemory 経路との parity のため除去する（`fromItem` / `fromSnapshotItem` / `parseStreamRecord` の 3 経路）
- `executeCommand` の retry 判定に `name === "ConcurrencyError"` fallback を追加。dual-package install（`pnpm link` 等で 2 コピー存在）や cross-realm 由来の同名エラーも retry 対象にする。`store.append` 直発以外のエラーはこれまで通り retry しない
- `onCommitted` が throw しても `finally` で snapshot save を試行する。observer 失敗で snapshot 層の save が skip される経路を塞ぐ
- snapshot 用の state `structuredClone` 失敗を `TypeError` に正規化し、`Snapshot` envelope に `timestamp` の文字列検査を追加（save 側 `assertSnapshot` と load 側の対称性）。`snapshotPolicy.everyNEvents` の非有限数を `TypeError` で reject
- `loadFrom` fallback の filter が未検証要素の `e.version` を参照しないよう、検証を filter より先に実行
- `CancellationReasons` の防御を強化（非配列・null 要素・malformed reason object）
- `ConcurrencyError` / `RetryExhaustedError` の message に含まれる `aggregateId` を `clip()` で整形（改行・制御文字 injection 対策）
- `formatIssue` が malformed issue（null 要素・非配列 `path`）で生 TypeError を投げないよう防御
- 型レベル: `EventsOf` / `StoredEventsOf` / `Evolver` の event data から `undefined` を除外（`Exclude<TMap[K], undefined>`）。`Evolver` の mapped key を `-?` で必須化し、EventMap の optional キーで evolve エントリ省略時に silent skip しなくなった。`EventStoreTable.for` の generic デフォルトを `never` に変更し、型引数省略時は widen せず fail-closed になる。いずれも runtime で既に reject していた契約違反を型でも検出する tightening で、通常の（non-optional キーの）EventMap を持つ consumer の型は不変
