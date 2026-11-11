/**
 * Regex membership across the three engines.
 *
 * For each family of semantic edges (non-ASCII digits, the four line terminators, anchors, negated classes, the empty
 * string, escapes), an exploration draws batches of randomized strings over the family's alphabet and generated
 * patterns, and every batch meets every handwritten and generated admitted pattern of the family; four answers must
 * agree on every pair:
 *
 * 1. ECMAScript's `new RegExp(source, flags).test`, the development-only oracle;
 * 2. the host NFA, which the compiler uses for its own constants;
 * 3. PostgreSQL 19's `~` with the translated ARE, under pg_c_utf8;
 * 4. the installed enforcement itself: the compiler's domain DDL (finite IN, ARE CHECK, or no domain at all for a
 *    tautology), asked through pg_input_is_valid, which evaluates the domain's CHECK constraints.
 *
 * The file also holds that every admitted pattern compiles inside the limits of PostgreSQL's regex compiler: the largest
 * pattern the limits admit along drawn shapes, and generated nested quantifiers. The refusal of unadmitted constructs
 * is test/unit/text/parse.test.ts's, and that the limits judge the printed ARE whatever its spelling is
 * test/unit/text/lowering.test.ts's.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): differential-dollar-anchor.patch (the ARE translation of `$` matching
 * before a final line terminator).
 */
import { layer } from "@effect/vitest"
import { drawn, explore, sketched } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	uniqueArray,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Exit, Formatter, Option, String as Str } from "effect"
import { everyProperty } from "#compiler/core/canonical.ts"
import type { RegexSpaceMeasure } from "#compiler/core/errors.ts"
import { domainDigest } from "#compiler/core/fingerprint.ts"
import { identity } from "#compiler/core/identity.ts"
import { regexMaxRepeat } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { admitPattern } from "#compiler/scalar/regex/admit.ts"
import * as RegexIr from "#compiler/scalar/regex/ir.ts"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { analyzeText, type TextRefinement, textDomainDdl } from "#compiler/text/refinement.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { accepts, analyzeLanguage } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickGen } from "#test/support/pick.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	type Family,
	type Flags,
	families,
	flagsGen,
	jsMatcher,
	nestedPattern,
	patternOver,
	stringsOver,
	walk,
	walkGen,
	walkLength,
	walkTape
} from "#test/unit/text/generators.ts"

/** What refuses a pattern past the limits: the limit of PostgreSQL's regex compiler it crosses, or another refusal. */
type EdgeRefusal = RegexSpaceMeasure["kind"] | "another refusal"

/** What an edge search reached: the refusal past its largest admitted count, or the shape's greatest count itself. */
type EdgeFeature = EdgeRefusal | "the shape's top"

/**
 * A shape a pattern grows along, from count 1 to `top`, each count's pattern its source: the limits of PostgreSQL's
 * regex compiler bind along one of them, or none does by the top.
 */
interface Growth {
	readonly at: (n: number) => string
	readonly top: number
}

const measureAt = (growth: Growth, n: number): "admitted" | EdgeRefusal => {
	const r = admitPattern(growth.at(n), "u", SourceLoc("str.regex", []))
	if (r.ok) {
		return "admitted"
	}
	const reason = r.error.reason
	return reason._tag === "ResourceBound" && reason.bound.kind === "regexCompileSpace"
		? reason.bound.measure.kind
		: "another refusal"
}

/** The largest count the limits admit from an admitted 1, and what refuses the count past it. */
interface Edge {
	readonly greatest: number
	readonly past: EdgeFeature
}

/** The largest count the limits admit from an admitted 1, by bisection over 1 to the shape's top. */
const edgeAt = (growth: Growth): Edge => {
	const top = measureAt(growth, growth.top)
	if (top === "admitted") {
		return { greatest: growth.top, past: "the shape's top" }
	}
	let low = 1
	let high = growth.top
	let past: EdgeRefusal = top
	while (high - low > 1) {
		const middle = Math.floor((low + high) / 2)
		const measured = measureAt(growth, middle)
		if (measured === "admitted") {
			low = middle
		} else {
			high = middle
			past = measured
		}
	}
	return { greatest: low, past }
}

