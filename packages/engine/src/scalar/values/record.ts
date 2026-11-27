/**
 * The text of a PostgreSQL record, a variant's composite (ir/scalar.ts VariantType), both ways: the attribute
 * record_in reads (recordAttribute), and the attributes of a record text, record_out's or a literal recordAttribute
 * quoted (recordAttributes).
 *
 * A record's text is `(` its attributes separated by `,` `)`. An attribute left empty and unquoted is NULL. A quoted
 * attribute is its text between double quotes, in which a backslash takes the character after it as it is and two
 * double quotes are one; record_out quotes an attribute that is empty or holds a quote, a backslash, a parenthesis, a
 * comma or white space, doubling each quote and backslash in it, and leaves any other unquoted, and recordAttribute
 * quotes every attribute it writes, escaping each quote and backslash by a backslash, so the empty text is `""`, never
 * NULL. Both are a per-row hot path: one pass over the text, one slice per unquoted attribute and one string per quoted
 * one.
 */

/**
 * One attribute of a record literal as PostgreSQL's record_in reads it: a value's text in double quotes, each `"` and
 * `\` in it escaped by a backslash, so a quoted empty text is the empty string and only an attribute left unwritten is
 * NULL.
 */
const recordAttribute = (text: string): string =>
	`"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`

/** A record literal of `attributes`, each quoted (recordAttribute), an absent one, NULL, left unwritten. */
export const recordText = (attributes: ReadonlyArray<string | undefined>): string =>
	`(${attributes.map((a) => (a === undefined ? "" : recordAttribute(a))).join(",")})`

/** The code unit of a double quote, a backslash, a comma and a closing parenthesis. */
const quote = 0x22
const backslash = 0x5c
const comma = 0x2c
const close = 0x29

/**
 * The attributes of a record's text, each its text or none for NULL, in order: record_out's of a value PostgreSQL holds,
 * or a literal recordText wrote. The text is PostgreSQL's own or grizzle's, so nothing is checked.
 */
export const recordAttributes = (text: string): ReadonlyArray<string | undefined> => {
	const attributes: Array<string | undefined> = []
	let at = 1
	const end = text.length - 1
	for (;;) {
		if (text.charCodeAt(at) === quote) {
			let value = ""
			let from = at + 1
			at = from
			for (;;) {
				const c = text.charCodeAt(at)
				if (c === backslash) {
					value += text.slice(from, at)
					from = at + 1
					at += 2
				} else if (c === quote) {
					if (text.charCodeAt(at + 1) === quote) {
						value += text.slice(from, at + 1)
						at += 2
						from = at
					} else {
						value += text.slice(from, at)
						at++
						break
					}
				} else {
					at++
				}
			}
			attributes.push(value)
		} else {
			let stop = at
			while (stop < end && text.charCodeAt(stop) !== comma) {
				stop++
			}
			attributes.push(stop === at ? undefined : text.slice(at, stop))
			at = stop
		}
		const c = text.charCodeAt(at)
		if (c === close || at >= end) {
			return attributes
		}
		at++
	}
}
