import { InMemorySnapshotStore } from "../src/index.js";
import {
  registerSnapshotStoreContract,
  type SnapshotTestState,
} from "./contract/snapshot-store.js";

/**
 * SnapshotStore Contract Tests (CT-SS-01〜05) を InMemorySnapshotStore 対象で実行。
 * DynamoSnapshotStore 側は test/dynamodb.integration.test.ts で同 suite を走らせる。
 */
registerSnapshotStoreContract({
  label: "InMemorySnapshotStore",
  makeStore: async () => new InMemorySnapshotStore<SnapshotTestState>(),
});
