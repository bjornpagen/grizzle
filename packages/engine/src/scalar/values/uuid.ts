import type { regex } from "arkregex"
import type { ValueFault } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import {
	type UuidGroup,
	uuidGroupStart,
	uuidGroups,
	uuidHyphens,
	uuidTextLength
} from "#compiler/ir/carriers.ts"

/**
 * A uuid host value: ArkRegex's language of uuid_out's spelling, `${string}-${string}-${string}-${string}-${string}`,
 * which every canonical uuid is, crypto.randomUUID()'s own type included. It is the uuid descriptor's host type,
 * domain and language, so a JavaScript value at a uuid column, parameter or fact is one of it, and a plain string
 * becomes one through Uuid.parse.
 *
 * The language is wider than the uuids: TypeScript writes a hexadecimal group as `${string}`, since a template of exact
 * groups would be a union of 16^32 members, so any text with four hyphens is in it ("a-b-c-d-e") and is refused at the
 * boundary instead: toUuid when a parameter or a fact encodes, and the checker for a literal in a description.
 * RegexInfer (types/fields/regex.ts), the guarded path for an author's pattern, would widen this one to string twice over: its
 * scan stops at 40 code units, and a class holding a digit range beside letters could be a union holding `${number}`.
 * Neither applies to the inference itself: ArkRegex writes the hexadecimal class as `${string}`, never `${number}`, and
 * the pattern has no escape and anchors only at the two ends of its one alternative. So ArkRegex's own inference is
 * its language, as is.
 */
export type Uuid = regex.infer<
	"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
	"u"
>

/** One group's digits of a hyphenated text. */
const groupText = (text: string, group: UuidGroup): string =>
	text.slice(uuidGroupStart(group), uuidGroupStart(group) + uuidGroups[group])

/**
 * The uuid admission core, canonical: UUID case and byte encodings need canonicalization.
 *
 * A uuid is 16 bytes. The host spelling is the hyphenated 8-4-4-4-12 hexadecimal form in either case; the canonical
 * value is its lowercase spelling, which is PostgreSQL's uuid_out text, so equal uuids have one host string and string
 * order is byte order. PostgreSQL's other accepted input spellings (braces, missing or regrouped hyphens) are refused
 * at the boundary rather than given a second host spelling.
 *
 * A per-row hot path: one allocation-free scan of the uuidTextLength code units, hex digits with hyphens between the
 * groups (uuidHyphens). The
 * canonical spelling is the input itself when it has no uppercase digit, which is every uuid_out text, and its ASCII
 * lowercase otherwise.
 */
export const toUuid = (value: unknown): Result.Result<string, ValueFault> => {
	if (typeof value !== "string" || value.length !== uuidTextLength) {
		return Result.err("uuidSyntax")
	}
	let upper = false
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		const upperDigit = code >= 0x41 && code <= 0x46
		const lowerDigit = (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66)
		if (uuidHyphens.has(i) ? code !== 0x2d : !upperDigit && !lowerDigit) {
			return Result.err("uuidSyntax")
		}
		upper ||= upperDigit
	}
	return Result.ok(upper ? value.toLowerCase() : value)
}

/** A canonical uuid text toUuid admitted, as the value it spells: its five groups, hyphenated. */
const spelled = (text: string): Uuid =>
	`${groupText(text, 0)}-${groupText(text, 1)}-${groupText(text, 2)}-${groupText(text, 3)}-${groupText(text, 4)}`

/**
 * The public parse of a uuid: any value, refused unless it is a hyphenated 8-4-4-4-12 hexadecimal text in either case
 * (`uuidSyntax`), and otherwise the Uuid of its canonical spelling. A caller holding a plain string id gets the Uuid a
 * uuid column, parameter or fact takes through it, once.
 */
const parse = (input: unknown): Result.Result<Uuid, ValueFault> =>
	Result.map(toUuid(input), spelled)

/** The uuid operations, beside the Uuid type of the same name. */
export const Uuid = Object.freeze({ parse })
