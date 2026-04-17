import { describe, expect, expectTypeOf, it } from "vitest";
import type { ReadonlyDeep, StandardSchemaV1 } from "../src/index.js";
import { ConcurrencyError, ValidationError, validate } from "../src/index.js";

describe("ReadonlyDeep", () => {
  it("enforces deep readonly at type level", () => {
    type Input = { a: { b: string }; c: number[] };
    type Result = ReadonlyDeep<Input>;

    const value: Result = { a: { b: "hello" }, c: [1, 2, 3] };
    expect(value.a.b).toBe("hello");
    expect(value.c).toEqual([1, 2, 3]);

    // @ts-expect-error — readonly violation
    value.a.b = "x";
    // @ts-expect-error — readonly violation on array
    value.c.push(4);
  });

  it("preserves tuple length and position types", () => {
    type Result = ReadonlyDeep<[{ a: string }, number]>;

    const value: Result = [{ a: "hello" }, 42];
    expect(value.length).toBe(2);
    expect(value[0].a).toBe("hello");
    expect(value[1]).toBe(42);

    // Position types are preserved at compile time: value[1] is number, not string | number
    const second: number = value[1];
    expect(second).toBe(42);

    // @ts-expect-error — deep readonly applies to nested tuple element (compile-time)
    value[0].a = "x";
    // @ts-expect-error — tuple element itself is readonly (compile-time)
    value[1] = 100;
  });

  it("preserves optional tuple elements", () => {
    type Result = ReadonlyDeep<[string, number?]>;
    expectTypeOf<Result>().toEqualTypeOf<readonly [string, number?]>();

    const withOptional: Result = ["a", 1];
    const withoutOptional: Result = ["a"];

    expect(withOptional[1]).toBe(1);
    expect(withoutOptional[1]).toBeUndefined();
  });

  it("preserves optional-only tuple shape", () => {
    // Codex review #5 の P1 指摘: `[A?]`, `[A?, B?]` のような optional-only tuple は
    // `length` が `0 | 1` / `0 | 1 | 2` の literal union なので tuple として保持される必要がある
    type Single = ReadonlyDeep<[number?]>;
    expectTypeOf<Single>().toEqualTypeOf<readonly [number?]>();

    type Pair = ReadonlyDeep<[string?, number?]>;
    expectTypeOf<Pair>().toEqualTypeOf<readonly [string?, number?]>();
  });

  it("preserves leading-fixed variadic tuple shape", () => {
    // `[Head, ...Tail[]]` は head の固定位置型と rest の要素型を保持しなければならない。
    // ここが破れると `readonly (string | number)[]` に退化する（Codex review #4 の指摘）。
    type Result = ReadonlyDeep<[string, ...number[]]>;
    expectTypeOf<Result>().toEqualTypeOf<readonly [string, ...number[]]>();

    const value: Result = ["a", 1, 2, 3];
    expect(value[0]).toBe("a");
    expect(value.slice(1)).toEqual([1, 2, 3]);
  });

  it("preserves trailing-fixed variadic tuple shape", () => {
    type Result = ReadonlyDeep<[...number[], string]>;
    expectTypeOf<Result>().toEqualTypeOf<readonly [...number[], string]>();
  });

  it("preserves middle-rest tuple shape", () => {
    // head + rest + tail の複合形も tuple として length・位置・要素型を保持する必要がある
    type Result = ReadonlyDeep<[string, ...number[], boolean]>;
    expectTypeOf<Result>().toEqualTypeOf<readonly [string, ...number[], boolean]>();
  });

  it("preserves empty tuple as readonly empty tuple", () => {
    type Result = ReadonlyDeep<[]>;
    expectTypeOf<Result>().toEqualTypeOf<readonly []>();
  });

  it("distinguishes plain array from tuple at type level", () => {
    type Result = ReadonlyDeep<number[]>;
    expectTypeOf<Result>().toEqualTypeOf<ReadonlyArray<number>>();
  });

  it("produces ReadonlyArray for non-tuple arrays (runtime contract)", () => {
    type Result = ReadonlyDeep<{ a: string }[]>;

    const value: Result = [{ a: "x" }];
    expect(value[0]?.a).toBe("x");

    // @ts-expect-error — ReadonlyArray disallows mutation
    value.push({ a: "y" });
    // @ts-expect-error — nested element is also readonly
    if (value[0]) value[0].a = "z";
  });
});

