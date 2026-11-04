import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { codePoint, element, type Gen, oneOf, string } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, String as Str } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { regexMaxNodes } from "#compiler/core/policy.ts"
import * as RegexIr from "#compiler/scalar/regex/ir.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { toAre } from "#compiler/text/are.ts"
import { analyzeLanguage, analyzeText, textLimits } from "#compiler/text/refinement.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import { families, flagsGen, nestedPattern, patternOver } from "#test/unit/text/generators.ts"

/**
 * Lowering a refinement to PostgreSQL: the canonical wildcard, the empty-language refusal, the constraint loops the IR
 * rewrites away, and the printed ARE read back for its language and for the budgets' verdict.
 */
const loc = SourceLoc("str.regex", ["Content", "relations", "Article", "fields", "f"])
const limits = textLimits(regexMaxNodes)

const hex = (c: number): string => Str.toUpperCase(c.toString(16))
const isAsciiAlnum = (c: number): boolean =>
	(c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)

/**
 * The admitted source spelling (scalar/regex/parse.ts) of an ARE the printer (are.ts toAre) wrote, or undefined for any other
 * string: the printer's inverse up to spelling, written here from the printer's documented output, so the language an
 * ARE recognizes can be analyzed again. Every construct the printer emits is respelled into the admitted grammar, which
 * reads it as the same set of code points: `\A` and `\Z` are `^` and `$` (absolute without the `m` flag), and every
 * escaped character, a `\X` of printable ASCII or a fixed-width `\uXXXX` or `\UXXXXXXXX`, is the `\u{H...}` escape of
 * its code point, inside or outside a bracket expression. ASCII letters, digits and space, and the printer's own
 * syntax (`[`, `]`, `-`, `(?:`, `)`, `|` and the quantifiers), pass through. Anything the printer never emits, such as
 * a bare `.`, `^` or `$`, or another escape, leaves the string unread.
 */
const areSource = (are: string): string | undefined => {
	const syntax = new Set(["[", "]", "-", "(", "?", ":", ")", "|", "*", "+", "{", "}", ","])
	/** The printer's fixed-width uppercase hexadecimal digits at `at`. */
	const fixed = (at: number, width: number): number | undefined => {
		const digits = Str.slice(at, at + width)(are)
		if (digits.length !== width) {
			return undefined
		}
		for (const d of digits) {
			if (!((d >= "0" && d <= "9") || (d >= "A" && d <= "F"))) {
				return undefined
			}
		}
		return Number.parseInt(digits, 16)
	}
	let out = ""
	let i = 0
	for (let at = Str.charCodeAt(are, i); Option.isSome(at); at = Str.charCodeAt(are, i)) {
		const code = at.value
		const c = String.fromCharCode(code)
		if (c !== "\\") {
			if (!(isAsciiAlnum(code) || code === 0x20 || syntax.has(c))) {
				return undefined
			}
			out += c
			i++
			continue
		}
		/** A trailing backslash escapes nothing. */
		const escaped = Str.charCodeAt(are, i + 1)
		if (Option.isNone(escaped)) {
			return undefined
		}
		const next = String.fromCharCode(escaped.value)
		if (next === "A" || next === "Z") {
			out += next === "A" ? "^" : "$"
			i += 2
			continue
		}
		const width = next === "u" ? 4 : next === "U" ? 8 : 0
		if (width > 0) {
			const cp = fixed(i + 2, width)
			if (cp === undefined) {
				return undefined
			}
			out += `\\u{${hex(cp)}}`
			i += 2 + width
			continue
		}
		if (isAsciiAlnum(escaped.value) || escaped.value <= 0x20 || escaped.value >= 0x7f) {
			return undefined
		}
		out += `\\u{${hex(escaped.value)}}`
		i += 2
	}
	return out
}

/**
 * The canonical pattern key of the language a printed ARE recognizes, read back (areSource) and analyzed as a declared
 * pattern would be, or undefined when the string is no such ARE or its language cannot be analyzed within the bounds.
 */
