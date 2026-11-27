/**
 * A one-row write's upkeep of a stored relation reads the rows its delta reaches, however many rows its stored unit
 * holds: the upkeep of a definition over holders a write only inserts into is its delta program (analysis/theory/
 * upkeep.ts), each rule of the definition read from the written row outward along the keys it binds, a computed key
 * among them, and its facts inserted by its table's primary key (physical/ddl/rules.ts upkeepBlock), never the sitting
 * it lies in re-derived. On PostgreSQL 19, over UpkeepFlat (upkeep-flat.fixtures.ts): a learner's sitting, its
 * candidate sessions, suspensions, presentations and end, closed, in the learner's unit; and Order, the ledger's
 * SittingOrder in the box's terms, stored at the sitting.
 *
 * Each case stores a sitting of a few candidate sessions, the last open, committed, and measures the judge's work at a
 * one-row write's COMMIT, explained with ANALYZE before the judge runs, in a transaction rolled back
 * (test/support/judge.ts judgeRun); then grows the sitting tenfold, committed, and measures the same write again, at the
 * new open session. No planner setting: the installation's declared statistics rank every lookup's index at any size.
 *
 * Oracle: invariance: each statement reads the same rows, of the holders, of Order and of the deltas, beside the few
 * sessions and beside ten times as many, the rows counted over every loop, never a clock; and no upkeep statement
 * anti-joins Order's table, whose rows its insert meets by its primary key's index.
 *
 * The box, exhausted: a resumption, a suspension or a presentation; one or four sessions, then ten times as many; one or
 * three presentations a session.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type FlatFeature,
	type FoundFeature,
	flatGen,
	foundFlatTemplate,
	foundGen,
	type LostFeature,
	lostFlatTemplate,
	lostGen,
	runFlat,
	runFound,
	runLost,
	upkeepFlatTemplate
} from "#test/pg/derived/upkeep-flat.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** A one-row write's upkeep of a stored relation over insert-only holders reads the same rows however long its sitting. */
export const aOneRowWritesUpkeepReadsTheSameRowsHoweverManyRowsItsStoredUnitHolds =
	property.exhaust(finite(flatGen), {
		needs: { flat: Substrate.fresh(upkeepFlatTemplate) },
		situations: [
			"the upkeep of Order ran at a visit",
			"the upkeep of Order ran at a suspension",
			"the upkeep of Order ran at a presentation"
		] satisfies ReadonlyArray<Reached<FlatFeature>>,
		check:
			({ flat }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* flat
					const session = yield* substrate.session({ ...ownerSession(), label: "upkeep flat" })
					yield* runFlat(value, session, drawn, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "universal",
			name: "invariance: each statement the judge runs at a one-row write's COMMIT reads the same rows beside a few sessions of its sitting and beside ten times as many, and no upkeep statement anti-joins its stored table"
		},
		box: "a resumption, a suspension or a presentation; one or four sessions, then ten times as many; one or three presentations a session",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/upkeep.ts",
				original: "\tconst c = classOf(u)\n",
				replacement: '\tconst c: UpkeepClass = { kind: "other" }\n',
				why: "Every stored relation is kept by its unit form, its upkeep re-deriving the sitting a write touched: Order's DELETE and INSERT read every session of the sitting, ten times as many beside the second measure."
			},
			{
				file: "packages/engine/src/analysis/theory/upkeep.ts",
				original: "\t\t\treturn gained.map((rule) => withSolved(rule, u.fieldOf))",
				replacement: "\t\t\treturn gained",
				why: "A gained rule states no computed equality solved: a visit of session k + 1 reads the sitting's every suspension and keeps the one at k by `k + 1 = next.k`, where `k = next.k - 1` probes the suspension's key, so a resumption's upkeep reads ten times the suspensions beside ten times the sessions."
			}
		]
	})

/**
 * A publish's upkeep of a stored relation over a sealed unit derives each of its facts once: its upkeep is the unit
 * form's (analysis/theory/upkeep.ts `founded`), its definition read at the units the publish founded, whose delta is
 * the whole package, never a delta program, which reads the publish's rows again from each occurrence. On PostgreSQL
 * 19, over FoundFlat (upkeep-flat.fixtures.ts): a package's nodes and their attributes, closed, in the package's sealed
 * unit, and Named, each attribute beside its node's kind, stored at the package's nodes.
 *
 * Oracle: the plan's shape: Named's upkeep is one removal loop and one INSERT, and the INSERT's source produces exactly the
 * rows of Named's facts, each once, counted over every loop, never a clock.
 *
 * The box, exhausted: one or eight nodes, one or three attributes each.
 */
