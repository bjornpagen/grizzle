/**
 * A rule over the mutable relations of one declared unit is judged whole over the units a transaction wrote
 * (analysis/theory/unit.ts wholeRule): every write of their rows borrows the unit at their key exclusively, so the rows
 * the judge reads at a unit its transaction wrote are its own until it commits, and an update of a column a rule reads
 * is captured as any write of its side is. Over the rows of two units, two borrows, the rule is probed. On PostgreSQL
 * 19, Presence(child, slot, score) and its seat, both mutable: Seat in the learner's unit, keyed by its child first, or
 * its twin Bench, keyed by its pupil in a unit of its own (rule-open-unit.fixtures.ts); under Seated, every presence at
 * a seat, a foreign key; Present, a scored presence at an open seat, a containment between selected sides; and Capped,
 * a check over their join that a presence scores at most its seat's cap.
 *
 * Each case writes a lawful state of two children, then one to four writes by direct SQL, each a put (INSERT ... ON
 * CONFLICT DO UPDATE), an UPDATE or a DELETE of one row, in one transaction rolled back after, the judge run (SET
 * CONSTRAINTS ALL IMMEDIATE) after each and the constraints deferred again before the next.
 *
 * Oracle: the laws restated over the state the writes leave, kept apart from PostgreSQL: the transaction refuses
 * exactly when a presence stands at no seat, at a closed seat with a score, or past its seat's cap, under an integrity
 * SQLSTATE, and under a rule's name where one judged whole refuses; each rule's check over every row, the one a
 * migration runs, finds a row exactly where its violation query lowered by the oracle baseline does.
 *
 * Features: judged whole in one unit, probed across two; each write accepted, and each that can break a law refused.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { recorded } from "@bjornpagen/testing/gen"
import { property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	keptOpen,
	openCaseGen,
	type OpenFeature,
	openFeatures,
	openTemplates,
	runOpen
} from "#test/pg/laws/rule-open-unit.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A rule over one unit's mutable relations is judged whole, over two units' probed, and either refuses exactly the
 * writes, updates and deletes among them, whose state breaks a law.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aRuleOverOneUnitsMutableRelationsIsJudgedWholeAndRefusesExactlyTheWritesUpdatesAndDeletesAmongThemWhoseStateBreaksALaw =
	property.explore(recorded(openCaseGen, keptOpen), {
		needs: Substrate.oneOf(openTemplates, Substrate.rolledBack),
		situations: openFeatures satisfies ReadonlyArray<Reached<OpenFeature>>,
		check: (installed, c) => (drawn) =>
			Effect.gen(function* () {
				const { connection, value } = yield* installed[drawn.shape]
				yield* runOpen(value, connection, drawn, c)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the laws restated over the state the writes leave: the transaction refuses exactly when a presence stands at no seat, at a closed seat with a score, or past its seat's cap"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/laws/rule-open-unit.test.ts#aRuleOverOneUnitsMutableRelationsIsJudgedWholeAndRefusesExactlyTheWritesUpdatesAndDeletesAmongThemWhoseStateBreaksALaw:-:1"
				),
				reason:
					"a seat's cap lowered in place under a presence's score, its key and openness as they were: the update no side of olds captures, which a witness of the seat through Seated would read as no replacement",
				since: "2026-11-23"
			},
			{
				token: ReplayToken(
					"test/pg/laws/rule-open-unit.test.ts#aRuleOverOneUnitsMutableRelationsIsJudgedWholeAndRefusesExactlyTheWritesUpdatesAndDeletesAmongThemWhoseStateBreaksALaw:-:2"
				),
				reason:
					"an open seat closed in place under a scored presence: Present, judged whole, is broken through the seat's old row alone, the side of what a write removes at its target's negative occurrence, which no other law of the shape reads",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: '\t\t\treturn ["removed"]',
				replacement: "\t\t\treturn []",
				why: "A whole rule's region holds no unit a write removed rows of at a negative occurrence: an open seat closed in place under a scored presence is judged by no region of Present, and the transaction that breaks it commits."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: '\tp === "positive" ? "negative" : p === "negative" ? "positive" : "both"',
				replacement: "\tp",
				why: "A relation a containment's target reads keeps its polarity under the rule's negation, read on its side of news alone at the target's conditions: a seat closed in place leaves no new row open, so Present's region holds no unit, and the transaction that breaks it commits."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: '\tif (r.polarity !== "positive" || n?.kind !== "relation" || n.mutable) {',
				replacement: '\tif (r.polarity !== "positive" || n?.kind !== "relation") {',
				why: "A mutable seat updated in place is proved by Seated's witness as a seat replaced would be, so Capped's region reads a seat a transaction gained only where it lost one at its key, and the side of olds holds no update of a cap, which no negated read reads: a cap lowered under a presence's score commits."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\tconditions.push(mapLeaves(c, leaves))",
				replacement: '\t\t\tconditions.push({ kind: "not", arg: mapLeaves(c, leaves) })',
				why: "The region keeps the written rows an occurrence's conditions refuse in place of those it reads, so Present's units are read at the presences of no score a transaction wrote and the seats it closed, never at a scored presence written or a seat it opened, and a presence that scores at a closed seat commits."
			}
		]
	})
