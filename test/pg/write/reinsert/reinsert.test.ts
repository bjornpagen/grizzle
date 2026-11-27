import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import {
	addedOf,
	type CallFacts,
	judgeRefused,
	type Laws,
	ownerMutability,
	physicalRows,
	reinsertCases,
	sameWritten,
	type Situation,
	situationOf,
	situations,
	storesExactly,
	targetOf,
	type VerdictLabel,
	verdictLabel
} from "#test/pg/write/reinsert/reinsert.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { againVerdict, differed, unitDelete, unitRelations } from "#test/support/families/again.ts"
import {
	buildFill,
	insertedRelations,
	instanceFacts,
	type InstanceRow,
	relationName,
	rootEntries,
	treeOn,
	uuidOfRow
} from "#test/support/families/fill.ts"
import { installFullWorld } from "#test/support/installed.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { oneFlight } from "#test/support/one-flight.ts"
import { applicationOf, member, openServedDb } from "#test/support/served-db.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A stored instance inserted again answers no-change where every stated row is stored as stated, accepted where it adds rows, and invariant-rejected on the key of a stated row that differs, witnessed by that row's key.
 */
export const aStoredInstanceInsertedAgainAnswersNoChangeWhereEveryStatedRowIsStoredAsStatedAcceptedWhereItAddsRowsAndInvariantRejectedOnTheKeyOfAStatedRowThatDiffersWitnessedByThatRowsKey =
	property.explore(steered(reinsertCases), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ substrate }, c: Case<Situation>) =>
			({ spec, rows, again }) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const built = buildFill(spec)
						const declared = built.rename("Again")
						const done = yield* installFullWorld(declared, {}, [], {
							ambient: ordinarySession,
							label: "again"
						})
						const value = built.rename(done.schema)
						const world = fullWorld(value, {}, [])
						const names = namesOf(done)
						const lawNames = lawNamesOf(value)
						const laws: Laws = {
							reported: names.reported,
							primaryKey: (r: number) => lawNames.primaryKeyLaw({ name: relationName(r) }),
							family: (f: number) =>
								lawNames.lawOf(defined(built.families[f], "a family's statement"))
						}
						const relationAtName = (r: number) =>
							defined(built.relations[relationName(r)], "a relation value")
						const insert = Arr.reduce(insertedRelations(spec), ChangeSet.empty(value), (cs, r) =>
							cs.insert(relationAtName(r), [])
						)
						/** An instance's facts under each relation the insert writes, every one twice where `twice` says. */
						const factsOf = (instance: ReadonlyArray<InstanceRow>, twice: boolean): CallFacts => {
							const facts = instanceFacts(spec, instance)
							return {
								insert: Rec.fromEntries(
									Arr.map(
										insertedRelations(spec),
										(r): readonly [string, ReadonlyArray<unknown>] => {
											const stated = facts.get(r) ?? []
											return [relationName(r), twice ? [...stated, ...stated] : stated]
										}
									)
								)
							}
						}
						/** A replace: each unit relation deleted whole, then every relation a caller writes inserted, one stratum. */
						const units = unitRelations(spec)
						const replace = Arr.reduce(
							insertedRelations(spec),
							Arr.reduce(units, ChangeSet.empty(value), (cs, r) =>
								cs.delete(relationAtName(r), [])
							),
							(cs, r) => cs.insert(relationAtName(r), [])
						)
						/**
						 * The facts a delete of unit rows `ids` names, by relation: a tree's root fields, and any other unit's
						 * written fields, its `id` and `v`, since a unit is no family's member, never the members its insert
						 * nests at a sequence's count field.
						 */
						const unitFacts = (
							stored: ReadonlyArray<InstanceRow>,
							ids: ReadonlyArray<number>
						): Readonly<Record<string, ReadonlyArray<unknown>>> =>
							Rec.fromEntries(
								Arr.map(units, (r): readonly [string, ReadonlyArray<unknown>] => [
									relationName(r),
									Arr.map(
										Arr.filter(stored, (x) => x.relation === r && ids.includes(x.id)),
										(x: InstanceRow): unknown =>
											Option.match(Option.fromUndefinedOr(treeOn(spec, r)), {
												onSome: (f) => Rec.fromEntries(rootEntries(f, x.id)),
												onNone: () => ({ id: uuidOfRow(x.id), v: x.v })
											})
									)
								])
							)
						yield* Effect.gen(function* () {
							const db = yield* openServedDb(done, world.server.roles.app, {})
							const flight = yield* oneFlight(db.ctx, done.as(world.server))
							const loaded = yield* db.load(
								Arr.isReadonlyArrayNonEmpty(units) ? { insert, replace } : { insert }
							)
							/** A call of the member `name`, which the load holds: a replace only where the schema has units. */
							const calledWith = (name: "insert" | "replace") => (callFacts: CallFacts) =>
								applicationOf(
									flight.context,
									member(loaded, name)
								)({ params: {}, facts: callFacts })
							const applied = calledWith("insert")
							const replaced = calledWith("replace")
							const first = yield* flight.judged("the first insert", applied(factsOf(rows, false)))
							assert.equal(
								first.kind,
								rows.length === 0 ? "no-change" : "accepted",
								`the first insert of ${Formatter.format(spec)}`
							)
							yield* storesExactly(done, spec, built.relations, rows, "the first insert")
							let stored = rows
							for (const [i, step] of again.entries()) {
								const label = `insert again ${String(i)} of ${Formatter.format(spec)}`
								const restated = Arr.reduce(step.differences, stored, (at, d) =>
									differed(spec, at, d)
								)
								const deleted = unitDelete(spec, stored, step.units)
								const verdict = againVerdict(spec, deleted.left, restated)
								const identical =
									Arr.isReadonlyArrayNonEmpty(step.units) &&
									verdict.kind === "written" &&
									sameWritten(spec, stored, verdict.rows)
								const physicalBefore = identical ? yield* physicalRows(done, spec) : []
								const outcome = yield* flight.judged(
									label,
									Arr.isReadonlyArrayNonEmpty(step.units)
										? replaced({
												...factsOf(restated, step.twice),
												delete: unitFacts(stored, deleted.units)
											})
										: applied(factsOf(restated, step.twice))
								)
								if (verdict.kind === "refused") {
									judgeRefused(label, spec, restated, outcome, verdict, laws)
									yield* storesExactly(done, spec, built.relations, stored, `the refused ${label}`)
								} else {
									const changed = Arr.isReadonlyArrayNonEmpty(step.units)
										? !sameWritten(spec, stored, verdict.rows)
										: Arr.isReadonlyArrayNonEmpty(verdict.added)
									assert.equal(
										outcome.kind,
										changed ? "accepted" : "no-change",
										`${label}: every stated row is stored as stated, adding ${Formatter.format(Arr.map(verdict.added, (x) => x.id))}${Arr.isReadonlyArrayNonEmpty(step.units) ? ` after deleting the units ${Formatter.format(deleted.units)} whole` : ""}, so it is not ${Formatter.format(outcome)}`
									)
									if (identical) {
										const physicalAfter = yield* physicalRows(done, spec)
										unorderedEqual(
											physicalAfter,
											physicalBefore,
											`${label}: an identical replace writes no row, every row's ctid and xmin kept (README "Families", replace)`
										)
									}
									if (outcome.kind === "accepted" && !Arr.isReadonlyArrayNonEmpty(step.units)) {
										for (const [r] of spec.relations.entries()) {
											const counted = addedOf(outcome, relationName(r))
											assert.equal(
												counted?.added ?? 0n,
												BigInt(Arr.filter(verdict.added, (x) => x.relation === r).length),
												`${label}: ${relationName(r)}'s added rows`
											)
											assert.equal(
												counted?.deleted ?? 0n,
												0n,
												`${label}: an insert deletes nothing`
											)
										}
									}
									yield* storesExactly(done, spec, built.relations, verdict.rows, label)
								}
								const v: VerdictLabel =
									verdict.kind === "written" && Arr.isReadonlyArrayNonEmpty(step.units)
										? sameWritten(spec, stored, verdict.rows)
											? "no-change"
											: "accepted"
										: verdictLabel(verdict)
								const [only, ...more] = step.differences
								if (Arr.isReadonlyArrayNonEmpty(step.units)) {
									c.note(
										only === undefined
											? `a replace of the same units: ${v}`
											: only.kind === "removed" && deleted.units.includes(only.id)
												? `a replace dropping a unit: ${v}`
												: `a replace with a difference: ${v}`
									)
								} else if (only === undefined) {
									c.note(
										step.twice
											? `the same instance stated twice in one call: ${v}`
											: `the same instance again: ${v}`
									)
								} else if (Arr.isReadonlyArrayNonEmpty(more)) {
									c.note("two differences in one insert")
								} else {
									c.note(
										situationOf(
											targetOf(spec, stored, only),
											v,
											ownerMutability(spec, stored, only)
										)
									)
								}
								stored = verdict.kind === "written" ? verdict.rows : stored
							}
						}).pipe(Effect.scoped)
					}).pipe(Effect.scoped),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the README's set rule over relations as sets of facts (test/support/families/again.ts againVerdict), every drawn value the reference writer's (test/support/families/fill.ts writtenRows)"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/reinsert/reinsert.test.ts#aStoredInstanceInsertedAgainAnswersNoChangeWhereEveryStatedRowIsStoredAsStatedAcceptedWhereItAddsRowsAndInvariantRejectedOnTheKeyOfAStatedRowThatDiffersWitnessedByThatRowsKey:-:8.0.0.0.1.1.0.0.0.3.0.0.1.0.0.3.0.1.0.1.0.1.0.0.0.1.0.1.0.0.0.0.0.0.0.0.1.0.1.1.1.0"
				),
				reason:
					"a counted member of a closed owner renamed: R1 a member of three counted families of the closed R0, member 2 stored at slot 0 of owner 1's groups, inserted again as member 3 beside owner 1 restated, which the host draws at slot 0 with the stored count. The oracle accepted it, adding member 3, where the README refuses a member joining a stored closed owner's family on the family's rule alone, witnessed by the member's key; the slot key refused it with no witness, the host's facts naming no drawn slot",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "test/support/families/again.ts",
				original: "\t\t\t\t\t\t!relationAt(spec, f.owner).mutable &&\n",
				replacement: "\t\t\t\t\t\tfalse &&\n",
				why: "The oracle's old verdict: a new counted member under a stored closed owner is added, so the kept case expects accepted, adding member 3, where the insert is refused on the family's rule."
			},
			{
				file: "packages/engine/src/write/family/additions.ts",
				original: '\t\t\t\t\tonConflict: { kind: "every", action: { kind: "doNothing" } },',
				replacement:
					'\t\t\t\t\tonConflict: { kind: "columns", columns: mapNonEmpty(relation.primaryFields, (f) => w.names.column(name, f.name)), action: { kind: "doNothing" } },',
				why: "The member insert arbitrates its primary key alone, as before main's ruling on reinsert's round trips: the kept case's new member meets the stored closed owner's member at the family's slot key, a 23505 the statement does not judge, refused with the host's witness, unreported, since no stated row names the hidden index, where the statement names the member's key."
			},
			{
				file: "packages/engine/src/write/family/additions.ts",
				original: "\t\t: source.walked.has(key) || computes(source.stamps, key)",
				replacement: "\t\t: true",
				why: "A nested row states every column, the counts and ends of the counted families it owns among them, which a nested write never states and its stored group holds: a stored tree node inserted again beside a new member of the counted family it owns meets its stored row at its count and is refused on its key where it appends (1ad6e4df9, the defect KEYSTRESS's G4, this property, found)."
			}
		]
	})
