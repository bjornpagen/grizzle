/**
 * A conjunction of patterns (str.and), whose language is the intersection of its members', as the text analysis keys,
 * bounds, matches, compares and enforces it. Each search draws its patterns from the generated grammar and finite
 * languages over a small alphabet, ECMAScript's own membership of every member (generators.ts jsMatcher) the oracle of
 * the intersection:
 *
 * - **its language:** the host's membership of a drawn text (scalar/regex/patterns.ts) and the intersection's canonical
 *   DFA, where the analysis builds one, are ECMAScript's conjunction of its members' verdicts; every text of it lies
 *   within the bounds it proves, which a bounded member gives an unbounded one; and the key is the language's, so the
 *   members in either order, a member twice, or a member beside every text's pattern key alike;
 * - **inclusion:** a conjunction's inclusion in another (scalar/regex/inclusion.ts) holds exactly when brute force over
 *   every text of up to four code points of the alphabet, and walks of the inner members, finds no text of every inner
 *   member outside some outer one, and a refutation's witness is such a text;
 * - **a match guard:** Compute.matches over a refined subject types its branch by both languages, so a parse in the
 *   branch compiles exactly when the conjunction lies inside the parse's form, a case neither pattern alone proves among
 *   them;
 * - **its size:** its CHECK prints in no more bytes than its members' own tests joined by AND, so a conjunction's
 *   installation is linear in its members, the NCName conjunction of XML Schema's two name classes among them.
 *
 * Oracles: ECMAScript's membership of every member; brute force over every short text and walks of the inner members;
 * the inclusion of the two patterns' conjunction in the form; the sum of the members' own tests and their joins.
 *
 * Features: a pair and a triple, keyed by the intersection's automaton or by its members, a text of the conjunction and
 * one the first member alone holds, refused as matching no text, bounded where a member alone is not; included and
 * refuted inclusions; admitted and refused guards; a regex check of several patterns and an IN list.
 *
 * Plants: text-conjunction-some (the host takes a text any member matches), text-inclusion-some-outer (an inclusion in
 * one outer member taken as inclusion in their conjunction), text-guard-drops-subject (a match guard's branch typed by
 * the guard's pattern alone), text-check-doubled (a conjunction's CHECK writes each test twice).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { codePoints, codePointsText } from "#compiler/core/text.ts"
import {
	type PatternSource,
	type Patterns,
	regexCheck,
	wildcardPattern
} from "#compiler/ir/scalar.ts"
import { Compute } from "#compiler/public/compute.ts"
import { generated, pg, uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { formSource } from "#compiler/scalar/lexical.ts"
import { has } from "#compiler/scalar/regex/charset.ts"
import type { CanonicalDfa } from "#compiler/scalar/regex/dfa.ts"
import { type Inclusion, inclusion } from "#compiler/scalar/regex/inclusion.ts"
import type { Nfa } from "#compiler/scalar/regex/match.ts"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { regexField } from "#compiler/text/field.ts"
import {
	analyzeText,
	domainValue,
	membership,
	type TextRefinement
} from "#compiler/text/refinement.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { checkedIn } from "#test/support/policy.ts"
import { textInfo } from "#test/support/text.ts"
import { refinementBounds } from "#test/support/text.ts"
import {
	finiteLanguageOver,
	flagsGen,
	jsMatcher,
	patternOver,
	stringsOver,
	walkGen
} from "#test/unit/text/generators.ts"

const loc = SourceLoc("str.and", [])

/**
 * A pattern of a conjunction as a case draws it: a generated one, or a finite language, which bounds what the generated
 * ones, whose anchors fall anywhere among their unbounded quantifiers, rarely bound.
 */
const memberGen =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<PatternSource> =>
	(source) => ({
		source: source.draw(
			weighted<string>([
				[3, patternOver(alphabet)],
				[1, map(finiteLanguageOver(alphabet), (language) => language.source)]
			])
		),
		flags: source.draw(flagsGen)
	})

/** From `min` to `max` patterns of a conjunction, its members in declared order, at least one. */
const conjunctionGen =
	(alphabet: Arr.NonEmptyReadonlyArray<number>, min: number, max: number): Gen<Patterns> =>
	(source) => [
		source.draw(memberGen(alphabet)),
		...source.draw(array(memberGen(alphabet), { min: Math.max(0, min - 1), max: max - 1 }))
	]

