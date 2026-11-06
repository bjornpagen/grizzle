import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { check, closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { matchPattern } from "#compiler/scalar/regex/admit.ts"
import { judged, probe } from "#test/pg/physical/checks.ts"
import { assert, defined } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import {
	baseParams,
	type LeafBinding,
	lowerWith,
	plainRender,
	renderSql,
	testPg
} from "#test/unit/compute/support.ts"
import { families, jsAccepts, patternOver, stringsOver } from "#test/unit/text/generators.ts"

/**
 * Compute's text terms on PostgreSQL 19, against the host.
 *
 * 1. The SQL a query or a check holds (lower/conservative/expr/ops.ts, the one spelling of every operation): a match
 *    of a literal pattern, `~` over its ARE, and of a dictionary, `~` over a CASE from each source to its ARE; a
 *    prefix test, a suffix test, a concatenation, lowered as a check lowers it since no query builds one, and an
 *    equation with one, which no lowering builds. Each runs over a batch of rows in one round trip, and PostgreSQL's
 *    answer must be the reference evaluator's (test/support/oracle/evaluate/catalog.ts, grizzle's own automaton over
 *    the pattern's parse) and, for a match, ECMAScript's own test, the development oracle the text differential holds
 *    the ARE translation to.
 * 2. Installed CHECKs: the real installer's DDL, one CHECK whose pattern is a closed relation's dictionary,
 *    `Pattern.at("pattern", domain)`, and one of a literal, each probe row inserted under a savepoint; the server
 *    admits a row exactly when ECMAScript's test of its pattern holds, and refuses every other with 23514 naming that
 *    CHECK.
 */

/** A text whose pattern bounds its bytes, which a query's `~` reads (lower.ts regexReadable); every drawn row is short. */
const textColumn: LeafBinding = { kind: "column", type: testPg.regex("^.{0,64}$", "su").scalar }
const boolColumn: LeafBinding = { kind: "column", type: testPg.boolean.scalar }

const variable = (name: string): ExprDesc => ({ kind: "var", var: name })
const text = (value: string): ExprDesc => ({ kind: "literal", value, type: undefined })
const compute = (
	fn: "matches" | "concat" | "startsWith" | "endsWith",
	...args: ReadonlyArray<ExprDesc>
): ExprDesc => ({ kind: "compute", fn, args })

/** One expression case: a family, the patterns of its match, the row batch and the dictionary's choice. */
interface SqlCase {
	readonly family: number
	readonly sources: Arr.NonEmptyReadonlyArray<string>
	readonly rows: ReadonlyArray<{
		readonly v: string
		readonly w: string
		readonly r: string
		readonly p: boolean
	}>
}

type SqlFeature =
	| "a literal's match held"
	| "a literal's match failed"
	| "a dictionary's match held"
	| "a dictionary's match failed"
	| "a prefix held"
	| "an equation held"

const sqlCase: Gen<SqlCase> = (source) => {
	const fi = source.draw(int(0, families.length - 1))
	const family = defined(families[fi], "a family")
	const pattern: Gen<string> = weighted([
		[
			1,
			map(
				element(
					Arr.isReadonlyArrayNonEmpty(family.patterns) ? family.patterns : [["^$", "u"] as const]
				),
				([s]) => s
			)
		],
		[2, patternOver(family.alphabet)]
	])
	const first = source.draw(pattern)
	const second = source.draw(boolean) ? [source.draw(pattern)] : []
	const strings = stringsOver(family.alphabet, 8)
	return {
		family: fi,
		sources: [first, ...second],
		rows: source.draw(
			array(
				(row) => {
					const w = row.draw(strings)
					const r = row.draw(strings)
					/** Half the time v is w then r, so prefix tests and equations hold as often as not. */
					const v = row.draw(boolean) ? `${w}${r}` : row.draw(strings)
					return { v, w, r, p: row.draw(boolean) }
				},
				{ min: 1, max: 64 }
			)
		)
	}
}

/** A lowered expression of a case, its SQL and the reference evaluator's value per row. */
interface Probe {
	readonly label: string
	readonly expr: ScalarExpr
	readonly sql: string
}

const lowered = (
	label: string,
	desc: ExprDesc,
	predicate: boolean,
	mode: "query" | "check"
): Probe | undefined => {
	const result = lowerWith(
		mode,
		desc,
		{ v: textColumn, w: textColumn, r: textColumn, p: boolColumn },
		predicate,
		baseParams
	)
	if (!result.ok) {
		return undefined
	}
	const expr = result.value.root.expr
	return { label, expr, sql: renderSql(expr, plainRender) }
}

/** The text PostgreSQL prints a host value as: a boolean's word, a text itself. */
const printed = (value: unknown): string =>
	typeof value === "boolean" ? (value ? "true" : "false") : String(value)

layer(Substrate.layer)("Compute's text terms on PostgreSQL", (it) => {
	it.effect(
		"match, prefix, suffix, concatenation and equation agree with the host and with ECMAScript",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const db = yield* s.session(ownerSession())
					return yield* explore(
						{
							suite: "pg/compute/text-sql",
							draw: drawn(sqlCase),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "the reference evaluator, and ECMAScript's own RegExp test"
							},
							coverage: required<SqlFeature>(
								[
									"a literal's match held",
									"a literal's match failed",
									"a dictionary's match held",
									"a dictionary's match failed",
									"a prefix held",
									"an equation held"
								],
								{ cases: 60, sense: notesOnly }
							),
							kept: [],
							/** Each case one round trip of up to 64 rows and six expressions. */
							runs: 60,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(c, k) =>
							Effect.gen(function* () {
								const [first, second] = c.sources
								const pattern =
									second === undefined
										? text(first)
										: {
												kind: "cond" as const,
												pred: variable("p"),
												onTrue: text(first),
												onFalse: text(second)
											}
								const match = lowered(
									"match",
									compute("matches", variable("v"), pattern),
									true,
									"query"
								)
								if (match === undefined) {
									return
								}
								const probes: ReadonlyArray<Probe> = [
									match,
									defined(
										lowered(
											"prefix",
											compute("startsWith", variable("v"), variable("w")),
											true,
											"query"
										)
									),
									defined(
										lowered(
											"suffix",
											compute("endsWith", variable("v"), variable("w")),
											true,
											"query"
										)
									),
									defined(
										lowered(
											"equation",
											{
												kind: "compare",
												op: "eq",
												left: variable("v"),
												right: compute("concat", variable("w"), variable("r"))
											},
											true,
											"query"
										)
									),
									defined(
										lowered(
											"concat",
											compute("concat", variable("w"), variable("r")),
											false,
											"check"
										)
									)
								]
								const select = Arr.join(
									Arr.map(probes, (p) => `(${p.sql})::text`),
									", "
								)
								const rows = yield* db.values(
									`SELECT ${select} FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, v text, w text, r text, p boolean) ORDER BY r0.ord`,
									[jsonText(Arr.map(c.rows, (r, ord) => ({ ord, ...r })))]
								)
								assert.equal(rows.length, c.rows.length, "a row per input")
								for (const [i, row] of rows.entries()) {
									const input = defined(c.rows[i])
									const columns = new Map<string, unknown>([
										["v", input.v],
										["w", input.w],
										["r", input.r],
										["p", input.p]
									])
									for (const [j, p] of probes.entries()) {
										const host = evaluate(p.expr, {
											kind: "row",
											column: (ref) => {
												const value = columns.get(ref.name)
												return typeof value === "string" || typeof value === "boolean"
													? value
													: undefined
											},
											param: () => undefined,
											regexMember: patternMember
										})
										if (host._tag !== "Success") {
											return assert.fail(`${p.label}: the reference evaluates it`)
										}
										assert.equal(
											row[j],
											printed(host.success),
											`${p.label} over ${Formatter.format(input)}: PostgreSQL against the host`
										)
									}
									const chosen = second === undefined || input.p ? first : second
									const js = jsAccepts(chosen, "u", input.v)
									assert.equal(
										row[0],
										printed(js),
										`/${chosen}/u over ${Formatter.format(input.v)}`
									)
									k.note(
										second === undefined
											? js
												? "a literal's match held"
												: "a literal's match failed"
											: js
												? "a dictionary's match held"
												: "a dictionary's match failed"
									)
									if (row[1] === "true") {
										k.note("a prefix held")
									}
									if (row[3] === "true") {
										k.note("an equation held")
									}
								}
							})
					)
				})
			)
	)

	/** The dictionary a case installs: each domain's pattern, and the probe texts. */
	interface Dictionary {
		readonly family: number
		readonly patterns: Arr.NonEmptyReadonlyArray<string>
		readonly probes: ReadonlyArray<{ readonly domain: number; readonly lexical: string }>
	}

	type DictionaryFeature =
		| "dictionary admits"
		| "dictionary refuses"
		| "literal admits"
		| "literal refuses"

	/** Patterns the case's family admits, each checked as Compute.matches admits it. */
	const dictionary: Gen<Dictionary> = (source) => {
		const fi = source.draw(int(0, families.length - 1))
		const family = defined(families[fi], "a family")
		const admitted = (p: string): boolean => matchPattern(p, SourceLoc("pattern", [])).ok
		const one: Gen<string> = (s) => {
			const drawnPattern = s.draw(patternOver(family.alphabet))
			return admitted(drawnPattern) ? drawnPattern : "^$"
		}
		const patterns = source.draw(array(one, { min: 1, max: 4 }))
		const strings = stringsOver(family.alphabet, 6)
		return {
			family: fi,
			patterns: Arr.isReadonlyArrayNonEmpty(patterns) ? patterns : ["^$"],
			probes: source.draw(
				array((p) => ({ domain: p.draw(int(0, 3)), lexical: p.draw(strings) }), {
					min: 1,
					max: 12
				})
			)
		}
	}

	/** The literal pattern every case's Tagged rows are checked by. */
	const literalSource = "^[ab]+$"

	const dictionarySchema = (d: Dictionary) => {
		const handles = Arr.map(d.patterns, (_, i) => `D${i}`)
		const Domain = closed("Domain", Arr.isReadonlyArrayNonEmpty(handles) ? handles : ["D0"])
		const Pattern = closed.relation(
			"Pattern",
			{ domain: closedId(Domain), pattern: str.regex("^.*$", "su") },
			["domain"],
			Arr.map(d.patterns, (pattern, i) => ({ domain: `D${i}`, pattern }))
		)
		const Value = relation(
			"Value",
			{ id: pg.integer, domain: closedId(Domain), lexical: str.regex("^.*$", "su") },
			["id"]
		)
		const Tagged = relation("Tagged", { id: pg.integer, code: str.regex("^.*$", "su") }, ["id"])
		const lexical = check("Lexical", Value, (v) =>
			Compute.matches(v.lexical, Pattern.at("pattern", v.domain))
		)
		const literal = check("Literal", Tagged, (t) => Compute.matches(t.code, literalSource))
		const value = schema("Dictionary", { Domain, Pattern, Value, Tagged }, [lexical, literal])
		return { value, Value, Tagged, lexical, literal }
	}

	const installationOf = (s: ReturnType<typeof dictionarySchema>) =>
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const schemaName = yield* substrate.schema({ create: false, label: "text" })
			const owned = owning(s.value)
			const real = compileInstallation(owned, {
				...installOptions(owned, substrate.owner.role),
				installation: identity.schema(parsedSchemaName(schemaName))
			})
			if (!real.ok) {
				return yield* Effect.die(new Error(`real compile ${real.error.message}`))
			}
			return real.value
		})

	/** Installs `sql` on the pinned session in a transaction, runs `body` in it, and rolls back. */
	const inInstallation = <A>(
		pinned: PgConnection,
		sql: ReadonlyArray<string>,
		body: Effect.Effect<A, SqlError>
	): Effect.Effect<A, SqlError> =>
		Effect.ensuring(
			Effect.gen(function* () {
				yield* pinned.query("BEGIN", [])
				for (const statement of sql) {
					yield* pinned.query(statement, [])
				}
				return yield* body
			}),
			Effect.orDie(pinned.query("ROLLBACK", []))
		)

	const judgeDictionary = (
		pinned: PgConnection,
		installation: Installation,
		s: ReturnType<typeof dictionarySchema>,
		d: Dictionary
	) =>
		Effect.gen(function* () {
			const names = installationNamesOf(installation)
			const lexicalCheck = names.constraintOf(names.lawOf(s.lexical), "TableCheck")
			const literalCheck = names.constraintOf(names.lawOf(s.literal), "TableCheck")
			const problems: Array<string> = []
			const reached = new Set<DictionaryFeature>()
			let id = 0
			for (const p of d.probes) {
				const domain = p.domain % d.patterns.length
				const pattern = defined(d.patterns[domain])
				const holds = jsAccepts(pattern, "u", p.lexical)
				id += 1
				const verdict = yield* probe(
					pinned,
					`INSERT INTO ${names.table(s.Value)} (${names.column(s.Value, "id")}, ${names.column(s.Value, "domain")}, ${names.column(s.Value, "lexical")}) VALUES ($1, $2, $3)`,
					[id, domain, p.lexical]
				)
				appendAll(
					problems,
					judged(
						`Value /${pattern}/u over ${Formatter.format(p.lexical)}`,
						holds,
						verdict,
						lexicalCheck
					)
				)
				reached.add(holds ? "dictionary admits" : "dictionary refuses")
				const tagged = jsAccepts(literalSource, "u", p.lexical)
				const literalVerdict = yield* probe(
					pinned,
					`INSERT INTO ${names.table(s.Tagged)} (${names.column(s.Tagged, "id")}, ${names.column(s.Tagged, "code")}) VALUES ($1, $2)`,
					[id, p.lexical]
				)
				appendAll(
					problems,
					judged(
						`Tagged /${literalSource}/u over ${Formatter.format(p.lexical)}`,
						tagged,
						literalVerdict,
						literalCheck
					)
				)
				reached.add(tagged ? "literal admits" : "literal refuses")
			}
			return { problems, reached }
		})

	it.effect(
		"an installed CHECK over a closed dictionary of patterns admits exactly each domain's matches",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					return yield* explore(
						{
							suite: "pg/compute/text-dictionary",
							draw: drawn(dictionary),
							literal: Formatter.format,
							oracle: { kind: "second-implementation", name: "ECMAScript's own RegExp test" },
							coverage: required<DictionaryFeature>(
								["dictionary admits", "dictionary refuses", "literal admits", "literal refuses"],
								{ cases: 30, sense: notesOnly }
							),
							kept: [],
							runs: 30,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(d, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const s = dictionarySchema(d)
									const installation = yield* installationOf(s)
									const pinned = yield* substrate.admin.pin
									const { problems, reached } = yield* inInstallation(
										pinned,
										installationSql(installation),
										judgeDictionary(pinned, installation, s, d)
									)
									c.noteAll(reached)
									assert.deepEqual(problems, [])
								})
							)
					)
				})
			)
	)
})
