export { executeCommand, rehydrate } from "./command/execute.js";
export { createCommandRunner } from "./command/runner.js";
export type { CommandHandler, CommandResult } from "./command/types.js";
export type { Aggregate, AggregateConfig } from "./core/aggregate.js";
export type {
  DomainEvent,
  EventMap,
  EventsOf,
  Evolver,
  StoredEvent,
  StoredEventsOf,
} from "./core/types.js";
export type {
  InvalidEventStreamDetails,
  InvalidEventStreamReason,
  InvalidStreamRecordReason,
} from "./errors.js";
export {
  ConcurrencyError,
  EventLimitError,
  InvalidEventStreamError,
  InvalidStreamRecordError,
  ValidationError,
} from "./errors.js";
export type { DynamoEventStoreConfig } from "./event-store/dynamo/index.js";
export { DynamoEventStore } from "./event-store/dynamo/index.js";
export type { EventStoreTable } from "./event-store/dynamo/table.js";
export { createEventStoreTable } from "./event-store/dynamo/table.js";
export { InMemoryEventStore } from "./event-store/in-memory.js";
export type { AppendOptions, EventStore } from "./event-store/types.js";
export type { ExecuteObserver } from "./observability.js";
export type { ParseStreamRecordOptions } from "./projection/bridge.js";
export { eventNamesOf, parseStreamRecord } from "./projection/bridge.js";
export type { Snapshot, SnapshotPolicy, SnapshotStore } from "./snapshot/types.js";
export type {
  InferSchemaInput,
  InferSchemaOutput,
  StandardSchemaFailure,
  StandardSchemaIssue,
  StandardSchemaPathSegment,
  StandardSchemaProps,
  StandardSchemaResult,
  StandardSchemaSuccess,
  StandardSchemaTypes,
  StandardSchemaV1,
} from "./standard-schema.js";
export type { ReadonlyDeep } from "./types.js";
export { validate } from "./validation.js";