/**
 * Whether ECMAScript finds every member of a conjunction in a text: the oracle of the conjunction's membership, each
 * member compiled once.
 */
const jsAll = (patterns: ReadonlyArray<PatternSource>): ((text: string) => boolean) => {
	const matchers = Arr.map(patterns, (p) => jsMatcher(p.source, p.flags))
	return (text) => Arr.every(matchers, (m) => m(text))
}

/** A member's NFA, or none for a member the parser refuses. */
const nfaOf = (p: PatternSource): Option.Option<Nfa> => {
	const parsed = parsePattern(p.source, p.flags)
	return parsed.ok ? Option.some(buildNfa(parsed.value)) : Option.none()
}

/** Whether a canonical DFA, which reads whole values, accepts `text`: its states walked by `text`'s code points. */
const dfaAccepts = (dfa: CanonicalDfa, text: string): boolean =>
	Option.exists(
		Arr.reduce(codePoints(text), Arr.head(dfa.states), (state, c) =>
			Option.flatMap(state, (s) =>
				Option.flatMap(
					Arr.findFirst(s.edges, (e) => has(e.set, c)),
					(e) => Arr.get(dfa.states, e.to)
				)
			)
		),
		(s) => s.accept
	)

/** Every text of at most `length` code points of `alphabet`: the empty text, and each code point before a shorter. */
const textsUpTo = (alphabet: ReadonlyArray<number>, length: number): ReadonlyArray<string> =>
	length === 0
		? [""]
		: [
				"",
				...Arr.flatMap(textsUpTo(alphabet, length - 1), (t) =>
					Arr.map(alphabet, (c) => `${codePointsText([c])}${t}`)
				)
			]

/** Every member's walks drawn over its own NFA: texts of each member's language, of the conjunction's or not. */
const walksOf =
	(patterns: Patterns): Gen<ReadonlyArray<string>> =>
	(source) =>
		Arr.flatMap(patterns, (p) =>
			Option.match(nfaOf(p), {
				onNone: () => [],
				onSome: (nfa) =>
					Arr.flatMap(source.draw(array(walkGen(nfa), { min: 0, max: 8 })), (w) =>
						w === undefined ? [] : [w]
					)
			})
		)

/** The alphabet the language and key search draws its patterns and texts over. */
const letters: Arr.NonEmptyReadonlyArray<number> = [0x61, 0x62, 0x63, 0x30, 0x0a]

/** A conjunction's analysis in another order of its members. */
const reversed = (patterns: Patterns): Patterns => {
	const [first, ...rest] = patterns
	return Arr.isReadonlyArrayNonEmpty(rest) ? [...Arr.reverse(rest), first] : [first]
}

type LanguageFeature =
	| "a pair"
	| "a triple"
	| "keyed by the intersection's automaton"
	| "keyed by its members past the bounds"
	| "a text the first member holds and the conjunction does not"
	| "a text of the conjunction"
	| "refused as matching no text"
	| "bounded where a member alone is not"

