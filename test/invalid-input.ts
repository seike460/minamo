/**
 * 型では防げない runtime 入力をテストに注入するための unsafe cast helper。
 *
 * fail-fast / validation の契約テストでは、型システム上はありえない値
 * (null config・非 string の type・Proxy 等) を実際に渡す必要がある。
 * `as never` を call site に散らすと unsafe な境界が追いにくく意図も
 * 読み取りにくいため、名前付きの 1 箇所に集約する。
 *
 * test code 専用。production code (src/) では使わない。
 */
export function invalidInput<T = never>(value: unknown): T {
  return value as T;
}
