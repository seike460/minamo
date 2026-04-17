import assert from "node:assert/strict";
import {
  ConcurrencyError,
  EventLimitError,
  InvalidEventStreamError,
  InvalidStreamRecordError,
  ValidationError,
} from "../dist/index.js";

const concurrency = new ConcurrencyError("test-agg", 42);
assert(concurrency instanceof Error, "ConcurrencyError must be instanceof Error");
assert(
  concurrency instanceof ConcurrencyError,
  "ConcurrencyError must be instanceof ConcurrencyError",
);
assert.strictEqual(concurrency.name, "ConcurrencyError", "name must be ConcurrencyError");
assert.strictEqual(concurrency.aggregateId, "test-agg", "aggregateId must match");
assert.strictEqual(concurrency.expectedVersion, 42, "expectedVersion must match");

const issues = [{ message: "expected string", path: ["user", "name"] }];
const validation = new ValidationError(issues);
assert(validation instanceof Error, "ValidationError must be instanceof Error");
assert(validation instanceof ValidationError, "ValidationError must be instanceof ValidationError");
assert.strictEqual(validation.name, "ValidationError", "name must be ValidationError");
assert.strictEqual(validation.issues, issues, "issues array must be preserved by reference");
assert.match(validation.message, /user\.name: expected string/, "message must include path.msg");

const eventLimit = new EventLimitError("agg-limit", "events must not be empty");
assert(eventLimit instanceof Error, "EventLimitError must be instanceof Error");
assert(eventLimit instanceof EventLimitError, "EventLimitError must be instanceof EventLimitError");
assert.strictEqual(eventLimit.name, "EventLimitError", "name must be EventLimitError");
assert.strictEqual(eventLimit.aggregateId, "agg-limit", "aggregateId must match");
assert.strictEqual(eventLimit.message, "events must not be empty", "message must match");

const invalidStream = new InvalidEventStreamError(
  "agg-stream",
  "version_gap",
  "version 3 expected 2",
  { eventIndex: 2, expectedVersion: 2, actualVersion: 3 },
);
assert(invalidStream instanceof Error, "InvalidEventStreamError must be instanceof Error");
assert(
  invalidStream instanceof InvalidEventStreamError,
  "InvalidEventStreamError must be instanceof InvalidEventStreamError",
);
assert.strictEqual(invalidStream.name, "InvalidEventStreamError", "name must match");
assert.strictEqual(invalidStream.aggregateId, "agg-stream", "aggregateId must match");
assert.strictEqual(invalidStream.reason, "version_gap", "reason must match");
assert.deepStrictEqual(
  invalidStream.details,
  { eventIndex: 2, expectedVersion: 2, actualVersion: 3 },
  "details must be preserved",
);

const invalidStreamNoDetails = new InvalidEventStreamError(
  "agg-no-details",
  "aggregateId_mismatch",
  "id mismatch",
);
assert.strictEqual(
  Object.hasOwn(invalidStreamNoDetails, "details"),
  false,
  "details property must be absent when undefined is passed",
);

const invalidRecord = new InvalidStreamRecordError("unknown_type", "type not allowed", "FooEvent");
assert(invalidRecord instanceof Error, "InvalidStreamRecordError must be instanceof Error");
assert(
  invalidRecord instanceof InvalidStreamRecordError,
  "InvalidStreamRecordError must be instanceof InvalidStreamRecordError",
);
assert.strictEqual(invalidRecord.name, "InvalidStreamRecordError", "name must match");
assert.strictEqual(invalidRecord.reason, "unknown_type", "reason must match");
assert.strictEqual(invalidRecord.detail, "FooEvent", "detail must match");

const invalidRecordNoDetail = new InvalidStreamRecordError("missing_field", "no NewImage");
assert.strictEqual(
  Object.hasOwn(invalidRecordNoDetail, "detail"),
  false,
  "detail property must be absent when undefined is passed",
);

console.log("✓ instanceof verification passed (post-build)");
