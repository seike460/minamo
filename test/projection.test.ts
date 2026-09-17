import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { StoredEvent } from "../src/index.js";
import { eventNamesOf, InvalidStreamRecordError, parseStreamRecord } from "../src/index.js";
import { type CounterEvents, counterConfig } from "./fixtures/counter.js";
import {
  insertRecord,
  insertWithCorruptNewImage,
  insertWithoutNewImage,
  modifyRecord,
  removeRecord,
  type StreamRecordFixture,
} from "./fixtures/stream-records.js";

const acceptedNames: ReadonlyArray<keyof CounterEvents & string> = ["Incremented"];

describe("parseStreamRecord", () => {
  it("CT-PB-01 returns a StoredEvent for a valid INSERT record", () => {
    const result = parseStreamRecord<CounterEvents>(insertRecord(), acceptedNames);
    expect(result).not.toBeNull();
    expect(result?.aggregateId).toBe("agg-1");
    expect(result?.version).toBe(1);
    expect(result?.type).toBe("Incremented");
    expect(result?.data).toEqual({ amount: 5 });
    expect(result?.timestamp).toBe("2026-04-17T00:00:00.000Z");
  });

  it("CT-PB-02 returns null for MODIFY", () => {
    expect(parseStreamRecord<CounterEvents>(modifyRecord, acceptedNames)).toBeNull();
  });

  it("CT-PB-03 returns null for REMOVE", () => {
    expect(parseStreamRecord<CounterEvents>(removeRecord, acceptedNames)).toBeNull();
  });

  it("CT-PB-04 throws missing_field when NewImage is absent", () => {
    try {
      parseStreamRecord<CounterEvents>(insertWithoutNewImage, acceptedNames);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStreamRecordError);
      const e = err as InvalidStreamRecordError;
      expect(e.reason).toBe("missing_field");
      expect(e.detail).toBe("dynamodb.NewImage");
    }
  });

  it("CT-PB-05 throws missing_field when aggregateId is not a string", () => {
    const bad = {
      eventName: "INSERT" as const,
      dynamodb: {
        NewImage: marshall({
          version: 1,
          type: "Incremented",
          data: { amount: 1 },
          timestamp: "2026-04-17T00:00:00.000Z",
        }) as Record<string, unknown>,
      },
    };
    try {
      parseStreamRecord<CounterEvents>(bad, acceptedNames);
      expect.fail("expected throw");
    } catch (err) {
      const e = err as InvalidStreamRecordError;
      expect(e.reason).toBe("missing_field");
      expect(e.detail).toBe("aggregateId");
    }
  });

  it("CT-PB-06 throws missing_field when version is not a number", () => {
    const bad = insertRecord({
      aggregateId: "agg-1",
      version: "one",
      type: "Incremented",
      data: {},
      timestamp: "2026-04-17T00:00:00.000Z",
    });
    try {
      parseStreamRecord<CounterEvents>(bad, acceptedNames);
      expect.fail("expected throw");
    } catch (err) {
      const e = err as InvalidStreamRecordError;
      expect(e.reason).toBe("missing_field");
      expect(e.detail).toBe("version");
    }
  });

  it("CT-PB-07 throws unknown_type for unregistered type in strict mode", () => {
    const bad = insertRecord({
      aggregateId: "agg-1",
      version: 1,
      type: "NotRegistered",
      data: {},
      timestamp: "2026-04-17T00:00:00.000Z",
    });
    try {
      parseStreamRecord<CounterEvents>(bad, acceptedNames);
      expect.fail("expected throw");
    } catch (err) {
      const e = err as InvalidStreamRecordError;
      expect(e.reason).toBe("unknown_type");
      expect(e.detail).toBe("NotRegistered");
    }
  });

  it("CT-PB-08 returns null for unregistered type when ignoreUnknownTypes is true", () => {
    const bad = insertRecord({
      aggregateId: "agg-1",
      version: 1,
      type: "NotRegistered",
      data: {},
      timestamp: "2026-04-17T00:00:00.000Z",
    });
    const result = parseStreamRecord<CounterEvents>(bad, acceptedNames, {
      ignoreUnknownTypes: true,
    });
    expect(result).toBeNull();
  });

  it("CT-PB-09 preserves correlationId when provided", () => {
    const rec = insertRecord({
      aggregateId: "agg-1",
      version: 1,
      type: "Incremented",
      data: { amount: 3 },
      timestamp: "2026-04-17T00:00:00.000Z",
      correlationId: "corr-abc",
    });
    const result = parseStreamRecord<CounterEvents>(rec, acceptedNames);
    expect(result?.correlationId).toBe("corr-abc");
  });

  it("CT-PB-10 omits correlationId property when not present in NewImage", () => {
    const result = parseStreamRecord<CounterEvents>(insertRecord(), acceptedNames);
    expect(Object.hasOwn(result ?? {}, "correlationId")).toBe(false);
  });

  it("CT-PB-11 throws unmarshal_failed when NewImage is a corrupt AttributeValue", () => {
    try {
      parseStreamRecord<CounterEvents>(insertWithCorruptNewImage, acceptedNames);
      expect.fail("expected throw");
    } catch (err) {
      const e = err as InvalidStreamRecordError;
      expect(e.reason).toBe("unmarshal_failed");
    }
  });

  it("CT-PB-13 throws missing_field when version is not an integer >= 1", () => {
    // NaN は DynamoDB number として表現不能 (marshall が拒否) なため stream 経由では
    // 到達しない。非整数・0 のみ検証する (NaN は typeof 検査側で弾かれる)。
    for (const version of [1.5, 0, -2]) {
      const bad = insertRecord({
        aggregateId: "agg-1",
        version,
        type: "Incremented",
        data: { amount: 1 },
        timestamp: "2026-04-17T00:00:00.000Z",
      });
      try {
        parseStreamRecord<CounterEvents>(bad, acceptedNames);
        expect.fail(`expected throw for version=${String(version)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidStreamRecordError);
        expect((err as InvalidStreamRecordError).reason).toBe("missing_field");
      }
    }
  });

  it("CT-PB-14 throws missing_field when data attribute is absent", () => {
    const bad = insertRecord({
      aggregateId: "agg-1",
      version: 1,
      type: "Incremented",
      timestamp: "2026-04-17T00:00:00.000Z",
    });
    try {
      parseStreamRecord<CounterEvents>(bad, acceptedNames);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStreamRecordError);
      expect((err as InvalidStreamRecordError).reason).toBe("missing_field");
      expect((err as InvalidStreamRecordError).detail).toBe("data");
    }
  });

  it("CT-PB-15 throws missing_field when a required field is only reachable via a polluted prototype", () => {
    // unmarshall は `"__proto__"` キーを持つ Map で結果 object の [[Prototype]] を
    // 汚染する。version を own property として持たず __proto__ Map 経由で偽装する
    // record を再現する (computed key は own property "__proto__" を作る)。
    const forged: StreamRecordFixture = {
      eventName: "INSERT",
      dynamodb: {
        NewImage: {
          aggregateId: { S: "agg-1" },
          type: { S: "Incremented" },
          timestamp: { S: "2026-04-17T00:00:00.000Z" },
          data: { M: { amount: { N: "5" } } },
          ["__proto__"]: { M: { version: { N: "1" } } },
        },
      },
    };
    try {
      parseStreamRecord<CounterEvents>(forged, acceptedNames);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStreamRecordError);
      expect((err as InvalidStreamRecordError).reason).toBe("missing_field");
    }
  });

  it("CT-PB-12 narrows stored.type to TEventName at the type level", () => {
    const result = parseStreamRecord<CounterEvents, "Incremented">(insertRecord(), ["Incremented"]);
    expectTypeOf(result).toEqualTypeOf<StoredEvent<"Incremented", unknown> | null>();
  });

  it("CT-PB-17 throws TypeError when eventNames is not an array", () => {
    // `eventNames.includes` が生 TypeError になる前に入口で弾く。
    for (const bad of [null, undefined, "Incremented", 42, { includes: () => true }]) {
      expect(() => parseStreamRecord<CounterEvents>(insertRecord(), bad as never)).toThrow(
        TypeError,
      );
    }
  });

  it("CT-PB-18 throws missing_field when NewImage unmarshalls to an empty item", () => {
    // NewImage が空 map だと unmarshall は {} を返す。必須 field 欠落として
    // missing_field で弾く (生 TypeError に落とさない)。
    const bad: StreamRecordFixture = { eventName: "INSERT", dynamodb: { NewImage: {} } };
    try {
      parseStreamRecord<CounterEvents>(bad, acceptedNames);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStreamRecordError);
      const e = err as InvalidStreamRecordError;
      expect(e.reason).toBe("missing_field");
      expect(e.detail).toBe("aggregateId");
    }
  });

  it("CT-PB-20 throws TypeError when options is not an object", () => {
    // 非 object の options は `options?.ignoreUnknownTypes` が undefined に揃って
    // strict mode として静かに無視されるため入口で弾く。配列も同じく
    // `ignoreUnknownTypes` を持たず silent skip になるため拒否する。
    for (const bad of [null, 42, "opts", [], () => {}]) {
      expect(() =>
        parseStreamRecord<CounterEvents>(insertRecord(), acceptedNames, bad as never),
      ).toThrow(TypeError);
    }
  });

  it("CT-PB-19 throws missing_field when aggregateId is an empty string", () => {
    // 空文字は DynamoDB partition key として成立しないため欠落扱いにする。
    const bad = insertRecord({
      aggregateId: "",
      version: 1,
      type: "Incremented",
      data: { amount: 1 },
      timestamp: "2026-04-17T00:00:00.000Z",
    });
    try {
      parseStreamRecord<CounterEvents>(bad, acceptedNames);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStreamRecordError);
      const e = err as InvalidStreamRecordError;
      expect(e.reason).toBe("missing_field");
      expect(e.detail).toBe("aggregateId");
    }
  });

  it("CT-PB-16 throws missing_field when type or timestamp is absent", () => {
    // type / timestamp の欠落も missing_field で detail に field 名が入る。
    const noType = insertRecord({
      aggregateId: "agg-1",
      version: 1,
      data: {},
      timestamp: "2026-04-17T00:00:00.000Z",
    });
    const noTimestamp = insertRecord({
      aggregateId: "agg-1",
      version: 1,
      type: "Incremented",
      data: {},
    });
    for (const [bad, detail] of [
      [noType, "type"],
      [noTimestamp, "timestamp"],
    ] as const) {
      try {
        parseStreamRecord<CounterEvents>(bad, acceptedNames);
        expect.fail(`expected throw for missing ${detail}`);
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidStreamRecordError);
        const e = err as InvalidStreamRecordError;
        expect(e.reason).toBe("missing_field");
        expect(e.detail).toBe(detail);
      }
    }
  });
});

describe("eventNamesOf", () => {
  it("CT-EN-01 returns a single key for a single-event Aggregate", () => {
    expect(eventNamesOf(counterConfig)).toEqual(["Incremented"]);
  });

  it("CT-EN-02 returns all keys of evolve regardless of declaration order", () => {
    type MultiEvents = {
      Beta: { b: number };
      Alpha: { a: number };
      Gamma: { g: number };
    };
    const multiConfig = {
      initialState: {},
      evolve: {
        Alpha: () => ({}),
        Beta: () => ({}),
        Gamma: () => ({}),
      },
    } as unknown as Parameters<typeof eventNamesOf<Record<string, never>, MultiEvents>>[0];
    const names = eventNamesOf(multiConfig);
    expect([...names].sort()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("returns a ReadonlyArray narrowed to keyof TMap & string at the type level", () => {
    const names = eventNamesOf(counterConfig);
    expectTypeOf(names).toEqualTypeOf<ReadonlyArray<"Incremented">>();
  });

  it("CT-EN-03 throws TypeError when config.evolve is not an object", () => {
    // `Object.keys("ab")` は ["0","1"] の garbage を返し、結果の eventNames が
    // 全件 unknown_type 判定になる静かな破綻を生む。入口で弾く。
    for (const bad of [
      null,
      "config",
      {}, // evolve 欠落
      { evolve: null },
      { evolve: "ab" }, // Object.keys → ["0","1"] の garbage
      { evolve: 42 },
      { evolve: [] }, // Object.keys([]) → [] で全件 unknown_type になる
      { evolve: () => {} }, // function は own enumerable key を持たず [] になる
    ]) {
      expect(() => eventNamesOf(bad as never)).toThrow(TypeError);
    }
  });
});
