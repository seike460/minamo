import { ValidationError } from "./errors.js";
import { isObjectRecord } from "./internal/guards.js";
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
  // `value` と同じく own property で判定する — prototype chain 由来の `issues`
  // を拾うと `{value}` を返す正常な結果が failure に誤分類される。
  if (Object.hasOwn(result, "issues") && result.issues !== undefined) {
    if (!Array.isArray(result.issues)) {
      throw new TypeError("schema returned non-array issues");
    }
    throw new ValidationError(result.issues);
  }
  if (!Object.hasOwn(result, "value")) {
    throw new TypeError("schema result has neither value nor issues");
  }
  // `hasOwn` では union が narrow されないため明示的に読み出す
  return (result as { value: unknown }).value as InferSchemaOutput<Schema>;
}
