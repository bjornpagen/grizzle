/**
 * URI reference resolution as RFC 3986 states it (§5.2): a reference read against a base URI gives its target, the
 * reference's components where it states them and the base's where it does not, its path merged with the base's and
 * its dot segments removed, then recomposed (§5.3). It is the strict resolver: a reference with a scheme is that
 * scheme's, even the base's own. Every step is the RFC's pseudocode, by its names, over a string read by its own scan
 * of the components Appendix B's expression splits a reference into, so it constructs no RegExp and runs wherever
 * JavaScript does, a browser included.
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
 * remove_dot_segments (§5.2.4): the path's `.` and `..` segments interpreted and removed, by the RFC's own loop over
 * an input buffer and an output buffer, steps A to E.
 */
export const removeDotSegments = (path: string): string => {
	let input = path
	let output = ""
	while (input.length > 0) {
		if (input.startsWith("../")) {
			input = input.slice(3)
		} else if (input.startsWith("./")) {
			input = input.slice(2)
		} else if (input.startsWith("/./")) {
			input = input.slice(2)
		} else if (input === "/.") {
			input = "/"
		} else if (input.startsWith("/../")) {
			input = input.slice(3)
			output = output.slice(0, Math.max(0, output.lastIndexOf("/")))
		} else if (input === "/..") {
			input = "/"
			output = output.slice(0, Math.max(0, output.lastIndexOf("/")))
		} else if (input === "." || input === "..") {
			input = ""
		} else {
			const next = input.indexOf("/", input.startsWith("/") ? 1 : 0)
			const end = next < 0 ? input.length : next
			output += input.slice(0, end)
			input = input.slice(end)
		}
	}
	return output
}

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
 * The target of `reference` resolved against `base` (§5.2.2, Transform References, strict), recomposed: the RFC's
 * pseudocode, each branch its own.
 */
export const resolveReference = (base: string, reference: string): string => {
	const b = componentsOf(base)
	const r = componentsOf(reference)
	if (r.scheme !== undefined) {
		return recomposed({ ...r, path: removeDotSegments(r.path) })
	}
	if (r.authority !== undefined) {
		return recomposed({ ...r, scheme: b.scheme, path: removeDotSegments(r.path) })
	}
	if (r.path === "") {
		return recomposed({
			scheme: b.scheme,
			authority: b.authority,
			path: b.path,
			query: r.query ?? b.query,
			fragment: r.fragment
		})
	}
	return recomposed({
		scheme: b.scheme,
		authority: b.authority,
		path: removeDotSegments(r.path.startsWith("/") ? r.path : merge(b, r.path)),
		query: r.query,
		fragment: r.fragment
	})
}
