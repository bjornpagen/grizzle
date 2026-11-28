/**
 * An owner of counted families read from a query may be inserted at its starts, its count 0 and its ends at their
 * starts, which a row check reading an end against a written field refuses; so a ChangeSet that inserts or puts owners
 * read from a query that may insert one, and in the same stratum inserts or puts a member of its family, is refused
 * when it compiles (QueriedOwnerAppend), naming the write, the owner, the family and the member, at the owner's write.
 * Every other write of owners from a query compiles: one whose facts carry a stored owner's key alone, which inserts no
 * owner; one beside no member write, or beside a member's removal; one sequenced before the append; and a deletion of
 * owners a query reads, which inserts none. An owner stated
 * by facts is inserted at its final count and end with its members, which the families swarm
 * (test/pg/write/swarm/families.test.ts) runs.
 *
 * A deletion of ledgers, from a query or stated, removes each ledger with its entries whole (README "Families", a group
 * is deleted whole through its owner), so a stratum that also puts an entry is refused when it compiles, at the
 * entry's put, by the named Refusal "a stratum puts no row its deletes remove whole" (core/refusals.ts, since
 * ee93f32d); beside an entry's insert or removal it compiles.
 *
 * The oracle is those two rules over generated ChangeSets of one or two strata over a ledger whose entries sum to its
 * total. A ChangeSet writes an entry in one stratum at most, so no ChangeSet breaks both.
 *
 * Features: each refused write of given ledgers beside each member write, a deletion of ledgers beside an entry's put
 * refused, and each kind of compiled write (compiledFeatures).
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import { descOf } from "#test/support/unit/write/changeset/fixtures.ts"
import {
	compile,
	compiledFeatures,
	type OwnerFeature,
	refusalOf,
	strataGen,
	stratumOf,
	wholeRefusalOf
} from "#test/unit/write/owner.fixtures.ts"

/**
 * An owner of counted families read from a query is refused beside an insert or put of its members in its stratum
 * exactly when the query may insert it.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/write/owner.test.ts:245 at 8cad5bce, its runs and its coverage's cases).
 */
export const anOwnerOfCountedFamiliesReadFromAQueryIsRefusedBesideAnInsertOrPutOfItsMembersInItsStratumExactlyWhenTheQueryMayInsertIt =
	property.explore(strataGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"insert of given ledgers beside insert of an entry: refused",
			"insert of given ledgers beside put of an entry: refused",
			"put of given ledgers beside insert of an entry: refused",
			"put of given ledgers beside put of an entry: refused",
			"given ledgers beside an entry's removal: compiled",
			"given ledgers beside no entry: compiled",
			"restated ledgers beside an append: compiled",
			"stated ledgers beside an append: compiled",
			"given ledgers sequenced before an append: compiled",
			"a deletion of given ledgers beside an append: compiled",
			"a deletion of ledgers beside a put of an entry: refused",
			"a deletion of ledgers beside an entry's removal: compiled"
		] satisfies ReadonlyArray<Reached<OwnerFeature>>,
		check: (_, c: Case<OwnerFeature>) => (strata) =>
			Effect.sync(() => {
				const [first, ...rest] = Arr.map(strata, stratumOf)
				const value = Arr.reduce(rest, defined(first, "a first stratum"), (a, b) =>
					ChangeSet.sequence(a, b)
				)
				const refusal = refusalOf(strata)
				const whole = wholeRefusalOf(strata)
				if (Option.isSome(whole)) {
					c.note("a deletion of ledgers beside a put of an entry: refused")
					const put = Arr.findFirst(
						defined(descOf(value).strata[whole.value.at], "the refused stratum").members,
						(m) => m.op === "put" && m.relation === "Entry"
					)
					const named = refused(
						compile(value),
						"Refused",
						"a put of an entry beside a whole delete of its ledgers"
					)
					assert.equal(
						named.reason._tag === "Refused" ? named.reason.refusal : undefined,
						"a stratum puts no row its deletes remove whole: a delete of a tree or of a family's owner removes every row nested under it, so put in another stratum (ChangeSet.sequence), or insert the rows again whole",
						"the refusal is the whole delete's named Refusal"
					)
					assert.deepEqual(
						refusalLoc(named),
						defined(Option.getOrUndefined(put), "the entry's put").loc,
						"the refusal is at the entry's put"
					)
					return
				}
				if (Option.isNone(refusal)) {
					succeeded(compile(value), "a write that inserts no owner it appends to compiles")
					c.noteAll(compiledFeatures(strata))
					return
				}
				const { at, op, member } = refusal.value
				c.note(`${op} of given ledgers beside ${member} of an entry: refused`)
				const reason = refused(
					compile(value),
					"QueriedOwnerAppend",
					"an owner a query states may be inserted at its starts, which the check refuses"
				).reason
				if (reason._tag !== "QueriedOwnerAppend") {
					return assert.fail("a QueriedOwnerAppend")
				}
				const write = Arr.findFirst(
					defined(descOf(value).strata[at], "the refused stratum").members,
					(m) => m.op === op && m.relation === "Ledger"
				)
				assert.deepEqual(
					{
						op: reason.op,
						owner: reason.owner,
						family: reason.family,
						member: reason.member,
						at: reason.at
					},
					{
						op,
						owner: "Ledger",
						family: { owner: "Ledger", count: "n" },
						member: "Entry",
						at: defined(Option.getOrUndefined(write), "the owners' write").loc
					},
					"the refusal names the write, the owner, its family and the member, at the owner's write"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the queried owner's append rule and the whole delete's put rule"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: '\t\tif (op === "delete") {',
				replacement: '\t\tif (op === "delete" || op === "put") {',
				why: "A put of owners read from a query beside an append to their family compiles, QueriedOwnerAppend refusing only their insert."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: "\t\tif (edited !== undefined) {",
				replacement: '\t\tif (edited !== undefined && edited.op !== "put") {',
				why: "The refusal of a put of a relation a whole delete's units remove never fires (write/frontend/compile.ts `edited`), so a deletion of ledgers beside an entry's put compiles."
			}
		]
	})
