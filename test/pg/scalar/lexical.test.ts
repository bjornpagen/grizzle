/**
 * The parse on PostgreSQL 19: for every candidate text (test/support/lexical.ts), the host and the database agree on
 * whether the text is a member of its target's lexical form and on the value it names.
 *
 * - **Membership:** PostgreSQL's verdict on the form's ARE, the translation the text analysis gives str.regex domains
 *   and Text.matches (text/refinement.ts), and on its octet_length within the form's byte bound where it has one,
 *   equals the host scan's (scalar/lexical.ts lexicalValue), which the unit suite holds to the form's pattern and to
 *   the specification.
 * - **Value:** where PostgreSQL finds a member, the parse grizzle prints (the cast `t::T`, numeric's typmod included,
 *   plain numeric for a decimal text, and for a date make_date over the text's parts, sql/lexical.ts) reads to the
 *   host's value: an integer, a decimal by equality, a double exactly (PostgreSQL's float8in against the host's
 *   rational rounding, half to even), a boolean, and a date by its day number after 0001-01-01, so no DateStyle enters
 *   the comparison.
 * - **No DateStyle:** the session runs under DateStyle `SQL, DMY`, so a parse that read the session's date order
 *   (date_in, text::date) would read 2024-03-04 as another day; make_date reads none.
 * - **No raise:** every member parses without an error, which a raise would make the batch's statement fail; the
 *   parse runs only under its membership's CASE, as a guarded law column or Logic.when runs it.
 *
 * Oracle: PostgreSQL itself, the form's ARE and the printed parse. Bound: batches of up to 160 candidates of every
 * target, 300 batches a run.
 *
 * Features: every candidate shape of test/support/lexical.ts.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { lexicalValue } from "#compiler/scalar/lexical.ts"
import {
	agrees,
	areOf,
	memberSql,
	parseSql,
	roundDouble,
	targetKey
} from "#test/pg/scalar/lexical.fixtures.ts"
import { type Candidate, candidateGen, type Shape, shapes } from "#test/support/lexical.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Lexical parse: the host and PostgreSQL 19 agree on every candidate's membership in its form and on the value its parse reads, under a foreign DateStyle.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/scalar/lexical.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/scalar/lexical.test.ts` at its budget before,
 *   `{ runs: 300, steered: 300 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the
 *   red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path
 *   in run-budgets.log there
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
export const lexicalParseTheHostAndPostgreSQL19AgreeOnEveryCandidatesMembershipInItsFormAndOnTheValueItsParseReadsUnderAForeignDateStyle =
	property.explore(array(candidateGen, { min: 1, max: 160 }), {
		needs: { tx: Substrate.transaction },
		situations: shapes satisfies ReadonlyArray<Reached<Shape>>,
		budget: { runs: 1, steered: 300 },
		check:
			({ tx }, c: Case<Shape>) =>
			(batch) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					yield* db.query("SET DateStyle = 'SQL, DMY'", [])

					const groups = Arr.groupBy(batch, (x) => targetKey(x.target))
					for (const group of Rec.values(groups)) {
						const target = defined(group[0], "a group's first candidate").target
						const rows = yield* db.values(
							`SELECT (${memberSql(target)})::text,
										        CASE WHEN ${memberSql(target)} THEN ${parseSql(target)} END
										 FROM unnest($1::text[]) WITH ORDINALITY AS u(t, i) ORDER BY u.i`,
							[Arr.map(group, (x: Candidate) => x.text), areOf(target)]
						)
						assert.equal(rows.length, group.length, targetKey(target))
						for (const [i, row] of rows.entries()) {
							const x = defined(group[i], "a row's candidate")
							c.note(x.shape)
							const label = `${targetKey(target)} ${Formatter.format(x.text)}`
							const host = lexicalValue(target, x.text, roundDouble)
							const member = row[0] === "true"
							assert.equal(member, host !== undefined, `${label}: membership`)
							if (member) {
								const text = row[1]
								assert.ok(
									typeof text === "string" && agrees(target, text, host),
									`${label}: PostgreSQL read ${Formatter.format(text)}, the host ${Formatter.format(host)}`
								)
							}
						}
					}
				}),
		oracle: {
			kind: "postgresql",
			name: "the form's ARE and the printed parse, run under DateStyle SQL, DMY"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/lexical.ts",
				original: '\t\t\treturn text === "true" || text === "1"',
				replacement: '\t\t\treturn text === "true"',
				why: 'The host\'s boolean parse reads "1" as no member.'
			}
		]
	})
