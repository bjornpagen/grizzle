/**
 * A text's bytes have one proof in every mode (scalar/compute/typing.ts textBytes): its type's byte bound, or the
 * Logic.when whose guard bounds Text.octetLength of it, at every occurrence of the text in the guard's branch. A
 * query reads Text.octetLength, which is total, so a query matches a text whose type bounds no bytes inside such a
 * guard, as a check does, and PostgreSQL reads the match only where the guard holds, the when being a CASE.
 *
 * - Over a batch of texts of one family, some within the guard's bytes and some past them, in one round trip: the
 *   guarded match, lowered as a query's predicate over text whose type bounds no bytes, is admitted, and PostgreSQL's
 *   answer on each row is the host evaluator's (scalar/compute/evaluate.ts) and the reference evaluator's
 *   (test/support/oracle/evaluate/catalog.ts): the match's own within the bound, and the program's false past it.
 *
 * Oracle: the host evaluator and the reference evaluator, the second the catalogue's specification over grizzle's own
 * automaton of the pattern.
 *
 * Features: a match held and failed within the bound, and a text past it.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	type BoundedCase,
	type BoundedFeature,
	boundedCase,
	boundedFeatures,
	loweredInQuery,
	withinBound
} from "#test/pg/text/bounded.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { values } from "#test/support/unit/compute/text.fixtures.ts"

/** The text PostgreSQL prints a boolean as. */
const printed = (value: unknown): string => (value === true ? "true" : "false")

/**
 * In a query, a match of a text whose type bounds no bytes, guarded by a bound on its octetLength, is admitted, and PostgreSQL answers each row as the host evaluator and the reference do: the match within the bound, the program's false past it.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/text/bounded.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/text/bounded.test.ts` at its budget before,
 *   the runner's, runs 150 and steered 200, each kill's verdict printed with where its witnesses went red (judgedLine
 *   with the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget
 *   run by path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const inAQueryAMatchOfATextWhoseTypeBoundsNoBytesGuardedByABoundOnItsOctetLengthIsAdmittedAndPostgreSqlAnswersEachRowAsTheHostEvaluatorAndTheReferenceDo =
	property.explore(boundedCase, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: boundedFeatures,
		check:
			({ tx }, k: Case<BoundedFeature>) =>
			(c: BoundedCase) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					const { expr, sql } = loweredInQuery(c)
					const rows = yield* db.values(
						`SELECT (${sql})::text FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, v text) ORDER BY r0.ord`,
						[jsonText(Arr.map(c.texts, (v, ord) => ({ ord, v })))]
					)
					assert.equal(rows.length, c.texts.length, "a row per text")
					for (const [i, [answer]] of rows.entries()) {
						const text = defined(c.texts[i], `text ${i}`)
						const { host, reference } = values(expr, new Map([["v", text]]))
						const shown = `/${c.pattern}/u within ${c.bytes} bytes over ${Formatter.format(text)}`
						assert.equal(answer, printed(host), `${shown}: PostgreSQL against the host evaluator`)
						assert.equal(answer, printed(reference), `${shown}: PostgreSQL against the reference`)
						k.note(
							!withinBound(text, c.bytes)
								? "a text past the bound, the program's false"
								: answer === "true"
									? "a match held within the bound"
									: "a match failed within the bound"
						)
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the host evaluator and the reference evaluator over grizzle's own automaton"
		},
		budget: { runs: 1, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: '\t\t\t\tif (desc.fn === "charLength") {\n',
				replacement: "\t\t\t\t{\n",
				why: "octetLength refused in a query, as before: the guard that proves a text's bytes stands only in checks, so a query refuses the guarded match over text of no byte bound."
			}
		]
	})