export const aPublishsUpkeepOfAStoredRelationOverASealedUnitDerivesEachOfItsFactsOnce =
	property.exhaust(finite(foundGen), {
		needs: { found: Substrate.fresh(foundFlatTemplate) },
		situations: [
			"the upkeep of Named ran at a publish of 1 attributes a node",
			"the upkeep of Named ran at a publish of 3 attributes a node"
		] satisfies ReadonlyArray<Reached<FoundFeature>>,
		check:
			({ found }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* found
					const session = yield* substrate.session({ ...ownerSession(), label: "found flat" })
					yield* runFound(value, session, drawn, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "universal",
			name: "the plan's shape: a publish's upkeep of a stored relation over a sealed unit is one removal loop and one INSERT whose source produces each of its facts once"
		},
		box: "one or eight nodes, one or three attributes each",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/upkeep.ts",
				original: '\tif (u.founded) {\n\t\treturn { kind: "founded" }\n\t}\n',
				replacement: "",
				why: "A stored relation over a sealed unit is kept by a delta program where its definition is monotone: a publish's upkeep reads the package's nodes and joins each node's attributes, then reads its attributes and joins each one's node again, every fact derived twice."
			}
		]
	})

/**
 * A one-row write's upkeep of a stored relation kept by its checked form reads the rows its delta reaches, however many
 * sessions its sitting holds, and each fact it withdraws is found and checked by index probes alone
 * (analysis/theory/upkeep.ts `checked`): the candidate read at the stored table's key, its definition read at the fact,
 * one probe of a key for each occurrence of each rule, the closure from its head. On PostgreSQL 19, over LostFlat
 * (upkeep-flat.fixtures.ts): a learner's sitting, its candidate sessions, suspensions, end and presentations, open, in
 * the learner's unit, beside the learner's cohort; Open, each visit no suspension ended of a sitting not ended,
 * AssignmentStatus's shape, kept by its checked form; Suspended, each suspended visit with its suspension's instant and
 * the learner's cohort, unit-local at the learner alone, kept by its checked form, whose removed visit or suspension
 * reads the facts it may withdraw from Suspended's own table at the session (analysis/theory/query.ts lostFacts); and
 * Waiting, the sittings with a session no suspension ended, which its head reaches at no key of the visit, kept by the
 * unit form.
 *
 * Each case stores a sitting of a few sessions, the last open, committed, and measures the judge's work at a one-row
 * write's COMMIT, explained with ANALYZE before the judge runs, in a transaction rolled back; then grows the sitting
 * tenfold, committed, and measures the same write again at the new open session. No planner setting.
 *
 * Oracle: invariance and the plan's shape: each statement of a checked form's upkeep reads the same rows beside the few
 * sessions and beside ten times as many, counted over every loop, never a clock; and its removal reads at most one row
 * a loop of every table, kept or filtered: one probe of the stored table's key for each candidate and one of a key for
 * each occurrence its check reads, Open's and Suspended's tables holding one fact at each of a thousand other sittings
 * for each session of the measured one.
 *
 * The box, exhausted: a suspension, a visit, a visit's delete, a suspension's delete or a visit's move; two or four
 * sessions, then ten times as many; one or three presentations a session. A sitting's end is no row of it: its lost
 * rule reads the sitting's visits (upkeep-flat.fixtures.ts lostWrites).
 */
export const aCheckedUpkeepReadsTheRowsItsWriteReachesAndChecksEachFactLostByProbesAlone =
	property.exhaust(finite(lostGen), {
		needs: { lost: Substrate.fresh(lostFlatTemplate) },
		situations: [
			"the checked upkeep of Open ran at a suspension",
			"the checked upkeep of Open ran at a visit",
			"the checked upkeep of Open ran at a visit's delete",
			"the checked upkeep of Open ran at a suspension's delete",
			"the checked upkeep of Open ran at a visit's move"
		] satisfies ReadonlyArray<Reached<LostFeature>>,
		check:
			({ lost }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* lost
					const session = yield* substrate.session({ ...ownerSession(), label: "lost flat" })
					yield* runLost(value, session, drawn, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "universal",
			name: "invariance and the plan's shape: each statement of a checked upkeep reads the same rows beside a few sessions and beside ten times as many, and its removal reads at most one row a loop of every table"
		},
		box: "a suspension, a visit, a visit's delete, a suspension's delete or a visit's move; two or four sessions, then ten times as many; one or three presentations a session",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/upkeep.ts",
				original: "\tconst unreached = unreachedRule(d)\n",
				replacement: "\tconst unreached = undefined\n",
				why: "A definition its head reaches at no key of a match is kept by the checked form: Waiting's check of a sitting a suspension touched reads every visit of the sitting for one no suspension ended, ten times as many beside the second measure."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					"\tconst fact = Object.fromEntries(\n\t\theading.map((f) => [f, free.includes(f) ? varRef(id(f)) : defined(derived[f], f)] as const)\n\t)\n\treturn {\n\t\tfact,\n\t\tvars: free.map((f) => ({ id: id(f), origin: { relation: stored.relation, field: f }, loc })),\n",
				replacement:
					"\tconst fact = Object.fromEntries(\n\t\theading.map((f) => [f, free.includes(f) || !stored.unit.includes(f) ? varRef(id(f)) : defined(derived[f], f)] as const)\n\t)\n\treturn {\n\t\tfact,\n\t\tvars: heading.filter((f) => free.includes(f) || !stored.unit.includes(f)).map((f) => ({ id: id(f), origin: { relation: stored.relation, field: f }, loc })),\n",
				why: "A lost candidate read from the stored table at the learner alone: a visit's or a suspension's delete reads every Suspended fact of the learner, each checked at the fact, where it reads the one at the session, ten times as many beside the second measure."
			}
		]
	})
