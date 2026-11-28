/** What the properties of parse.test.ts read: its spaces, models and helpers. */

import type { RegexNode } from "@bjornpagen/grizzle-text/regex/ir"
import { parsePattern, type RegexFlags } from "@bjornpagen/grizzle-text/regex/parse"
import {
	aimed,
	array,
	codePoint,
	constant,
	element,
	type Gen,
	oneOf,
	string
} from "@bjornpagen/testing/gen"
import { lsw, WILD_KINDS, type WildKind } from "@bjornpagen/testing/lsw"
import { regex } from "arkregex"
import { Array as Arr, Option, Result, String as Str } from "effect"
import { nonStringWildKinds } from "#test/support/unit/values/support.ts"

export const parse = (source: string, flags: RegexFlags) => parsePattern(source, flags)

export const failure = (source: string, flags: RegexFlags) => {
	const result = parse(source, flags)
	if (result.ok) {
		throw new Error(`expected /${source}/${flags} to be refused`)
	}
	return result.error
}

/** Whether ECMAScript compiles the source as a pattern of the u flag, whose unicode flag its RegExp then carries. */
export const jsValid = (source: string): boolean =>
	Result.getOrElse(
		Result.try(() => regex.as(source, "u").unicode),
		() => false
	)

/**
 * A construct outside the admitted fragment, planted with the context it needs: valid ECMAScript `lead`, the construct
 * itself, and `tail`, so the refusal stands where the construct begins, after the lead.
 */
interface Planting {
	readonly lead: string
	readonly construct: string
	readonly tail: string
}

/** Up to `max` lowercase ASCII letters. */
export const lowercase = (max: number) => string(codePoint(0x61, 0x7a), { min: 0, max })

/**
 * Valid ECMAScript outside the admitted fragment, the dictionary of the scanner's refusals: backreferences, named groups
 * and references, lookarounds, word-boundary assertions, \s and \S, property escapes, lazy quantifiers, bounds above
 * 255, NUL and lone surrogates, inline modifiers, and the first of two refusals in source order.
 */
export const unsupported = [
	{ lead: "(a)", construct: "\\1", tail: "" },
	{ lead: "", construct: "(?<n>a)", tail: "\\k<n>" },
	{ lead: "a", construct: "(?=b)", tail: "" },
	{ lead: "a", construct: "(?!b)", tail: "" },
	{ lead: "", construct: "(?<=a)", tail: "b" },
	{ lead: "", construct: "(?<!a)", tail: "b" },
	{ lead: "", construct: "\\b", tail: "word" },
	{ lead: "a", construct: "\\B", tail: "" },
	{ lead: "x", construct: "\\s", tail: "" },
	{ lead: "[", construct: "\\S", tail: "]" },
	{ lead: "", construct: "\\p{L}", tail: "" },
	{ lead: "[", construct: "\\P{Lu}", tail: "]" },
	{ lead: "ab", construct: "*?", tail: "" },
	{ lead: "a", construct: "{2,3}?", tail: "" },
	{ lead: "a", construct: "{256}", tail: "" },
	{ lead: "a", construct: "{0,1000}", tail: "" },
	{ lead: "a", construct: "\\0", tail: "" },
	{ lead: "[", construct: "\\x00", tail: "-\\x7f]" },
	{ lead: "", construct: "\\u{0}", tail: "" },
	{ lead: "", construct: "\\uD800", tail: "" },
	{ lead: "a", construct: "\\u{DC00}", tail: "" },
	{ lead: "", construct: "\\1", tail: "(a)" },
	{ lead: "", construct: "(?<a>x)", tail: "\\k<a>" },
	{ lead: "", construct: "\\k<a>", tail: "(?<a>x)" },
	{ lead: "", construct: "(?<\\u0061>x)", tail: "\\k<a>" },
	{ lead: "", construct: "(?<a>x)", tail: "|(?<a>y)" },
	{ lead: "(?:", construct: "(?<a>x)", tail: "|(?<a>y))z" },
	{ lead: "", construct: "(?<a$1>x)", tail: "" },
	{ lead: "", construct: "(?i-:a)", tail: "" },
	{ lead: "", construct: "(?-ms:a)", tail: "" },
	{ lead: "", construct: "\\p{gc=Lu}", tail: "" },
	{ lead: "(a)", construct: "\\1", tail: "*" },
	{ lead: "a", construct: "{256}", tail: "(?=b)\\s" },
	{ lead: "a", construct: "*?", tail: "\\u{0}" }
] as const satisfies ReadonlyArray<Planting>

type Planted = (typeof unsupported)[number]

/** A planted construct's whole spelling, which names it among the required situations. */
export type Spelled = `${Planted["lead"]}${Planted["construct"]}${Planted["tail"]}`

export const spelling = (planted: Planted): Spelled =>
	`${planted.lead}${planted.construct}${planted.tail}`

/** A planting `planted` draws, between up to six drawn lowercase letters on each side. */
const plantedAmid =
	(planted: Gen<Planted>): Gen<Readonly<{ planted: Planted; before: string; after: string }>> =>
	(source) => ({
		planted: source.draw(planted),
		before: source.draw(lowercase(6)),
		after: source.draw(lowercase(6))
	})

/**
 * Every planting of the dictionary between drawn letters, aimed: a witness whose turn aims at a planting's spelling
 * draws that planting, so each construct is planted within the witnesses on every worker.
 */
