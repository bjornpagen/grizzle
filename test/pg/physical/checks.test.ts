/**
 * The predicate CHECKs of the real installer admit exactly what their declarations mean (checks.ts).
 *
 * Each case declares one CHECK of every predicate class over a small schema, its thresholds and the closed facts drawn:
 * - a row check, `check("AtLeast", Gauge, level >= k)` (a law model TableCheck);
 * - a closed check, the containment of Mark's (grade, score) in GradeScore's (grade, score) rows, a closed relation
 *   over the roster Grade (a ClosedCheck);
 * - a contract's predicate, `Level` between lo and hi, as the domain's CHECK on a plain column, and as the endpoint
 *   CHECK of a span over Level, the predicate over the lower and then the upper endpoint (physical/span/storage.ts);
 * - a text refinement, `^[ab]{1,2}$`, as its text domain's CHECK on a plain column, probed with checks.ts textProbes
 *   and judged by the declared pattern as the JavaScript engine reads it;
 * - money constants: a contract `Fee` over money, at least a drawn amount, as its domain's CHECK, and a key over the
 *   charges selected at a drawn tip, `key(on(select(Charge, tip = t), account))`, whose law column's expression holds
 *   the constant. A STABLE cast in the law column's expression is refused by the installation itself.
 *
 * The real installation runs in a transaction on a pinned session, and every probe row is inserted under a savepoint:
 * the server must admit a row exactly when the host meaning holds and refuse every other with 23514 naming that
 * declaration's CHECK, or 23505 naming the key's UNIQUE for a second charge of an account at the selected tip. Beside
 * the drawn probes, each case adds rows on both sides of every predicate, the span's upper endpoint failing alone among
 * them, so a run judges each class both ways. Each case then installs again without one drawn class's CHECK, that CHECK
 * alone under its own table or domain, and requires the same judge to find the defect: the property discriminates every
 * class.
 *
 * Features: each predicate class judged both ways and each class's CHECK dropped.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type CheckFeature,
	checksOf,
	inInstallation,
	installationOf,
	judgeCase,
	plantedGen,
	plantedSchema,
	situations,
	withoutCheck
} from "#test/pg/physical/checks.fixtures.ts"
import { assert } from "#test/support/assert.ts"
import { filledStatements, installationSql } from "#test/support/compile.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The predicate CHECKs of the real installer admit exactly what each declaration means, and the judge finds any one class's CHECK dropped.
 *
 * Its pre-conversion budget: runs 40, coverage cases 40 (test/pg/physical/checks.test.ts at d8eed1786).
 */
export const thePredicateCHECKsOfTheRealInstallerAdmitExactlyWhatEachDeclarationMeansAndTheJudgeFindsAnyOneClasssCHECKDropped =
	property.explore(plantedGen, {
		needs: { substrate2: Substrate.installing },
		situations: situations satisfies ReadonlyArray<Reached<CheckFeature>>,
		check:
			({ substrate2 }, c: Case<CheckFeature>) =>
			(p) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						return yield* Effect.scoped(
							Effect.gen(function* () {
								const s = plantedSchema(p)
								const installation = yield* installationOf(s)
								const pinned = yield* substrate.admin.pin
								const intact = yield* inInstallation(
									pinned,
									installationSql(installation, substrate.database),
									judgeCase(pinned, installation, s, p)
								)
								c.noteAll(intact.reached)
								assert.deepEqual(intact.problems, [])
								/**
								 * The same judge over the installation without one class's CHECK, that CHECK alone under
								 * its own table or domain: it must find a probe the server now judges otherwise.
								 */
								const dropped = checksOf(installation, s)[p.dropped]
								const mutant = yield* inInstallation(
									pinned,
									filledStatements(
										withoutCheck(installation.statements, dropped),
										substrate.database
									),
									judgeCase(pinned, installation, s, p)
								)
								assert.ok(
									mutant.problems.length > 0,
									`the ${p.dropped} CHECK ${dropped.name} of ${dropped.owner.kind} ${dropped.owner.name} dropped went unnoticed`
								)
								c.note(`dropped ${p.dropped} found`)
							})
						)
					}),
					Substrate,
					substrate2
				),
		oracle: {
			kind: "second-implementation",
			name: "each declaration's meaning stated on the host, and the dropped CHECK's class planted"
		},
		budget: { runs: 40, steered: 40 },
		kept: [],
		kills: []
	})
