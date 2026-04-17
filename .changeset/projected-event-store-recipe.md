---
"@seike460/minamo": patch
---

「設計の境界」ドキュメントと projected-event-store recipe を追加。

`README.md` / `README.ja.md` に "Design Boundaries" セクションを追加し、minamo 本体がやらないこと (projection 層のラッピング / event type 命名規約の enforce / immer 等 draft proxy への依存) と、その理由を明文化。v0.2.x 以降の検討項目 (Aggregate 横断 `EventStoreTable` facade / first-party `createCommandRunner`) は `docs/roadmap.md` に集約。

`examples/projected-event-store/` を新設し、append 成功後に projection callback を同期実行する `EventStore<TMap>` Decorator と、`executeCommand` を Aggregate 別に curry する `createCommandRunner` の 2 つの consumer-side recipe を runnable + test 付きで提供。本体 API は変更なし。

npm tarball (`files: ["dist"]`) には影響しない docs + examples + test の追加。
