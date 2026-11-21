/**
 * Text's terms on PostgreSQL 19, against the host.
 *
 * 1. The SQL a query or a check holds (lower/conservative/expr/ops.ts, the one spelling of every operation): a match
 *    of a literal pattern, `~` over its ARE, and of a dictionary, `~` over its pattern's ARE read by key; a
 *    prefix test, a suffix test, a concatenation, lowered as a check lowers it since no query builds one, and an
 *    equation with one, which no lowering builds. Each runs over a batch of rows in one round trip, and PostgreSQL's
 *    answer must be the reference evaluator's (test/support/oracle/evaluate/catalog.ts, grizzle's own automaton over
 *    the pattern's parse) and, for a match, ECMAScript's own test, the development oracle the text differential holds
 *    the ARE translation to.
 * 2. Installed CHECKs: the real installer's DDL, one CHECK whose pattern is a closed relation's str.pattern field,
 *    `Pattern.at("pattern", domain)`, read from its ARE dictionary by the domain's key, and one of a drawn literal, each probe row inserted under a savepoint; the server
 *    admits a row exactly when ECMAScript's test of its pattern holds, and refuses every other with 23514 naming that
 *    CHECK.
 *
 * Oracle: the reference evaluator and ECMAScript's own RegExp test for the SQL; PostgreSQL's CHECK for the installed
 * patterns, against ECMAScript's test.
 *
 * Features: each text term and each dictionary situation the searches name.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	compute,
	dictionary,
	type DictionaryFeature,
	dictionarySchema,
	inInstallation,
	textInstallation,
	judgeDictionary,
	lowered,
	patternLiteral,
	printed,
	type Probe,
	sqlCase,
	type SqlFeature,
	variable
} from "#test/pg/compute/text.fixtures.ts"
import { installationSql } from "#test/support/compile.ts"
import { evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { jsMatcher } from "#test/support/regex.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Text's terms on PostgreSQL match, prefix, suffix, concatenation and equation agree with the host and with ECMAScript.
 *
 * Its pre-conversion budget: runs 60, coverage cases 60 (test/pg/compute/text.test.ts at c568eb123).
 */
export const computesTextTermsOnPostgreSQLMatchPrefixSuffixConcatenationAndEquationAgreeWithTheHostAndWithECMAScript =
	property.explore(sqlCase, {
		needs: { substrate: Substrate.installing },
		situations: [
			"a literal's match held",
			"a literal's match failed",
			"a dictionary's match held",
			"a dictionary's match failed",
			"a prefix held",
			"an equation held"
		] satisfies ReadonlyArray<Reached<SqlFeature>>,
		check:
			({ substrate }, k: Case<SqlFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const db = yield* s.session(ownerSession())

						const [first, second] = c.sources
						const pattern =
							second === undefined
								? patternLiteral(first)
								: {
										kind: "cond" as const,
										pred: variable("p"),
										onTrue: patternLiteral(first),
										onFalse: patternLiteral(second)
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
								lowered("suffix", compute("endsWith", variable("v"), variable("w")), true, "query")
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
								lowered("concat", compute("concat", variable("w"), variable("r")), false, "check")
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
						const ofFirst = jsMatcher(first, "u")
						const ofSecond = second === undefined ? ofFirst : jsMatcher(second, "u")
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
							const js = (input.p ? ofFirst : ofSecond)(input.v)
							assert.equal(row[0], printed(js), `/${chosen}/u over ${Formatter.format(input.v)}`)
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
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator, and ECMAScript's own RegExp test"
		},
		budget: { runs: 60, steered: 60 },
		kept: [],
		kills: []
	})

/**
 * Text's terms on PostgreSQL an installed CHECK over a closed dictionary of patterns admits exactly each domain's matches.
 *
 * Its pre-conversion budget: runs 30, coverage cases 30 (test/pg/compute/text.test.ts at c568eb123).
 */
export const computesTextTermsOnPostgreSQLAnInstalledCHECKOverAClosedDictionaryOfPatternsAdmitsExactlyEachDomainsMatches =
	property.explore(dictionary, {
		needs: { substrate2: Substrate.installing },
		situations: [
			"dictionary admits",
			"dictionary refuses",
			"literal admits",
			"literal refuses"
		] satisfies ReadonlyArray<Reached<DictionaryFeature>>,
		check:
			({ substrate2 }, c: Case<DictionaryFeature>) =>
			(d) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						return yield* Effect.scoped(
							Effect.gen(function* () {
								const s = dictionarySchema(d)
								const installation = yield* textInstallation(s)
								const pinned = yield* substrate.admin.pin
								const { problems, reached } = yield* inInstallation(
									pinned,
									installationSql(installation, substrate.database),
									judgeDictionary(pinned, installation, s, d)
								)
								c.noteAll(reached)
								assert.deepEqual(problems, [])
							})
						)
					}),
					Substrate,
					substrate2
				),
		oracle: { kind: "second-implementation", name: "ECMAScript's own RegExp test" },
		budget: { runs: 30, steered: 30 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/index.ts",
				original: '{ kind: "are", field: read.field }',
				replacement: '{ kind: "at", field: read.field }',
				why: "The CHECK matches its text against its domain's pattern as grizzle spells it, where PostgreSQL reads an ARE: a pattern whose spellings differ admits or refuses another row than ECMAScript's test."
			}
		]
	})