/** A code point as its braced escape, which means itself inside a class and out. */
const escaped = (c: number): string => `\\u{${c.toString(16)}}`

/** Code points of three widths, so a drawn alphabet cuts the characters into many colors. */
const widePoint: Gen<number> = oneOf<number>([
	int(0x21, 0x7e),
	int(0x4e00, 0x9fff),
	int(0x1f300, 0x1faff)
])

/** A drawn body repeated `{inner}` times, then `{n}` or `{0,n}` times, anchored at both ends or followed by a literal. */
const repeatedOf =
	(body: Gen<string>): Gen<Growth> =>
	(source) => {
		const drawnBody = source.draw(body)
		const inner = source.draw(int(1, regexMaxRepeat.value))
		const exact = source.draw(boolean)
		const anchored = source.draw(boolean)
		return {
			at: (n) =>
				`${anchored ? "^" : ""}(?:(?:${drawnBody}){${inner}}){${exact ? n : `0,${n}`}}${anchored ? "$" : "b"}`,
			top: regexMaxRepeat.value
		}
	}

/** m code points of their own, then n copies of a class of all of them under a drawn quantifier: arcs by colors. */
const colorfulGen: Gen<Growth> = (source) => {
	const points = source.draw(uniqueArray(widePoint, (c) => c, { min: 2, max: 2_048 }, 8))
	const quantifier = source.draw(element(["", "?", "{0,255}", "{1,255}", "{255}", "*"]))
	const spelled = Arr.join(Arr.map(points, escaped), "")
	return { at: (n) => `${spelled}(?:[${spelled}]${quantifier}){${n}}b`, top: regexMaxRepeat.value }
}

/** An alternation of n hundred words of a drawn alphabet: the states a match reads, and colors as the alphabet is wide. */
const wordsGen: Gen<Growth> = (source) => {
	const points = source.draw(uniqueArray(widePoint, (c) => c, { min: 10, max: 64 }, 8))
	const length = source.draw(int(2, 6))
	const wordOf = (i: number): string =>
		Arr.join(
			upTo(length, (d) =>
				escaped(defined(points[Math.floor(i / points.length ** d) % points.length], "a point"))
			),
			""
		)
	return {
		at: (n) => `^(?:${Arr.join(upTo(n * 100, wordOf), "|")})$`,
		top: Math.min(Math.floor(points.length ** length / 100), 1_024)
	}
}

