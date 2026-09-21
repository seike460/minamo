import { ValidationError } from "./errors.js";
import { hasOwnOrAccessor, isObjectRecord } from "./internal/guards.js";
import type { InferSchemaOutput, StandardSchemaV1 } from "./standard-schema.js";

/**
 * Standard Schema でバリデートし、成功時は Output を返す。失敗時は ValidationError を throw。
 *
 * schema["~standard"].validate は同期・非同期のどちらを返す実装でも受け入れる。
 *
 * 使い方:
 * ```ts
 * const input = await validate(userCommandInputSchema, raw);
 * await executeCommand({ config, store, handler, aggregateId, input });
 * ```
 */
export async function validate<Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
): Promise<InferSchemaOutput<Schema>> {
  // `~standard.validate` を持たない入力 (null / 別の object / 古い spec 形状) を
  // プロパティアクセスの生 TypeError ではなく契約違反として弾く。
  const standard = (schema as StandardSchemaV1 | null | undefined)?.["~standard"];
  if (!isObjectRecord(standard) || typeof standard.validate !== "function") {
    throw new TypeError("schema does not implement Standard Schema v1");
  }
  const result = await Promise.resolve(standard.validate(value));
  // Standard Schema 非準拠の結果 (null / 配列 / issues が非配列 / value も issues も無い) を弾く。
  // 非配列 issues を ValidationError に流すと consumer が issues.map 等で生 TypeError を踏む。
  if (!isObjectRecord(result)) {
    throw new TypeError("schema returned a non-object result");
  }
  // `issues` が定義されていれば失敗。own property に限定すると、prototype
  // getter で `issues` を供給する非準拠の失敗結果を成功に誤分類し、
  // 検証失敗の入力が `value` として通ってしまう。spec 上 success の
  // `issues` は `undefined` のみ許容されるため、定義済みなら常に失敗側に倒す。
  if (result.issues !== undefined) {
    if (!Array.isArray(result.issues)) {
      throw new TypeError("schema returned non-array issues");
    }
    throw new ValidationError(result.issues);
  }
  // `value` の存在判定も `issues` と同じ境界ルールに揃える: own property か
  // prototype getter のみ受理し、prototype 上の data property は欠落として扱う
  // (snapshot / initialState の存在判定と同じく prototype 汚染経路を塞ぐ)。
  if (!hasOwnOrAccessor(result, "value")) {
    throw new TypeError("schema result has neither value nor issues");
  }
  // `in` では union が narrow されないため明示的に読み出す
  return (result as { value: unknown }).value as InferSchemaOutput<Schema>;
}