describe("ConcurrencyError", () => {
  it("is instanceof Error and ConcurrencyError", () => {
    const err = new ConcurrencyError("agg-1", 5);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConcurrencyError);
    expect(err.name).toBe("ConcurrencyError");
    expect(err.aggregateId).toBe("agg-1");
    expect(err.expectedVersion).toBe(5);
    expect(err.message).toContain("agg-1");
    expect(err.message).toContain("5");
  });

  it("has a stack trace", () => {
    const err = new ConcurrencyError("agg-2", 10);
    expect(err.stack).toBeDefined();
  });
});

// Standard Schema conformant test doubles: Zod / Valibot / ArkType に依存せず
// minamo が受け入れる interface のみを満たす最小実装。
function syncStringSchema(): StandardSchemaV1<unknown, string> {
  return {
    "~standard": {
      version: 1,
      vendor: "test-double-sync",
      validate: (value) =>
        typeof value === "string"
          ? { value }
          : { issues: [{ message: "expected string", path: ["root"] }] },
      types: { input: undefined as unknown, output: "" as string },
    },
  };
}

function asyncNumberSchema(): StandardSchemaV1<unknown, number> {
  return {
    "~standard": {
      version: 1,
      vendor: "test-double-async",
      validate: async (value) =>
        typeof value === "number" ? { value } : { issues: [{ message: "expected number" }] },
      types: { input: undefined as unknown, output: 0 as number },
    },
  };
}

function nestedPathSchema(): StandardSchemaV1<unknown, { user: { name: string } }> {
  return {
    "~standard": {
      version: 1,
      vendor: "test-double-nested",
      validate: () => ({
        issues: [
          { message: "required", path: ["user", { key: "name" }] },
          { message: "too short", path: [0, "items", 3] },
        ],
      }),
      types: {
        input: undefined as unknown,
        output: { user: { name: "" } } as { user: { name: string } },
      },
    },
  };
}

describe("ValidationError", () => {
  it("is instanceof Error and ValidationError", () => {
    const err = new ValidationError([{ message: "expected string" }]);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.name).toBe("ValidationError");
    expect(err.issues).toEqual([{ message: "expected string" }]);
  });

  it("formats path segments (string / PathSegment / number) in message", () => {
    const err = new ValidationError([
      { message: "required", path: ["user", { key: "name" }] },
      { message: "too short", path: [0, "items", 3] },
    ]);

    expect(err.message).toContain("user.name: required");
    expect(err.message).toContain("0.items.3: too short");
  });

  it("omits path prefix when path is absent or empty", () => {
    const err = new ValidationError([
      { message: "root failure" },
      { message: "also root", path: [] },
    ]);

    expect(err.message).toBe("Validation failed: root failure; also root");
  });

  it("preserves issues reference for programmatic inspection", () => {
    const issues = [{ message: "x" }] as const;
    const err = new ValidationError(issues);
    expect(err.issues).toBe(issues);
  });
});

describe("validate (Standard Schema)", () => {
  it("returns Output for sync-valid input", async () => {
    const schema = syncStringSchema();
    const result = await validate(schema, "hello");
    expect(result).toBe("hello");
    expectTypeOf(result).toEqualTypeOf<string>();
  });

  it("returns Output for async-valid input", async () => {
    const schema = asyncNumberSchema();
    const result = await validate(schema, 42);
    expect(result).toBe(42);
    expectTypeOf(result).toEqualTypeOf<number>();
  });

  it("throws ValidationError on sync failure with structured issues", async () => {
    const schema = syncStringSchema();
    await expect(validate(schema, 123)).rejects.toThrow(ValidationError);
    await expect(validate(schema, 123)).rejects.toMatchObject({
      name: "ValidationError",
      issues: [{ message: "expected string", path: ["root"] }],
    });
  });

  it("throws ValidationError on async failure", async () => {
    const schema = asyncNumberSchema();
    await expect(validate(schema, "oops")).rejects.toBeInstanceOf(ValidationError);
  });

  it("propagates multiple issues with composed paths in message", async () => {
    const schema = nestedPathSchema();
    await expect(validate(schema, {})).rejects.toThrow(/user\.name: required/);
    await expect(validate(schema, {})).rejects.toThrow(/0\.items\.3: too short/);
  });

  it("infers Output via InferSchemaOutput from concrete schema", () => {
    // 型レベルのみの regression gate: validate 戻り値が Output に narrow されることを
    // expectTypeOf で compile-time に検証する。runtime assertion は上の happy-path ケースで担保。
    const schema = syncStringSchema();
    expectTypeOf(validate(schema, "x")).resolves.toEqualTypeOf<string>();

    const numberSchema = asyncNumberSchema();
    expectTypeOf(validate(numberSchema, 1)).resolves.toEqualTypeOf<number>();
  });
});
