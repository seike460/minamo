import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  dts: false,
  clean: true,
  outDir: "dist",
  sourcemap: true,
  // tsdown v0.21 では `package.json` `"type": "module"` があっても出力拡張子が
  // `.mjs` になる挙動。`exports` は `./dist/index.js` を指すため明示的に `.js`
  // に固定して整合を取る。将来 tsdown upgrade 時に削除可否を検討すること。
  outExtensions: () => ({ js: ".js" }),
});
