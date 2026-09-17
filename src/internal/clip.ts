/**
 * error message に埋め込む文字列を安全に整形する。
 * 改行・制御文字の escape (log injection 対策) と長大入力の truncate (log flood 対策)
 * を兼ねる。主に stream / store 由来の untrusted 値向けだが、巨大化しうる
 * consumer 指定値 (aggregateId 等) にも使ってよい — JSON 引用符が付くだけで
 * message の意味は変わらない。
 */
export function clip(value: unknown, maxLength = 256): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : String(value);
  } catch {
    // Object.create(null) や投げる toString を持つ malformed な store 由来値でも
    // 本来の検証エラー (InvalidEventStreamError 等) を隠さないよう fallback する。
    s = "<unprintable>";
  }
  return JSON.stringify(s.length > maxLength ? `${s.slice(0, maxLength)}...` : s);
}