describe("a conjunction's language", () => {
	it.effect(
		"is every member's at once, by the host and by the intersection's automaton, and is keyed by its language",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "ECMAScript's membership of every member (generators.ts jsMatcher)"
						},
						suite: "unit/text/conjunction-language",
						draw: drawn((source) => {
							const patterns = source.draw(conjunctionGen(letters, 2, 3))
							return {
								patterns,
								texts: [
									...source.draw(array(stringsOver(letters, 6), { min: 1, max: 40 })),
									...source.draw(walksOf(patterns))
								]
							}
						}),
						literal: Formatter.format,
						coverage: required<LanguageFeature>(
							[
								"a pair",
								"a triple",
								"keyed by the intersection's automaton",
								"a text the first member holds and the conjunction does not",
								"a text of the conjunction",
								"refused as matching no text",
								"bounded where a member alone is not"
							],
							{ cases: 1200, sense: notesOnly }
						),
						kept: [],
						runs: 1200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ patterns, texts }, k) =>
						Effect.sync(() => {
							const label = Formatter.format(patterns)
							const analyzed = analyzeText(patterns, loc)
							k.note(patterns.length === 2 ? "a pair" : "a triple")
							const members = Arr.map(patterns, (p) => analyzeText([p], loc))
							const ofAll = jsAll(patterns)
							if (!analyzed.ok) {
								if (Arr.every(members, (m) => m.ok)) {
									k.note("refused as matching no text")
									assert.equal(analyzed.error.reason._tag, "UnsupportedOperation", label)
									assert.ok(
										Arr.every(texts, (t) => !ofAll(t)),
										`${label} is refused as empty, and holds no drawn text`
									)
								}
								return
							}
							const r: TextRefinement = analyzed.value
							const { regex } = textInfo(r)
							const host = new CompilePatterns()
							const bounds = refinementBounds(r)
							if (
								bounds !== undefined &&
								Arr.some(members, (m) => m.ok && refinementBounds(m.value) === undefined)
							) {
								k.note("bounded where a member alone is not")
							}
							const ofFirst = jsAll([patterns[0]])
							for (const t of texts) {
								const expected = ofAll(t)
								const where = `${label} on ${Formatter.format(t)}`
								if (expected) {
									k.note("a text of the conjunction")
								} else if (ofFirst(t)) {
									k.note("a text the first member holds and the conjunction does not")
								}
								assert.equal(
									regex === "wildcard" || host.member(regex, t),
									expected,
									`${where}: the host`
								)
								if (r.known.kind === "automaton") {
									assert.equal(
										dfaAccepts(r.known.dfa, t),
										expected,
										`${where}: the intersection's DFA`
									)
								}
								if (expected && bounds !== undefined) {
									assert.ok(
										codePoints(t).length <= bounds.length && utf8Length(t) <= bounds.bytes,
										`${where}: within its proved bounds ${Formatter.format(bounds)}`
									)
								}
							}
							const other = analyzeText(reversed(patterns), loc)
							assert.ok(other.ok, `${label} in another order`)
							if (r.known.kind === "automaton") {
								k.note("keyed by the intersection's automaton")
								assert.equal(other.value.key, r.key, `${label}: one key in either order`)
							} else {
								k.note("keyed by its members past the bounds")
							}
							const [first] = patterns
							const alone = analyzeText([first], loc)
							if (alone.ok) {
								const twice = analyzeText([first, first], loc)
								const beside = analyzeText([first, wildcardPattern], loc)
								assert.equal(
									twice.ok && twice.value.key,
									alone.value.key,
									`${label}: its first member twice`
								)
								assert.equal(
									beside.ok && beside.value.key,
									alone.value.key,
									`${label}: its first member beside every text's pattern`
								)
							}
						})
				)
			)
	)
})

/** The small alphabet whose every short text the inclusion search enumerates. */
const abc: Arr.NonEmptyReadonlyArray<number> = [0x61, 0x62, 0x63]

/** Every text of up to four code points of the inclusion search's alphabet: 121 texts. */
const shortTexts = textsUpTo(abc, 4)

type InclusionFeature =
	| "included"
	| "refuted"
	| "bounded"
	| "included by inner members together, by none alone"

describe("a conjunction's inclusion", () => {
	it.effect(
		"holds exactly when no short text or inner walk holds every inner member and misses an outer one",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "brute force over every short text, by ECMAScript's membership"
						},
						suite: "unit/text/conjunction-inclusion",
						draw: drawn((source) => {
							const inner = source.draw(conjunctionGen(abc, 1, 3))
							return {
								inner,
								outer: source.draw(conjunctionGen(abc, 1, 2)),
								walks: source.draw(walksOf(inner))
							}
						}),
						literal: Formatter.format,
						coverage: required<InclusionFeature>(["included", "refuted"], {
							cases: 1500,
							sense: notesOnly
						}),
						kept: [
							{
								note: "two inner members whose intersection, and neither alone, lies inside the outer",
								sketch: {
									inner: [
										{ source: "^a*$", flags: "u" },
										{ source: "^.{0,2}$", flags: "u" }
									],
									outer: [{ source: "^(?:a|aa)?$", flags: "u" }],
									walks: []
								},
								draws: "",
								reaches: ["included", "included by inner members together, by none alone"]
							}
						],
						runs: 1500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ inner, outer, walks }, k) =>
						Effect.sync(() => {
							const innerNfas = Arr.getSomes(Arr.map(inner, nfaOf))
							const outerNfas = Arr.getSomes(Arr.map(outer, nfaOf))
							if (
								!Arr.isReadonlyArrayNonEmpty(innerNfas) ||
								!Arr.isReadonlyArrayNonEmpty(outerNfas) ||
								innerNfas.length !== inner.length ||
								outerNfas.length !== outer.length
							) {
								return
							}
							const label = `${Formatter.format(inner)} in ${Formatter.format(outer)}`
							const verdict = inclusion(innerNfas, outerNfas)
							k.note(verdict.kind)
							const ofInner = jsAll(inner)
							const ofOuter = jsAll(outer)
							const outside = (t: string): boolean => ofInner(t) && !ofOuter(t)
							switch (verdict.kind) {
								case "included": {
									const counter = Arr.findFirst([...shortTexts, ...walks], outside)
									assert.ok(
										Option.isNone(counter),
										`${label}: ${Formatter.format(counter)} holds every inner member and misses an outer one`
									)
									if (
										inner.length > 1 &&
										Arr.every(innerNfas, (n) => inclusion([n], outerNfas).kind !== "included")
									) {
										k.note("included by inner members together, by none alone")
									}
									return
								}
								case "refuted":
									assert.ok(
										outside(verdict.witness),
										`${label}: the witness ${Formatter.format(verdict.witness)}`
									)
									return
								case "bounded":
									return
							}
						})
				)
			)
	)
})

