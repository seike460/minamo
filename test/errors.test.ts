import { describe, expect, it } from "vitest";
import {
  EventLimitError,
  InvalidEventStreamError,
  InvalidStreamRecordError,
} from "../src/index.js";

describe("EventLimitError", () => {
  it("is instanceof Error and EventLimitError, carries aggregateId + name", () => {
    const err = new EventLimitError("agg-1", "events must not be empty");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EventLimitError);
    expect(err.name).toBe("EventLimitError");
    expect(err.aggregateId).toBe("agg-1");
    expect(err.message).toBe("events must not be empty");
    expect(err.stack).toBeDefined();
  });
});

describe("InvalidEventStreamError", () => {
  it("exposes reason + aggregateId, instanceof chain preserved", () => {
    const err = new InvalidEventStreamError("agg-2", "version_gap", "version 3 expected 2", {
      eventIndex: 2,
      expectedVersion: 2,
      actualVersion: 3,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(InvalidEventStreamError);
    expect(err.name).toBe("InvalidEventStreamError");
    expect(err.aggregateId).toBe("agg-2");
    expect(err.reason).toBe("version_gap");
    expect(err.details).toEqual({ eventIndex: 2, expectedVersion: 2, actualVersion: 3 });
  });

  it("omits details property entirely when constructor argument is undefined", () => {
    const err = new InvalidEventStreamError("agg-3", "aggregateId_mismatch", "id mismatch");
    expect(Object.hasOwn(err, "details")).toBe(false);
    expect(err.details).toBeUndefined();
  });

  it("accepts all five reasons as discriminated union", () => {
    const reasons = [
      "aggregateId_mismatch",
      "non_monotonic_version",
      "version_gap",
      "invalid_initial_version",
      "missing_evolve_handler",
    ] as const;
    for (const reason of reasons) {
      const err = new InvalidEventStreamError("agg", reason, reason);
      expect(err.reason).toBe(reason);
    }
  });
});

describe("InvalidStreamRecordError", () => {
  it("exposes reason + detail when provided", () => {
    const err = new InvalidStreamRecordError("unknown_type", "type not allowed", "FooEvent");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(InvalidStreamRecordError);
    expect(err.name).toBe("InvalidStreamRecordError");
    expect(err.reason).toBe("unknown_type");
    expect(err.detail).toBe("FooEvent");
  });

  it("omits detail property when argument is undefined", () => {
    const err = new InvalidStreamRecordError("missing_field", "no NewImage");
    expect(Object.hasOwn(err, "detail")).toBe(false);
    expect(err.detail).toBeUndefined();
  });

  it("accepts the three reason literals", () => {
    const reasons = ["missing_field", "unmarshal_failed", "unknown_type"] as const;
    for (const reason of reasons) {
      const err = new InvalidStreamRecordError(reason, reason);
      expect(err.reason).toBe(reason);
    }
  });
});
