import { JsonPointer, String as Str } from "effect"

/**
 * The only `$ref` form the schema store resolves: a key of the document-level `$defs` map.
 */
export const defsRefPrefix = "#/$defs/"

/**
 * The `$defs` key a `$ref` names, or `undefined` when the reference is not under `#/$defs/`.
 * The key is the plain slice after the prefix with `~1` and `~0` unescaped; nothing is
 * percent-decoded.
 */
export const defsKeyOf = (ref: string): string | undefined =>
	Str.startsWith(defsRefPrefix)(ref)
		? JsonPointer.unescapeToken(Str.slice(defsRefPrefix.length)(ref))
		: undefined
