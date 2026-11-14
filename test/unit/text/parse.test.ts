/**
 * The admitted grammar and its diagnostics.
 *
 * Each refusal carries its reason, pinned against ECMAScript itself: a MalformedDescription refusal is a pattern
 * `new RegExp(source, "u")` also throws on, and an UnsupportedOperation refusal is valid ECMAScript outside the admitted
 * fragment.
 *
 * - Unsupported: valid ECMAScript outside the fragment, each construct of the scanner's dictionary planted between
 *   drawn letters, is refused as UnsupportedOperation where the construct begins. Oracle: ECMAScript's RegExp reads it.
 * - Malformed: a random source is MalformedDescription exactly where ECMAScript's Unicode mode throws. Oracle: a
 *   differential against ECMAScript's RegExp.
 * - Text: a literal NUL or lone surrogate planted in a source is refused at its offset. Oracle: the specification.
 * - Flags: the builder refuses exactly the flags other than u and su, and a non-string source, as malformed. Oracle:
 *   the specification as a checker.
 * - Nesting: a pattern nested 1, 1,000 or 100,000 levels deep parses, its groups leaving no node, and its chains of
 *   repetitions and of optional groups as deep as written. Oracle: the specification, the nesting's own depth.
 *
 * Features: every planted construct; malformed, admitted and unsupported sources; a NUL and a lone surrogate; admitted
 * and other flags, a non-string source, no flags and every wild kind; each nesting.
 *
 * Plants: text-parse-lookahead-offset (a lookahead refused one code point late), text-parse-stray-paren (an
 * unmatched ')' passed over), text-parse-nul-admitted (a literal NUL admitted), text-flags-any-string (any flags
 * string admitted), text-expanded-size-empty-arm (an optional's empty arm counted as a written-out position).
 */