/**
 * The digits and signs the guard search draws over: the characters of an integer's lexical form, and two others, so its
 * finite languages often lie inside smallint's form and its generated patterns often reach past it.
 */
const numerals: Arr.NonEmptyReadonlyArray<number> = [0x30, 0x31, 0x39, 0x2d, 0x2e, 0x61]

/** smallint's lexical form, which a parse in the guard's branch reads its text into. */
const smallintForm = formSource({ kind: "integer", carrier: "int2" })

/**
 * A relation whose text `t` is typed by `subject`, and a smallint generated from its parse under a match of `guard`:
 * the branch reads `t` as text of both patterns.
 */
const guardedParse = (subject: string, guard: string) =>
	schema(
		"Guarded",
		{
			R: relation.generated("R", { id: uuid, t: regexField<string>(subject, []) }, ["id"], (r) => ({
				n: generated(
					pg.smallint,
					Compute.when(
						Compute.matches(r.t, Compute.pattern(guard)),
						(t) => Compute.cast(t, pg.smallint),
						Compute.literal(pg.smallint, 0)
					)
				)
			}))
		},
		[]
	)

/** What compiling a guarded parse answers: admitted, or refused for a reason. */
type GuardOutcome =
	| { readonly kind: "admitted" }
	| { readonly kind: "refused"; readonly reason: CompileReasonTag }

/**
 * What compiling the guarded parse answers for each verdict of the conjunction's inclusion in the form: admitted where it
 * lies inside, a missing guard where a value of it lies outside, and the analysis's bounds where they decide nothing.
 */
const guardOutcome: { readonly [K in Inclusion["kind"]]: GuardOutcome } = {
	included: { kind: "admitted" },
	refuted: { kind: "refused", reason: "PartialOperation" },
	bounded: { kind: "refused", reason: "ResourceBound" }
}

type GuardFeature =
	| "admitted"
	| "refused"
	| "admitted where neither pattern alone lies inside the form"

describe("a match guard over a refined subject", () => {
	it.effect(
		"types its branch by the subject's patterns and the match's, so a parse in it compiles exactly when they lie inside the form",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the inclusion of the two patterns' conjunction in smallint's form (scalar/regex/inclusion.ts)"
						},
						suite: "unit/text/conjunction-guard",
						draw: drawn((source) => ({
							subject: source.draw(memberGen(numerals)).source,
							guard: source.draw(memberGen(numerals)).source
						})),
						literal: Formatter.format,
						coverage: required<GuardFeature>(["admitted", "refused"], {
							cases: 600,
							sense: notesOnly
						}),
						kept: [
							{
								note: "digits of any count, under a match of at most four characters: smallint's form holds both together",
								sketch: { subject: "^[0-9]*$", guard: "^.{1,4}$" },
								draws: "",
								reaches: ["admitted", "admitted where neither pattern alone lies inside the form"]
							}
						],
						runs: 600,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ subject, guard }, k) =>
						Effect.sync(() => {
							const subjectPattern: PatternSource = { source: subject, flags: "u" }
							const guardPattern: PatternSource = { source: guard, flags: "u" }
							const patterns: Patterns = [subjectPattern, guardPattern]
							if (!analyzeText([subjectPattern], loc).ok || !analyzeText([guardPattern], loc).ok) {
								return
							}
							const label = Formatter.format(patterns)
							const checked = checkedIn(guardedParse(subject, guard))
							const together = analyzeText(patterns, loc)
							k.note(checked.ok ? "admitted" : "refused")
							if (!together.ok) {
								assert.equal(
									!checked.ok && checked.error.reason._tag,
									together.error.reason._tag,
									`${label}: a guard no subject text can pass`
								)
								return
							}
							const nfas = Arr.getSomes(Arr.map(patterns, nfaOf))
							const form = defined(
								Option.getOrUndefined(nfaOf({ source: smallintForm, flags: "u" })),
								"the form's NFA"
							)
							if (!Arr.isReadonlyArrayNonEmpty(nfas)) {
								return assert.fail(`${label} parses`)
							}
							const actual: GuardOutcome = checked.ok
								? { kind: "admitted" }
								: { kind: "refused", reason: checked.error.reason._tag }
							assert.deepEqual(actual, guardOutcome[inclusion(nfas, [form]).kind], label)
							if (
								checked.ok &&
								Arr.every(nfas, (nfa) => inclusion([nfa], [form]).kind !== "included")
							) {
								k.note("admitted where neither pattern alone lies inside the form")
							}
						})
				)
			)
	)
})

