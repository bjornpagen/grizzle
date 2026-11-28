/**
 * A closed import's record holds its whole reading, however its check obtained each closed import it read (check/
 * checker.ts #closedImport, #journal, ClosedImport): a closed import read again in one check, which the check found among
 * those it read before, journals its record for the closed import being checked around the read, its uses of the
 * reader's parameters, its searches, its declarations and the imports it read, as a first check of it and an adoption of
 * it do. So an import's record is the same whatever the check that made it read before it, and a later member that adopts
 * it types every parameter the import's reading uses. A record whose known reads journaled nothing lacked the uses of a
 * parameter only those reads reached, and the member adopting it refused that parameter as untyped (metis's carryEnter
 * at grizzle 58fc1a9a: the ledger's take bound `taken` to its carried sittings, read again inside the take's nested
 * imports, and ShuffleRank's insert refused `sittings`).
 *
 * The box, exhausted: a ChangeSet binding the relation parameter `taken` to a query over the call's relation parameter
 * `sittings`, whose first member reads the items of the taken sessions, itself or inside another import of them, and
 * then an import that reads the items again one or two imports deep; and whose second member reads that import alone,
 * naming no parameter but `taken`.
 *
 * Property, per case: the write compiles, declaring the call's one parameter, `sittings`, a relation of the sessions'
 * heading, as the second member's own check of the import would type it. Oracle: specification. Kill: a known read
 * journals nothing, so the import checked inside the first member records no use of `sittings`, and the second member,
 * adopting it, refuses `sittings` as named where none of its uses is checked.
 *
 * Features: one deep, two deep; read by the member, read inside another import.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { compiled } from "#test/support/unit/write/changeset/fixtures.ts"
import {
	type Before,
	type Depth,
	Known,
	knownGen,
	writeOf
} from "#test/unit/check/known-imports.fixtures.ts"

/** A closed import read again in one check journals its record, so a member adopting an import types its every parameter. */
export const aClosedImportReadAgainInOneCheckJournalsItsRecordSoAMemberAdoptingAnImportTypesItsEveryParameter =
	property.exhaust(finite(knownGen), {
		needs: {},
		situations: [
			"one deep",
			"two deep",
			"read by the member",
			"read inside another import"
		] satisfies ReadonlyArray<Reached<Depth | Before>>,
		check: (_, c: Case<Depth | Before>) => (known) =>
			Effect.sync(() => {
				c.note(known.depth)
				c.note(known.before)
				const declared = compiled(Known, writeOf(known)).params
				assert.deepEqual(
					Arr.map(declared, (p) =>
						p.kind === "relation"
							? `${p.name}(${Arr.join(
									Arr.map(p.heading, (h) => h.name),
									", "
								)})`
							: p.name
					),
					["sittings(session)"],
					"the call's one parameter, the relation of the sittings it names"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the write declares the call's one parameter, sittings, a relation of the sessions' heading"
		},
		box: "a ChangeSet binding taken to a query over sittings: its first member reads the items, itself or inside another import, then an import of them one or two deep, which its second member reads alone",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					"\t\tconst imported = this.#importRecord(key, build)\n\t\tthis.#journal(key, imported)\n",
				replacement:
					"\t\tconst known = this.#imported.has(key)\n\t\tconst imported = this.#importRecord(key, build)\n\t\tif (!known) {\n\t\t\tthis.#journal(key, imported)\n\t\t}\n",
				why: "A closed import this check read before journals nothing where it is read again: the import checked inside the first member records no use of sittings, and the second member, adopting it, refuses sittings as named where none of its uses is checked."
			}
		]
	})
