/**
 * Contract predicates against PostgreSQL 19 domains: a contract over numeric(7, 6), its predicate the installed domain's
 * CHECK.
 *
 * A literal stated as a value of a numeric contract is rounded to its scale before its predicate, as the domain cast does
 * (scalar/compute/literal.ts LiteralMeeting `stored`): the host admits a drawn literal about the predicate's bounds
 * exactly where PostgreSQL's cast does. A literal compared with a column of the contract is held to it as written
 * (`compared`), since PostgreSQL compares it at the base type: the host admits it exactly where the cast admits it and
 * leaves it as written, and refuses it where the cast would round it, so a comparison never reads a value its literal
 * does not state (README Arithmetic, main's ruling on a bare literal).
 *
 * Oracle: PostgreSQL itself, the domain cast of each literal.
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { predicateTree } from "#compiler/ir/expr.ts"
import { compareDecimal, Decimal } from "#compiler/scalar/values/decimal.ts"
import {
	domainRuns,
	evaluatorSchema,
	Rate,
	roundingBatch
} from "#test/pg/compute/contract.fixtures.ts"
import { parseAnswer } from "#test/pg/compute/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	adoptedLiteral,
	plainRender,
	renderSql,
	admittedStored
} from "#test/unit/compute/support.ts"

/**
 * Contract predicates against PostgreSQL 19 domains round a literal stated as a value of the contract to its scale
 * before its predicate, as PostgreSQL's domain cast does, and refuse a literal compared with one that the cast would
 * round.
 *
 * Its pre-conversion budget: runs 2, no coverage cases, so no steered phase (test/pg/compute/contract.test.ts at
 * c568eb123).
 */
export const contractPredicatesRoundALiteralToTheContractsScaleBeforeItsPredicateAsPostgreSQLsDomainCastDoes =
	property.explore(roundingBatch, {
		needs: { substrate: Substrate.installing },
		situations: [],
		check:
			({ substrate }) =>
			(batch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const { db, s } = yield* evaluatorSchema
						const predicate = Rate.scalar.contract?.predicate
						if (predicate === undefined) {
							return yield* Effect.die(new Error("Rate has no predicate table"))
						}
						yield* db.query(
							`CREATE DOMAIN "${s}".rate AS numeric(7, 6) CONSTRAINT rate_check CHECK ((${renderSql(succeeded(predicateTree(predicate)), plainRender)}) IS TRUE)`,
							[]
						)
						const literals = batch
						const rows = yield* db.values(
							`SELECT "${s}".try_eval(c.q, c.q) FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, q text) ORDER BY c.ord`,
							[jsonText(Arr.map(literals, (l, ord) => ({ ord, q: `'${l}'::"${s}".rate` })))]
						)
						const disagreements = Arr.flatMap(literals, (l, i) => {
							const answer = parseAnswer(String(rows[i]?.[0]))
							const written = Decimal.of(l)
							const stored = admittedStored(written, Rate.scalar)
							const compared = adoptedLiteral(written, Rate.scalar)
							const pgAdmits = answer.kind !== "error"
							/** The cast admitted the literal as it is written: its value is the literal's own, not a rounding. */
							const unrounded =
								answer.kind === "value" && compareDecimal(Decimal.of(answer.text), written) === 0
							return stored.ok === pgAdmits &&
								(pgAdmits || ["23514", "22003"].includes(answer.sqlstate)) &&
								compared.ok === unrounded
								? []
								: [
										{
											literal: l,
											pg: answer,
											stored: stored.ok ? "admitted" : stored.error.reason,
											compared: compared.ok ? "admitted" : compared.error.reason._tag
										}
									]
						})
						assert.deepEqual(disagreements, [])
					}),
					Substrate,
					substrate
				),
		oracle: { kind: "postgresql", name: "the domain cast of each literal into numeric(7, 6)" },
		budget: { runs: domainRuns, steered: domainRuns },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/literal.ts",
				original:
					"\tif (exact.ok) {\n\t\treturn undefined\n\t}\n\tconst shown = parsed.value.toString()\n",
				replacement:
					'\tif (exact.ok || exact.error === "numericScale") {\n\t\treturn undefined\n\t}\n\tconst shown = parsed.value.toString()\n',
				why: "A literal compared with a column of the contract is admitted past its scale, as a stored one is rounded: 0.0000005 compared with Rate compiles, where PostgreSQL's comparison at numeric reads it as written and its cast would round it, so the host must refuse it."
			},
			{
				file: "packages/engine/src/scalar/compute/literal.ts",
				original: "stored: (value, t) => irLiteral(value, t),",
				replacement: "stored: (value, t) => oppositeLiteral(value, t),",
				why: "A literal stated as a value of the contract is held to its type as written: 0.0000005 is refused, where PostgreSQL's domain cast rounds it to 0.000001 and admits it."
			}
		]
	})
