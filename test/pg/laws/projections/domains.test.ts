/**
 * `natural` and `pred` against PostgreSQL 19rc2, through the engine's own lowering: the domain a `natural` field is,
 * the STORED generated column a `pred` term is, and the foreign keys between the two, out of pred's column into a
 * natural key and out of a selected side's natural columns into pred's column.
 *
 * A partial term is null outside its definition, pred(x) at x = 0 among them. pred's column is generated as the natural
 * domain's base, int8, as every law column is typed by its base (ir/physical.ts lawColumnType): its value,
 * x - 1 where x > 0, is a natural its generation proves, so the domain's CHECK would only judge it again. 19rc2 would
 * take the domain, since it refuses a domain only to a virtual generated column (catalog/heap.c CheckAttributeType). A
 * box of no slots leaves pred's column null: the last slot's foreign key, out of that column, passes, and marked's,
 * into it, finds no key there, so the box's state is admitted and a slot marked last in it refused.
 *
 * Each case installs the real installation of the schema in a transaction of a pinned session, and writes each of its
 * drawn states whole under a savepoint: one INSERT per relation, the slots successor before predecessor
 * (`successorFirst`), then every deferred constraint checked at once (SET CONSTRAINTS ALL IMMEDIATE), so the verdict is
 * the state's whichever foreign keys the installation defers.
 *
 * Oracle, the specification turned into a checker: a state holding a negative count or index is refused as it is
 * written, with a check violation under the natural domain, its boxes' INSERT first; any other is admitted exactly
 * when the host meaning of its laws holds (`broken`), and otherwise refused with a foreign key violation under a
 * constraint the installation maps to one of the laws it breaks.
 *
 * A state is drawn box by box (boxGen), each draw a named, weighted case of the representation: a box absent or present
 * with a count of 0 to 3 or a negative one; its slots a run from 0 covering the count or falling short of it; a gap in
 * the run or none; a mark on no slot, on the count's last or on another; and a slot at a negative index or none. So
 * lawful states and states breaking each law are drawn as often as their weights say, never filtered for.
 *
 * Features: a state admitted, one beside a box of no slots, each law refusing, marked refusing under a box of no slots,
 * and the domain refusing a negative count and a negative index.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import {
	caseGen,
	type DomainFeature,
	inInstallation,
	domainsInstallation,
	judgeState,
	probe,
	situations,
	writerOf
} from "#test/pg/laws/projections/domains.fixtures.ts"
import { assert } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Natural and pred against PostgreSQL admit exactly the states their laws admit, as the real installation lowers them.
 *
 * Its pre-conversion budget: runs 40, coverage cases 40 (test/pg/laws/projections/domains.test.ts at d8eed1786).
 */
export const naturalAndPredAgainstPostgreSQLAdmitExactlyTheStatesTheirLawsAdmitAsTheRealInstallationLowersThem =
	property.explore(caseGen, {
		needs: { substrate2: Substrate.installing },
		situations: situations satisfies ReadonlyArray<Reached<DomainFeature>>,
		check:
			({ substrate2 }, c: Case<DomainFeature>) =>
			(drawnStates) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						return yield* Effect.scoped(
							Effect.gen(function* () {
								const installation = yield* domainsInstallation
								const pinned = yield* substrate.admin.pin
								const writer = writerOf(installation)
								const problems: Array<string> = []
								yield* inInstallation(
									pinned,
									installationSql(installation, substrate.database),
									Effect.gen(function* () {
										for (const state of drawnStates) {
											const verdict = yield* probe(pinned, writer.state(state))
											const judged = judgeState(
												installation.constraintToLaw,
												writer.laws,
												state,
												verdict
											)
											appendAll(problems, judged.problems)
											c.noteAll(judged.reached)
										}
									})
								)
								assert.deepEqual(problems, [])
							})
						)
					}),
					Substrate,
					substrate2
				),
		oracle: {
			kind: "specification",
			name: "the laws' host meaning over each drawn state (broken), pred(x) x - 1 above zero, and the natural domain refusing a negative value"
		},
		budget: { runs: 40, steered: 40 },
		kept: [],
		kills: []
	})
