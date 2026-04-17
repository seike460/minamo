# examples/counter

concept.md §4 最小コード例を実行可能な形で配置したもの。`src/` を relative import しているため、README の Quick Start と 1 対 1 で一致する (docs drift 防止)。

## 実行方法

### InMemoryEventStore 版

```bash
pnpm exec tsx examples/counter/in-memory.ts
```

期待出力:

```
counter-1 state=5 version=1
```

### DynamoEventStore 版 (DynamoDB Local)

```bash
docker run -d -p 8000:8000 amazon/dynamodb-local:2.5.4
pnpm exec tsx examples/counter/dynamo.ts
```

期待出力:

```
counter-dynamo state=3 version=1
```

テーブルは実行ごとに delete → create される (実行順序不問)。

## npm publish

`package.json` の `files` は `["dist"]` なので examples/ は npm publish に含まれない。
