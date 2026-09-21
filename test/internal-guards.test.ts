import { describe, expect, it } from "vitest";
import { hasOwnOrAccessor } from "../src/internal/guards.js";

/**
 * `hasOwnOrAccessor` の単体検証。
 *
 * 境界ルール: own property (data / accessor) と prototype chain 上の getter
 * accessor は受理するが、prototype 上の data property は prototype 汚染の
 * 経路になるため欠落として拒否する。rehydrate / snapshot load 経路を通じた
 * 振る舞い検証は rehydrate.test.ts / snapshot.test.ts にある。
 */
describe("hasOwnOrAccessor", () => {
  it("own data property / own getter を受理する", () => {
    expect(hasOwnOrAccessor({ key: 1 }, "key")).toBe(true);
    const ownGetter = {
      get key() {
        return 1;
      },
    };
    expect(hasOwnOrAccessor(ownGetter, "key")).toBe(true);
  });

  it("prototype getter を受理する (class instance / 中間 prototype)", () => {
    class WithGetter {
      get key(): number {
        return 1;
      }
    }
    expect(hasOwnOrAccessor(new WithGetter(), "key")).toBe(true);
    // 中間 prototype 上の getter も accessor として受理する
    const mid = Object.create(WithGetter.prototype);
    const leaf = Object.create(mid);
    expect(hasOwnOrAccessor(leaf, "key")).toBe(true);
  });

  it("inherited data property は拒否する (Object.create / setPrototypeOf / 中間 prototype)", () => {
    expect(hasOwnOrAccessor(Object.create({ key: 1 }), "key")).toBe(false);
    const viaProto = {};
    Object.setPrototypeOf(viaProto, { key: 1 });
    expect(hasOwnOrAccessor(viaProto, "key")).toBe(false);
    // 中間 prototype 経由の data property も拒否する
    const leaf = Object.create(Object.create({ key: 1 }));
    expect(hasOwnOrAccessor(leaf, "key")).toBe(false);
  });

  it("prototype 上の setter-only accessor は拒否する (get を持たない)", () => {
    // prototype 経由では callable な `get` を持つ accessor のみ受理する。
    // setter-only は読み出せないため存在しない扱いにする。
    const setterOnly = Object.create(
      Object.defineProperty({}, "key", {
        set: (_v: unknown) => {},
      }),
    );
    expect(hasOwnOrAccessor(setterOnly, "key")).toBe(false);
    // own property は種別を問わず受理する (own setter-only は読み出し時に
    // undefined になり、呼び出し側の値検証で弾かれる)
    const ownSetter = Object.defineProperty({}, "key", {
      set: (_v: unknown) => {},
    });
    expect(hasOwnOrAccessor(ownSetter, "key")).toBe(true);
  });

  it("key が存在しなければ false", () => {
    expect(hasOwnOrAccessor({}, "missing")).toBe(false);
    expect(hasOwnOrAccessor(Object.create(null), "missing")).toBe(false);
  });

  it("getPrototypeOf が自分自身を返す Proxy でも無限ループせず false", () => {
    const cyclic: object = new Proxy(
      {},
      {
        getPrototypeOf: () => cyclic,
      },
    );
    expect(hasOwnOrAccessor(cyclic, "key")).toBe(false);
  });
});