const areKey = (are: string): string | undefined => {
	const source = areSource(are)
	if (source === undefined) {
		return undefined
	}
	const analyzed = analyzeText(source, "su", SourceLoc("a printed ARE", []))
	return analyzed.ok ? analyzed.value.key : undefined
}

/**
 * A pattern no admitted value matches is refused: an empty class, an end before a character, a character before a
 * start, or a class of every scalar negated, planted beside a drawn pattern that otherwise matches.
 */
type Empty =
	| "an empty class"
	| "an end before a character"
	| "a character after the start's end"
	| "every scalar negated"

const empties: Arr.NonEmptyReadonlyArray<readonly [Empty, string]> = [
	["an empty class", "[]"],
	["an end before a character", "$b"],
	["a character after the start's end", "^$a"],
	["every scalar negated", "[^\\u{1}-\\u{10FFFF}]"]
]

/** A pattern over any family's alphabet. */
const familyPattern: Gen<string> = (source) =>
	source.draw(patternOver(source.draw(element(families)).alphabet))

describe("the text refinement", () => {
	it.effect("refuses a pattern no admitted value matches", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/text/empty-language",
					draw: drawn((source) => ({
						empty: source.draw(element(empties)),
						prefix: source.draw(string(codePoint(0x61, 0x7a), { min: 0, max: 4 })),
						flags: source.draw(flagsGen)
					})),
					literal: Formatter.format,
					coverage: required<Empty>(
						Arr.map(empties, ([e]) => e),
						{ cases: 100, sense: notesOnly }
					),
					kept: [],
					runs: 100,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				({ empty: [name, construct], prefix, flags }, c) =>
					Effect.sync(() => {
						c.note(name)
						const source = `${prefix}${construct}`
						refused(analyzeText(source, flags, loc), "UnsupportedOperation", source)
					})
			)
		)
	)
})

/** Whether a repetition loops through an assertion: an unbounded repeat whose body can match zero-width through one. */
const loops = (node: RegexIr.RegexNode): boolean => {
	switch (node.kind) {
		case "seq":
			return Arr.some(node.items, loops)
		case "alt":
			return Arr.some(node.arms, loops)
		case "repeat":
			return (
				(node.max === "unbounded" && RegexIr.expandedAssertions(RegexIr.zeroPart(node.body)) > 0) ||
				loops(node.body)
			)
		case "empty":
		case "never":
		case "set":
		case "start":
		case "end":
			return false
	}
}

describe("constraint loops (scalar/regex/ir.ts repeat)", () => {
	it.effect("leaves no repetition that loops through an assertion", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/text/assertion-loops",
					draw: drawn(
						(source) =>
							[
								source.draw(
									oneOf([
										element([
											"(?:a|$)*b",
											"(?:(?:.|$|){0,2})+b",
											"(?:(?:a|^)*b|$)*c",
											"(?:(?:a|$|)b?)+c",
											"(?:(?:[a-z]{255}){65}|$)*b"
										]),
										nestedPattern,
										familyPattern
									])
								),
								source.draw(flagsGen)
							] as const
					),
					literal: Formatter.format,
					coverage: required<"source loops through an assertion">(
						["source loops through an assertion"],
						{ cases: 1000, sense: notesOnly }
					),
					kept: [],
					/** text/parse's flags search, the nearest generated neighbour of the replaced examples. */
					runs: 1000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				([source, flags], c) =>
					Effect.sync(() => {
						const parsed = parsePattern(source, flags, limits)
						if (parsed.ok && loops(parsed.value)) {
							c.note("source loops through an assertion")
						}
						const r = analyzeText(source, flags, loc)
						if (r.ok) {
							assert.equal(loops(r.value.ir), false, `/${source}/${flags}`)
						}
					})
			)
		)
	)
})

