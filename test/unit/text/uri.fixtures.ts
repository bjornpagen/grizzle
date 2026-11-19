/** What the property of uri.test.ts reads: drawn bases and references, and the oracle that resolves them. */

import { array, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Option, String as Str } from "effect"

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

/** A reference's components as the oracle reads them: one undefined where the reference states none. */
interface Parts {
	readonly scheme: string | undefined
	readonly authority: string | undefined
	readonly path: string
	readonly query: string | undefined
	readonly fragment: string | undefined
}

/**
 * RFC 3986 Appendix B's own expression, which splits every reference into its five components, capture 2 the scheme,
 * 4 the authority, 5 the path, 7 the query and 9 the fragment.
 */
const appendixB = regex("^(([^:/?#]+):)?(//([^/?#]*))?([^?#]*)(\\?([^#]*))?(#(.*))?")

const partsOf = (reference: string): Parts => {
	const m = Option.getOrThrow(Option.fromNullishOr(appendixB.exec(reference)))
	return { scheme: m[2], authority: m[4], path: m[5], query: m[7], fragment: m[9] }
}

/** §5.2.4's rules, each the pattern of the input buffer's prefix it reads. */
const ruleA = regex("^\\.\\.?/")
const ruleB = regex("^/\\.(/|$)")
const ruleC = regex("^/\\.\\.(/|$)")
const ruleD = regex("^\\.\\.?$")
const ruleE = regex("^/?[^/]*")
const lastSegment = regex("/?[^/]*$")

/** remove_dot_segments (§5.2.4), by its rules A to E applied as patterns to the input buffer until it is empty. */
const removeDots = (path: string): string => {
	let input = path
	let output = ""
	while (input !== "") {
		if (ruleA.test(input)) {
			input = Str.replace(ruleA, "")(input)
		} else if (ruleB.test(input)) {
			input = Str.replace(ruleB, "/")(input)
		} else if (ruleC.test(input)) {
			input = Str.replace(ruleC, "/")(input)
			output = Str.replace(lastSegment, "")(output)
		} else if (ruleD.test(input)) {
			input = ""
		} else {
			const segment = Option.getOrThrow(Option.fromNullishOr(ruleE.exec(input)))[0]
			output = `${output}${segment}`
			input = Str.slice(segment.length)(input)
		}
	}
	return output
}

/** §5.2.3's merge: the base's path to its last `/` and the reference's, or `/` and it where the base has only an
 * authority. */
const mergePaths = (base: Parts, path: string): string =>
	base.authority !== undefined && base.path === ""
		? `/${path}`
		: `${Str.slice(
				0,
				Str.lastIndexOf("/")(base.path).pipe(
					Option.map((at) => at + 1),
					Option.getOrElse(() => 0)
				)
			)(base.path)}${path}`

/** §5.3's recomposition. */
const recompose = (t: Parts): string =>
	Arr.join(
		[
			t.scheme === undefined ? "" : `${t.scheme}:`,
			t.authority === undefined ? "" : `//${t.authority}`,
			t.path,
			t.query === undefined ? "" : `?${t.query}`,
			t.fragment === undefined ? "" : `#${t.fragment}`
		],
		""
	)

/** §5.2.2's transformation, strict, then §5.3's recomposition. */
export const oracleResolve = (base: string, reference: string): string => {
	const b = partsOf(base)
	const r = partsOf(reference)
	const target: Parts =
		r.scheme !== undefined
			? { ...r, path: removeDots(r.path) }
			: r.authority !== undefined
				? { ...r, scheme: b.scheme, path: removeDots(r.path) }
				: r.path === ""
					? {
							scheme: b.scheme,
							authority: b.authority,
							path: b.path,
							query: r.query ?? b.query,
							fragment: r.fragment
						}
					: {
							scheme: b.scheme,
							authority: b.authority,
							path: removeDots(Str.startsWith("/")(r.path) ? r.path : mergePaths(b, r.path)),
							query: r.query,
							fragment: r.fragment
						}
	return recompose(target)
}

/** The RFC's example base (§5.4). */
const rfcBase = "http://a/b/c/d;p?q"

const segment = element(["", ".", "..", "g", "g;x", "h", "g.", "..g"] as const)

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
		["the RFC's example base", base === rfcBase]
	]
	return { base, reference, features: Arr.flatMap(reached, ([f, holds]) => (holds ? [f] : [])) }
}
