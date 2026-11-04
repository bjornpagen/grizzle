import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { array, constant, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Exit, Formatter } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { regexMaxNodes } from "#compiler/core/policy.ts"
import { emit, unmetered } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import * as RegexIr from "#compiler/text/ir.ts"
import { parsePattern } from "#compiler/text/parse.ts"
import {
	accepts,
	analyzeLanguage,
	analyzeText,
	type TextRefinement,
	textDomainDdl,
	textLimits
} from "#compiler/text/refinement.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { jsonText } from "#test/support/json.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import {
	type Family,
	type Flags,
	families,
	flagsGen,
	jsAccepts,
	nestedPattern,
	patternOver,
	stringsOver,
	walkGen
} from "#test/unit/text/generators.ts"

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
 * The file also holds that every admitted pattern compiles inside PostgreSQL's regex compile space: the planted
 * worst case of each budget, and generated nested quantifiers near the budgets. The refusal of unadmitted constructs
 * is test/unit/text/parse.test.ts's, and that the budgets judge the printed ARE whatever its spelling is
 * test/unit/text/lowering.test.ts's.
 */
const loc = (family: string, i: number) => SourceLoc("str.regex", [family, i])
/** A batch's randomized strings, and the generated patterns a case draws besides the family's own. */
const stringsPerCase = 500
const generatedPerFamily = 12
/** The accepting walks a case draws over a pattern's NFA, its own members besides its finite ones. */
const walksPerPattern = 24

/**
 * A pattern's refinement, a language with no admitted text value ("empty"), or a pattern past the budgets ("bound").
 */
