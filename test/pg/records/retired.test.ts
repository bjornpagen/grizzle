/**
 * A query's records retired with their run on PostgreSQL 19: over drawn queries of Shelves (attached.fixtures.ts, at
 * depths one to three and every delivery), drawn facts of Shelves, and a drawn owner of the records (its run field
 * `run`, or `kind`, which a books relation carries as `kind2`; the run first or second of the owner's key), the records
 * installed as a level over Shelves with Run, the header of their retirable unit, retirable(Run, [on(records, run)]):
 * one side over the records that stands for each of their relations. With the query's rows stored under runs 1 and 2,
 * retiring run 1 removes every row of it from every relation of the records, at every depth, and nothing of run 2.
 * Records holding an arm are no body: their alternatives law over the unit's bodies is refused (schema/own.ts).
 *
 * Oracle: the rows stored before the retirement, read per relation and run as the owner: after a retirer retires run 1
 * (ChangeSet.retire, served), each relation holds exactly its rows of run 2; Run holds run 1 retired and run 2 open;
 * and run 2's records read back exactly the rows the query delivered (test/support/equivalence.ts exactValue).
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import {
	armed,
	type RetiredCase,
	retiredCase,
	retiredCaseGen
} from "#test/pg/records/retired.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * What a case retires: rows below the root, a carried run renamed, a run second in the owner's key, no book; or
 * records holding an arm, refused as a retirable body.
 */
type RetiredFeature =
	| "rows below the root retired"
	| "a carried run renamed"
	| "the run second in the owner's key"
	| "no book"
	| "an arm refused"

/** The features a case reaches: what it stored before the retirement, by its owner and its facts. */
const reached = (
	c: RetiredCase,
	before: Readonly<Record<string, ReadonlyArray<string>>>
): ReadonlyArray<RetiredFeature> => {
	if (armed(c)) {
		return ["an arm refused"]
	}
	const below = Arr.some(
		Rec.toEntries(before),
		([name, rows]) => name !== "KeptRow" && Arr.isReadonlyArrayNonEmpty(rows)
	)
	const feature = (holds: boolean, f: RetiredFeature): ReadonlyArray<RetiredFeature> =>
		holds ? [f] : []
	return [
		...feature(below, "rows below the root retired"),
		...feature(c.owner.run === "kind", "a carried run renamed"),
		...feature(c.owner.step === "before", "the run second in the owner's key"),
		...feature(!Arr.isReadonlyArrayNonEmpty(c.attached.facts.books), "no book")
	]
}

/** Retiring a run removes every row of it from every relation of its records, and nothing of another run. */
export const aRunRetiredRemovesItsRowsFromEveryRelationOfItsRecordsAndNothingOfAnother =
	property.explore(retiredCaseGen, {
		needs: { substrate: Substrate.fresh },
		situations: [
			"rows below the root retired",
			"a carried run renamed",
			"the run second in the owner's key",
			"no book",
			"an arm refused"
		] satisfies ReadonlyArray<Reached<RetiredFeature>>,
		check:
			({ substrate }, notes: Case<RetiredFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.map(retiredCase(c), ({ before }) => {
							for (const feature of reached(c, before)) {
								notes.note(feature)
							}
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the rows stored before the retirement, per relation and run: run 2's alone after it, read back as the query delivered them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/records.ts",
				original: 'defined(carriedAs.get(f), "a child carrying each field of its parent\'s key")',
				replacement: 'defined(f, "a child carrying each field of its parent\'s key")',
				why: "Each relation of the records is named by the owner's fields, not by its own fields carrying them (program/records.ts carryingOf), so a books relation that carries the run `kind` as `kind2` is retired by its own column `kind`."
			},
			{
				file: "packages/engine/src/program/records.ts",
				original: "\t...holder.attachments.flatMap((a) => {",
				replacement: "\t...holder.attachments.slice(0, 0).flatMap((a) => {",
				why: "A side over records stands for their root alone (program/records.ts carryingOf), so their attachments' relations are no body of the unit, and a run's retirement leaves its books, or is refused by them."
			},
			{
				file: "packages/engine/src/schema/statements.ts",
				original: 'defined(carries[at], "a relation of records carrying each owner key field")',
				replacement: 'defined(carries[0], "a relation of records carrying each owner key field")',
				why: "Each relation's side reads the owner key's first field, whatever the side names (schema/statements.ts recordsSides), so a run second in the owner's key retires every row at its step, run 2's among them."
			}
		]
	})
