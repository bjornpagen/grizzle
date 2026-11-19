/**
 * Contract predicates against PostgreSQL 19 domains: a contract over each base (bigint, integer, numeric, double
 * precision and text), its predicate the installed domain's CHECK.
 *
 * - Admission: for every drawn value, the edges its predicate turns on weighted among them, a literal's cast into the
 *   contract compiles exactly where PostgreSQL's CAST into the domain succeeds, the host evaluator's value then a value
 *   and the literal adopting the contract; and it is refused exactly where PostgreSQL refuses it, for the reason its
 *   SQLSTATE names (23514 for the predicate, 22003 for the typmod).
 * - Rounding: a literal is rounded to a numeric contract's scale before its predicate, as the domain cast does: the
 *   host admits a drawn literal about the predicate's bounds exactly where PostgreSQL does.
 *
 * Oracle: PostgreSQL itself, the domain cast of each value.
 *
 * Features: a value the domain admits and one it refuses, for each contract.
 */
import { family, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { predicateTree } from "#compiler/ir/expr.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import {
	contractProperty,
	domainRuns,
	evaluatorSchema,
	fixtures,
	Rate,
	roundingBatch
} from "#test/pg/compute/contract.fixtures.ts"
import { parseAnswer } from "#test/pg/compute/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { adoptedLiteral, plainRender, renderSql } from "#test/unit/compute/support.ts"

/** Contract predicates against PostgreSQL 19 domains admit exactly the values PostgreSQL's domain admits, for every generated value of each contract. */
export const contracts = family(
	Rec.fromEntries(Arr.map(fixtures(), (f) => [f.name, contractProperty(f)]))
)

/**
 * Contract predicates against PostgreSQL 19 domains round a literal to the contract's scale before its predicate, as
 * PostgreSQL's domain cast does.
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
							const host = adoptedLiteral(Decimal.of(l), Rate.scalar)
							const pgAdmits = answer.kind !== "error"
							return host.ok === pgAdmits &&
								(pgAdmits || ["23514", "22003"].includes(answer.sqlstate))
								? []
								: [
										{
											literal: l,
											pg: answer,
											host: host.ok ? "admitted" : host.error.reason
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
		kills: []
	})