/** n times 64 nested optional groups, each a code point and the rest: the parser's recursion and the walks' depth. */
const nestingGen: Gen<Growth> = (source) => {
	const c = escaped(source.draw(widePoint))
	return { at: (n) => `${Str.repeat(n * 64)(`(?:${c}`)}${Str.repeat(n * 64)(")?")}b`, top: 1_024 }
}

/** An alternation of an anchor on either side of a wide class's counted run, n times, two anchors to move each time. */
const anchorsGen: Gen<Growth> = (source) => {
	const run = `${source.draw(element([".", "[a-z]", "\\W"]))}{1,${source.draw(int(1, regexMaxRepeat.value))}}`
	return { at: (n) => `(?:^|${run}|$){${n}}b`, top: 64 }
}

/** An alternation of n hundred two-character words, each a code point of its own and a common one: states times colors. */
const colorsGen: Gen<Growth> = (source) => {
	const base = source.draw(element([0x4e00, 0x20000]))
	return {
		at: (n) =>
			`^(?:${Arr.join(
				upTo(n * 100, (i) => `${escaped(base + i)}y`),
				"|"
			)})$`,
		top: 255
	}
}

/** A counted run of a nullable body, the shape whose empty paths copy arcs. */
const nullableNestGen: Gen<Growth> = repeatedOf(
	(source) =>
		`(?:${source.draw(element(["a|", "a|b?", "a?", "(?:a|)"]))}){${source.draw(int(2, regexMaxRepeat.value))}}`
)

/**
 * The limits a shape grows to the edge of: every one a count binds first, the colors and the states held at once
 * binding none the match's limits leave, and a loop through an anchor growing with no count.
 */
const edgeLimits = [
	"depth",
	"arcs",
	"matchStates",
	"matchCells",
	"anchors"
] as const satisfies Arr.NonEmptyReadonlyArray<RegexSpaceMeasure["kind"]>
type EdgeLimit = (typeof edgeLimits)[number]

/** Each limit's shape, the one a pending limit steers to. */
const shapeOf: { readonly [K in EdgeLimit]: Gen<Growth> } = {
	depth: nestingGen,
	arcs: colorfulGen,
	matchStates: wordsGen,
	matchCells: colorsGen,
	anchors: anchorsGen
}

/** A drawn shape, each limit's among them. */
const growthGen: Gen<Growth> = weighted<Growth>([
	[2, repeatedOf(nestedPattern)],
	[2, colorfulGen],
	[1, colorsGen],
	[1, wordsGen],
	[1, nestingGen],
	[1, anchorsGen],
	[1, nullableNestGen]
])

const loc = (family: string, i: number) => SourceLoc("str.regex", [family, i])
/** A batch's randomized strings, and the generated patterns a case draws besides the family's own. */
const stringsPerCase = 500
const generatedPerFamily = 12
/** The accepting walks a case draws over a pattern's NFA, its own members besides its finite ones. */
const walksPerPattern = 24

/**
 * A pattern's refinement, a language with no admitted text value ("empty"), or a pattern past the limits ("bound").
 */
const refine = (
	source: string,
	flags: Flags,
	at: SourceLoc
): TextRefinement | "empty" | "bound" => {
	const result = analyzeText([{ source, flags }], at)
	if (result.ok) {
		return result.value
	}
	if (result.error.reason._tag === "ResourceBound") {
		return "bound"
	}
	const parsed = parsePattern(source, flags)
	if (!parsed.ok) {
		throw new Error(`/${source}/${flags} does not parse: ${parsed.error.message}`)
	}
	if (analyzeLanguage(parsed.value).kind === "empty") {
		return "empty"
	}
	throw new Error(`/${source}/${flags}: ${result.error.message}`)
}

const admitted = (source: string, flags: Flags, at: SourceLoc): TextRefinement => {
	const r = refine(source, flags, at)
	if (r === "empty" || r === "bound") {
		throw new Error(`/${source}/${flags} must be admitted, not ${r}`)
	}
	return r
}

const truth = (value: unknown): boolean => {
	if (value === "true") {
		return true
	}
	if (value === "false") {
		return false
	}
	throw new Error(`expected a boolean text, got ${String(value)}`)
}

/**
 * What a case of a family reached: a pattern enforced by an installed domain, a generated pattern admitted, a pattern
 * whose own member PostgreSQL's ARE and the domain accepted, one that refused a string of the batch, and a pattern whose
 * language is empty.
 */
type DifferentialFeature =
	| "domain enforced"
	| "generated pattern admitted"
	| "own member accepted"
	| "member refused"
	| "empty language"

/** Whether a refinement's own members are walked over its NFA: none where its members are finite or it has none. */
const walked = (r: TextRefinement | "empty" | "bound"): r is TextRefinement =>
	r !== "empty" && r !== "bound" && r.check.kind !== "finite"

/** The walks a case draws for a handwritten pattern's refinement: accepting walks over its NFA, where it is walked. */
const walksFor = (r: TextRefinement | "empty" | "bound"): Gen<ReadonlyArray<string | undefined>> =>
	walked(r)
		? array(walkGen(buildNfa(r.members[0].ir)), { min: 0, max: walksPerPattern })
		: constant([])

/** The tapes of a generated pattern's walks, drawn before its refinement is known, each a walk's choices. */
const walkTapes: Gen<ReadonlyArray<ReadonlyArray<number>>> = array(
	array(pickGen, { min: 0, max: walkTape }),
	{ min: 0, max: walksPerPattern }
)

/** A generated pattern's walks: its tapes walked over its NFA, built once, where its refinement is walked. */
const walksOf = (
	r: TextRefinement | "empty" | "bound",
	tapes: ReadonlyArray<ReadonlyArray<number>>
): ReadonlyArray<string | undefined> => {
	if (!walked(r)) {
		return []
	}
	const nfa = buildNfa(r.members[0].ir)
	return Arr.map(tapes, (tape) => walk(nfa, tape, walkLength))
}

/**
 * One drawn case of a family: the strings, the walks of each handwritten pattern, and generated patterns with the
 * tapes of their walks.
 */
interface FamilySketch {
	readonly strings: ReadonlyArray<string>
	readonly handwritten: ReadonlyArray<ReadonlyArray<string | undefined>>
	readonly generated: ReadonlyArray<{
		readonly source: string
		readonly flags: Flags
		readonly tapes: ReadonlyArray<ReadonlyArray<number>>
	}>
}

/**
 * One pattern of a case: its text, whether a person wrote it, its refinement, its drawn walks, and its ECMAScript
 * membership, compiled once.
 */
interface CasePattern {
	readonly source: string
	readonly flags: Flags
	readonly handwritten: boolean
	readonly r: TextRefinement | "empty" | "bound"
	readonly walks: ReadonlyArray<string | undefined>
	readonly ecma: (value: string) => boolean
}

/** A resolved case of a family: its strings, and every pattern it asks about them. */
interface FamilyCase {
	readonly strings: ReadonlyArray<string>
	readonly patterns: ReadonlyArray<CasePattern>
}

/**
 * The family's agreement on one drawn case, inside one transaction of `db` that the case's domains are created in and
 * that is rolled back.
 */
const agreeOn = (
	db: RawSession,
	schema: string,
	fi: number,
	family: Family,
	patterns: ReadonlyArray<CasePattern>,
	strings: ReadonlyArray<string>,
	note: (feature: DifferentialFeature) => void
) =>
	Effect.gen(function* () {
		yield* db.begin
		yield* Effect.gen(function* () {
			for (const [pi, { source, flags, handwritten, r, walks, ecma }] of patterns.entries()) {
				const label = `${family.name} /${source}/${flags}`
				if (r === "bound") {
					assert.equal(handwritten, false, `${label} exceeds the limits`)
					continue
				}
				if (!handwritten && r !== "empty") {
					note("generated pattern admitted")
				}
				/**
				 * The batch's strings, and the pattern's own members: its finite members, or the distinct strings of its
				 * drawn accepting walks, so no pattern is only ever asked to refuse.
				 */
				const own =
					r === "empty"
						? []
						: r.check.kind === "finite"
							? [...r.check.members]
							: [...new Set(Arr.flatMap(walks, (w) => (w === undefined ? [] : [w])))]
				const all = ["", ...strings, ...own]
				const js = Arr.map(all, ecma)
				if (r === "empty") {
					note("empty language")
					assert.equal(
						Arr.some(js, (x) => x),
						false,
						label
					)
					continue
				}
				const host = Arr.map(all, (v) => accepts(r, v))
				const slug = `f${fi}_p${pi}`
				const named = identity.textDomain(domainDigest({ slug }, everyProperty))
				const name = named.identifier
				let domainType = "text"
				if (r.check.kind !== "tautology") {
					const statement = textDomainDdl(r.check, {
						schema,
						name,
						constraint: identity.domainCheck(named).identifier
					})
					const ddl = succeeded(emit(statement, emptyNameMap)).text
					yield* db.query(ddl, [])
					domainType = `${quoteIdent(schema)}.${quoteIdent(name)}`
					note("domain enforced")
				}
				const payload = jsonText(Arr.map(all, (v, ord) => ({ ord, v })))
				const rows = yield* db.values(
					`SELECT (c.v COLLATE pg_catalog.pg_c_utf8 ~ $2::text)::text, pg_input_is_valid(c.v, $3::text)::text
					 FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.ord`,
					[payload, r.members[0].are, domainType]
				)
				assert.equal(rows.length, all.length, label)
				for (const [i, row] of rows.entries()) {
					const value = Formatter.format(all[i])
					const expected = defined(js[i], `the ECMAScript answer on ${value}`)
					assert.equal(
						defined(host[i], `the host answer on ${value}`),
						expected,
						`${label} host on ${value}`
					)
					assert.equal(truth(row[0]), expected, `${label} ARE ${r.members[0].are} on ${value}`)
					assert.equal(truth(row[1]), expected, `${label} domain on ${value}`)
				}
				assert.equal(Arr.every(own, ecma), true, `${label} witnesses are members`)
				if (own.length > 0) {
					note("own member accepted")
				}
				if (Arr.some(js, (x) => !x)) {
					note("member refused")
				}
			}
		}).pipe(Effect.ensuring(Effect.ignore(db.rollback)))
	})

layer(Substrate.layer)(
	"regex membership: ECMAScript, host NFA, PostgreSQL ARE and installed domain",
	(it) => {
		it.effect("agree on batches of randomized strings per family", (ctx) =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const schema = yield* s.schema(freshSchema)
				const db = yield* s.session(ownerSession())
				for (const [fi, family] of families.entries()) {
					/**
					 * The family's own patterns, refined and compiled once: a handwritten pattern past the limits fails the
					 * test.
					 */
					const written = Arr.map(family.patterns, ([source, flags], pi) => {
						const r = refine(source, flags, loc(family.name, pi))
						if (r === "bound") {
							throw new Error(`${family.name} /${source}/${flags} exceeds the limits`)
						}
						return { source, flags, r, ecma: jsMatcher(source, flags) }
					})
					const familySketch: Gen<FamilySketch> = (source) => ({
						strings: source.draw(
							array(stringsOver(family.alphabet, 8), { min: 1, max: stringsPerCase })
						),
						handwritten: Arr.map(written, (w) => source.draw(walksFor(w.r))),
						generated: source.draw(
							array(
								(inner) => ({
									source: inner.draw(patternOver(family.alphabet)),
									flags: inner.draw(flagsGen),
									tapes: inner.draw(walkTapes)
								}),
								{ min: 0, max: generatedPerFamily }
							)
						)
					})
					/** A sketch's case: each generated pattern refined once, its tapes walked over its NFA where it is walked. */
					const familyCase = (sketch: FamilySketch): FamilyCase => ({
						strings: sketch.strings,
						patterns: [
							...Arr.map(written, (w, pi) => ({
								...w,
								handwritten: true,
								walks: defined(sketch.handwritten[pi], `the walks of handwritten pattern ${pi}`)
							})),
							...Arr.map(sketch.generated, (g, gi) => {
								const r = refine(g.source, g.flags, loc(family.name, written.length + gi))
								return {
									source: g.source,
									flags: g.flags,
									handwritten: false,
									r,
									walks: walksOf(r, g.tapes),
									ecma: jsMatcher(g.source, g.flags)
								}
							})
						]
					})
					yield* searched(
						ctx,
						explore(
							{
								oracle: {
									kind: "second-implementation",
									name: "ECMAScript's RegExp membership, against the host NFA, PostgreSQL's ~ and the installed domain"
								},
								suite: `text/differential/${family.name}`,
								draw: sketched(familySketch, familyCase),
								literal: Formatter.format,
								coverage: required<DifferentialFeature>(
									[
										"domain enforced",
										"generated pattern admitted",
										"own member accepted",
										"member refused"
									],
									{ cases: 10, sense: notesOnly }
								),
								kept: [],
								runs: 10,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang
							},
							(c, k) => agreeOn(db, schema, fi, family, c.patterns, c.strings, (f) => k.note(f))
						)
					)
				}
			})
		)

		/**
		 * The limits of PostgreSQL's regex compiler grizzle holds a pattern to (scalar/regex/space.ts) must keep every
		 * admitted pattern inside what PostgreSQL 19 compiles: it refuses none of them as too complex or for too many
		 * colors. How long a compile takes is no part of the property, since the machine's load sets it; a compile that
		 * never ends is a hang, which the case's hang guard reports.
		 */
		const compileWithin = (db: RawSession, are: string) =>
			db.query("SELECT 'x' COLLATE pg_catalog.pg_c_utf8 ~ $1::text", [are])

		it.effect(
			"compiles the largest pattern the limits admit along a drawn shape, at each limit's edge",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const db = yield* s.session(ownerSession())
						return yield* explore(
							{
								suite: "text/differential/at-limit",
								draw: drawn(growthGen),
								literal: (growth) => Formatter.format(Str.slice(0, 160)(growth.at(1))),
								oracle: {
									kind: "postgresql",
									name: "PostgreSQL 19's regex compiler and ~, on the largest pattern the limits admit"
								},
								coverage: required<EdgeFeature>(edgeLimits, { cases: 96, sense: notesOnly }),
								kept: [],
								runs: 16,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 4,
								caseHang
							},
							(drawnGrowth, k) =>
								Effect.gen(function* () {
									const growth = Option.getOrElse(
										Option.flatMap(k.steering, (pending) =>
											Option.map(
												Arr.findFirst(edgeLimits, (kind) => pending.has(kind)),
												(kind) => k.draw(shapeOf[kind])
											)
										),
										() => drawnGrowth
									)
									yield* k.assume(measureAt(growth, 1) === "admitted")
									const { greatest, past } = edgeAt(growth)
									k.note(past)
									const source = growth.at(greatest)
									const r = admitted(source, "u", SourceLoc("str.regex", []))
									yield* compileWithin(db, r.members[0].are)
									const rows = yield* db.values(
										"SELECT ($1::text COLLATE pg_catalog.pg_c_utf8 ~ $2::text)::text",
										["abcd", r.members[0].are]
									)
									assert.equal(truth(rows[0]?.[0]), accepts(r, "abcd"), Str.slice(0, 160)(source))
								})
						)
					})
				)
		)

		it.effect("compiles generated admitted nested-quantifier patterns", (ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const db = yield* s.session(ownerSession())
					return yield* explore(
						{
							oracle: {
								kind: "postgresql",
								name: "PostgreSQL 19's regex compiler, which compiles every admitted pattern"
							},
							suite: "text/differential/nested",
							draw: drawn(nestedPattern),
							literal: Formatter.format,
							coverage: required<"a large pattern">(["a large pattern"], {
								cases: 4800,
								sense: notesOnly
							}),
							kept: [],
							runs: 4800,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(source, k) =>
							Effect.gen(function* () {
								const r = refine(source, "u", SourceLoc("str.regex", []))
								if (r === "empty" || r === "bound" || RegexIr.expandedSize(r.members[0].ir) < 64) {
									return
								}
								k.note("a large pattern")
								const exit = yield* Effect.exit(compileWithin(db, r.members[0].are))
								assert.equal(
									Exit.isSuccess(exit),
									true,
									`/${source}/u as ${r.members[0].are}: ${Exit.isFailure(exit) ? String(exit.cause) : ""}`
								)
							})
					)
				})
			)
		)
	}
)
