/** What the properties of scaling.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Record as Rec, Stream } from "effect"
import type { IdentityDigest } from "#compiler/core/fingerprint.ts"
import { type ChangeSetDesc, decodeDesc, descIdentity } from "#compiler/ir/desc.ts"
import { queryOver as query, queryValueDesc, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import {
	changeSetOver as ChangeSet,
	changeSetState,
	type ChangeSetValue
} from "#compiler/write/changeset/value.ts"
import { containersOf, freshContainers, keyOrders } from "#test/support/containers.ts"
import { Task, TaskNote, Work } from "#test/support/fixtures/api/work.ts"
import { sitesRead } from "#test/support/sites.ts"
import { descOf, uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"

/** The i-th query member: a rule over Task with a parameter of its own, so no two are one member. */
const member = (i: number) =>
	query(Work).rule((r: RuleValue) => {
		const { account, kind } = v(Task, "task")
		const id = r.param(`task${i}`, Task.fields.id)
		return r.match(Task, { id, account, kind }).find({ id, account, kind })
	})

const note = (i: number) => ({ task: uuidOf(i), note: `n${i}` })

/** The query member states of a ChangeSet value, every stratum's: each new one is an identity text computed. */
const membersOf = (value: ChangeSetValue): ReadonlyArray<object> =>
	Arr.filter(
		defined(changeSetState(value), "a ChangeSet's state").strata.flat(),
		(m) => m.kind === "query"
	)

/** What one step built and recomputed: the containers new to its Description, and its query member states not carried. */
interface StepCount {
	readonly containers: number
	readonly members: number
}

/** How a step grows the ChangeSet: the start, and the i-th step, which adds the i-th member's query. */
interface Growth {
	readonly start: ChangeSetValue
	readonly step: (c: ChangeSetValue, i: number) => ChangeSetValue
}

export const growthNames = [
	"a query member",
	"an array member into its group, then a query member",
	"a query member after a bind"
] as const

type GrowthName = (typeof growthNames)[number]

export const growths: Readonly<Record<GrowthName, Growth>> = {
	"a query member": {
		start: ChangeSet.empty(Work).insert(Task, member(0)),
		step: (c, i) => c.insert(Task, member(i))
	},
	"an array member into its group, then a query member": {
		start: ChangeSet.empty(Work)
			.insert(Task, member(0))
			.insert(TaskNote, [note(0)]),
		step: (c, i) => c.insert(TaskNote, [note(i)]).insert(Task, member(i))
	},
	"a query member after a bind": {
		start: ChangeSet.empty(Work)
			.insert(Task, member(0))
			.bind({ task0: uuidOf(0) }),
		step: (c, i) => c.insert(Task, member(i))
	}
}

/** The counts of `n` steps of a growth. */
export const counts = (growth: Growth, n: number): ReadonlyArray<StepCount> => {
	const out: Array<StepCount> = []
	let before = growth.start
	for (let i = 1; i <= n; i++) {
		const added = queryValueDesc(member(i))
		const after = growth.step(before, i)
		const known = containersOf(added, containersOf(descOf(before), new Set()))
		const carried = new Set(membersOf(before))
		out.push({
			containers: freshContainers(descOf(after), known),
			members: Arr.filter(membersOf(after), (m) => !carried.has(m)).length
		})
		before = after
	}
	return out
}

/** The ChangeSet the ops build, every value on the way: the old path's oracle checks each. */
type Op =
	| { readonly op: "insert"; readonly member: number }
	| { readonly op: "put"; readonly member: number }
	| { readonly op: "facts"; readonly note: number }
	| { readonly op: "delete"; readonly note: number }
	| { readonly op: "stream"; readonly note: number }
	| { readonly op: "bind" }
	| { readonly op: "read"; readonly member: number }
	| { readonly op: "union" }
	| { readonly op: "union after" }
	| { readonly op: "sequence" }
	| { readonly op: "sequence after" }

/** A ChangeSet union and sequence combine with: a bound member, an array member and a Stream member. */
const other = ChangeSet.empty(Work)
	.insert(TaskNote, [note(9)])
	.insert(TaskNote, Stream.fromIterable([note(8)]))
	.put(Task, member(1))
	.bind({ task1: uuidOf(9) })

export const opOf = (kind: number, n: number): Op => {
	const ops: ReadonlyArray<Op> = [
		{ op: "insert", member: n },
		{ op: "put", member: n },
		{ op: "facts", note: n },
		{ op: "delete", note: n },
		{ op: "stream", note: n },
		{ op: "bind" },
		{ op: "read", member: n },
		{ op: "union" },
		{ op: "union after" },
		{ op: "sequence" },
		{ op: "sequence after" }
	]
	return defined(ops[kind], "an op")
}

/** The values the ops build in turn from the empty ChangeSet, each read-back named apart. */
export const built = (ops: ReadonlyArray<Op>): ReadonlyArray<ChangeSetValue> => {
	const out: Array<ChangeSetValue> = []
	let at = ChangeSet.empty(Work)
	let free = new Set<number>()
	for (const [k, op] of ops.entries()) {
		switch (op.op) {
			case "insert":
				at = at.insert(Task, member(op.member))
				free = new Set([...free, op.member])
				break
			case "put":
				at = at.put(Task, member(op.member))
				free = new Set([...free, op.member])
				break
			case "facts":
				at = at.insert(TaskNote, [note(op.note)])
				break
			case "delete":
				at = at.delete(TaskNote, [note(op.note)])
				break
			case "stream":
				at = at.insert(TaskNote, Stream.fromIterable([note(op.note)]))
				break
			case "bind":
				at = at.bind(Rec.fromEntries(Arr.map([...free], (i) => [`task${i}`, uuidOf(i)] as const)))
				free = new Set()
				break
			case "read":
				at = at.read(`read${k}`, () => member(op.member))
				free = new Set([...free, op.member])
				break
			case "union":
				at = ChangeSet.union(at, other)
				break
			case "union after":
				at = ChangeSet.union(other, at)
				break
			case "sequence":
				at = ChangeSet.sequence(at, other)
				break
			case "sequence after":
				at = ChangeSet.sequence(other, at)
		}
		out.push(at)
	}
	return out
}

/**
 * The Description the old path gives: a whole decode of a plain copy, which no shape recognises, its locations' sites
 * read as JSON would carry them (sitesRead).
 */
const decodedWhole = (desc: ChangeSetDesc): ChangeSetDesc => {
	const decoded = decodeDesc("changeSet", structuredClone(sitesRead(desc)))
	if (!decoded.ok) {
		throw decoded.error
	}
	return decoded.value
}

const identityOf = (desc: unknown): IdentityDigest => {
	const identity = descIdentity(desc)
	if (!identity.ok) {
		throw identity.error
	}
	return identity.value
}

/**
 * The old path's checks: the assembled Description equals the whole decode's, its keys in the same order, frozen
 * throughout; and each query member's identity digest is its query's, which the old path computed again at every step.
 */
export const asTheOldPath = (value: ChangeSetValue): void => {
	const desc = descOf(value)
	const whole = decodedWhole(desc)
	const read = sitesRead(desc)
	assert.deepEqual(read, whole)
	assert.deepEqual(keyOrders(read), keyOrders(whole))
	assert.ok(
		Arr.every([...containersOf(desc, new Set())], (c) => Object.isFrozen(c)),
		"the Description is frozen throughout"
	)
	for (const m of defined(changeSetState(value), "a ChangeSet's state").strata.flat()) {
		if (m.kind === "query") {
			assert.equal(m.identity, identityOf(m.query), "a query member's identity is its query's")
		}
	}
}
