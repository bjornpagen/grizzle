import { Array as Arr, pipe, String as Str } from "effect"
import type { NamedDetailCodec } from "#compiler/ir/law.ts"
import { decodeDetail, detailTag } from "#compiler/laws/model/detail.ts"

/**
 * A residual law's DETAIL text written on the host, as the law function's expression computes it in SQL
 * (packages/engine/src/laws/model/detail.ts detailExpr): the tag (detailTag), then one JSON array of the relation's declared
 * name and each key value's text, or the relation's name alone when the keys are withheld from a role that does not
 * hold the relation whole. The compiler never writes a DETAIL on the host; tests write one to forge a raised witness
 * and to read a raised one strictly.
 */
export const encodeDetail = (codec: NamedDetailCodec, values: ReadonlyArray<string>): string => {
	if (values.length !== codec.keys.length) {
		throw new Error(
			`DetailCodec: ${codec.keys.length} key values for ${codec.relation}, not ${values.length}`
		)
	}
	return `${detailTag}${JSON.stringify([codec.relation, ...values])}`
}

/** The DETAIL of `codec`'s law with its keys withheld: the tag and the relation's name alone. */
const withheldDetail = (codec: NamedDetailCodec): string =>
	`${detailTag}${JSON.stringify([codec.relation])}`

/**
 * The key texts of a DETAIL a law function raised for a caller that holds the relation whole, read strictly: the
 * library's trusting decodeDetail reads them, and they must encode back to exactly the text, so a DETAIL of another
 * tag, relation, arity or escaping, or one that withholds its keys, fails the test.
 */
export const strictDetail = (codec: NamedDetailCodec, text: string): ReadonlyArray<string> => {
	if (!pipe(text, Str.startsWith(`${detailTag}[${JSON.stringify(codec.relation)}`))) {
		throw new Error(`DETAIL ${text}: not ${codec.relation}'s`)
	}
	const decoded = decodeDetail(codec, text)
	if (decoded.kind === "withheld") {
		throw new Error(`DETAIL ${text}: withholds its keys`)
	}
	const keys = Arr.map(decoded.keys, (k) => k.text)
	if (encodeDetail(codec, keys) !== text) {
		throw new Error(`DETAIL ${text}: not the codec's text of its keys`)
	}
	return keys
}

/**
 * Whether a DETAIL a law function raised withholds its keys, read strictly: exactly the withheld text, or exactly the
 * codec's text of some keys; any other text fails the test.
 */
export const withholds = (codec: NamedDetailCodec, text: string): boolean => {
	if (text === withheldDetail(codec)) {
		return true
	}
	strictDetail(codec, text)
	return false
}
