/**
 * A row a containment's source loses opens no fact through a target that reads the source at its key
 * (analysis/theory/unit.ts withdrawnAlone): a whole rule's region reads no row a write removes at a negative occurrence
 * of a relation B whose root requires a row of B at the same key, positively, since the fact the removed row would open
 * needs a row of B at that key after the write, which the write must have given B, a row the region reads where B gains
 * it. Such as metis's Assignment ⊆ AssignmentStatus, whose status of a sitting with no event reads Assignment at the
 * containment's fields (METIS-PERFBAR): every write touching a sitting read the assignments it deleted for nothing.
 *
 * On PostgreSQL 19, over Withdrawn (rule-withdrawn.fixtures.ts): mutable assignments and their sittings' events, in the
 * unit of the child, and two containments of the assignments the judge holds whole: into Status, which reads Assignment
 * at its key, and into Started, which reads Event and no row of Assignment, each target read live (Noted, an aggregate).
 *
 * - **withdrawn**: a schedule of direct SQL transactions at SERIALIZABLE, each judged at its end against each rule's
 *   whole check (its violation query over every fact, lowered by the oracle baseline, which reads no delta), the oracle
 *   of the elision: the judge refuses exactly the states a rule breaks, naming one it breaks, and commits the others.
 *   And no capture writes the rows Assignment loses, while one writes the rows Event loses, which Started reads
 *   (rule-withdrawn.fixtures.ts `coverage`). Each situation is required, a constructed case aiming at each.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	coverage,
	runSchedule,
	withdrawnFeatures,
	withdrawnSpace,
	withdrawnTemplate
} from "#test/pg/laws/rule-withdrawn.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** The judge reads no row a containment's source loses where its target reads the source at its key, and breaks no verdict. */
export const aRowAContainmentsSourceLosesIsReadByNoJudgeWhereItsTargetReadsTheSourceAtItsKey =
	property.explore(withdrawnSpace, {
		needs: { withdrawn: Substrate.fresh(withdrawnTemplate) },
		situations: withdrawnFeatures,
		check:
			({ withdrawn }, c) =>
			(schedule) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* withdrawn
					coverage(value)
					const session = yield* substrate.session({ ...ownerSession(), label: "withdrawn" })
					yield* runSchedule(value, session, schedule, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "each rule's whole check, its violation query lowered by the oracle baseline, read on the state: the judge refuses exactly the states one finds broken, naming a law it finds broken; and no capture of the rows Assignment loses, one of the rows Event loses"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\t\tif (side === "removed" ? closed || withdrawn.has(place) : proofs.has(place)) {',
				replacement: '\t\t\tif (side === "removed" ? closed : proofs.has(place)) {',
				why: "The judge reads the rows a containment's source loses again: Assignment ⊆ Status captures every assignment a write deletes and reads its unit, though no fact opens there (METIS-PERFBAR's olds_assignment)."
			}
		]
	})
