/**
 * What URI reference resolution's properties read: RFC 3986 §5.4's examples, and drawn bases and references, which the
 * host's resolver (uri.test.ts) and the library function's SQL (test/pg/compute/resolve-reference.test.ts) are held to
 * RFC 3986 read by other means over (test/support/oracle/evaluate/uri.ts).
 */

import { array, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { partsOf } from "#test/support/oracle/evaluate/uri.ts"

export type UriFeature =
	| "a reference with a scheme"
	| "a reference with an authority"
	| "a reference with an empty path"
	| "a reference with an absolute path"
	| "a reference with a relative path"
	| "a dot segment"
	| "a .. past the root"
	| "an undefined query against a base's"
	| "the RFC's example base"
	| "a percent-encoded dot"

/** The RFC's example base (§5.4). */
const rfcBase = "http://a/b/c/d;p?q"

/**
 * RFC 3986 §5.4's 42 examples, each a reference against the example base and its target: §5.4.1's 23 normal ones and
 * §5.4.2's 19 abnormal ones, the last the strict resolver's reading of a reference that states the base's own scheme.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc3986#section-5.4 | RFC 3986, §5.4 Reference Resolution Examples}
 */
const examples: Arr.NonEmptyReadonlyArray<readonly [reference: string, target: string]> = [
	["g:h", "g:h"],
	["g", "http://a/b/c/g"],
	["./g", "http://a/b/c/g"],
	["g/", "http://a/b/c/g/"],
	["/g", "http://a/g"],
	["//g", "http://g"],
	["?y", "http://a/b/c/d;p?y"],
	["g?y", "http://a/b/c/g?y"],
	["#s", "http://a/b/c/d;p?q#s"],
	["g#s", "http://a/b/c/g#s"],
	["g?y#s", "http://a/b/c/g?y#s"],
	[";x", "http://a/b/c/;x"],
	["g;x", "http://a/b/c/g;x"],
	["g;x?y#s", "http://a/b/c/g;x?y#s"],
	["", "http://a/b/c/d;p?q"],
	[".", "http://a/b/c/"],
	["./", "http://a/b/c/"],
	["..", "http://a/b/"],
	["../", "http://a/b/"],
	["../g", "http://a/b/g"],
	["../..", "http://a/"],
	["../../", "http://a/"],
	["../../g", "http://a/g"],
	["../../../g", "http://a/g"],
	["../../../../g", "http://a/g"],
	["/./g", "http://a/g"],
	["/../g", "http://a/g"],
	["g.", "http://a/b/c/g."],
	[".g", "http://a/b/c/.g"],
	["g..", "http://a/b/c/g.."],
	["..g", "http://a/b/c/..g"],
	["./../g", "http://a/b/g"],
	["./g/.", "http://a/b/c/g/"],
	["g/./h", "http://a/b/c/g/h"],
	["g/../h", "http://a/b/c/h"],
	["g;x=1/./y", "http://a/b/c/g;x=1/y"],
	["g;x=1/../y", "http://a/b/c/y"],
	["g?y/./x", "http://a/b/c/g?y/./x"],
	["g?y/../x", "http://a/b/c/g?y/../x"],
	["g#s/./x", "http://a/b/c/g#s/./x"],
	["g#s/../x", "http://a/b/c/g#s/../x"],
	["http:g", "http:g"]
]

export const rfcExamples: Arr.NonEmptyReadonlyArray<{
	readonly base: string
	readonly reference: string
	readonly target: string
}> = Arr.map(examples, ([reference, target]) => ({ base: rfcBase, reference, target }))

/** A path's segment: empty, a dot segment, a name, a name of dots, or percent-encoded dots, which are no dot segment. */
const segment = element([
	"",
	".",
	"..",
	"g",
	"g;x",
	"h",
	"g.",
	"..g",
	"%2E",
	"%2E%2E",
	".%2e"
] as const)

/** A path of up to four drawn segments, `/` between them, absolute or relative. */
const pathGen: Gen<string> = (source) => {
	const segments = Arr.join(source.draw(array(segment, { min: 0, max: 4 })), "/")
	return source.draw(element([false, true])) ? `/${segments}` : segments
}

/** A base: the RFC's own, or a drawn absolute URI. */
const baseGen: Gen<string> = weighted([
	[1, element([rfcBase] as const)],
	[
		3,
		(source) =>
			`${source.draw(element(["http", "foo"] as const))}:${source.draw(element(["//a", "//a:80", "//", ""] as const))}${source.draw(pathGen)}${source.draw(element(["", "?q", "?"] as const))}`
	]
])

/** One component of a reference: stated as one of `stated`, or not, three times in four. */
const component = (stated: Arr.NonEmptyReadonlyArray<string>): Gen<string> =>
	weighted([
		[3, element([""] as const)],
		[1, element(stated)]
	])

const schemeGen = component(["g:", "http:"])
const authorityGen = component(["//g", "//"])
const queryGen = component(["?y", "?"])
const fragmentGen = component(["#s", "#"])

/** A reference: each component stated or not. */
const referenceGen: Gen<string> = (source) =>
	Arr.join(
		[
			source.draw(schemeGen),
			source.draw(authorityGen),
			source.draw(pathGen),
			source.draw(queryGen),
			source.draw(fragmentGen)
		],
		""
	)

/** A case: a base, a reference, and the situations it reaches. */
export const referenceCaseGen: Gen<{
	readonly base: string
	readonly reference: string
	readonly features: ReadonlyArray<UriFeature>
}> = (source) => {
	const base = source.draw(baseGen)
	const reference = source.draw(referenceGen)
	const r = partsOf(reference)
	const reached: ReadonlyArray<readonly [UriFeature, boolean]> = [
		["a reference with a scheme", r.scheme !== undefined],
		["a reference with an authority", r.scheme === undefined && r.authority !== undefined],
		[
			"a reference with an empty path",
			r.scheme === undefined && r.authority === undefined && r.path === ""
		],
		["a reference with an absolute path", Str.startsWith("/")(r.path)],
		["a reference with a relative path", r.path !== "" && !Str.startsWith("/")(r.path)],
		["a dot segment", Str.includes("./")(reference) || Str.endsWith(".")(r.path)],
		["a .. past the root", Str.includes("../..")(reference) || Str.startsWith("/..")(r.path)],
		["an undefined query against a base's", r.query === undefined && Str.includes("?")(base)],
		["the RFC's example base", base === rfcBase],
		["a percent-encoded dot", Str.includes("%2")(reference) || Str.includes("%2")(base)]
	]
	return { base, reference, features: Arr.flatMap(reached, ([f, holds]) => (holds ? [f] : [])) }
}
