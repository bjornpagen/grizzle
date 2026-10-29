import { jsonStrings } from "#compiler/core/json-strings.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { NamedDetailCodec } from "#compiler/ir/law.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { binary, call, cast, lit, types } from "#compiler/sql/build.ts"

export const detailTag = "w"

/** What a DETAIL raised by a law carries: the violating fact's key texts, each with its key column of the codec, or
 * none, withheld from a role that does not hold the violating relation whole. */
export type DecodedDetail =
	| {
			readonly kind: "keys"
			readonly keys: ReadonlyArray<{ readonly field: string; readonly text: string }>
	  }
	| { readonly kind: "withheld" }

/** The withheld DETAIL of a law whose codec's relation is `relation`: the tag and the relation alone. */
const withheldText = (relation: string): string => `${detailTag}[${JSON.stringify(relation)}]`

/** The key texts of a DETAIL raised by the law whose codec, by name (`namedDetail`), is `codec`: the strings after the
 * relation's, one per key column with its column, or none when the DETAIL withholds them. */
export const decodeDetail = (codec: NamedDetailCodec, text: string): DecodedDetail => {
	if (text === withheldText(codec.relation)) {
		return { kind: "withheld" }
	}
	const next = jsonStrings(text)
	next()
	return { kind: "keys", keys: codec.keys.map((field) => ({ field, text: next() })) }
}

/** The SQL expression of the withheld DETAIL of the law whose codec's relation is `relation`. */
export const withheldDetailExpr = (relation: string): Expr =>
	lit.text(withheldText(relation), types.text)

/** The SQL expression of the DETAIL for one key tuple, `value(key, i)` the expression of the value of the codec's i-th
 * key field: the constant prefix, then `to_jsonb(<value>::text)::text` per value, separated by commas, then the
 * closing bracket.
 *
 * The DETAIL text of a law's violation, the fixed text encoding of a residual law's DETAIL.
 *
 * A law function raises with its stable identity as the constraint name and a key-only DETAIL. The runtime builds the
 * witness from fields grizzle controls and never parses PostgreSQL's prose, so the DETAIL is grizzle's own text:
 *
 *   w["<relation>","<key value>",...]
 *
 * or, raised for a role that does not hold the violating relation whole, the relation alone, its keys withheld:
 *
 *   w["<relation>"]
 *
 * the tag `w` (a residual law's witness) immediately followed by a JSON array of strings: the declared name of the
 * relation whose facts violate, then the text form of each of its key columns in the codec's key order. Each value is its type's
 * text output, the same form the result codecs convert, so the adapter converts a witness key with the
 * column's codec. JSON string escaping is the escape: a key text holding quotes, backslashes, commas, brackets or
 * control characters stays one component, and PostgreSQL produces it with `to_jsonb(<value>::text)::text`, so the law
 * function composes the DETAIL from builtin operators alone. The tag keeps the DETAIL apart from a
 * statement's refusal DETAIL, which one law can raise under the same constraint name.
 *
 * `decodeDetail` trusts its text: the runtime reads a residual law's DETAIL only from that law's own function, which
 * grizzle installed, so the text is this codec's and nothing is checked. */
export const detailExpr = <K>(
	codec: { readonly relation: string; readonly keys: NonEmptyReadonlyArray<K> },
	value: (key: K, i: number) => Expr
): Expr => {
	const pieces = codec.keys.flatMap((key, i) => {
		const text = cast(call("to_jsonb", [cast(value(key, i), types.text)]), types.text)
		return i === 0 ? [text] : [lit.text(",", types.text), text]
	})
	const opening: Expr = lit.text(`${detailTag}[${JSON.stringify(codec.relation)},`, types.text)
	return [...pieces, lit.text("]", types.text)].reduce(
		(left, right) => binary("||", left, right),
		opening
	)
}
