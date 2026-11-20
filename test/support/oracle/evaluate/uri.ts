/**
 * URI reference resolution read again from RFC 3986 by other means than @bjornpagen/grizzle-text's uri.ts: Appendix
 * B's own regular expression splits each reference into its components, §5.2.4's rules A to E rewrite the path by
 * their own patterns over its input buffer, and §5.2.2 and §5.3 transform and recompose the components. The second
 * implementation the uri property holds the host's resolver to, and the reference evaluator's Text.resolveReference
 * (catalog.ts), which the library function's SQL is held to.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc3986#section-5.2 | RFC 3986, §5.2 Relative Resolution}
 */

import { regex } from "arkregex"
import { Array as Arr, Option, String as Str } from "effect"

/** A reference's components as the oracle reads them: one undefined where the reference states none. */
export interface Parts {
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

export const partsOf = (reference: string): Parts => {
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
export const resolvedReference = (base: string, reference: string): string => {
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

/**
 * How many `..` segments of the path a resolution walks climb past its root (§5.2.2's path, §5.2.4's walk), by a depth
 * over the path's segments read apart from the rules: the path of a reference with a scheme or an authority is its own,
 * an empty path walks nothing, an absolute one is its own and a relative one is merged with the base's; then, its root's
 * `/` aside, each segment between `/`s, an empty one among them, is one step down, `.` none, and `..` one up, or a
 * climb where no step down is left to undo.
 */
export const climbsOf = (base: string, reference: string): number => {
	const b = partsOf(base)
	const r = partsOf(reference)
	const path =
		r.scheme !== undefined || r.authority !== undefined || Str.startsWith("/")(r.path)
			? r.path
			: r.path === ""
				? undefined
				: mergePaths(b, r.path)
	if (path === undefined || path === "") {
		return 0
	}
	const segments = Str.split(Str.startsWith("/")(path) ? Str.slice(1)(path) : path, "/")
	return Arr.reduce(segments, { depth: 0, climbs: 0 }, ({ depth, climbs }, segment) =>
		segment === "."
			? { depth, climbs }
			: segment === ".."
				? depth === 0
					? { depth, climbs: climbs + 1 }
					: { depth: depth - 1, climbs }
				: { depth: depth + 1, climbs }
	).climbs
}
