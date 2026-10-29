import { regex } from "arkregex"
import { Array as Arr, String as Str } from "effect"

/** RegExp's flags in the order RegExp.prototype.flags spells them. */
const FLAG_ORDER = "dgimsuvy"

/** A flags text in that order, each flag at most once and never both u and v: the flags arkregex takes. */
const orderedFlags = regex("^d?g?i?m?s?[uv]?y?$")

/**
 * A pattern compiled from a source and flags a value holds, its flags read in RegExp's own order. Flags RegExp refuses
 * (a flag twice, an unknown one, both u and v) are refused here with the SyntaxError RegExp throws.
 */
export const compiledPattern = (source: string, flags: string): RegExp => {
	const ordered = Arr.join(
		Arr.filter(Str.split("")(FLAG_ORDER), (flag) => Str.includes(flag)(flags)),
		""
	)
	if (ordered.length !== flags.length || !orderedFlags.test(ordered)) {
		throw new SyntaxError(`Invalid flags supplied to RegExp constructor '${flags}'`)
	}
	return regex.as(source, ordered)
}
