import { ValidationError } from "./errors.js";
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
  if (
    standard === null ||
    typeof standard !== "object" ||
    typeof standard.validate !== "function"
  ) {
    throw new TypeError("schema does not implement Standard Schema v1");
  }
  const result = await Promise.resolve(standard.validate(value));
  // Standard Schema 非準拠の結果 (null / issues が非配列 / value も issues も無い) を弾く。
  // 非配列 issues を ValidationError に流すと consumer が issues.map 等で生 TypeError を踏む。
  if (result === null || typeof result !== "object") {
    throw new TypeError("schema returned a non-object result");
  }
  if (result.issues !== undefined) {
    if (!Array.isArray(result.issues)) {
      throw new TypeError("schema returned non-array issues");
    }
    throw new ValidationError(result.issues);
  }
  if (!Object.hasOwn(result, "value")) {
    throw new TypeError("schema result has neither value nor issues");
  }
  return result.value as InferSchemaOutput<Schema>;
}