import { drawn, exhaust, explore } from "@bjornpagen/testing/explore"
import { required, requiredInSpace } from "@bjornpagen/testing/features"
import { array, codePoint, element, map, oneOf, option, string } from "@bjornpagen/testing/gen"
import { drawnFeature, lsw, passed, WILD_KINDS, type WildKind } from "@bjornpagen/testing/lsw"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { expandedSize, type RegexNode } from "#compiler/scalar/regex/ir.ts"
import { parsePattern, type RegexFlags } from "#compiler/scalar/regex/parse.ts"
import { admitRegex } from "#compiler/text/field.ts"
import { assert, matchesObject, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { nonStringWildKinds } from "#test/unit/values/support.ts"

import { regex } from "arkregex"
const parse = (source: string, flags: RegexFlags) => parsePattern(source, flags)
const failure = (source: string, flags: RegexFlags) => {
	const result = parse(source, flags)
	if (result.ok) {
		throw new Error(`expected /${source}/${flags} to be refused`)
	}
	return result.error
}

/** Whether ECMAScript compiles the source as a pattern of the u flag, whose unicode flag its RegExp then carries. */
const jsValid = (source: string): boolean =>
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
const lowercase = (max: number) => string(codePoint(0x61, 0x7a), { min: 0, max })

/**
 * Valid ECMAScript outside the admitted fragment, the dictionary of the scanner's refusals: backreferences, named groups
 * and references, lookarounds, word-boundary assertions, \s and \S, property escapes, lazy quantifiers, bounds above
 * 255, NUL and lone surrogates, inline modifiers, and the first of two refusals in source order.
 */
const unsupported = [
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
type Spelled = `${Planted["lead"]}${Planted["construct"]}${Planted["tail"]}`

const spelling = (planted: Planted): Spelled => `${planted.lead}${planted.construct}${planted.tail}`

describe("refusals with location and reason", () => {
	it.effect(
		"refuses valid ECMAScript outside the fragment where the construct begins, wherever it is planted",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/text/parse-unsupported",
						draw: drawn((source) => ({
							planted: source.draw(element<Planted>(unsupported)),
							before: source.draw(lowercase(6)),
							after: source.draw(lowercase(6))
						})),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "ECMAScript's own RegExp, which reads every source"
						},
						coverage: required<Spelled>(Arr.map(unsupported, spelling), {
							cases: 600,
							sense: notesOnly
						}),
						kept: [],
						runs: 600,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ planted, before, after }, c) =>
						Effect.sync(() => {
							c.note(spelling(planted))
							const source = `${before}${spelling(planted)}${after}`
							assert.equal(jsValid(source), true, source)
							matchesObject(failure(source, "u"), {
								reason: "UnsupportedOperation",
								offset: Arr.fromIterable(`${before}${planted.lead}`).length
							})
						})
				)
			)
	)

	it.effect(
		"is MalformedDescription exactly where ECMAScript's Unicode mode throws, on random sources",
		(ctx) => {
			/**
			 * Sources over the grammar's syntax characters, escapes, group and reference spellings. Property escapes and
			 * non-ASCII names are left out: their validity needs Unicode tables the scanner does not carry (scalar/regex/parse.ts).
			 */
			const unit = element([
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
			return searched(
				ctx,
				explore(
					{
						oracle: { kind: "second-implementation", name: "ECMAScript's RegExp in Unicode mode" },
						suite: "unit/text/parse-7168364",
						draw: drawn(array(unit, { min: 0, max: 9 })),
						literal: Formatter.format,
						coverage: required<"malformed" | "admitted" | "unsupported">(
							["malformed", "admitted", "unsupported"],
							{ cases: 1000, sense: notesOnly }
						),
						kept: [],
						runs: 30000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(units, c) =>
						Effect.sync(() => {
							const source = Arr.join(units, "")
							const result = parse(source, "u")
							const malformed = !result.ok && result.error.reason === "MalformedDescription"
							c.note(result.ok ? "admitted" : malformed ? "malformed" : "unsupported")
							assert.equal(malformed, !jsValid(source), source)
						})
				)
			)
		}
	)

	it.effect("refuses a literal NUL and a lone surrogate in the source, at its offset", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "NUL and a lone surrogate are no admitted text, refused where they stand"
					},
					suite: "unit/text/parse-text",
					draw: drawn((source) => ({
						before: source.draw(lowercase(8)),
						after: source.draw(lowercase(8)),
						planted: source.draw(element(["\u0000", "\ud800", "\udfff"])),
						flags: source.draw(element<RegexFlags>(["u", "su"]))
					})),
					literal: Formatter.format,
					coverage: required<"a NUL" | "a lone surrogate">(["a NUL", "a lone surrogate"], {
						cases: 100,
						sense: notesOnly
					}),
					kept: [],
					runs: 100,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ before, after, planted, flags }, c) =>
					Effect.sync(() => {
						c.note(planted === "\u0000" ? "a NUL" : "a lone surrogate")
						matchesObject(failure(`${before}${planted}${after}`, flags), {
							reason: "UnsupportedOperation",
							offset: before.length
						})
					})
			)
		)
	)

	/**
	 * A Description's flags are "u" or "su" by its type, and str.regex's admission (field.ts admitRegex) is the boundary
	 * that takes what a JavaScript caller passes. Any other flags value is malformed structure, whether or not ECMAScript
	 * reads it as a flag string and whatever the source holds, and so is a source that is no string.
	 */
	type FlagsFeature =
		| "admitted flags"
		| "other flags"
		| "a non-string source"
		| "no flags"
		| `wild ${WildKind}`

	it.effect(
		"refuses exactly the flags other than u and su, and a non-string source, as malformed, at the builder",
		(ctx) => {
			const sourceGen = lsw<string>({
				live: element(["a", "(", "a{2,1}", "(?=a)b", "^[a-z]+$"]),
				stale: Option.none(),
				wild: nonStringWildKinds
			})
			const flagsGen = lsw<string>({
				live: oneOf([
					element(["u", "su"]),
					string(element(Str.split("usgimdyvx U", "")), { min: 0, max: 4 })
				]),
				stale: Option.none(),
				wild: WILD_KINDS
			})
			return searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "a Description's flags are u or su, and its source a string"
						},
						suite: "unit/text/regex-flags",
						draw: drawn(
							(source) =>
								[
									source.draw(sourceGen),
									source.draw(map(option(flagsGen), Option.getOrUndefined))
								] as const
						),
						literal: Formatter.format,
						coverage: required<FlagsFeature>(
							[
								"admitted flags",
								"other flags",
								"a non-string source",
								"no flags",
								...Arr.map(WILD_KINDS, (kind): FlagsFeature => `wild ${kind}`)
							],
							{ cases: 1000, sense: notesOnly }
						),
						kept: [],
						/** The replaced flags search's own bound. */
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([sourceDrawn, flagsDrawn], c) =>
						Effect.sync(() => {
							const source = passed(sourceDrawn)
							const flags = flagsDrawn === undefined ? undefined : passed(flagsDrawn)
							if (sourceDrawn.kind === "wild") {
								c.note(`wild ${sourceDrawn.wild.kind}`)
							}
							if (flagsDrawn?.kind === "wild") {
								c.note(`wild ${flagsDrawn.wild.kind}`)
							}
							const admittedFlags = flags === undefined || flags === "u" || flags === "su"
							c.note(
								typeof source !== "string"
									? "a non-string source"
									: flags === undefined
										? "no flags"
										: admittedFlags
											? "admitted flags"
											: "other flags"
							)
							const malformed = typeof source !== "string" || !admittedFlags
							/** The case by its kinds: a wild value is never rendered. */
							const call = `str.regex(${drawnFeature(sourceDrawn)}, ${flagsDrawn === undefined ? "no flags" : drawnFeature(flagsDrawn)})`
							const admitted = catchCompileError(() => admitRegex(source, flags))
							assert.equal(
								!admitted.ok && admitted.error.reason._tag === "MalformedDescription",
								malformed,
								call
							)
						})
				)
			)
		}
	)
})

