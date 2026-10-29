/** The deterministic uuid of fact `n` of group `group` in a worked example's golden facts. */
import { pipe, String as Str } from "effect"
export const id = (group: number, n: number): string =>
	`00000000-0000-4000-8000-${pipe((group * 0x1000 + n).toString(16), Str.padStart(12, "0"))}`
