# minamo -- Development Rules

## Project
- minamo -- Type-safe CQRS+ES for AWS Serverless
- npm: @seike460/minamo | GitHub: seike460/minamo | License: MIT

## Current Phase: Released / v0.1.x Maintenance
- Published: npm `@seike460/minamo` (0.1.x line, public API frozen per concept.md §5)
- Concept: docs/concept.md (approved)
- Design principles: docs/concept.md §4 "設計の姿勢"
- Detailed design: docs/design/v0.1.0.md (§5 実装計画・モジュール構造・test strategy)
- Future work: docs/roadmap.md (v0.2.x candidates, not committed)

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
