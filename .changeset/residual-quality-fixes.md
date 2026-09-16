---
"@seike460/minamo": patch
---

出荷後の残存品質レビューで検出した correctness 修正と、optional peer の実装乖離を解消する（DEC-027）。公開 API は不変。

- **AWS SDK optional peer の lazy 解決（DEC-027）**: `@aws-sdk/*` が static import だったため、AWS SDK を install していない consumer は `import "@seike460/minamo"` 自体が `ERR_MODULE_NOT_FOUND` で失敗していた。全ての runtime 参照を `createRequire` ベースの遅延解決に変更し、InMemory-only consumer は SDK なしで import・利用できる。Dynamo 系 / `parseStreamRecord` は利用時点で未 install なら「optional peer dependency ... is not installed」の明示的エラーになる。
- **rehydrate の `evolve` lookup を own-property 限定に修正**: `in` 演算子は prototype chain を辿るため、`type: "toString"` のようなイベントが `missing_evolve_handler` を素通りして state を静かに破壊しえた。`Object.hasOwn` で弾く。
- **upcast 適用順を §5.11 / DEC-020 に一致**: raw イベントの `aggregateId` / `version` 検証を upcast より先に行い、consumer の upcast が壊れていても stream 破損（他 aggregate 混入 / version gap）を正しく報告する。upcast 戻り値の shape 検証と malformed 要素の fail-loud も追加。
- **retry 捕捉を `store.append` に限定**: post-commit 処理（evolve 再適用 / `onCommitted` / snapshot save）で投げられた `ConcurrencyError` が retry catch に飲み込まれて二重 append しうる経路を塞いだ。post-commit のエラーはそのまま伝播する。
- **handler が `evolve` 未登録 type を emit した場合に commit 前で `missing_evolve_handler`**: これまでは append 後の evolve 再適用で失敗し、poison イベントが stream に残った。pre-append 検証で fail-fast する。
- **custom `SnapshotStore` の契約違反を `TypeError` で fail-loud**: 別 aggregateId / `version` が非整数・0 以下 / `state` 欠落の snapshot は `fromItem` 系と同じ strict 方針で弾く。`loadFrom` が非関数（truthy 非関数）の custom store は full load + filter に fallback する。
- **`InMemoryEventStore` の mutation 隔離**: append 入力と `load` / `loadFrom` / `allEvents` の返り値を `structuredClone` で切り離し、caller の改変が stored event に及ばない DynamoDB と同じ隔離性にした。
- **`expectedVersion` の入力検証**: 両 store で非負整数以外（負数・小数・NaN・Infinity）を `EventLimitError` で reject する。
- **`TransactionCanceledException` の判定を name + instanceof 併用に**: consumer 持参 client が別コピーの SDK（pnpm link / npm link の二重インスタンス）由来の例外を投げる場合でも `ConditionalCheckFailed` → `ConcurrencyError` 変換が働く。SDK が解決不能な環境では instanceof 側を安全に false に倒す。
- **非直列化可能な event data のエラー報告を改善**: `JSON.stringify` が失敗する入力（circular 参照・BigInt 等）を raw の TypeError ではなく `EventLimitError` で報告する。