export const plantedSpace = aimed(
	plantedAmid(element(unsupported)),
	Arr.map(unsupported, (planted) => [spelling(planted), plantedAmid(constant(planted))] as const)
)

/**
 * A Description's flags are "u" or "su" by its type, and str.regex's admission (field.ts admitRegex) is the boundary
 * that takes what a JavaScript caller passes. Any other flags value is malformed structure, whether or not ECMAScript
 * reads it as a flag string and whatever the source holds, and so is a source that is no string.
 */
export type FlagsFeature =
	| "admitted flags"
	| "other flags"
	| "a non-string source"
	| "no flags"
	| `wild ${WildKind}`

/**
 * How a nesting wraps its one literal: groups of either spelling, which leave no node behind, so the parse is the
 * literal's; a chain of `+` groups, a repetition of a repetition at each level; and a chain of optional groups, each
 * level a literal and an optional group around the rest; and XML Schema's groups and class subtractions, read by its
 * own reader, a group leaving no node and `[b-[a-[a…]]]` the class of `b` alone, whatever its depth. Each scan keeps
 * its open groups on the heap (scalar/regex/parse.ts Disjunction, regex/xsd.ts XsdReader.read's stack and
 * #classExpression's chain of groups) and every walk of the IR keeps its frames there too (scalar/regex/ir.ts folded),
 * so no depth is a bound of either grammar's: a pattern nested 100,000 deep parses in the small-stack project, whose
 * stack a recursion of about a thousand frames exhausts.
 */
export type Nesting =
	| "capturing groups"
	| "non-capturing groups"
	| "a chain of + groups"
	| "a chain of optional groups"
	| "XML Schema groups"
	| "XML Schema class subtractions"

export const nestings: Arr.NonEmptyReadonlyArray<Nesting> = [
	"capturing groups",
	"non-capturing groups",
	"a chain of + groups",
	"a chain of optional groups",
	"XML Schema groups",
	"XML Schema class subtractions"
]

/** The pattern `depth` levels of `nesting` spell. */
export const nested = (nesting: Nesting, depth: number): string => {
	switch (nesting) {
		case "capturing groups":
			return `${Str.repeat(depth)("(")}a${Str.repeat(depth)(")")}`
		case "non-capturing groups":
			return `${Str.repeat(depth)("(?:")}a${Str.repeat(depth)(")")}`
		case "a chain of + groups":
			return `${Str.repeat(depth)("(?:")}a${Str.repeat(depth)(")+")}`
		case "a chain of optional groups":
			return `${Str.repeat(depth)("(?:a")}${Str.repeat(depth)(")?")}`
		case "XML Schema groups":
			return `${Str.repeat(depth)("(")}a${Str.repeat(depth)(")")}`
		case "XML Schema class subtractions":
			return `[b${Str.repeat(depth)("-[a")}${Str.repeat(depth + 1)("]")}`
	}
}

/** How deep a chain of repetitions nests: the repetitions from the root down through each one's body. */
export const repetitionDepth = (node: RegexNode): number => {
	let depth = 0
	for (let at = node; at.kind === "repeat"; at = at.body) {
		depth += 1
	}
	return depth
}

/**
 * Sources over the grammar's syntax characters, escapes, group and reference spellings. Property escapes and
 * non-ASCII names are left out: their validity needs Unicode tables the scanner does not carry (scalar/regex/parse.ts).
 */
export const unit = element([
	...Str.split("ab1209()?:<>=!|[]-^$.*+{},\\kxucsdwBiPm", ""),
	"(?<a>",
	"(?<b>",
	"\\k<a>",
	"\\k<b>",
	"(?:",
	"(?=",
	"(?<=",
	"(?i:",
	"(?-s:",
	"\\u{41}",
	"\\x41",
	"\\u0041"
])

/**
 * What a random source is to the scanner: admitted, refused as malformed or as unsupported, and malformed by a `)` that
 * closes no group, the refusal a scanner that passed over the `)` would turn into an admission.
 */
export type SourceKind =
	| "malformed"
	| "admitted"
	| "unsupported"
	| "malformed by a ')' that closes no group"

/**
 * A random source with a `)` among its units: up to three units on each side, so the `)` often closes no group and is
 * the source's one malformation, which random units alone seldom spell.
 */
export const strayClose: Gen<ReadonlyArray<string>> = (source) => [
	...source.draw(array(unit, { min: 0, max: 3 })),
	")",
	...source.draw(array(unit, { min: 0, max: 3 }))
]

/**
 * A random source with a construct of the dictionary planted among its units: up to three units on each side, so the
 * source is often valid ECMAScript the scanner refuses as unsupported, which random units alone seldom spell.
 */
export const plantedUnits: Gen<ReadonlyArray<string>> = (source) => [
	...source.draw(array(unit, { min: 0, max: 3 })),
	spelling(source.draw(element(unsupported))),
	...source.draw(array(unit, { min: 0, max: 3 }))
]

export const sourceGen = lsw<string>({
	live: element(["a", "(", "a{2,1}", "(?=a)b", "^[a-z]+$"]),
	stale: Option.none(),
	wild: nonStringWildKinds
})

export const flagsGen = lsw<string>({
	live: oneOf([
		element(["u", "su"]),
		string(element(Str.split("usgimdyvx U", "")), { min: 0, max: 4 })
	]),
	stale: Option.none(),
	wild: WILD_KINDS
})
