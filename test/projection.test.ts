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

  it("CT-PB-12 narrows stored.type to TEventName at the type level", () => {
    const result = parseStreamRecord<CounterEvents, "Incremented">(insertRecord(), ["Incremented"]);
    expectTypeOf(result).toEqualTypeOf<StoredEvent<"Incremented", unknown> | null>();
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
});
