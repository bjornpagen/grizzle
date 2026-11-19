/**
 * A fact guard over a contract on PostgreSQL 19: Compute.nonzero, Compute.nonnegative, Compute.positive and
 * Compute.isFinite over a term of a contract drawn over a numeric of every typmod, its precision and its scale both
 * drawn, and over the integers, the contract's predicate one that keeps zero out, one that lets it in, or none, in each
 * position a guard stands: a query's predicate over a column, Compute.when's guard over a column, and Compute.when's
 * guard over a parameter.
 *
 * The oracle: compilation admits the guard exactly where the types do (the compute population's verdict,
 * test/support/agreement/compute.ts: isFinite over numeric, the others over every number), whatever constant the
 * contract's domain holds; and over a batch of the domain's own values, NaN among them where the domain admits it,
 * PostgreSQL's answer to the SQL compiled for the case, its subject a value of the domain, is the host evaluator's,
 * value by value: a NaN that isFinite keeps out included, since a typmod keeps out an infinity but never NaN.
 *
 * Features: each guard in each position over each contract predicate's relation to zero.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { CompileError } from "#compiler/core/errors.ts"
import { predicateTree } from "#compiler/ir/expr.ts"
import {
	aimedCaseGen,
	baseSql,
	BuilderThrew,
	carried,
	compiled,
	constantKeptOut,
	contractOver,
	type Feature,
	typesAdmit,
	valueText
} from "#test/pg/compute/fact-guards.fixtures.ts"
import { compareAnswers, type EvalCase, type PgAnswer } from "#test/pg/compute/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { plainRender, renderSql } from "#test/unit/compute/support.ts"

/**
 * A fact guard over a contract on PostgreSQL 19 is admitted wherever the types admit it, and tests every value of the domain as the host does.
 *
 * Its pre-conversion budget: runs 60, coverage cases 60 (test/pg/compute/fact-guards.test.ts at 22a8e17e9).
 */
export const aFactGuardOverAContractOnPostgreSQL19IsAdmittedWhereverTheTypesAdmitItAndTestsEveryValueOfTheDomainAsTheHostDoes =
	property.explore(steered(aimedCaseGen), {
		needs: { substrate: Substrate.installing },
		situations: [
			"a query's predicate",
			"when's guard over a column",
			"when's guard over a parameter",
			"a guard whose constant the domain keeps out",
			"a NaN tested",
			"refused where the types refuse"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, k: CaseOf<Feature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const { session, schema } = yield* Substrate
						const db = yield* session(ownerSession())
						const s = yield* schema(freshSchema)

						const field = contractOver(c.base, c.keeps)
						const lowered = yield* Effect.result(compiled(c, field))
						if (!typesAdmit(c)) {
							const refusal = Result.isFailure(lowered)
								? lowered.failure instanceof BuilderThrew
									? lowered.failure.cause
									: lowered.failure
								: undefined
							assert.ok(
								refusal instanceof CompileError && refusal.reason._tag === "MalformedDescription",
								"compilation refuses what the types refuse, as a malformed description"
							)
							k.note("refused where the types refuse")
							return
						}
						assert.ok(
							Result.isSuccess(lowered),
							`the guard is admitted: ${Formatter.format(lowered)}`
						)
						const root = lowered.success.root
						k.note(c.position)
						if (constantKeptOut(c)) {
							k.note("a guard whose constant the domain keeps out")
						}
						const domain = `"${s}"."guarded"`
						const predicate = field.scalar.contract?.predicate
						yield* db.query(
							predicate === undefined
								? `CREATE DOMAIN ${domain} AS ${baseSql(c.base)}`
								: `CREATE DOMAIN ${domain} AS ${baseSql(c.base)} CHECK ((${renderSql(succeeded(predicateTree(predicate)), plainRender)}) IS TRUE)`,
							[]
						)
						const sql = renderSql(root.expr, plainRender)
						const name = "fact_guard"
						yield* db.query(
							c.position === "when's guard over a parameter"
								? `PREPARE ${name}(${domain}) AS SELECT (${sql})::text, pg_typeof(${sql})::text`
								: `PREPARE ${name}(${domain}) AS SELECT (${sql})::text, pg_typeof(${sql})::text FROM (SELECT $1 AS x) AS r0`,
							[]
						)
						const answers: Array<PgAnswer> = []
						for (const value of c.values) {
							if (value.kind === "nan") {
								k.note("a NaN tested")
							}
							const ran = yield* Effect.result(
								db.values(`EXECUTE ${name}('${valueText(value)}')`, [])
							)
							if (Result.isFailure(ran)) {
								const reason = ran.failure.reason
								answers.push({
									kind: "error",
									sqlstate: reason._tag === "ServerError" ? reason.fields.code : reason._tag
								})
								continue
							}
							const [text, type] = ran.success[0] ?? []
							answers.push(
								typeof text === "string" && typeof type === "string"
									? { kind: "value", text, type }
									: { kind: "null", type: String(type) }
							)
						}
						yield* db.query(`DEALLOCATE ${name}`, [])
						const cases: ReadonlyArray<EvalCase> = Arr.map(c.values, (value, ord) => {
							const host = carried(c.base, value)
							return {
								ord,
								label: `${c.guard} over ${valueText(value)}`,
								sql,
								valueSql: valueText(value),
								type: root.actual,
								host: evaluate(root.expr, {
									kind: "row",
									column: () => host,
									param: () => host,
									regexMember: patternMember
								})
							}
						})
						assert.deepEqual(compareAnswers(cases, answers).mismatches, [])
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the types' verdict and the reference evaluator"
		},
		budget: { runs: 60, steered: 60 },
		kept: [],
		kills: []
	})
