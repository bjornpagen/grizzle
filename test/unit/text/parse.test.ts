import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required, requiredInSpace } from "@grizzle/testing/features"
import { array, codePoint, element, map, oneOf, option, string } from "@grizzle/testing/gen"
import { drawnFeature, lsw, passed, WILD_KINDS, type WildKind } from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Result, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { expandedSize, type RegexNode } from "#compiler/scalar/regex/ir.ts"
import { parsePattern, type RegexFlags } from "#compiler/scalar/regex/parse.ts"
import { admitRegex } from "#compiler/text/field.ts"
import { assert, matchesObject, succeeded } from "#test/support/assert.ts"
import { nonStringWildKinds } from "#test/unit/values/support.ts"

import { regex } from "arkregex"
/**
 * The admitted grammar and its diagnostics.
 *
 * Each refusal carries its reason, pinned against ECMAScript itself: a MalformedDescription refusal is a pattern
 * `new RegExp(source, "u")` also throws on, and an UnsupportedOperation refusal is valid ECMAScript outside the admitted
 * fragment.
 */
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

interface Refusal {
	readonly source: string
	readonly reason: "UnsupportedOperation"
	readonly offset: number
}

/** Up to `max` lowercase ASCII letters. */
const lowercase = (max: number) => string(codePoint(0x61, 0x7a), { min: 0, max })

/** Valid ECMAScript outside the admitted fragment. */
const unsupported = [
	{ source: "(a)\\1", reason: "UnsupportedOperation", offset: 3 },
	{ source: "(?<n>a)\\k<n>", reason: "UnsupportedOperation", offset: 0 },
	{ source: "a(?=b)", reason: "UnsupportedOperation", offset: 1 },
	{ source: "a(?!b)", reason: "UnsupportedOperation", offset: 1 },
	{ source: "(?<=a)b", reason: "UnsupportedOperation", offset: 0 },
	{ source: "(?<!a)b", reason: "UnsupportedOperation", offset: 0 },
	{ source: "\\bword", reason: "UnsupportedOperation", offset: 0 },
	{ source: "a\\B", reason: "UnsupportedOperation", offset: 1 },
	{ source: "x\\s", reason: "UnsupportedOperation", offset: 1 },
	{ source: "[\\S]", reason: "UnsupportedOperation", offset: 1 },
	{ source: "\\p{L}", reason: "UnsupportedOperation", offset: 0 },
	{ source: "[\\P{Lu}]", reason: "UnsupportedOperation", offset: 1 },
	{ source: "ab*?", reason: "UnsupportedOperation", offset: 2 },
	{ source: "a{2,3}?", reason: "UnsupportedOperation", offset: 1 },
	{ source: "a{256}", reason: "UnsupportedOperation", offset: 1 },
	{ source: "a{0,1000}", reason: "UnsupportedOperation", offset: 1 },
	{ source: "a\\0", reason: "UnsupportedOperation", offset: 1 },
	{ source: "[\\x00-\\x7f]", reason: "UnsupportedOperation", offset: 1 },
	{ source: "\\u{0}", reason: "UnsupportedOperation", offset: 0 },
	{ source: "\\uD800", reason: "UnsupportedOperation", offset: 0 },
	{ source: "a\\u{DC00}", reason: "UnsupportedOperation", offset: 1 },
	{ source: "\\1(a)", reason: "UnsupportedOperation", offset: 0 },
	{ source: "(?<a>x)\\k<a>", reason: "UnsupportedOperation", offset: 0 },
	{ source: "\\k<a>(?<a>x)", reason: "UnsupportedOperation", offset: 0 },
	{ source: "(?<\\u0061>x)\\k<a>", reason: "UnsupportedOperation", offset: 0 },
	{ source: "(?<a>x)|(?<a>y)", reason: "UnsupportedOperation", offset: 0 },
	{ source: "(?:(?<a>x)|(?<a>y))z", reason: "UnsupportedOperation", offset: 3 },
	{ source: "(?<a$1>x)", reason: "UnsupportedOperation", offset: 0 },
	{ source: "(?i-:a)", reason: "UnsupportedOperation", offset: 0 },
	{ source: "(?-ms:a)", reason: "UnsupportedOperation", offset: 0 },
	{ source: "\\p{gc=Lu}", reason: "UnsupportedOperation", offset: 0 },
	{ source: "(a)\\1*", reason: "UnsupportedOperation", offset: 3 },
	{ source: "a{256}(?=b)\\s", reason: "UnsupportedOperation", offset: 1 },
	{ source: "a*?\\u{0}", reason: "UnsupportedOperation", offset: 1 }
] as const satisfies ReadonlyArray<Refusal>

describe("refusals with location and reason", () => {
	it.effect(
		"refuses valid ECMAScript outside the fragment at the construct's offset, wherever it stands",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/text/parse-unsupported",
						draw: drawn((source) => ({
							refusal: source.draw(element<(typeof unsupported)[number]>(unsupported)),
							before: source.draw(lowercase(6)),
							after: source.draw(lowercase(6))
						})),
						literal: Formatter.format,
						coverage: required<(typeof unsupported)[number]["source"]>(
							Arr.map(unsupported, (r) => r.source),
							{ cases: 600, sense: notesOnly }
						),
						kept: [],
						/** The rotating stream's sample of thirty-three constructs. */
						runs: 600,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					({ refusal, before, after }, c) =>
						Effect.sync(() => {
							c.note(refusal.source)
							const source = `${before}${refusal.source}${after}`
							assert.equal(jsValid(source), true, source)
							matchesObject(failure(source, "u"), {
								reason: refusal.reason,
								offset: before.length + refusal.offset
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
						suite: "unit/text/parse-7168364",
						draw: drawn(array(unit, { min: 0, max: 9 })),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 30000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(units) =>
						Effect.sync(() => {
							const source = Arr.join(units, "")
							const result = parse(source, "u")
							const malformed = !result.ok && result.error.reason === "MalformedDescription"
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
					caseHang: Duration.minutes(2)
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
						caseHang: Duration.minutes(2)
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
					suite: "unit/text/parse-depth",
					literal: Formatter.format,
					generator: (source) => ({
						nesting: source.draw(element(nestings)),
						depth: source.draw(element([1, 1_000, 100_000]))
					}),
					limit: 12,
					coverage: requiredInSpace<Nesting>(nestings),
					caseHang: Duration.minutes(2)
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
