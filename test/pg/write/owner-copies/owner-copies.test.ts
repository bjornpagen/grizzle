/**
 * Every row of a call that inserts a counted family's owners beside its members is stored as the rule writes it, on
 * PostgreSQL 19, where the owner's insert or its members' computes a field from the call (ChangeSet.insertAllComputed): a
 * stamp is taken once in its stratum, by the statement that writes the rows carrying it, so the host draws each fresh
 * group from the rows it holds (runtime/write/bind.ts freshOwners), matching a member to its owner by the group fields
 * both hold, a group field both compute by one term of the call's parameters a unit every row shares, which the
 * statements stamp (write/frontend/compile.ts FreshFill); and a member's copy of its owner's field reads the owner's
 * rows as its own statement holds them, from the owner's table where another statement stamps them (schedule.ts
 * CopySource `drawn`). Its compile half, every shape of the box and the refusal of a group field one side computes and
 * the other states, is test/unit/write/owner-copies.
 *
 * The box, exhausted: every case of test/unit/write/owner-copies' box whose write binds (owner-copies.fixtures.ts
 * boundGen), pantry's insertWrite taking `package` as its one scalar parameter among them, the tree's key computed and
 * its Attrs apart computing it too. Each case installs its schema, serves its write, and calls it once with the case's
 * nodes and Attrs.
 *
 * Property, per case: the call is accepted, and the tables hold exactly its rows: every node at the call's pkg, its path,
 * its start, its tag and the call's note, its `attributes` the number of Attrs it owns, one; every Attr at its node's key, holding
 * its node's tag where it copies it; and, nested, one P at each node holding its one Attr. Oracle: the rule, the case's
 * nodes and Attrs as it states them, every computed field the call's one value. Kills: every owner read as its
 * statement appended it, which dies where the write compiles (PANTRY-WRITERS, `the column pkg of r10`); and the host
 * matching members to their owners by every group field, a computed one among them, which no row it holds holds, so
 * the call dies at bind.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import { installFullWorld } from "#test/support/installed.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"
import {
	boundGen,
	callParams,
	type CopyCase,
	type CopyFeature,
	copyFeatures,
	copyingOf,
	nodesOf,
	path
} from "#test/unit/write/owner-copies.fixtures.ts"

/** Rows of column texts, in one order. */
const sorted = (rows: ReadonlyArray<ReadonlyArray<string>>) =>
	Arr.sort(
		rows,
		Order.mapInput(Order.String, (r: ReadonlyArray<string>) => Arr.join(r, " "))
	)

/** The columns each table is read back by, the rule's: Node's key, tag, note and count; Attr's key and, where it
 * copies, its tag; P's key, value and count. */
const columnsOf = (c: CopyCase) => ({
	Node: ["pkg", "path", "start", "tag", "note", "attributes"],
	Attr: [
		"pkg",
		"path",
		"start",
		...(c.members === "nested" ? ["pat", "at"] : ["name"]),
		...(c.copies ? ["tag"] : [])
	],
	P: ["pkg", "path", "start", "at", "v", "ms"]
})

/** The rows a case's one call stores, each column's text (`columnsOf`): every node at the call's pkg and note, owning one
 * Attr; each Attr at its node, copying its tag where the case copies; nested, one P at each node holding its Attr. */
const expectedOf = (c: CopyCase) => {
	const nodes = nodesOf(c)
	const key = (start: bigint) => [String(callParams.pkg), String(path), String(start)]
	return {
		Node: Arr.map(nodes, (n) => [...key(n.start), String(n.tag), String(callParams.note), "1"]),
		Attr: Arr.map(nodes, (n) => [
			...key(n.start),
			...(c.members === "nested" ? ["0", "0"] : ["6"]),
			...(c.copies ? [String(n.tag)] : [])
		]),
		P: c.members === "nested" ? Arr.map(nodes, (n) => [...key(n.start), "0", "7", "1"]) : []
	}
}

