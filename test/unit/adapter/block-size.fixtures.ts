/** What the property of block-size.test.ts reads: its texts, its specification and its features. */

import { isAsciiDigits } from "@bjornpagen/grizzle-text/text"
import { element, type Gen } from "@bjornpagen/testing/gen"

/**
 * The texts a survey's read of current_setting('block_size') is judged over: each block size PostgreSQL 19 builds with,
 * 1 to 32 kB, in bytes, the unit-less number current_setting prints, and texts no server answers, the default with a
 * unit, with a trailing blank, and the empty text.
 */
const texts = ["1024", "2048", "4096", "8192", "16384", "32768", "8kB", "8192 ", ""] as const

export const blockSizeTextGen: Gen<(typeof texts)[number]> = element(texts)

/** What a survey makes of a server whose block_size reads `text`: admitted at the size grizzle's page bounds rest on. */
export type Specified = "admitted" | "refused"

/**
 * The specification: grizzle derives its page bounds from PostgreSQL's default block size, 8192 bytes (core/page.ts
 * blockSize; meson_options.txt at REL_19_0, `option('blocksize', ..., value: '8')`), which current_setting prints as
 * `8192` (guc_tables.c, block_size, an integer of no unit); every other text is a server of other pages, or none.
 */
export const specified = (text: string): Specified => (text === "8192" ? "admitted" : "refused")

/** Why a case's verdict is what it is, as the search must reach each. */
export type BlockSizeFeature =
	| "the default block size admitted"
	| "a smaller block size refused"
	| "a larger block size refused"
	| "a text no server answers refused"

export const features = [
	"the default block size admitted",
	"a smaller block size refused",
	"a larger block size refused",
	"a text no server answers refused"
] as const

/** The feature `text`'s verdict reaches (BlockSizeFeature). */
export const featureOf = (text: string): BlockSizeFeature => {
	const bytes = text.length > 0 && isAsciiDigits(text, 0, text.length) ? Number(text) : undefined
	return bytes === undefined
		? "a text no server answers refused"
		: bytes === 8192
			? "the default block size admitted"
			: bytes < 8192
				? "a smaller block size refused"
				: "a larger block size refused"
}
