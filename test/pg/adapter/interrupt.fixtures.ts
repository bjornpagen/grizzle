/** What the properties of interrupt.test.ts read: its spaces, models and helpers. */

import type { Steered } from "@bjornpagen/testing/explore"
import { type Reached } from "@bjornpagen/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	type Weight,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { onceCalls, variantOf } from "#adapter/db/handles.ts"
import type { LoadedMember } from "#adapter/served/load.ts"
import { Uuid } from "#compiler/public/fields.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { assert, assertVariant } from "#test/support/assert.ts"
import { answered, writeOnce } from "#test/support/calls.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { workFacts } from "#test/support/fixtures/golden/work.ts"
import { pickFrom, pickGen, pickIndex } from "#test/support/pick.ts"
import type { BackendMessage } from "#test/support/wire-tap.ts"

/**
 * One member of a drawn write: a note for a task with none, the deletion of a note, or another text at a note's task.
 */
type Member = { readonly kind: "insert" | "delete" | "put"; readonly pick: number }

/**
 * Where the gate holds among the call's own backend messages of its type: before one inside them, before the last one
 * (a write's COMMIT has run on the server by then), or past the end, where the call completes before the gate.
 */
type Arm = "inside" | "end" | "beyond"

interface GatePoint {
	readonly type: "Z" | "any"
	readonly arm: Arm
	readonly pick: number
}

interface CaseSketch {
	readonly call: "write" | "read"
	/** Whether a read's member is deferrable(...): its transaction begins DEFERRABLE. A write's is never read. */
	readonly deferrable: boolean
	readonly members: ReadonlyArray<Member>
	/**
	 * What the owner session holds first: nothing, a lock on a note the write deletes or puts, or on the task a new note
	 * references, whose deferred reference COMMIT checks; for a deferrable read, either one is a SERIALIZABLE read-write
	 * transaction open with its snapshot taken, which its safe snapshot waits for.
	 */
	readonly blocker: "none" | "statement" | "commit"
	readonly point: GatePoint
}

const pointGen =
	(weights: { readonly [A in Arm]: Weight }): Gen<GatePoint> =>
	(source) => ({
		type: source.draw(element(["Z", "any"] as const)),
		arm: source.draw(
			weighted<Arm>([
				[weights.inside, constant("inside")],
				[weights.end, constant("end")],
				[weights.beyond, constant("beyond")]
			])
		),
		pick: source.draw(pickGen)
	})

const membersGen = array<Member>(
	(source) => ({
		kind: source.draw(element(["insert", "delete", "put"] as const)),
		pick: source.draw(pickGen)
	}),
	{ min: 1, max: 3 }
)

const blockerGen = element(["none", "statement", "commit"] as const)

/**
 * A write three times in four, its gate inside or at the end three times in five; a read once in four, its gate inside
 * or at the end four times in five. In 38 cases (a run's floor and rotating streams) that expects about 7.6 interrupted
 * reads, 22 interrupted writes, 6.2 writes completed before the gate (a write without a lock, the gate past its end),
 * and 13 lock waits: a lock on 46% of writes (a delete or put under a statement lock, an insert under a COMMIT lock),
 * every one interrupted where the server waits on it.
 */
const caseSketchGen: Gen<CaseSketch> = weighted<CaseSketch>([
	[
		3,
		(source) => ({
			call: "write",
			deferrable: false,
			members: source.draw(membersGen),
			blocker: source.draw(blockerGen),
			point: source.draw(pointGen({ inside: 2, end: 1, beyond: 2 }))
		})
	],
	[
		1,
		(source) => ({
			call: "read",
			deferrable: source.draw(boolean),
			members: source.draw(membersGen),
			blocker: source.draw(blockerGen),
			point: source.draw(pointGen({ inside: 3, end: 1, beyond: 1 }))
		})
	]
])

/**
 * Planted: a write completing before a gate past its end; a write deleting a note a lock holds, interrupted where it
 * waits; a write held before its last ReadyForQuery, its COMMIT run, which commits; a read held at once.
 */
const point = (type: GatePoint["type"], arm: Arm): GatePoint => ({ type, arm, pick: 0 })

/**
 * The number of the call's backend messages of the gate's type after which the gate holds, drawn against `traffic`, the
 * call's own messages: before one of them, before the last, or past the end, so the call has every answer first. A call
 * that sends nothing (a write whose members all resolve away) has no message to hold before: its gate holds at once, or
 * past the end.
 */
export const gateCount = (gate: GatePoint, traffic: ReadonlyArray<BackendMessage>): number => {
	const n = gate.type === "Z" ? Arr.filter(traffic, (m) => m.type === "Z").length : traffic.length
	switch (gate.arm) {
		case "inside":
			return n <= 1 ? 0 : pickIndex(gate.pick, n - 1)
		case "end":
			return Math.max(n - 1, 0)
		case "beyond":
			return n + 1 + pickIndex(gate.pick, n + 1)
	}
}

export interface Note {
	readonly task: Uuid
	readonly note: string
}

const tasks: ReadonlyArray<Uuid> = Arr.map(workFacts.Task, (task) => task.id)

const byTask: Order.Order<Note> = Order.mapInput(Order.String, (n: Note) => n.task)

/**
 * A write's members against the notes it starts from, each key once: what it inserts, deletes and puts, and the notes
 * it leaves when accepted.
 */
