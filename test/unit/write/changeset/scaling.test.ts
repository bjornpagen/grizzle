import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { array, element, int, map } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec, Stream } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { type ChangeSetDesc, decodeDesc, descText } from "#compiler/ir/desc.ts"
import { queryOver as query, queryValueDesc, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import {
	changeSetOver as ChangeSet,
	type ChangeSetValue,
	changeSetState
} from "#compiler/write/changeset/value.ts"
import { assert, defined } from "#test/support/assert.ts"
import { Task, TaskNote, Work } from "#test/support/fixtures/api/work.ts"
import { caseHang } from "#test/support/limits.ts"
import { sitesRead } from "#test/support/sites.ts"
import { descOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A ChangeSet builder step reads only what it adds. Its Description is its members' own Descriptions assembled, so
 * every container of the Description before the step, and of the query it adds, is carried into the one after it by
 * reference: the step builds a fixed number of containers whatever the ChangeSet's size, where a decode of the whole
 * would copy every one. Its member states are carried by reference too, so the step computes the identity text of its
 * new member alone. Both counts are taken at four sizes. The assembled Description is the one the whole decode gives,
 * the old path, kept here as the oracle.
 */

/** The arrays and plain objects reachable from `value`, added to `into`. */
const containersOf = (value: unknown, into: Set<object>): Set<object> => {
	const pending: Array<unknown> = [value]
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		if (isRecord(at) && !into.has(at)) {
			into.add(at)
			for (const child of Rec.values(at)) {
				pending.push(child)
			}
		}
	}
	return into
}

/** The containers reachable from `value` without passing through one of `known`: the ones a step built. */
const freshContainers = (value: unknown, known: ReadonlySet<object>): number => {
	const seen = new Set<object>()
	const pending: Array<unknown> = [value]
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		if (isRecord(at) && !known.has(at) && !seen.has(at)) {
			seen.add(at)
			for (const child of Rec.values(at)) {
				pending.push(child)
			}
		}
	}
	return seen.size
}

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

const growthNames = [
	"a query member",
	"an array member into its group, then a query member",
	"a query member after a bind"
] as const

type GrowthName = (typeof growthNames)[number]

const growths: Readonly<Record<GrowthName, Growth>> = {
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
const counts = (growth: Growth, n: number): ReadonlyArray<StepCount> => {
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

const opOf = (kind: number, n: number): Op => {
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
const built = (ops: ReadonlyArray<Op>): ReadonlyArray<ChangeSetValue> => {
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

/** The keys of every object reachable from `value`, in order, by path: the key order a Description has. */
const keyOrders = (value: unknown): ReadonlyArray<string> => {
	const out: Array<string> = []
	const pending: Array<readonly [string, unknown]> = [["", value]]
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		const [path, node] = at
		if (isRecord(node)) {
			out.push(`${path}: ${Arr.join(Rec.keys(node), ",")}`)
			for (const [key, child] of Rec.toEntries(node)) {
				pending.push([`${path}.${key}`, child])
			}
		}
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

const textOf = (desc: unknown): string => {
	const text = descText(desc)
	if (!text.ok) {
		throw text.error
	}
	return text.value
}

/**
 * The old path's checks: the assembled Description equals the whole decode's, its keys in the same order, frozen
 * throughout; and each query member's text is its query's, which the old path encoded again at every step.
 */
const asTheOldPath = (value: ChangeSetValue): void => {
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
			assert.equal(m.text, textOf(m.query), "a query member's text is its query's")
		}
	}
}

describe("a ChangeSet builder step reads only what it adds", () => {
	it.effect(
		"builds a fixed number of containers and one member state a step, at 50, 100, 200 and 400",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/write/changeset/step-reads",
						generator: (source) =>
							[
								source.draw(element(growthNames)),
								source.draw(map(int(0, 3), (doublings) => 50 * 2 ** doublings))
							] as const,
						literal: Formatter.format,
						limit: 12,
						coverage: noCoverage,
						caseHang
					},
					([name, n]) =>
						Effect.sync(() => {
							const steps = counts(growths[name], n)
							const first = defined(steps[0], "the first step")
							assert.equal(first.members, 1)
							for (const [i, step] of steps.entries()) {
								assert.deepEqual(step, first, `step ${i + 1} of ${n}`)
							}
						})
				)
			)
	)

	it.effect("assembles the Description the whole decode gives, over generated programs", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/write/changeset/assembled",
					draw: drawn((source) =>
						Arr.map(source.draw(array(int(0, 10), { min: 1, max: 12 })), (kind) =>
							opOf(kind, source.draw(int(1, 4)))
						)
					),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(ops) =>
					Effect.sync(() => {
						for (const value of built(ops)) {
							asTheOldPath(value)
						}
					})
			)
		)
	)
})
