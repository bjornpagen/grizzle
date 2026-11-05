import type { HiddenOptions } from "#fixture/clean.ts"

export const hidden = (options: HiddenOptions): number => options.limit ?? 0
