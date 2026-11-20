import { jsonTextOf } from "@superstarter/json"
import { regex } from "arkregex"
import { Array as Arr, JsonPointer, Option, String as Str } from "effect"
import { isRefusal } from "#model/diagnostic.ts"
import type { Diagnostic } from "#model/diagnostic.ts"

const unsafeCharacter = regex("^[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}]$", "u")

/** One code point of a field: a control, format, separator or lone surrogate character as its visible escape. */
const sanitizeCharacter = (character: string): string =>
	unsafeCharacter.test(character)
		? Option.match(Str.codePointAt(0)(character), {
				onNone: () => character,
				onSome: (point) => `\\u{${point.toString(16)}}`
			})
		: character

/**
 * Neutralizes control, format, separator and lone surrogate characters in one field of a human
 * line by writing each as a visible `\u{hex}` escape. An ANSI escape loses its ESC byte and stays
 * inert text (design 8.1, C8).
 */
export const sanitizeField = (text: string): string =>
	Arr.join(Arr.map(Arr.fromIterable(text), sanitizeCharacter), "")

const operationLabel = (operation: NonNullable<Diagnostic["operation"]>): string => {
	const route = `${operation.method} ${operation.path}`
	const label = operation.operationId === undefined ? route : `${route}, ${operation.operationId}`

	return ` (${sanitizeField(label)})`
}

/**
 * A field refusal sits at its Encoding entry, `<media>/encoding/<name>` (design 8.5 rule 4), so the
 * pointer names the field and its media type; any other pointer names the `element`.
 */
const fieldLabel = (diagnostic: Diagnostic): string => {
	const [media, keyword, name] = Arr.takeRight(Str.split("/")(diagnostic.pointer), 3)
	const entry = keyword === "encoding" && media !== undefined && name !== undefined
	const field = jsonTextOf(entry ? JsonPointer.unescapeToken(name) : diagnostic.element)
	const label = entry ? `${field} in ${JsonPointer.unescapeToken(media)}` : field

	return ` field ${sanitizeField(label)}`
}

/**
 * Renders one diagnostic as one human line (design 8.1): `<refused|notice> <code> at #<pointer>[
 * (<METHOD> <path>[, <operationId>])][ field "<name>" in <media type>]: <message>; <specSection>`.
 * The field part is present for a `field` refusal only. Every free-text field is sanitized.
 * `line`, `column`, `hint` and `related` stay out of the line.
 */
export const humanLine = (diagnostic: Diagnostic): string => {
	const severity = isRefusal(diagnostic) ? "refused" : "notice"
	const where = `#${sanitizeField(diagnostic.pointer)}`
	const operation = diagnostic.operation === undefined ? "" : operationLabel(diagnostic.operation)
	const field = diagnostic.scope === "field" ? fieldLabel(diagnostic) : ""

	return `${severity} ${sanitizeField(diagnostic.code)} at ${where}${operation}${field}: ${sanitizeField(diagnostic.message)}; ${sanitizeField(diagnostic.specSection)}`
}
