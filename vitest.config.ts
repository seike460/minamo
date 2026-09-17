import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // coverage は root レベルで宣言し全 project に適用される。
    // src 全体を対象にするため、DynamoEventStore (event-store/dynamo/*) は
    // integration test 側でカバーされる前提で、unit-only 計測では低めに出る。
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // 型のみファイル (runtime 出力ゼロ。verbatimModuleSyntax でビルド時に消える) は
      // coverage 上 0% のノイズになるため除外し、実行コードに数値を集中させる。
      exclude: [
        "src/types.ts",
        "src/standard-schema.ts",
        "src/**/types.ts",
        "src/core/aggregate.ts",
        "src/observability.ts",
      ],
      reporter: ["text", "json-summary", "html"],
      // 後退を CI で検出する閾値 (DEC-024 / CTeO・COO 指摘)。
      // unit-only 計測のため DynamoEventStore / DynamoSnapshotStore (event-store/dynamo/*) は
      // integration test 側でカバーされ unit では低めに出る。現状値
      // (stmts 98 / branch 98 / func 100 / lines 98) に余裕を持たせた下限とし、
      // 残りの未カバー分は実 SDK 到達不能の defense-in-depth 分岐である前提とする。
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 85,
        lines: 90,
      },
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.integration.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/**/*.integration.test.ts"],
          environment: "node",
          testTimeout: 30000,
        },
      },
    ],
  },
});
