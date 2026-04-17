---
"@seike460/minamo": patch
---

`examples/` を tsc 型チェック対象に追加（DX 改善）。

`tsconfig.test.json` の `include` に `"examples"` を追加し、`@types/node` を devDependency として加えることで、`pnpm run type-check` と CI が examples/ の型を自動検証するようになった。v0.1.3 開発中に `EventStore.append` の引数順違反と DynamoDB Stream record の marshal shape 違反を runtime まで検出できなかった反省に対応。

npm tarball (`files: ["dist"]`) には影響しない repo 内部 DX 変更。
