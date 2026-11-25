/** The default status vocabulary (状态口径): word → which table it lives in. */
export const STATUS_CLASSES = {
  未决: "open",
  部分解决: "open",
  观察: "open",
  已修: "closed",
  延后: "closed",
  决定不改: "closed",
  不是缺陷: "closed",
  范围外: "closed",
  撤回: "closed",
  并入: "closed",
  未分类: "closed",
} as const satisfies Record<string, "open" | "closed">;
