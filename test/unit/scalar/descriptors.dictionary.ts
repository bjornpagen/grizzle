import { dictionary } from "@bjornpagen/testing/dictionary"
import { binary64Precision } from "@grizzle/limits"
import { Array as Arr } from "effect"
import { nonEmpty } from "#test/support/assert.ts"
import { upTo } from "#test/support/up-to.ts"
import { type DescriptorSketch, spellings } from "#test/unit/scalar/support.ts"

/**
 * The namespace's descriptors of no typmod: every spelling that is a descriptor itself, and float(p) at every binary
 * precision PostgreSQL admits. The namespace and PostgreSQL's precisions are the domain, never cases a person chose.
 */
export const plainSketches = dictionary(
	nonEmpty(
		[
			...Arr.map(spellings, (name): DescriptorSketch => ({ kind: "spelling", name })),
			...Arr.map(
				upTo(binary64Precision.value, (i) => i + 1),
				(precision): DescriptorSketch => ({
					kind: "float",
					precision
				})
			)
		],
		"the plain descriptors"
	)
)
