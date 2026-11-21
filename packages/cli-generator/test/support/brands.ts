import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import { assert } from "@bjornpagen/testing/assert"

/**
 * A suite's own text as the brand its model predicate decides (model/brands.ts isWireName, isHeaderName and the rest,
 * model/pointer.ts isJsonPointer): a text the suite wrote or drew from the brand's grammar, so a text the predicate
 * refuses fails the case.
 */
export const branded = <B extends string>(is: (text: string) => text is B, text: string): B =>
	is(text) ? text : assert.fail(`${jsonText(text)} is no text its brand admits`)