/** The bytes a check's predicate over VALUE prints in. */
const predicateBytes = (r: TextRefinement): number =>
	r.check.kind === "tautology" ? 0 : utf8Length(printExpr(membership(r.check, domainValue)))

/** The bytes each member's own test prints in, `VALUE ~ '<ARE>'`, the test a conjunction's CHECK joins by AND. */
const memberBytes = (r: TextRefinement): number =>
	Arr.reduce(
		r.members,
		0,
		(n, m) => n + utf8Length(printExpr(membership(regexCheck([m.are], undefined), domainValue)))
	)

/** The bytes AND adds between two tests. */
const andBytes = utf8Length(" AND ")

/** XML's NameStartChar without the colon, NCName's first character (XML Namespaces 1.0, Namespaces in XML §3). */
const ncNameStart =
	"A-Z_a-z\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2FF}\\u{370}-\\u{37D}\\u{37F}-\\u{1FFF}\\u{200C}-\\u{200D}\\u{2070}-\\u{218F}\\u{2C00}-\\u{2FEF}\\u{3001}-\\u{D7FF}\\u{F900}-\\u{FDCF}\\u{FDF0}-\\u{FFFD}\\u{10000}-\\u{EFFFF}"

/** XML's NCName, a NameStartChar and then NameChars, never the colon, as XML Schema's xs:NCName facets state it. */
const ncName = `^[${ncNameStart}][${ncNameStart}\\-.0-9\\u{B7}\\u{300}-\\u{36F}\\u{203F}-\\u{2040}]*$`

type SizeFeature = "a regex check of several patterns" | "an IN list" | "more than four patterns"

describe("a conjunction's CHECK", () => {
	it.effect("prints in no more bytes than its members' own tests joined by AND", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "the sum of the members' own tests and their joins"
					},
					suite: "unit/text/conjunction-size",
					draw: drawn((source) => ({
						patterns: source.draw(conjunctionGen(letters, 1, source.draw(int(1, 8))))
					})),
					literal: Formatter.format,
					coverage: required<SizeFeature>(["a regex check of several patterns", "an IN list"], {
						cases: 400,
						sense: notesOnly
					}),
					kept: [
						{
							note: "XML Schema's NCName beside a length facet, a lexical facet and a second name class, each its own test",
							sketch: {
								patterns: [
									{ source: ncName, flags: "u" },
									{ source: "^.{1,64}$", flags: "u" },
									{ source: "^[^.\\-0-9]", flags: "u" },
									{ source: `^[${ncNameStart}0-9]*$`, flags: "u" },
									{ source: "[a-z]", flags: "u" }
								]
							},
							draws: "",
							reaches: ["a regex check of several patterns", "more than four patterns"]
						}
					],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ patterns }, k) =>
					Effect.sync(() => {
						const analyzed = analyzeText(patterns, loc)
						if (!analyzed.ok) {
							return
						}
						const r = analyzed.value
						if (r.check.kind === "regex" && r.check.ares.length > 1) {
							k.note("a regex check of several patterns")
						}
						if (r.check.kind === "finite") {
							k.note("an IN list")
						}
						if (patterns.length > 4) {
							k.note("more than four patterns")
						}
						assert.ok(
							predicateBytes(r) <= memberBytes(r) + andBytes * (patterns.length - 1),
							`${Formatter.format(patterns)}: ${predicateBytes(r)} bytes`
						)
					})
			)
		)
	)
})
