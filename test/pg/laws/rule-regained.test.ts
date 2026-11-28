/**
 * A target's negation of a relation R whose withdrawn facts a sibling arm regains by the clock emits nothing
 * (analysis/theory/query.ts regainedBy, the clock's class): a probe of the rows R gains reads no occurrence of R under a
 * negation of an arm of a containment's target where a sibling arm reads that arm's every match, condition and other
 * negation, delivers its facts, and reads R at exactly the negation's fields beside clocks of R stated no earlier than
 * a clock of the arm's matches of the same scope at the same key, which every writer's stamp makes true of a row R gains
 * (ir/instant.ts scopeOrder, physical/ddl/clocked.ts). qti-pie's "Inside a candidate session" read every response of a
 * sitting again at its end (edullm Q10: 2,256 pages at submit); its ended arm reads the end's kind too, so it stays
 * read, as Within here does, until it states the arm at the negation's fields alone.
 *
 * On PostgreSQL 19, over Regained (rule-regained.fixtures.ts): a sitting's closed rows in the unit of the sitting, one
 * clock ordering its ends and responses, and two containments of the responses the judge probes: into Inside, whose
 * ended arm reads the end at the negation's fields and its instant, and into Within, whose ended arm reads the end's
 * kind too.
 *
 * - **regained**: a schedule of direct SQL transactions at SERIALIZABLE, each stamping its instants, each judged at its
 *   end against each rule's whole check (its violation query over every fact, lowered by the oracle baseline, which
 *   reads no delta), the oracle of the elision: the judge and the foreign keys refuse exactly the states a law breaks,
 *   and commit the others. And Snap ⊆ Inside reads no row End gains, its regain recorded, while Snap ⊆ Within reads them
 *   (rule-regained.fixtures.ts `coverage`). Each situation is required, a constructed case aiming at each.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	coverage,
	regainedFeatures,
	regainedSpace,
	regainedTemplate,
	runSchedule
} from "#test/pg/laws/rule-regained.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** A negation of a target's arm that a sibling regains by the clock is read by no probe, and the judge breaks no verdict. */
export const aTargetsNegationASiblingArmRegainsByTheClockIsReadByNoProbe = property.explore(
	regainedSpace,
	{
		needs: { regained: Substrate.fresh(regainedTemplate) },
		situations: regainedFeatures,
		check:
			({ regained }, c) =>
			(schedule) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* regained
					coverage(value)
					const session = yield* substrate.session({ ...ownerSession(), label: "regained" })
					yield* runSchedule(value, session, schedule, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "each rule's whole check, its violation query lowered by the oracle baseline, read on the state: the judge refuses exactly the states one finds broken; and Snap ⊆ Inside reads no row End gains, Snap ⊆ Within reads them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					'\t\t\tif (e.kind !== "var" || bound.has(e.var) || order === undefined) {\n\t\t\t\treturn false\n\t\t\t}',
				replacement:
					'\t\t\tif (e.kind !== "var" || bound.has(e.var) || order === undefined) {\n\t\t\t\treturn true\n\t\t\t}',
				why: "A sibling regains through R read at more fields than the negation: Within's ended arm, reading the end's kind, is taken to regain its open arm's loss, so no probe reads the rows End gains, and an end of kind 0 under a response that stood is accepted."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: '\t\tyields === "negative" && memo.regained(arms, arm, n) !== undefined',
				replacement: "\t\tfalse && memo.regained(arms, arm, n) !== undefined",
				why: "No negation regained: Snap ⊆ Inside reads every row End gains, every response of the session again at its end, though its ended arm regains each."
			}
		]
	}
)