/**
 * How a nesting wraps its one literal: groups of either spelling, which leave no node behind, so the parse is the
 * literal's; a chain of `+` groups, a repetition of a repetition at each level; and a chain of optional groups, each
 * level a literal and an optional group around the rest. The scan keeps its open groups on the heap
 * (scalar/regex/parse.ts Disjunction) and every walk of the IR keeps its frames there too (scalar/regex/ir.ts folded),
 * so no depth is a bound of the grammar's: a pattern nested 100,000 deep parses in the small-stack project, whose stack
 * a recursion of about a thousand frames exhausts.
 */
type Nesting =
	| "capturing groups"
	| "non-capturing groups"
	| "a chain of + groups"
	| "a chain of optional groups"
const nestings: Arr.NonEmptyReadonlyArray<Nesting> = [
	"capturing groups",
	"non-capturing groups",
	"a chain of + groups",
	"a chain of optional groups"
]

/** The pattern `depth` levels of `nesting` spell. */
const nested = (nesting: Nesting, depth: number): string => {
	switch (nesting) {
		case "capturing groups":
			return `${Str.repeat(depth)("(")}a${Str.repeat(depth)(")")}`
		case "non-capturing groups":
			return `${Str.repeat(depth)("(?:")}a${Str.repeat(depth)(")")}`
		case "a chain of + groups":
			return `${Str.repeat(depth)("(?:")}a${Str.repeat(depth)(")+")}`
		case "a chain of optional groups":
			return `${Str.repeat(depth)("(?:a")}${Str.repeat(depth)(")?")}`
	}
}

/** How deep a chain of repetitions nests: the repetitions from the root down through each one's body. */
const repetitionDepth = (node: RegexNode): number => {
	let depth = 0
	for (let at = node; at.kind === "repeat"; at = at.body) {
		depth += 1
	}
	return depth
}

describe("nesting", () => {
	it.effect("parses a pattern nested to any depth, 100,000 levels included", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					box: "every nesting, 1, 1,000 and 100,000 levels deep",
					oracle: {
						kind: "specification",
						name: "groups leave no node, and a chain of repetitions or of optional groups is as deep as written"
					},
					suite: "unit/text/parse-depth",
					literal: Formatter.format,
					generator: (source) => ({
						nesting: source.draw(element(nestings)),
						depth: source.draw(element([1, 1_000, 100_000]))
					}),
					coverage: requiredInSpace<Nesting>(nestings),
					caseHang,
					concurrency: 1
				},
				({ nesting, depth }, n) =>
					Effect.sync(() => {
						n.note(nesting)
						const ir = succeeded(parse(nested(nesting, depth), "u"), `${nesting}, ${depth} deep`)
						switch (nesting) {
							case "capturing groups":
							case "non-capturing groups":
								assert.deepEqual(ir, succeeded(parse("a", "u")), `${nesting}, ${depth} deep`)
								return
							case "a chain of + groups":
								assert.equal(repetitionDepth(ir), depth, `${nesting}, ${depth} deep`)
								return
							case "a chain of optional groups":
								assert.equal(expandedSize(ir), depth, `${nesting}, ${depth} deep`)
								return
						}
					})
			)
		)
	)
})
