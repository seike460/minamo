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
 * await executeCommand({ aggregate, handler, input, ... });
 * ```
 */
export async function validate<Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
): Promise<InferSchemaOutput<Schema>> {
  const raw = schema["~standard"].validate(value);
  const result = await Promise.resolve(raw);
  if (result.issues) throw new ValidationError(result.issues);
  return result.value as InferSchemaOutput<Schema>;
}