const refine = (
	source: string,
	flags: Flags,
	at: SourceLoc
): TextRefinement | "empty" | "bound" => {
	const result = analyzeText(source, flags, at)
	if (result.ok) {
		return result.value
	}
	if (result.error.reason._tag === "ResourceBound") {
		return "bound"
	}
	const limits = textLimits(regexMaxNodes)
	const parsed = parsePattern(source, flags, limits)
	if (!parsed.ok) {
		throw new Error(`/${source}/${flags} does not parse: ${parsed.error.message}`)
	}
	if (analyzeLanguage(parsed.value, limits).kind === "empty") {
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

/**
 * The walks a case draws for a refinement: accepting walks over its NFA, or none where its members are finite or it
 * has none.
 */
const walksFor = (r: TextRefinement | "empty" | "bound"): Gen<ReadonlyArray<string | undefined>> =>
	r === "empty" || r === "bound" || r.check.kind === "finite"
		? constant([])
		: array(walkGen(r.nfa), { min: 0, max: walksPerPattern })

/**
 * One drawn case of a family: the strings, the walks of each handwritten pattern, and generated patterns with theirs.
 */
interface FamilyCase {
	readonly strings: ReadonlyArray<string>
	readonly handwritten: ReadonlyArray<ReadonlyArray<string | undefined>>
	readonly generated: ReadonlyArray<{
		readonly source: string
		readonly flags: Flags
		readonly walks: ReadonlyArray<string | undefined>
	}>
}

/** One pattern of a case: its text, whether a person wrote it, its refinement and its drawn walks. */
interface CasePattern {
	readonly source: string
	readonly flags: Flags
	readonly handwritten: boolean
	readonly r: TextRefinement | "empty" | "bound"
	readonly walks: ReadonlyArray<string | undefined>
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
			for (const [pi, { source, flags, handwritten, r, walks }] of patterns.entries()) {
				const label = `${family.name} /${source}/${flags}`
				if (r === "bound") {
					assert.equal(handwritten, false, `${label} exceeds the budgets`)
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
				const js = Arr.map(all, (v) => jsAccepts(source, flags, v))
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
				const named = identity.textDomain(slug)
				const name = named.identifier
				let domainType = "text"
				if (r.check.kind !== "tautology") {
					const statement = textDomainDdl(r.check, {
						schema,
						name,
						constraint: identity.domainCheck(named).identifier
					})
					const ddl = succeeded(emit(statement, emptyNameMap, unmetered)).text
					yield* db.query(ddl, [])
					domainType = `${quoteIdent(schema)}.${quoteIdent(name)}`
					note("domain enforced")
				}
				const payload = jsonText(Arr.map(all, (v, ord) => ({ ord, v })))
				const rows = yield* db.values(
					`SELECT (c.v COLLATE pg_catalog.pg_c_utf8 ~ $2::text)::text, pg_input_is_valid(c.v, $3::text)::text
					 FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.ord`,
					[payload, r.are, domainType]
				)
				assert.equal(rows.length, all.length, label)
				for (const [i, row] of rows.entries()) {
					const value = jsonText(all[i])
					const expected = defined(js[i], `the ECMAScript answer on ${value}`)
					assert.equal(
						defined(host[i], `the host answer on ${value}`),
						expected,
						`${label} host on ${value}`
					)
					assert.equal(truth(row[0]), expected, `${label} ARE ${r.are} on ${value}`)
					assert.equal(truth(row[1]), expected, `${label} domain on ${value}`)
				}
				assert.equal(
					Arr.every(own, (v) => jsAccepts(source, flags, v)),
					true,
					`${label} witnesses are members`
				)
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
		it.effect(`agree on batches of up to ${stringsPerCase} randomized strings per family`, (ctx) =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const schema = yield* s.schema(freshSchema)
				const db = yield* s.session(ownerSession())
				for (const [fi, family] of families.entries()) {
					/** The family's own patterns, refined once: a handwritten pattern past the budgets fails the test. */
					const written = Arr.map(family.patterns, ([source, flags], pi) => {
						const r = refine(source, flags, loc(family.name, pi))
						if (r === "bound") {
							throw new Error(`${family.name} /${source}/${flags} exceeds the budgets`)
						}
						return { source, flags, r }
					})
					const familyCase: Gen<FamilyCase> = (source) => ({
						strings: source.draw(
							array(stringsOver(family.alphabet, 8), { min: 1, max: stringsPerCase })
						),
						handwritten: Arr.map(written, (w) => source.draw(walksFor(w.r))),
						generated: source.draw(
							array(
								(inner) => {
									const pattern = inner.draw(patternOver(family.alphabet))
									const flags = inner.draw(flagsGen)
									return {
										source: pattern,
										flags,
										walks: inner.draw(walksFor(refine(pattern, flags, loc(family.name, -1))))
									}
								},
								{ min: 0, max: generatedPerFamily }
							)
						)
					})
					yield* searched(
						ctx,
						explore(
							{
								suite: `text/differential/${family.name}`,
								draw: drawn(familyCase),
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
								/** The floor's 3 and the rotating 10 batches of up to 500 strings each. */
								runs: 10,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang: Duration.minutes(2)
							},
							(c, k) => {
								const patterns: ReadonlyArray<CasePattern> = [
									...Arr.map(written, (w, pi) => ({
										...w,
										handwritten: true,
										walks: defined(c.handwritten[pi], `the walks of handwritten pattern ${pi}`)
									})),
									...Arr.map(c.generated, (g, gi) => ({
										source: g.source,
										flags: g.flags,
										handwritten: false,
										r: refine(g.source, g.flags, loc(family.name, written.length + gi)),
										walks: g.walks
									}))
								]
								return agreeOn(db, schema, fi, family, patterns, c.strings, (f) => k.note(f))
							}
						)
					)
				}
			})
		)

		/**
		 * The compile-space budgets (refinement.ts TextLimits) must keep every admitted pattern inside what
		 * PostgreSQL 19 compiles: it refuses none of them as too complex. How long a compile takes is no part of the
		 * property, since the machine's load sets it; the session's statement timeout guards against a hang alone.
		 */
		const compileWithin = (db: RawSession, are: string) =>
			db.query("SELECT 'x' COLLATE pg_catalog.pg_c_utf8 ~ $1::text", [are])
		const hangGuard = "SET statement_timeout = '60s'"

		/** The planted worst case of each budget. */
		const atBound: Arr.NonEmptyReadonlyArray<readonly [string, Flags]> = [
			["^(?:[a-z]{1,255}){16}$", "u"],
			["^(?:.{1,255}){16}$", "u"],
			["^(?:.{1,255}){16}$", "su"],
			["^(?:\\W{1,255}){16}$", "u"],
			["^(?:(?:ab|cd|ef|gh){0,255}){0,2}$", "u"],
			["(?:[^a]{2,255}x){0,8}", "u"],
			["^(?:[a-z]{0,255}){0,8}$", "u"],
			["(?:a?){255}(?:b?){100}c", "u"],
			["^(?:(?:a?){60}){2}$", "u"],
			["(?:(?:a|){100}){1,2}b", "u"],
			["(?:(?:a|b?){8}){8}c", "u"],
			["(?:$|a|){4}(?:^|a|){4}b", "u"],
			["(?:(?:a|$){1,3}){2}(?:^)?b", "u"],
			["(?:^|.{1,127}|$){2,4}b", "u"],
			["^(?:a{250}){4}$|^(?:b{250}){4}$", "u"],
			["(?:(?:(?:^){255}){255}){255}a", "u"],
			["(?:(?:.|$|){0,2})+b", "u"],
			["(?:(?:a*){8}|(?:$){0,8})(?:(?:a|){8,}|(?:^)*)+b", "u"]
		]

		it.effect(
			"compiles admitted patterns at each budget inside PostgreSQL's regex compile space",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const db = yield* s.session(ownerSession())
						yield* db.query(hangGuard, [])
						return yield* exhaust(
							{
								suite: "text/differential/at-bound",
								generator: element(atBound),
								literal: Formatter.format,
								limit: atBound.length,
								coverage: noCoverage,
								caseHang: Duration.minutes(2)
							},
							([source, flags]) =>
								Effect.gen(function* () {
									const r = admitted(source, flags, SourceLoc("str.regex", []))
									yield* compileWithin(db, r.are)
									const rows = yield* db.values(
										"SELECT ($1::text COLLATE pg_catalog.pg_c_utf8 ~ $2::text)::text",
										["abcd", r.are]
									)
									assert.equal(truth(rows[0]?.[0]), accepts(r, "abcd"), source)
								})
						)
					})
				)
		)

		it.effect("compiles generated admitted nested-quantifier patterns near the budgets", (ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const db = yield* s.session(ownerSession())
					yield* db.query(hangGuard, [])
					return yield* explore(
						{
							suite: "text/differential/nested",
							draw: drawn(nestedPattern),
							literal: Formatter.format,
							coverage: required<"near the budget">(["near the budget"], {
								cases: 4800,
								sense: notesOnly
							}),
							kept: [],
							/** The floor's 1,200 and the rotating 4,800. */
							runs: 4800,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang: Duration.minutes(2)
						},
						(source, k) =>
							Effect.gen(function* () {
								const r = refine(source, "u", SourceLoc("str.regex", []))
								if (r === "empty" || r === "bound" || RegexIr.expandedSize(r.ir) < 64) {
									return
								}
								k.note("near the budget")
								const exit = yield* Effect.exit(compileWithin(db, r.are))
								assert.equal(
									Exit.isSuccess(exit),
									true,
									`/${source}/u as ${r.are}: ${Exit.isFailure(exit) ? String(exit.cause) : ""}`
								)
							})
					)
				})
			)
		)
	}
)
