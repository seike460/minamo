/**
 * Standard Schema v1 interface.
 *
 * Zod / Valibot / ArkType 等が実装する validator の共通仕様。minamo は input
 * validation を consumer 側の外部層に任せる設計 (§5.3 CommandHandler 参照) のため、
 * interface のみを型として受け入れ、特定 validator 実装には依存しない。
 *
 * spec: https://standardschema.dev
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** spec で定義される hidden namespace。vendor が validate / types を public するためのマーカー。 */
  readonly "~standard": StandardSchemaProps<Input, Output>;
}

/**
 * Standard Schema vendor が実装する validator の public 面。
 *
 * @typeParam Input - validate 前の入力型。
 * @typeParam Output - validate 成功時の出力型 (coerce / transform 後)。
 */
export interface StandardSchemaProps<Input = unknown, Output = Input> {
  /** spec バージョン (常に `1`)。 */
  readonly version: 1;
  /** vendor 識別子 (`"zod"`, `"valibot"`, `"arktype"` 等)。 */
  readonly vendor: string;
  /**
   * validate 関数。成功時は `{ value }`、失敗時は `{ issues }` を返す。
   *
   * 同期 / 非同期のどちらの実装でも受け入れる。`minamo/validation#validate` が
   * `Promise.resolve` で包んで正規化する。
   */
  readonly validate: (
    value: unknown,
  ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
  /** `InferSchemaInput` / `InferSchemaOutput` による型抽出のための accessor (optional)。 */
  readonly types?: StandardSchemaTypes<Input, Output>;
}

/** validate 結果の discriminated union (成功 or 失敗)。 */
export type StandardSchemaResult<Output> = StandardSchemaSuccess<Output> | StandardSchemaFailure;

/**
 * validate 成功時の結果。
 *
 * @typeParam Output - 出力型。
 */
export interface StandardSchemaSuccess<Output> {
  /** coerce / transform 済の出力値。 */
  readonly value: Output;
  /** 成功時は常に undefined (失敗と区別するための discriminator)。 */
  readonly issues?: undefined;
}

/**
 * validate 失敗時の結果。`issues` が空配列であっても "失敗" として扱う。
 */
export interface StandardSchemaFailure {
  /** 構造化された違反情報の配列。 */
  readonly issues: readonly StandardSchemaIssue[];
}

/**
 * validate 違反 1 件分の構造化情報。
 *
 * path は network path (配列や object ネストを `key` segment の列で表現) で、
 * primitive segment と object segment (`{ key }`) が混在しうる。
 */
export interface StandardSchemaIssue {
  /** human-readable な違反説明。 */
  readonly message: string;
  /** 違反箇所を表す path segment 列 (optional)。 */
  readonly path?: readonly (PropertyKey | StandardSchemaPathSegment)[];
}

/**
 * path 内で object 形式を取るための segment。primitive segment (`string | number | symbol`) と
 * 併用される。
 */
export interface StandardSchemaPathSegment {
  /** path の key (property name / array index / symbol)。 */
  readonly key: PropertyKey;
}

/**
 * `InferSchemaInput` / `InferSchemaOutput` が参照する型 accessor。
 *
 * runtime には値を持たない (optional) が、TypeScript の型抽出に使われる。
 *
 * @typeParam Input - validate 前の入力型。
 * @typeParam Output - validate 成功時の出力型。
 */
export interface StandardSchemaTypes<Input = unknown, Output = Input> {
  /** 入力型。runtime には undefined (型抽出にのみ使用)。 */
  readonly input: Input;
  /** 出力型。runtime には undefined (型抽出にのみ使用)。 */
  readonly output: Output;
}

/** Schema の Input 型を導出する (spec 準拠: types.input accessor) */
export type InferSchemaInput<Schema extends StandardSchemaV1> = NonNullable<
  Schema["~standard"]["types"]
>["input"];

/** Schema の Output 型を導出する (spec 準拠: types.output accessor) */
export type InferSchemaOutput<Schema extends StandardSchemaV1> = NonNullable<
  Schema["~standard"]["types"]
>["output"];
