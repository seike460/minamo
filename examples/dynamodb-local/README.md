# examples/dynamodb-local

`DynamoEventStore` を Docker 上の DynamoDB Local で動かす E2E cookbook。本番 AWS に deploy する前にローカルで append / load / 楽観的ロック衝突まで一通り試す。

## 前提

- Docker (docker compose) が起動している
- repo ルートの `docker-compose.yml` に `dynamodb-local` service が定義済み (`amazon/dynamodb-local:2.5.4`, port 8000, inMemory + sharedDb)

## 実行方法

```bash
# 1) DynamoDB Local 起動
docker compose up -d dynamodb-local

# 2) example 実行
pnpm exec tsx examples/dynamodb-local/run.ts

# 3) (optional) 停止
docker compose down
```

期待出力 (末尾 3 行):

```
appended 3 events for counter-local
loaded 3 events, replayed state=8
append conflict detected (expected): ConcurrencyError
```

## 何を確認できるか

1. **table 作成**: PK=`aggregateId` / SK=`version` + `StreamSpecification.NEW_IMAGE` の schema を `setup.ts` が create する (concept.md §3 / C11)
2. **append**: `executeCommand` 経由で 3 回 append → `store.load()` で 3 events が返る
3. **rehydrate**: `rehydrate(config, id, events)` で state=8 に復元できる
4. **ConcurrencyError**: `expectedVersion=0` で古い version を渡すと楽観的ロック違反として `ConcurrencyError` が throw される (U6 design)

## 構成

| file | 役割 |
|---|---|
| `setup.ts` | table create/delete helper、`LOCAL_CLIENT_CONFIG` (endpoint / dummy credentials) |
| `run.ts` | setup → append × 3 → load → rehydrate → 楽観的ロック検証 → cleanup を 1 スクリプトで実行 |

## projection の検証は別トラック

DynamoDB Local は DynamoDB Streams の **Lambda trigger を動かせない**。つまり本 example では append 後の Stream → Projection の流れまでは検証できない。projection layer は consumer 責務であり、検証方法は [`docs/pitfalls.md` §3](../../docs/pitfalls.md#3-the-projection-layer-is-consumer-owned) と [`examples/multi-aggregate-projection/`](../multi-aggregate-projection/) を参照。

## npm publish

`package.json` の `files` は `["dist"]` なので examples/ は npm publish に含まれない。
