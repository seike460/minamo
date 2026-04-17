## Summary

<!-- 1-3 bullet points: why this change exists. -->

## Changes

<!-- 変更点を簡潔に。concept.md §5 の public API に触る場合は DEC 更新の有無を明記。 -->

## Test plan

- [ ] `pnpm run type-check`
- [ ] `pnpm run ci` (biome CI mode)
- [ ] `pnpm run test`
- [ ] Contract test が関わる変更は `pnpm run test:integration` も確認
- [ ] 公開 API 変更時は `pnpm run check-exports` / `pnpm run docs` 確認
- [ ] `pnpm changeset` 追加 (user-visible な変更の場合)

## Related

<!-- Issue / Discussion / concept.md §5 / DEC number -->
