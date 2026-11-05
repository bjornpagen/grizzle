import type { Relayed } from "#fixture/violating.ts"

export const relay = (input: Relayed): string => input.channel
