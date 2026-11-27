/**
 * A ChangeSet's read-backs are one set by name, read once after the whole ChangeSet (write/changeset/value.ts
 * readBackSet), on PostgreSQL 19: two ChangeSets that each end in `.read("standing", …)` over one query, as metis's
 * showItem sequences qti-pie's enterTest and presentItem, each ending in the read of the sitting's standing, combine
 * into one ChangeSet with one read-back `standing`, and its rows are the state after the whole ChangeSet, every stratum
 * of either and of a third sequenced after them, never the state after the stratum of the ChangeSet that declared it.
 *
 * Schema: Item(id, n) keyed by id, mutable inside the unit of its id. Stored: Item 1 | 10 and 2 | 20.
 *
 * The box, exhausted: an insert's ChangeSet and a delete's, each reading standing, sequenced either way, unioned in one
 * stratum, or sequenced with a third ChangeSet after them that puts Item 3 | 33 and reads nothing; the insert's fact a
 * fresh one, 3 | 30, or the stored 1 | 10 again; the delete's a stored fact, 2 | 20, or the insert's; standing every
 * fact of Item, or every fact of a relation parameter the combined ChangeSet binds once to a query of Item's facts, as
 * qti-pie's standing reads the sittings metis binds on its whole call. Each case installs the schema on a clone of its
 * own, stores the state and applies the ChangeSet once.
 *
 * Property, per case: the ChangeSet's Description holds the one read-back `standing`; the call is accepted; standing's
 * rows over Item are the model's state after the whole ChangeSet (merged-reads.fixtures.ts modelOf: each stratum's
 * meaning over the state before it, S' = (S \ D) ∪ A), each fact once, and over the bound relation parameter Item's
 * facts in the call's starting state, the stored ones: a relation parameter bound to a query on the whole call is
 * evaluated once before its first stratum (README "Writes"); the stored state after the call is the model's. Oracle: specification, the model. Kill: the read-backs' statements
 * sent before the writes in the applying transaction (adapter/apply/run.ts), so standing reads the stored state.
 *
 * Features: each composition, each insert and delete, each standing.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import {
	attemptLabel,
	installWrites,
	observedChange,
	openFull,
	owner
} from "#bench/write/support/writes.ts"
import { hasProperties } from "#compiler/core/record.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { changeSetDesc } from "#compiler/write/changeset/value.ts"
import {
	build,
	changeOf,
	factText,
	Item,
	mergedReadGen,
	modelOf,
	type Situation,
	situations,
	stored
} from "#test/pg/write/merged-reads/merged-reads.fixtures.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A delivered row of standing as the property compares it, "id | n", or a failure naming what it is. */
const rowText = (row: unknown): string =>
	hasProperties(row) && typeof row["id"] === "number" && typeof row["n"] === "number"
		? `${row["id"]} | ${row["n"]}`
		: assert.fail(`a row of standing, not ${Formatter.format(row)}`)

/** Two lists of facts as text, item by item. */
const sameFacts = Arr.makeEquivalence<string>((x, y) => x === y)

/** Two read-backs of one name over one query are one, read after the whole ChangeSet: its rows the state after its last stratum. */
export const twoReadBacksOfOneNameOverOneQueryAreOneReadAfterTheWholeChangeSetItsRowsTheStateAfterItsLastStratum =
	property.exhaust(finite(mergedReadGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ substrate }, k: Case<Situation>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							k.note(c.composition)
							k.note(c.inserted)
							k.note(c.deleted)
							k.note(c.standing)
							const s = yield* Substrate
							const fx = yield* installWrites(build("MergedReads"), "mergedreads", {
								programs: {},
								logins: () => []
							})
							const S = build(fx.installed.declared)
							const names = namesOf(fx.installed)
							const column = (field: string) => quoteIdent(names.columnIdent(Item, field))
							yield* owner(
								`INSERT INTO ${names.table(Item)} (${column("id")}, ${column("n")}) VALUES ${Arr.join(
									Arr.map(stored, (f) => `(${f.id}, ${f.n})`),
									", "
								)}`
							)
							const change = changeOf(S, c)
							assert.deepEqual(
								Arr.map(
									defined(changeSetDesc(change), "a ChangeSet's Description").reads,
									(r) => r.name
								),
								["standing"],
								"the two read-backs of standing are one"
							)
							const db = yield* openFull(fx, S)
							const observed = yield* observedChange(db, change, attemptLabel, { kind: "none" })
							const applied = yield* observed.apply({})
							const outcome = applied.value
							const model = modelOf(c)
							/** Standing over Item reads the state after the change; over the bound parameter, its one
							 * evaluation, in the call's starting state. */
							const standing =
								c.standing === "the state"
									? model
									: Arr.sort(Arr.map(stored, factText), Order.String)
							const reads =
								outcome.kind === "accepted" || outcome.kind === "no-change"
									? outcome.reads
									: assert.fail(`the call commits, not ${outcome.kind}`)
							assert.equal(
								outcome.kind,
								sameFacts(model, Arr.map(stored, factText)) ? "no-change" : "accepted",
								"the call is no change exactly where the whole ChangeSet leaves the stored state"
							)
							assert.deepEqual<ReadonlyArray<string>>(
								Arr.sort(
									Arr.map(defined(reads["standing"], "standing's rows"), rowText),
									Order.String
								),
								standing,
								"standing's rows are Item's after the whole ChangeSet, or the bound parameter's before it, each fact once"
							)
							const after = yield* s.admin.queryValues(
								`SELECT ${column("id")}::text, ${column("n")}::text FROM ${names.table(Item)}`,
								[]
							)
							assert.deepEqual<ReadonlyArray<string>>(
								Arr.sort(
									Arr.map(after, (row) => Arr.join(Arr.map(row, String), " | ")),
									Order.String
								),
								model,
								"the stored state after the call is the model's"
							)
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "each stratum's meaning over the state before it, S' = (S \\ D) ∪ A (merged-reads.fixtures.ts modelOf)"
		},
		box: "an insert's ChangeSet and a delete's, each reading standing over one query, sequenced either way, unioned, or sequenced before a put that reads nothing; the insert fresh or a stored fact again; the delete stored or the insert's; standing Item's facts or a relation parameter the whole binds to them",
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/apply/run.ts",
				original: "runFramed(session, frame, [...writes.success.statements, ...backs.statements])",
				replacement:
					"runFramed(session, frame, [...backs.statements, ...writes.success.statements])",
				why: "The read-backs' statements are sent before the writes in the applying transaction, so the one standing reads the stored state, not the state after the whole ChangeSet."
			}
		]
	})
