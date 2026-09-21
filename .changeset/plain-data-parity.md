---
"@seike460/minamo": patch
---

fix: plain-data 契約の再帰検証と永続化正規化で InMemory / DynamoDB の parity を確定

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
