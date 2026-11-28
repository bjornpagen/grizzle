import { nonEmpty } from "@bjornpagen/testing/assert"
import { dictionary } from "@bjornpagen/testing/dictionary"
import { Array as Arr } from "effect"
import { type DescriptorSketch, spellings } from "#test/support/unit/scalar/support.ts"

/**
 * The namespace's descriptors of no typmod: every spelling that is a descriptor itself. The namespace is the domain,
 * never cases a person chose.
 */
export const plainSketches = dictionary(
	nonEmpty(
		Arr.map(spellings, (name): DescriptorSketch => ({ kind: "spelling", name })),
		"the plain descriptors"
	)
)
