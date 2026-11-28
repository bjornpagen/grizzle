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
	contractEvaluator,
	domainRuns,
	Rate,
	roundingBatch
} from "#test/pg/compute/contract.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { parseAnswer } from "#test/support/pg/compute/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	adoptedLiteral,
	plainRender,
	renderSql,
	admittedStored
} from "#test/support/unit/compute/support.ts"

/**
 * Contract predicates against PostgreSQL 19 domains round a literal stated as a value of the contract to its scale
 * before its predicate, as PostgreSQL's domain cast does, and refuse a literal compared with one that the cast would
 * round.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/contract.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/contract.test.ts` at its budget
 *   before, `{ runs: domainRuns, steered: domainRuns }`, each kill's verdict printed with where its witnesses went red
 *   (judgedLine with the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log;
 *   this budget run by path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result each of its 2 kills went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const contractPredicatesRoundALiteralToTheContractsScaleBeforeItsPredicateAsPostgreSQLsDomainCastDoes =
	property.explore(roundingBatch, {
		needs: { evaluator: Substrate.rolledBack(contractEvaluator) },
		situations: [],
		check:
			({ evaluator }) =>
			(batch) =>
				Effect.gen(function* () {
					const { session: db, value: s } = yield* evaluator
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
		oracle: { kind: "postgresql", name: "the domain cast of each literal into numeric(7, 6)" },
		budget: { runs: 1, steered: domainRuns },
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
