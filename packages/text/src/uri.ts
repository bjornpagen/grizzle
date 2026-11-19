/**
 * URI reference resolution as RFC 3986 states it (§5.2): a reference read against a base URI gives its target, the
 * reference's components where it states them and the base's where it does not, its path merged with the base's and
 * its dot segments removed, then recomposed (§5.3). It is the strict resolver: a reference with a scheme is that
 * scheme's, even the base's own. Every step is the RFC's pseudocode, by its names, over a string read by its own scan
 * of the components Appendix B's expression splits a reference into, so it constructs no RegExp and runs wherever
 * JavaScript does, a browser included. Beside it, resolution within a base (resolveWithin): the same resolution, which
 * answers a reference whose `..` segments climb past its path's root, where the RFC clamps them at it, as above the base.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc3986#section-5.2 | RFC 3986, §5.2 Relative Resolution}
 */

/**
 * A reference's five components (§3, as Appendix B splits them): a component the reference does not state is
 * undefined, which the resolver tells apart from one stated empty, as `?` and `#` with nothing after them state one.
 */
interface Components {
	readonly scheme: string | undefined
	readonly authority: string | undefined
	readonly path: string
	readonly query: string | undefined
	readonly fragment: string | undefined
}

/**
 * The components of a reference, split as Appendix B's expression splits it,
 * `^(([^:/?#]+):)?(//([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?`: a scheme of no `:`, `/`, `?` or `#` before the first `:`,
 * an authority after `//` up to the next `/`, `?` or `#`, the path up to `?` or `#`, the query after `?` up to `#` and
 * the fragment after `#`. Every string splits so.
 */
const componentsOf = (reference: string): Components => {
	const hash = reference.indexOf("#")
	const fragment = hash < 0 ? undefined : reference.slice(hash + 1)
	const beforeFragment = hash < 0 ? reference : reference.slice(0, hash)
	const mark = beforeFragment.indexOf("?")
	const query = mark < 0 ? undefined : beforeFragment.slice(mark + 1)
	const hierarchical = mark < 0 ? beforeFragment : beforeFragment.slice(0, mark)
	const colon = hierarchical.indexOf(":")
	let firstDelimiter = hierarchical.length
	for (const delimiter of ["/", "?", "#"]) {
		const at = hierarchical.indexOf(delimiter)
		if (at >= 0 && at < firstDelimiter) {
			firstDelimiter = at
		}
	}
	const scheme = colon > 0 && colon < firstDelimiter ? hierarchical.slice(0, colon) : undefined
	const afterScheme = scheme === undefined ? hierarchical : hierarchical.slice(colon + 1)
	if (!afterScheme.startsWith("//")) {
		return { scheme, authority: undefined, path: afterScheme, query, fragment }
	}
	const slash = afterScheme.indexOf("/", 2)
	const end = slash < 0 ? afterScheme.length : slash
	return {
		scheme,
		authority: afterScheme.slice(2, end),
		path: afterScheme.slice(end),
		query,
		fragment
	}
}

/**
 * A path with its dot segments removed (`walked`): the path remove_dot_segments gives, and how many of its `..` segments
 * climbed past its root, each one that found no segment before it to remove, which the RFC drops.
 */
interface Walked {
	readonly path: string
	readonly climbed: number
}

/**
 * remove_dot_segments (§5.2.4): the path's `.` and `..` segments interpreted and removed, by the RFC's own loop over
 * an input buffer and an output buffer, steps A to E, counting each `..` that removes no segment, the output holding
 * none: a leading `../` or `..` (steps A and D, which only a path's start meets, its output still empty), or a `/../`
 * or `/..` over an empty output (step C). Only a literal `.` or `..` is a dot segment, `%2E` and `%2E%2E` none.
 */