export const resolveWrite = (
	members: ReadonlyArray<Member>,
	notes: ReadonlyArray<Note>,
	serial: number
) => {
	const inserts: Array<Note> = []
	const deletes: Array<Note> = []
	const puts: Array<Note> = []
	const touched = new Set<string>()
	for (const [i, member] of members.entries()) {
		const noted = new Set(Arr.map(notes, (n) => n.task))
		if (member.kind === "insert") {
			const [first, ...rest] = Arr.filter(tasks, (task) => !noted.has(task) && !touched.has(task))
			if (first === undefined) {
				continue
			}
			const task = pickFrom([first, ...rest], member.pick)
			touched.add(task)
			inserts.push({ task, note: `note ${serial}.${i}` })
			continue
		}
		const [first, ...rest] = Arr.filter(notes, (n) => !touched.has(n.task))
		if (first === undefined) {
			continue
		}
		const target = pickFrom([first, ...rest], member.pick)
		touched.add(target.task)
		if (member.kind === "delete") {
			deletes.push(target)
		} else {
			puts.push({ task: target.task, note: `note ${serial}.${i}` })
		}
	}
	const after = Arr.sort(
		[
			...Arr.map(
				Arr.filter(notes, (n) => !Arr.some(deletes, (d) => d.task === n.task)),
				(n) =>
					Option.getOrElse(
						Arr.findFirst(puts, (p) => p.task === n.task),
						() => n
					)
			),
			...inserts
		],
		byTask
	)
	return { inserts, deletes, puts, after }
}

/** What a case reached: how its call ended against the gate, where it was interrupted, and what the interruption left. */
export type InterruptFeature =
	| `${CaseSketch["call"]} interrupted`
	| `${CaseSketch["call"]} completed before the gate`
	| "deferrable read interrupted"
	| "interrupted where the server waits on a lock"
	| "interrupted where the server waits for a safe snapshot"
	| "committed after an interruption"
	| "rolled back after an interruption"

export const situations: Arr.NonEmptyReadonlyArray<InterruptFeature> = [
	"write interrupted",
	"read interrupted",
	"deferrable read interrupted",
	"write completed before the gate",
	"interrupted where the server waits on a lock",
	"interrupted where the server waits for a safe snapshot",
	"committed after an interruption",
	"rolled back after an interruption"
]

/**
 * A sketch as the generator draws it, aimed at what no witness reached yet (Steered): while no write has completed
 * before its gate, half its cases by a draw of their own are a write under no lock whose gate is past its end, its
 * members and gate type as drawn; while no read has been interrupted waiting for a safe snapshot, half of the rest are
 * a deferrable read under the owner's open transaction; a rotating case is drawn unaimed.
 */
export const aimedSketchGen: Steered<CaseSketch, InterruptFeature> = (steering) => (source) => {
	const sketch = source.draw(caseSketchGen)
	const pending = (feature: InterruptFeature) =>
		Option.exists(steering, (features) => features.has(feature))
	if (pending("write completed before the gate") && source.draw(boolean)) {
		return {
			...sketch,
			call: "write",
			deferrable: false,
			blocker: "none",
			point: { ...sketch.point, arm: "beyond" }
		}
	}
	if (pending("interrupted where the server waits for a safe snapshot") && source.draw(boolean)) {
		return { ...sketch, call: "read", deferrable: true, blocker: "statement" }
	}
	return sketch
}

/** A change member of array members, applied on `ctx` with the call's facts. */
export const applyFacts = (ctx: ServedDbContext, change: LoadedMember, facts: unknown) => {
	assertVariant(change, "kind", "change", "the write's member is a change")
	assert.equal(
		variantOf(ctx, change.variants).call.kind,
		"facts",
		"the write's member takes its call's facts"
	)
	return answered(writeOnce(onceCalls(ctx, change))({ params: {}, facts }))
}

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const workInstall = Object.freeze({ label: "real", programs: {} })

/** W.Work installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const workTemplate = fixtureTemplate(import.meta, W.Work, workInstall)

/**
 * The cases the search kept by value, which reached their situations on every run: each is the aim of the situations
 * it reaches (aimed), so a case whose turn aims at one draws it. None ever caught a bug (git log -S on the module).
 */
const interruptCases: ReadonlyArray<{
	readonly why: string
	readonly value: CaseSketch
	readonly reaches: ReadonlyArray<InterruptFeature>
}> = [
	{
		why: "a write past the gate",
		value: {
			call: "write",
			deferrable: false,
			members: [{ kind: "insert", pick: 0 }],
			blocker: "none",
			point: point("Z", "beyond")
		},
		reaches: ["write completed before the gate"]
	},
	{
		why: "a deletion waiting on a lock",
		value: {
			call: "write",
			deferrable: false,
			members: [{ kind: "delete", pick: 0 }],
			blocker: "statement",
			point: point("Z", "beyond")
		},
		reaches: [
			"interrupted where the server waits on a lock",
			"write interrupted",
			"rolled back after an interruption"
		]
	},
	{
		why: "a write held before its last answer",
		value: {
			call: "write",
			deferrable: false,
			members: [{ kind: "insert", pick: 0 }],
			blocker: "none",
			point: point("Z", "end")
		},
		reaches: ["committed after an interruption"]
	},
	{
		why: "a read held at once",
		value: {
			call: "read",
			deferrable: false,
			members: [{ kind: "insert", pick: 0 }],
			blocker: "none",
			point: point("any", "inside")
		},
		reaches: ["read interrupted"]
	}
]

/** The property's aims (interrupt): each kept case's value at every situation it reaches. */
export const interruptAims: ReadonlyArray<readonly [Reached<InterruptFeature>, Gen<CaseSketch>]> =
	Arr.flatMap(interruptCases, (c) =>
		Arr.map(c.reaches, (situation) => [situation, constant(c.value)] as const)
	)