describe("reading a printed ARE back", () => {
	it.effect(
		"recognizes the language of the pattern it was printed from, on generated patterns of every family",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/text/lowering-18081",
						draw: drawn((source) => [source.draw(familyPattern), source.draw(flagsGen)] as const),
						literal: Formatter.format,
						coverage: required<"compared" | "read back to its own key">(
							["compared", "read back to its own key"],
							{ cases: 1000, sense: notesOnly }
						),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					([source, flags], c) =>
						Effect.sync(() => {
							const r = analyzeText(source, flags, loc)
							if (!r.ok) {
								return
							}
							const language = analyzeLanguage(r.value.ir, limits)
							if (language.kind === "empty") {
								return assert.fail(`/${source}/${flags} is admitted with no member`)
							}
							if (language.known.kind === "structure") {
								return
							}
							c.note("compared")
							const key = areKey(r.value.are)
							if (key === r.value.key) {
								c.note("read back to its own key")
								return
							}
							if (key === undefined) {
								return
							}
							/**
							 * A key other than the pattern's own: the read-back pattern's language reaches no canonical automaton.
							 */
							const back = defined(
								areSource(r.value.are),
								`/${source}/${flags} as ${r.value.are} reads back`
							)
							const reparsed = succeeded(
								parsePattern(back, "su", limits),
								`/${source}/${flags} as ${r.value.are} parses back`
							)
							const readBack = analyzeLanguage(reparsed, limits)
							assert.equal(
								readBack.kind === "nonEmpty" && readBack.known.kind === "structure",
								true,
								`/${source}/${flags} as ${r.value.are}`
							)
						})
				)
			)
	)

	/**
	 * The compile-space budgets judge the ARE PostgreSQL is sent, whatever the spelling it was printed from: a pattern
	 * and its ARE read back are admitted alike, with one ARE, or refused for one reason. Patterns near the budgets are
	 * drawn, where a measure that read the spelling would part them.
	 */
	type Verdict = "admitted" | "refused at a budget" | "spelled otherwise than its ARE"
	it.effect("admits a pattern exactly when it admits the ARE it prints as, read back", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/text/are-verdict",
					draw: drawn(nestedPattern),
					literal: Formatter.format,
					coverage: required<Verdict>(
						["admitted", "refused at a budget", "spelled otherwise than its ARE"],
						{ cases: 500, sense: notesOnly }
					),
					kept: [
						{
							note: "an empty arm wrote a chain of optional copies more cheaply than the quantifier its ARE prints, so `(?:(?:a|)){0,255}...` was admitted and its ARE `(?:a?){0,255}(?:a+)?b` refused",
							sketch: "(?:(?:a|)){0,255}(?:(?:a){1,}){0,1}b",
							draws: "",
							reaches: ["admitted", "spelled otherwise than its ARE"]
						}
					],
					runs: 500,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				(source, c) =>
					Effect.sync(() => {
						const parsed = parsePattern(source, "u", limits)
						if (!parsed.ok || parsed.value.kind === "never") {
							return
						}
						const are = toAre(parsed.value)
						const back = defined(areSource(are), `/${source}/u as ${are} reads back`)
						if (!parsePattern(back, "su", limits).ok) {
							return
						}
						if (back !== source) {
							c.note("spelled otherwise than its ARE")
						}
						const own = analyzeText(source, "u", loc)
						if (own.ok) {
							c.note("admitted")
						} else if (own.error.reason._tag === "ResourceBound") {
							c.note("refused at a budget")
						}
						const verdict = (r: typeof own): string =>
							r.ok ? `admitted as ${r.value.are}` : `refused as ${r.error.reason._tag}`
						assert.equal(
							verdict(analyzeText(back, "su", loc)),
							verdict(own),
							`/${source}/u as ${are}`
						)
					})
			)
		)
	)

	it.effect("reads nothing the printer never prints", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/text/are-unread",
					generator: element([
						".",
						"^a",
						"a$",
						"\\d",
						"\\u12",
						"\\U0001F6",
						"\\uabcd",
						"\\",
						"\\é",
						"é"
					]),
					literal: Formatter.format,
					/** The space: the ten strings. */
					limit: 10,
					coverage: noCoverage,
					caseHang: Duration.minutes(2)
				},
				(unread) =>
					Effect.sync(() => assert.equal(areSource(unread), undefined, Formatter.format(unread)))
			)
		)
	)
})