const walked = (path: string): Walked => {
	let input = path
	let output = ""
	let climbed = 0
	/** The output with its last segment removed, or a climb counted where it holds none. */
	const up = (): string => {
		if (output === "") {
			climbed += 1
		}
		return output.slice(0, Math.max(0, output.lastIndexOf("/")))
	}
	while (input.length > 0) {
		if (input.startsWith("../")) {
			input = input.slice(3)
			climbed += 1
		} else if (input.startsWith("./")) {
			input = input.slice(2)
		} else if (input.startsWith("/./")) {
			input = input.slice(2)
		} else if (input === "/.") {
			input = "/"
		} else if (input.startsWith("/../")) {
			input = input.slice(3)
			output = up()
		} else if (input === "/..") {
			input = "/"
			output = up()
		} else if (input === "..") {
			input = ""
			climbed += 1
		} else if (input === ".") {
			input = ""
		} else {
			const next = input.indexOf("/", input.startsWith("/") ? 1 : 0)
			const end = next < 0 ? input.length : next
			output += input.slice(0, end)
			input = input.slice(end)
		}
	}
	return { path: output, climbed }
}

/** remove_dot_segments (§5.2.4): the path's `.` and `..` segments interpreted and removed (`walked`). */
export const removeDotSegments = (path: string): string => walked(path).path

/** merge (§5.2.3): a relative path against the base's, after the base's last `/`, or after `/` for an empty one. */
const merge = (base: Components, path: string): string => {
	if (base.authority !== undefined && base.path === "") {
		return `/${path}`
	}
	const slash = base.path.lastIndexOf("/")
	return slash < 0 ? path : `${base.path.slice(0, slash + 1)}${path}`
}

/** Component recomposition (§5.3). */
const recomposed = (t: Components): string =>
	`${t.scheme === undefined ? "" : `${t.scheme}:`}${t.authority === undefined ? "" : `//${t.authority}`}${t.path}${
		t.query === undefined ? "" : `?${t.query}`
	}${t.fragment === undefined ? "" : `#${t.fragment}`}`

/**
 * The target of `reference` resolved against `base` (§5.2.2, Transform References, strict), and how many `..` segments
 * of the path its dot segments were removed from climbed past that path's root (`walked`), none where no path is
 * walked: the RFC's pseudocode, each branch its own.
 */
const resolution = (
	base: string,
	reference: string
): { readonly target: string; readonly climbed: number } => {
	const b = componentsOf(base)
	const r = componentsOf(reference)
	if (r.scheme !== undefined) {
		const path = walked(r.path)
		return { target: recomposed({ ...r, path: path.path }), climbed: path.climbed }
	}
	if (r.authority !== undefined) {
		const path = walked(r.path)
		return {
			target: recomposed({ ...r, scheme: b.scheme, path: path.path }),
			climbed: path.climbed
		}
	}
	if (r.path === "") {
		return {
			target: recomposed({
				scheme: b.scheme,
				authority: b.authority,
				path: b.path,
				query: r.query ?? b.query,
				fragment: r.fragment
			}),
			climbed: 0
		}
	}
	const path = walked(r.path.startsWith("/") ? r.path : merge(b, r.path))
	return {
		target: recomposed({
			scheme: b.scheme,
			authority: b.authority,
			path: path.path,
			query: r.query,
			fragment: r.fragment
		}),
		climbed: path.climbed
	}
}

/**
 * The target of `reference` resolved against `base` (§5.2.2, Transform References, strict), recomposed, every `..` that
 * climbs past its path's root dropped, as the RFC states.
 */
export const resolveReference = (base: string, reference: string): string =>
	resolution(base, reference).target

/**
 * A reference resolved within its base: `Within`, its target, the RFC's (resolveReference), where no `..` segment of
 * the path it walks climbs past that path's root; `AboveBase` where some do, `climbed` how many, each a step above the
 * base's root that the RFC's resolution drops, so a hierarchy rooted at the base (a package's entries under its root)
 * holds no target of it.
 */
export type WithinBase =
	| { readonly _tag: "Within"; readonly target: string }
	| { readonly _tag: "AboveBase"; readonly climbed: number }

/**
 * `reference` resolved within `base` (WithinBase): the RFC's resolution (§5.2.2), its target where its walk stays at or
 * below the base's root, or the count of `..` segments that climbed past it, by the one walk resolveReference reads.
 */
export const resolveWithin = (base: string, reference: string): WithinBase => {
	const { target, climbed } = resolution(base, reference)
	return climbed === 0 ? { _tag: "Within", target } : { _tag: "AboveBase", climbed }
}
