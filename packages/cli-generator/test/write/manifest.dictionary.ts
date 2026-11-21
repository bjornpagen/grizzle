import { dictionary } from "@bjornpagen/testing/dictionary"

/** How a manifest text as a whole departs from the manifest's shape, or `none` for the text the writer prints. */
export type WholeFlaw =
	| "none"
	| "no JSON text"
	| "a list for the manifest"
	| "a member beside files"
	| "files that are no list"

/** How the first entry of a manifest text departs from an entry's shape, or repeats its path. */
export type EntryFlaw =
	| "a member beside an entry's three"
	| "an entry without its size"
	| "an empty path"
	| "a sha256 in capitals"
	| "a sha256 a digit short"
	| "a fractional size"
	| "a negative size"
	| "a size written as text"
	| "a repeated path"

/** Every way a manifest text as a whole departs from its shape, and none. */
export const wholeFlaws = dictionary<WholeFlaw>([
	"none",
	"no JSON text",
	"a list for the manifest",
	"a member beside files",
	"files that are no list"
])

/** Every way a manifest's first entry departs from an entry's shape. */
export const entryFlaws = dictionary<EntryFlaw>([
	"a member beside an entry's three",
	"an entry without its size",
	"an empty path",
	"a sha256 in capitals",
	"a sha256 a digit short",
	"a fractional size",
	"a negative size",
	"a size written as text",
	"a repeated path"
])
