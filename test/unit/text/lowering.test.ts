/**
 * Lowering a refinement to PostgreSQL: the constraint loops the IR rewrites away, the printed ARE read back for its
 * language and for the budgets' verdict, and the form a finite language is enforced by. The empty-language refusal is
 * emptiness.test.ts's.
 *
 * - Constraint loops: no admitted pattern's IR keeps an unbounded repetition whose body can match zero-width through an
 *   assertion. Oracle: a second implementation, a walk of the IR for such a repetition.
 * - Read back: the ARE a pattern prints, read back, recognizes the pattern's language, its own key or one past the
 *   canonical automaton. Oracle: universal, the printed ARE parsed again.
 * - Budgets: a pattern is admitted, or refused for one reason, exactly as the ARE it prints, read back. Oracle:
 *   universal, the verdict on a pattern is the verdict on its ARE.
 * - Finite form: a finite language is enforced by its shorter printed form, the IN list on a tie, and both forms
 *   recognize it. Oracle: the specification, the emitted DDL's UTF-8 bytes, and ECMAScript's RegExp test.
 *
 * Features: a source that loops through an assertion; compared and read back to its own key; admitted, refused at a
 * budget, spelled otherwise than its ARE; the IN list chosen, the regex chosen, a tie.
 *
 * Plants: text-loop-unrefused (a loop through an assertion the rewrite leaves is not refused), text-are-quantifier-max
 * (a counted quantifier printed one short), text-are-as-written (a pattern's ARE its source as written),
 * text-finite-tie-regex (a tie enforced by the regex).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen, oneOf } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { everyProperty } from "#compiler/core/canonical.ts"
import { domainDigest } from "#compiler/core/fingerprint.ts"
import { identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { RegexCheck } from "#compiler/ir/scalar.ts"
import { toAre } from "#compiler/scalar/regex/are.ts"
import * as RegexIr from "#compiler/scalar/regex/ir.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { analyzeText, type TextRefinement, textDomainDdl } from "#compiler/text/refinement.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { analyzeLanguage } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import { refinementBounds } from "#test/support/text.ts"
import {
	type FiniteLanguage,
	families,
	finiteLanguageOver,
	flagsGen,
	jsMatcher,
	mostFiniteMembers,
	nestedPattern,
	patternOver,
	stringsOver
} from "#test/unit/text/generators.ts"

const loc = SourceLoc("str.regex", ["Content", "relations", "Article", "fields", "f"])

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
	const analyzed = analyzeText([{ source, flags: "su" }], SourceLoc("a printed ARE", []))
	return analyzed.ok ? analyzed.value.key : undefined
}

/** A pattern over any family's alphabet. */
const familyPattern: Gen<string> = (source) =>
	source.draw(patternOver(source.draw(element(families)).alphabet))

/** Whether a node holds an assertion, `^` or `$`, anywhere. */
const asserts = (node: RegexIr.RegexNode): boolean => {
	switch (node.kind) {
		case "start":
		case "end":
			return true
		case "seq":
			return Arr.some(node.items, asserts)
		case "alt":
			return Arr.some(node.arms, asserts)
		case "repeat":
			return asserts(node.body)
		case "empty":
		case "never":
		case "set":
			return false
	}
}

/** Whether a repetition loops through an assertion: an unbounded repeat whose body can match zero-width through one. */
const loops = (node: RegexIr.RegexNode): boolean => {
	switch (node.kind) {
		case "seq":
			return Arr.some(node.items, loops)
		case "alt":
			return Arr.some(node.arms, loops)
		case "repeat":
			return (
				(node.max === "unbounded" && asserts(new RegexIr.RegexBuilder().zeroPart(node.body))) ||
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
					oracle: {
						kind: "second-implementation",
						name: "a walk of the IR for an unbounded repetition whose zero-width part asserts"
					},
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
											"(?:(?:(?:[a-z]{255}){255}){31}|$)*b"
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
					caseHang
				},
				([source, flags], c) =>
					Effect.sync(() => {
						const parsed = parsePattern(source, flags)
						if (parsed.ok && loops(parsed.value)) {
							c.note("source loops through an assertion")
						}
						const r = analyzeText([{ source, flags }], loc)
						if (r.ok) {
							assert.equal(loops(r.value.members[0].ir), false, `/${source}/${flags}`)
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
						oracle: {
							kind: "universal",
							name: "the printed ARE parsed again recognizes the pattern's language"
						},
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
						caseHang
					},
					([source, flags], c) =>
						Effect.sync(() => {
							const r = analyzeText([{ source, flags }], loc)
							if (!r.ok) {
								return
							}
							const language = analyzeLanguage(r.value.members[0].ir)
							if (language.kind === "empty") {
								return assert.fail(`/${source}/${flags} is admitted with no member`)
							}
							if (language.known.kind === "structure") {
								return
							}
							c.note("compared")
							const key = areKey(r.value.members[0].are)
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
								areSource(r.value.members[0].are),
								`/${source}/${flags} as ${r.value.members[0].are} reads back`
							)
							const reparsed = succeeded(
								parsePattern(back, "su"),
								`/${source}/${flags} as ${r.value.members[0].are} parses back`
							)
							const readBack = analyzeLanguage(reparsed)
							assert.equal(
								readBack.kind === "nonEmpty" && readBack.known.kind === "structure",
								true,
								`/${source}/${flags} as ${r.value.members[0].are}`
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
					oracle: {
						kind: "universal",
						name: "the budgets' verdict on a pattern is the verdict on its ARE"
					},
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
					caseHang
				},
				(source, c) =>
					Effect.sync(() => {
						const parsed = parsePattern(source, "u")
						if (!parsed.ok || parsed.value.kind === "never") {
							return
						}
						const are = toAre(parsed.value)
						const back = defined(areSource(are), `/${source}/u as ${are} reads back`)
						if (!parsePattern(back, "su").ok) {
							return
						}
						if (back !== source) {
							c.note("spelled otherwise than its ARE")
						}
						const own = analyzeText([{ source, flags: "u" }], loc)
						if (own.ok) {
							c.note("admitted")
						} else if (own.error.reason._tag === "ResourceBound") {
							c.note("refused at a budget")
						}
						const verdict = (r: typeof own): string =>
							r.ok ? `admitted as ${r.value.members[0].are}` : `refused as ${r.error.reason._tag}`
						assert.equal(
							verdict(analyzeText([{ source: back, flags: "su" }], loc)),
							verdict(own),
							`/${source}/u as ${are}`
						)
					})
			)
		)
	)
})

