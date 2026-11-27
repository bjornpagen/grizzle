/** The deterministic uuid of fact `n` of group `group` in a worked example's golden facts. */
import { pipe, String as Str } from "effect"
import { type IdValue, toId } from "#test/support/ids.ts"

export const id = (group: number, n: number): IdValue =>
	toId(`00000000-0000-4000-8000-${pipe((group * 0x1000 + n).toString(16), Str.padStart(12, "0"))}`)
