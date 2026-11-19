/** What the properties of closure-cost.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { type Dependency, implication, projectionCloses } from "#compiler/ir/keys.ts"
import { conservativeMeta, type DeclaredKey, type ValidDag } from "#compiler/ir/rel.ts"
import { Ir, type SchemaModel } from "#test/support/fixtures/ir/build.ts"
import { workModel } from "#test/support/fixtures/ir/work.ts"
import type { CallSite } from "#test/support/kernel/calls.ts"
import { type Table, tableGen } from "#test/unit/analysis/logical/keys.fixtures.ts"

/** A drawn dependency table (keys.fixtures.ts tableGen) and a start, the mask of the columns its closure starts from. */
export interface Started {
	readonly table: Table
	readonly start: number
}

export const startedGen: Gen<Started> = (source) => {
	const table = source.draw(tableGen)
	return { table, start: source.draw(int(0, 2 ** table.width - 1)) }
}

/** A drawn table's columns, c0 to c(width − 1). */
export const columnsOf = (table: Table): ReadonlyArray<string> =>
	Arr.map(indices(table.width), (i) => `c${i}`)

/** The columns of `mask`, in heading order. */
export const columnsIn = (table: Table, mask: number): ReadonlyArray<string> =>
	Arr.filter(columnsOf(table), (_, i) => (mask & (1 << i)) !== 0)

/** A drawn table's dependencies, each a projection's closing over an input of no steps. */
export const dependenciesOf = (table: Table): ReadonlyArray<Dependency> =>
	Arr.map(table.dependencies, (d) =>
		projectionCloses(
			columnsIn(table, d.from),
			columnsIn(table, d.to),
			implication(columnsIn(table, d.from), [])
		)
	)

/** The closure of `start` under a drawn table's dependencies, by brute force: every dependency fired until none adds. */
export const closedMask = (table: Table, start: number): number => {
	let known = start
	for (let changed = true; changed;) {
		changed = false
		for (const d of table.dependencies) {
			if ((d.from & ~known) === 0 && (d.to & ~known) !== 0) {
				known |= d.to
				changed = true
			}
		}
	}
	return known
}

/** The columns a mask holds. */
export const sizeOfMask = (mask: number): number =>
	Arr.reduce(indices(32), 0, (n, i) => n + ((mask >>> i) & 1))

export type ClosureFeature =
	| "a closure that adds nothing"
	| "a closure of three passes or more"
	| "a dependency that never fires"

/** A closure's one visit of a dependency in a pass (logical/closure.ts closure). */
export const steps = Object.freeze({
	step: { file: "packages/engine/src/logical/closure.ts", name: "step" }
} satisfies Readonly<Record<string, CallSite>>)

/**
 * Where the analysis interns a node's attributes and its dependencies over them, beside every node's properties built
 * and every closure computed.
 */
export const interning = Object.freeze({
	finish: { file: "packages/engine/src/logical/props.ts", name: "finish" },
	attributesOver: { file: "packages/engine/src/logical/attributes.ts", name: "attributesOver" },
	rowsOf: { file: "packages/engine/src/logical/closure.ts", name: "rowsOf" },
	closure: { file: "packages/engine/src/logical/closure.ts", name: "closure" }
} satisfies Readonly<Record<string, CallSite>>)

export type InterningFeature = "one relation" | "several relations"

/** Where a node's logical properties are built, and a Base's and a Delta's physical properties. */
export const readings = Object.freeze({
	finish: { file: "packages/engine/src/logical/props.ts", name: "finish" },
	baseProps: { file: "packages/engine/src/analysis/physical/rules.ts", name: "baseProps" },
	deltaProps: { file: "packages/engine/src/analysis/physical/rules.ts", name: "deltaProps" }
} satisfies Readonly<Record<string, CallSite>>)

export type ReadingFeature = "one query of a reading" | "several queries of a reading"

/**
 * The work model's tasks as every query of one schema reads them: the model, the primary key each Base of Task is read
 * by and the keys each Delta of it holds, one array each, as a schema's are its relation's (check/checker.ts
 * deltaKeys), each this reading's own, so no other case's reading shares them.
 */
export interface TaskReading {
	readonly model: SchemaModel
	readonly primaryKey: DeclaredKey
	readonly deltaKeys: ReadonlyArray<DeclaredKey>
}

/** A fresh schema's reading of its tasks (TaskReading). */
export const taskReading = (): TaskReading => {
	const model = workModel()
	const task = model.relation("Task")
	if (task.kind === "closed") {
		throw new Error("fixture: the work model's Task is an ordinary relation")
	}
	const [first, ...rest] = task.primaryKey
	const primaryKey: DeclaredKey = [first, ...rest]
	return { model, primaryKey, deltaKeys: [primaryKey, ...task.keys] }
}

/**
 * One query of a schema's tasks, a DAG of its own: a Base over Task semi-joined on its primary key to the tasks a
 * write added, a Delta of Task.
 */
export const readingQuery = (reading: TaskReading): ValidDag => {
	const q = new Ir(reading.model)
	const task = reading.model.relation("Task")
	if (task.kind === "closed") {
		throw new Error("fixture: the work model's Task is an ordinary relation")
	}
	const added = q.b.node({
		kind: "Delta",
		relation: task.name,
		side: "added",
		keys: reading.deltaKeys,
		heading: task.heading,
		loc: undefined,
		meta: conservativeMeta
	})
	const base = q.b.node({
		kind: "Base",
		relation: task.name,
		occurrence: q.b.ids.occurrence(),
		primaryKey: reading.primaryKey,
		keys: task.keys,
		relationKind: "relation",
		heading: task.heading,
		loc: undefined,
		meta: conservativeMeta
	})
	return q.build(
		q.semi(
			base,
			added,
			Arr.map(reading.primaryKey, (k) => [k, k] as const)
		)
	).dag
}
