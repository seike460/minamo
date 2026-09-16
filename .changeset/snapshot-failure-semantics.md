---
"@seike460/minamo": patch
---

snapshot 最適化層の異常時セマンティクスを Hybrid（失敗の性質で使い分け）に確定する（DEC-026）。公開 API は不変。

- **snapshot save は best-effort 化**: `executeCommand` の snapshot save は append 成功（イベント commit 済み）の後に走るため、save 失敗で command 全体を reject すると呼び出し側の再実行が二重 append を招きえた。save 失敗を伝播させず握りつぶし、command は正常に完了する。snapshot は rehydration の最適化であり、save が失敗しても次回は直近の snapshot か full replay から状態を復元する。
- **`DynamoSnapshotStore.load` の envelope 検証**: これまで取得 item を無検証で cast しており、`version` 欠損等が `baseVersion + 1 = NaN` のような沈黙した rehydration 破綻になりえた。`fromItem`(event) / `parseStreamRecord`(stream) と同じ strict 方針で primary field（`aggregateId` / `version` / `timestamp` の型と `state` の存在）を検証し、違反時は `TypeError` を throw する。

新しい public API（observer hook / error class / config）は追加していない（API Extractor gate で surface 不変を保証）。
