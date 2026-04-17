/**
 * object / array / tuple を再帰的に readonly 化する。
 *
 * tuple の length・位置別型・variadic 構造は保持し、関数型はそのまま通す。
 * 通常の配列は `ReadonlyArray` に変換される。
 *
 * @example
 * ```ts
 * type T = ReadonlyDeep<{ a: { b: number }; c: [string, number[]] }>;
 * // { readonly a: { readonly b: number }; readonly c: readonly [string, readonly number[]] }
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: ReadonlyDeep requires `any` for function detection
export type ReadonlyDeep<T> = T extends (...args: any[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? IsTuple<T> extends true
      ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
      : ReadonlyArray<ReadonlyDeep<T[number]>>
    : T extends object
      ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
      : T;

/**
 * @internal
 * 2 段階で判定する:
 *   (1) `length` が literal (0 / 1 / 2 / 0|1 / ... のような有限 union) なら fixed-length tuple
 *       — これは `[]`, `[A]`, `[A, B]`, `[A?]`, `[A?, B?]` 等すべての optional-only を含む
 *   (2) `length` が `number` なら variadic tuple か plain array のどちらかなので、
 *       先頭 or 末尾 fixed の構造パターンで variadic tuple のみを拾い、残りは array
 * 単純な length ベースや単純な構造パターンのどちらか片方だけでは取りこぼしが出るため、
 * 両者を合わせて使う (過去の Codex review #4 / #5 指摘で判明)
 */
type IsTuple<T extends readonly unknown[]> = number extends T["length"]
  ? T extends readonly [unknown, ...unknown[]] | readonly [...unknown[], unknown]
    ? true
    : false
  : true;
