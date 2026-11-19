import { assert, deepEquals, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { schema } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import {
	at,
	classesOf,
	distinct,
	Doc,
	docRows,
	factsOf,
	type LawName,
	lineObjectsOf,
	lineRows,
	metOf,
	oneSelectedPairs,
	type Owner,
	type SelectedKey,
	type Situation,
	situations,
	type StatedDoc,
	statementsOf,
	storesExactly,
	uniqueCases,
	verdictOf
} from "#test/pg/write/unique-witness/unique-witness.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { answered, writeOnce } from "#test/support/calls.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { oneFlight } from "#test/support/one-flight.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A family insert meeting a unique is refused by a law a stated row breaks, witnessed by that row's values at the law's fields, and writes the set otherwise.
 *
 * Its pre-conversion budget: runs 16, coverage cases 96 (test/pg/write/unique-witness/unique-witness.test.ts at d8eed1786).
 */
export const aFamilyInsertMeetingAUniqueIsRefusedByALawAStatedRowBreaksWitnessedByThatRowsValuesAtTheLawsFieldsAndWritesTheSetOtherwise =
	property.explore(steered(uniqueCases), {
		needs: { substrate: Substrate.installing },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ substrate }, c: Case<Situation>) =>
			({ shape, stored, again }) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const statements = statementsOf(shape)
						const schemaNamed = (name: string) => schema(name, statements.relations, statements.all)
						const declared = schemaNamed("Uniq")
						const done = yield* installMigrated(declared, {
							ambient: ordinarySession,
							label: "unique",
							logins: [fullWorld(declared, {}).server],
							extensions: []
						})
						const value = schemaNamed(done.schema)
						const world = fullWorld(value, {})
						const names = namesOf(done)
						const lawNames = lawNamesOf(value)
						const lawIds: ReadonlyArray<readonly [LawName, LawId]> = [
							["Doc key", lawNames.primaryKeyLaw({ name: "Doc" })],
							["Line key", lawNames.primaryKeyLaw({ name: "Line" })],
							["lines", lawNames.lawOf(statements.lines)],
							...Arr.map(statements.keys, ([k, statement]): readonly [LawName, LawId] => [
								`key ${k}`,
								lawNames.lawOf(statement)
							]),
							...Arr.map(statements.selected, ([s, statement]): readonly [LawName, LawId] => [
								`selected ${s.fields}`,
								lawNames.lawOf(statement)
							])
						]
						const lawId = (law: LawName): LawId =>
							defined(
								Option.getOrUndefined(Arr.findFirst(lawIds, ([name]) => name === law))?.[1],
								`the law ${law}`
							)
						const owner: Owner = shape.mutableDoc ? "a mutable doc" : "an immutable doc"
						/** Notes a verdict a key over a selection decided, by each class its predicate falls in. */
						const noteClasses = (s: SelectedKey): void => {
							for (const over of classesOf(s.pred)) {
								c.note(`a verdict at a selection key over ${over}`)
							}
						}
						const insert = ChangeSet.empty(value).insert(Doc, [])
						yield* Effect.gen(function* () {
							const db = yield* openServedDb(done, world.server.roles.app, {})
							const flight = yield* oneFlight(db.ctx, done.as(world.server))
							const loaded = yield* db.load({ insert })
							const applied = (docs: ReadonlyArray<StatedDoc>) =>
								answered(
									writeOnce(memberCalls(flight.context, member(loaded, "insert")))({
										params: {},
										facts: factsOf(docs)
									})
								)
							const first = yield* flight.judged("the first insert", applied(stored))
							assert.equal(
								first.kind,
								Arr.isReadonlyArrayNonEmpty(stored) ? "accepted" : "unchanged",
								`the first insert of ${Formatter.format(stored)} under ${Formatter.format(shape)}`
							)
							yield* storesExactly(done, docRows(stored), lineRows(stored), "the first insert")
							const label = `${Formatter.format(again)} over ${Formatter.format(stored)} under ${Formatter.format(shape)}`
							const outcome = yield* flight.judged("the second insert", applied(again))
							const verdict = verdictOf(shape, stored, again)
							if (verdict.kind === "written") {
								assert.equal(
									outcome.kind,
									verdict.adds ? "accepted" : "unchanged",
									`${label}: no stated row breaks a unique`
								)
								yield* storesExactly(done, verdict.docs, verdict.lines, label)
								c.note(verdict.adds ? "accepted" : "unchanged")
								for (const s of oneSelectedPairs(shape, verdict.lines, distinct(lineRows(again)))) {
									c.note(`two members at a selection key, one selected, admitted, under ${owner}`)
									noteClasses(s)
								}
								return
							}
							if (outcome.kind !== "refused") {
								return assert.fail(
									`${label}: stated rows break ${Formatter.format(verdict.breaks)}, so the insert is refused, not ${outcome.kind}`
								)
							}
							yield* storesExactly(done, docRows(stored), lineRows(stored), `the refused ${label}`)
							assert.equal(
								outcome.refused.kind,
								"every",
								`${label}: a key's refusal decides its laws`
							)
							const named = Arr.map(outcome.refused.laws, (l) => names.reported(l))
							const broken = Arr.map(verdict.breaks, (b) => ({ ...b, id: lawId(b.law) }))
							for (const law of named) {
								assert.ok(
									Arr.some(broken, (b) => b.id === law),
									`${label}: the refusal names ${law}, which no stated row breaks: ${Formatter.format(verdict.breaks)}`
								)
							}
							const witness = outcome.witness
							if (witness.kind === "unreported") {
								return assert.fail(
									`${label}: the refusal of ${Formatter.format(named)} reports no witness, where stated rows break it: ${Formatter.format(verdict.breaks)}`
								)
							}
							const met = Option.getOrUndefined(
								Arr.findFirst(
									broken,
									(b) =>
										named.includes(b.id) &&
										b.relation === witness.relation &&
										deepEquals<unknown>(witness.values, b.values)
								)
							)
							if (met === undefined) {
								return assert.fail(
									`${label}: the witness ${Formatter.format(witness)} is no stated row's values at a law the refusal names, ${Formatter.format(named)}, that the row breaks: ${Formatter.format(verdict.breaks)}`
								)
							}
							c.note(
								met.meets === "stored"
									? `${metOf(met.law)} met by a stored row, under ${owner}`
									: `${metOf(met.law)} met by another stated row, under ${owner}`
							)
							for (const [s] of Arr.filter(
								statements.selected,
								([s]) => `selected ${s.fields}` === met.law
							)) {
								noteClasses(s)
							}
							const statedLines = distinct(lineRows(again))
							const fields = Option.getOrUndefined(
								Arr.findFirst(lineObjectsOf(shape), (o) => o.law === met.law)
							)?.fields
							if (
								metOf(met.law) === "a declared key" &&
								fields !== undefined &&
								Arr.dedupeWith(
									Arr.map(statedLines, (l) => at(l, fields)),
									(x, y) => deepEquals(x, y)
								).length > 1
							) {
								c.note(
									"a declared key met where the statement writes several lines of different values there"
								)
							}
						}).pipe(Effect.scoped)
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "the README's set rule over relations as sets of rows with their unique objects, a key over a selection holding the rows its selection is true of (verdictOf)"
		},
		budget: { runs: 16, steered: 96 },
		kept: [],
		kills: []
	})
