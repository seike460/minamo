---
"@seike460/minamo": patch
---

`docs/pitfalls.md` (英日) を追加。11 Aggregate の production 利用から得られた躓き事例を体系化:

- `ReadonlyDeep<TState>` と array state の型衝突 → `ReadonlyArray<T>` 宣言推奨
- 空 event payload は `Record<string, never>` ではなく optional field で
- Projection layer の consumer 責務範囲と `ProjectedEventStore` wrapper パターン
- 非決定値 (時刻 / UUID / seq) の `input` 注入
- `@aws-sdk/*` peer dep ポリシーと `pnpm link:` 時の SDK drift 回避
- Contract Tests のカバー範囲と projection timing の境界
- `executeCommand` 自動リトライが `ConcurrencyError` 限定であること
