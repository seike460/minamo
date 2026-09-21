import { describe, expect, it } from "vitest";
import { requirePeer } from "../src/internal/require-peer.js";

/**
 * requirePeer (DEC-027) の単体検証。scripts/verify-optional-peer.mjs が
 * 「SDK 不在の隔離環境で dist が fail-loud する」ことを subprocess で担保するのに対し、
 * ここでは src 上の振る舞い (成功・cache・失敗時の契約) を直接検証する。
 */

// devDependencies に存在するため解決可能な specifier。
const INSTALLED = "@aws-sdk/util-dynamodb";
// 確実に不在の specifier (この名前の @aws-sdk パッケージは公開・依存ともに存在しない)。
const MISSING = "@aws-sdk/minamo-nonexistent-peer-for-test";

describe("requirePeer", () => {
  it("install 済み specifier は module を返す", () => {
    const mod = requirePeer<typeof import("@aws-sdk/util-dynamodb")>(INSTALLED);
    expect(typeof mod.marshall).toBe("function");
    expect(typeof mod.unmarshall).toBe("function");
  });

  it("同一 specifier は cache され同一 instance を返す", () => {
    const first = requirePeer<unknown>(INSTALLED);
    const second = requirePeer<unknown>(INSTALLED);
    expect(second).toBe(first);
  });

  it("未 install の specifier は導線を示す Error で fail する", () => {
    let err: unknown;
    try {
      requirePeer(MISSING);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof Error)) return;
    expect(err.message).toContain(`optional peer dependency "${MISSING}" is not installed`);
    expect(err.message).toContain("Install the AWS SDK v3 packages");
    // 原因となった resolution error は cause に保持される (診断情報の喪失を防ぐ)
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("失敗した specifier は cache せず、再試行でも同じ Error で fail する", () => {
    expect(() => requirePeer(MISSING)).toThrow(/optional peer dependency/);
    expect(() => requirePeer(MISSING)).toThrow(/optional peer dependency/);
  });
});