/** The UTF-8 bytes of a text: what PostgreSQL measures a statement by. */
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/** The structural domain each form of a case's language is printed as, under one name. */
const formDomain = identity.textDomain(domainDigest({ form: "finite" }, everyProperty))

/** The UTF-8 bytes of the CREATE DOMAIN the compiler installs a check by, as it prints it. */
const domainBytes = (check: RegexCheck): number =>
	utf8Bytes(
		succeeded(
			emit(
				textDomainDdl(check, {
					schema: "text",
					name: formDomain.identifier,
					constraint: identity.domainCheck(formDomain).identifier
				}),
				emptyNameMap
			),
			"a text domain prints"
		).text
	)

/** The two forms that enforce a finite language: the IN list of its members, and the regex of its pattern. */
interface Forms {
	readonly inList: RegexCheck
	readonly regex: RegexCheck
}

const formsOf = (language: FiniteLanguage, refinement: TextRefinement): Forms => {
	const bounds = defined(
		refinementBounds(refinement),
		`/${refinement.members[0].source}/${refinement.members[0].flags} bounds its finite language`
	)
	return {
		inList: { kind: "finite", members: language.members, bounds },
		regex: { kind: "regex", ares: [refinement.members[0].are], bounds }
	}
}

/**
 * The first run of two letters or more, `^a{k}$`, whose IN list prints as long as its regex: a list of two letters
 * prints shorter than the counted regex, and the list then grows by a byte a letter while the regex grows only with the
 * count's digits, so the two meet. Steered in where a tie is pending, since a drawn language rarely prints as long both
 * ways.
 */
const tieFrom = (k: number): FiniteLanguage => {
	const language: FiniteLanguage = { source: `^a{${k}}$`, members: [Str.repeat(k)("a")] }
	const { inList, regex } = formsOf(
		language,
		succeeded(analyzeText([{ source: language.source, flags: "u" }], loc), language.source)
	)
	return domainBytes(inList) < domainBytes(regex) ? tieFrom(k + 1) : language
}

const tie = tieFrom(2)

/** The quote, which an IN list's literal doubles and the ARE escapes. */
const apostrophe = 0x27

type FormFeature = "IN list chosen" | "regex chosen" | "tie"

describe("the enforcement of a finite language", () => {
	it.effect(
		"prints no longer than its other form, the IN list on a tie, and both forms recognize the language",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the shorter emitted DDL by UTF-8 bytes, the IN list on a tie, and ECMAScript's RegExp test"
						},
						suite: "unit/text/finite-form",
						draw: drawn((source) => {
							const family = source.draw(element(families))
							const alphabet: Arr.NonEmptyReadonlyArray<number> = [...family.alphabet, apostrophe]
							return {
								language: source.draw(finiteLanguageOver(alphabet, mostFiniteMembers)),
								flags: source.draw(flagsGen),
								strings: source.draw(array(stringsOver(element(alphabet), 6), { min: 1, max: 24 }))
							}
						}),
						literal: Formatter.format,
						coverage: required<FormFeature>(["IN list chosen", "regex chosen", "tie"], {
							cases: 1000,
							sense: notesOnly
						}),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(drawnCase, c) =>
						Effect.sync(() => {
							const { language, flags, strings } = Option.getOrElse(
								Option.flatMap(c.steering, (pending) =>
									pending.has("tie") ? Option.some({ ...drawnCase, language: tie }) : Option.none()
								),
								() => drawnCase
							)
							const label = `/${language.source}/${flags}`
							const r = succeeded(
								analyzeText([{ source: language.source, flags: flags }], loc),
								label
							)
							const check = r.check
							if (check.kind === "tautology") {
								return assert.fail(`${label} is a finite language, no tautology`)
							}
							const { inList, regex } = formsOf(language, r)
							const listed = domainBytes(inList)
							const matched = domainBytes(regex)
							c.note(check.kind === "finite" ? "IN list chosen" : "regex chosen")
							if (listed === matched) {
								c.note("tie")
							}
							assert.equal(
								domainBytes(check),
								Math.min(listed, matched),
								`${label} is enforced by its shorter form`
							)
							assert.equal(
								check.kind,
								listed <= matched ? "finite" : "regex",
								`${label} is enforced by the IN list on a tie`
							)
							const members = new Set(language.members)
							if (check.kind === "finite") {
								assert.equal(check.members.length, members.size, `${label} lists its members`)
								for (const m of check.members) {
									assert.equal(members.has(m), true, `${label} lists ${Formatter.format(m)}`)
								}
							}
							const ofLanguage = jsMatcher(language.source, flags)
							for (const m of language.members) {
								assert.equal(ofLanguage(m), true, `${label} on ${m}`)
							}
							for (const s of strings) {
								assert.equal(ofLanguage(s), members.has(s), `${label} on ${s}`)
							}
						})
				)
			)
	)
})
