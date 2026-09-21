# minamo -- Development Rules

## Project
- minamo -- Type-safe CQRS+ES for AWS Serverless
- npm: @seike460/minamo | GitHub: seike460/minamo | License: MIT

## Current Phase: Released / v0.2.0 (v1 機能実装完了, v0.3/v0.4 = 安定性窓)
- Published: npm `@seike460/minamo` v0.2.0。v1 機能群 (U10〜U18: observability / runner / facade / RetryExhaustedError / upcasting / SnapshotStore / loadFrom / snapshot 統合) を単一 v0.2.0 で一括導入済み (DEC-025)。公開 API は concept.md §5 に逐字従属
- Concept: docs/concept.md (approved。§5.10〜5.13 が v0.2.0 機能の正本)
- Design principles: docs/concept.md §4 "設計の姿勢"
- Detailed design: docs/design/v0.1.0.md (v0.1.0 コア) / docs/design/v0.2.0.md (v1 機能 U10〜U18)
- Roadmap: docs/roadmap-v1.md (v1.0.0 到達シーケンスと卒業条件) / docs/roadmap.md (軽量 backlog)
- 残る v1.0.0 障壁は非コードの卒業条件 (3-minor 安定窓 / 外部採用 ≥1 / co-maintainer ≥1)

## Toolchain
- Build: tsdown (Rolldown-based, ESM-only output)
- Package Manager: pnpm
- Test: vitest
- Lint/Format: Biome
- Type Quality: attw + publint (CI integration)
- TypeScript: strict, module=nodenext, target=ES2024, verbatimModuleSyntax=true

## Commands
- `pnpm run build` -- tsdown ESM build
- `pnpm run test` -- vitest unit tests
- `pnpm run test:integration` -- vitest + DynamoDB Local (Docker required)
- `pnpm run lint` -- biome check
- `pnpm run format` -- biome check --write
- `pnpm run type-check` -- tsc --noEmit
- `pnpm run check-exports` -- attw + publint
  - `--profile esm-only` 指定のため、attw は `node10` / `node16-cjs` resolution を無視する（ESM-only パッケージのため CJS 解決経路は評価対象外）。profile を変更する場合は attw docs を参照のこと。

## Code Style
- ESM: `"type": "module"`, import paths include `.js` extension
- Types use `import type` (verbatimModuleSyntax)
- Biome for formatting and linting (not ESLint/Prettier)

## Architecture
- Public API follows concept.md section 5 type signatures exactly
- Do not implement what is not in API Design
- Runtime dependency: AWS SDK v3 only (peerDependencies)
- Error classes use Object.setPrototypeOf pattern for instanceof safety
- structuredClone for initialState copy in rehydrate

## Testing
- Contract Tests: same test suite runs against InMemoryEventStore and DynamoEventStore
- Test-first: Red, Green, Refactor
- DynamoDB integration tests require Docker (amazon/dynamodb-local)
- Deterministic test doubles for retry logic (no timing-based tests)

## Package
- exports: `{ ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }`
- sideEffects: false
- engines: `{ "node": ">=24" }`
- peerDependencies: @aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb, @aws-sdk/util-dynamodb (^3.0.0) -- `peerDependenciesMeta.optional` 指定。DynamoEventStore は実装済みだが、InMemoryEventStore のみ使う consumer に AWS SDK を強制しないため optional を維持する

## Git
- Conventional commits: feat/fix/chore/docs/refactor/test
- Commit messages: public-quality, sharp, essential (no internal process details)

## Language
- Respond in Japanese (technical terms in English)