/** Every row of a call that inserts a counted family's owners beside its members, a field computed from the call, is stored as the rule writes it. */
export const everyRowOfACallInsertingACountedFamilysOwnersBesideItsMembersAFieldComputedFromTheCallIsStoredAsTheRuleWritesIt =
	property.exhaust(finite(boundGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a tree owner",
			"a plain owner",
			"a key field computed",
			"a payload field computed",
			"nothing computed",
			"members computing their group field",
			"members stating it",
			"members nested under the owner",
			"no copy"
		] satisfies ReadonlyArray<Reached<CopyFeature>>,
		check:
			({ substrate }, k: Case<CopyFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						k.noteAll(copyFeatures(c))
						const declared = copyingOf(c, "Copies")
						const done = yield* installFullWorld(
							declared.schema,
							{ publish: declared.changeSet("call") },
							{ ambient: ordinarySession, label: "copies" }
						)
						const built = copyingOf(c, done.schema)
						const world = fullWorld(built.schema, { publish: built.changeSet("call") })
						const db = yield* openServedDb(done, world.server.roles.app, {})
						const served = yield* db.serve({ publish: built.changeSet("call") })
						const answer = yield* writeAnswerOf(
							writeOnce(member(served, "publish"))({ params: built.params, facts: built.facts })
						)
						assert.equal(answer.kind, "accepted", `the call: ${Formatter.format(answer)}`)
						const names = namesOf(done)
						const s = yield* Substrate
						/** A table's rows, each column `columns` names as its text, in one order. */
						const stored = (relation: AnyRelation, columns: ReadonlyArray<string>) =>
							Effect.map(
								s.admin.queryValues(
									`SELECT ${Arr.join(
										Arr.map(
											columns,
											(column) => `${quoteIdent(names.columnIdent(relation, column))}::text`
										),
										", "
									)} FROM ${names.table(relation)}`,
									[]
								),
								(rows) => sorted(Arr.map(rows, (row) => Arr.map(row, (cell) => String(cell))))
							)
						const columns = columnsOf(c)
						const expected = expectedOf(c)
						assert.deepEqual(
							{
								Node: yield* stored(built.Node, columns.Node),
								Attr: yield* stored(built.Attr, columns.Attr),
								P: c.members === "nested" ? yield* stored(built.P, columns.P) : []
							},
							{
								Node: sorted(expected.Node),
								Attr: sorted(expected.Attr),
								P: sorted(expected.P)
							},
							"every row of the call as the rule writes it, each computed field the call's one value"
						)
					}),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the rule: every row of the call holds the call's one value of each computed field, each node its Attrs' count, each Attr its node's key and copied tag"
		},
		box: "every bound case of test/unit/write/owner-copies' box: a tree or plain owner computing its key field, a payload field or nothing, its counted members apart computing their group field or stating it, or nested two deep, copying the owner's tag or not; one call each",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original:
					"\t\t\tconst sources: ReadonlyArray<OwnerSourceRead> = statement.includes(owner)\n",
				replacement: "\t\t\tconst sources: ReadonlyArray<OwnerSourceRead> = true\n",
				why: "Every owner is read as if its statement appended it, its stamps held by the statement of a member inserted apart, which never takes them: the append scan dies where the write compiles, so no case installs (PANTRY-WRITERS at fa7560c88, `grizzle internal invariant: the column pkg of r10`)."
			},
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original:
					'\t\t\t\tconst groupOf = groupReader(ctx, hostGroup(f), "member", ctx.columns(f.member))\n',
				replacement:
					'\t\t\t\tconst groupOf = groupReader(ctx, f, "member", ctx.columns(f.member))\n',
				why: "The host matches the call's members to their fresh owners by every group field, pkg among them, which the members' insert computes and no row the host holds holds, so pantry's call dies at bind (`a value at position 3 of a row a reader reads`)."
			}
		]
	})
