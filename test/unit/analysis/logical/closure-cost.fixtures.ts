/** What the properties of closure-cost.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/testing/assert"
import { boolean, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { assembledDag } from "#compiler/ir/dag.ts"
import { type Dependency, implication, projectionCloses } from "#compiler/ir/keys.ts"
import {
	conservativeMeta,
	type DeclaredKey,
	type RelNode,
	type ValidDag
} from "#compiler/ir/rel.ts"
import { attributesOver, bitsOf } from "#compiler/logical/attributes.ts"
import {
	type NameSource,
	type Naming,
	namesNone,
	namingOver,
	type Rows
} from "#compiler/logical/closure.ts"
import { Ir, type SchemaModel } from "#test/support/fixtures/ir/build.ts"
import { workModel } from "#test/support/fixtures/ir/work.ts"
import type { CountedFunction } from "#test/support/kernel/calls.ts"
import { int4, type Table, tableGen } from "#test/unit/analysis/logical/keys.fixtures.ts"

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

/**
 * A drawn naming of a table's closure (logical/closure.ts Naming): where each dependency reads the value it fixes each of
 * its targets to, by its targets in heading order. A value of its own; a copy of another column's value, named once that
 * column is, so a dependency asked before it names nothing and is asked again once it is named; or none.
 */
export type DrawnSource =
	| { readonly kind: "value"; readonly value: number }
	| { readonly kind: "copy"; readonly column: number }
	| { readonly kind: "none" }

/** A drawn table, a start and each dependency's sources, one for each of its targets. */
export interface NamedStart extends Started {
	readonly sources: ReadonlyArray<ReadonlyArray<DrawnSource>>
}

/**
 * A drawn table with sources for each target, and, when drawn over two columns or more, a chain around it: a first
 * dependency of no determinants fixing a column x to a copy of a column y, and a last one fixing y to a value of its own,
 * neither in the start. The first is asked before y is named and must be asked again once the last names it, at a later
 * pass, so the chain is a naming the passes reach only by asking a row again.
 */
export const namedStartGen: Gen<NamedStart> = (source) => {
	const drawn = source.draw(startedGen)
	const width = drawn.table.width
	const sourceGen: Gen<DrawnSource> = (s) => {
		const kind = s.draw(int(0, 2))
		return kind === 0
			? { kind: "value", value: s.draw(int(0, 3)) }
			: kind === 1
				? { kind: "copy", column: s.draw(int(0, width - 1)) }
				: { kind: "none" }
	}
	const sources = Arr.map(drawn.table.dependencies, (d) =>
		Arr.map(indices(sizeOfMask(d.to)), () => source.draw(sourceGen))
	)
	if (width < 2 || !source.draw(boolean)) {
		return { ...drawn, sources }
	}
	const x = source.draw(int(0, width - 1))
	const y = (x + source.draw(int(1, width - 1))) % width
	return {
		table: {
			width,
			dependencies: [{ from: 0, to: 1 << x }, ...drawn.table.dependencies, { from: 0, to: 1 << y }]
		},
		start: drawn.start & ~((1 << x) | (1 << y)),
		sources: [
			[{ kind: "copy", column: y }],
			...sources,
			[{ kind: "value", value: source.draw(int(0, 3)) }]
		]
	}
}

/** The naming the drawn sources state over the table's rows, each copy of a column read at its position. */
export const namingOf = (
	rows: Rows,
	sources: ReadonlyArray<ReadonlyArray<DrawnSource>>
): Naming<number> =>
	namingOver(
		rows,
		Arr.map(sources, (targets) =>
			Arr.map(targets, (s): NameSource<number> =>
				s.kind === "value" ? s : s.kind === "copy" ? { kind: "copy", at: s.column } : namesNone
			)
		)
	)

/** What a closure reaches and how, by the columns' indexes: as logical/closure.ts Closure reads them. */
export interface PassClosure {
	readonly sequence: ReadonlyArray<number>
	/** Each column's row, by its index plus one: 0 by the start, or for a column not reached. */
	readonly by: ReadonlyArray<number>
	readonly fired: ReadonlyArray<number>
	readonly named: ReadonlyMap<number, number>
	/** The passes each round took, the last adding nothing. */
	readonly passes: ReadonlyArray<number>
	/** Whether a row asked when some target was left unnamed named one when it was asked again. */
	readonly askedAgain: boolean
}

/**
 * The closure of `start` as passes over the dependencies in table order compute it (the reference): with `sources`, a
 * round of the namings first, each row asked at its turn once its determinants are reached and again in each pass after
 * any value is named, then a round of every row; each round passing over the rows until a pass adds nothing, a row's
 * targets reached when its visit ends, in heading order.
 */
export const passClosure = (
	table: Table,
	start: number,
	sources: ReadonlyArray<ReadonlyArray<DrawnSource>> | undefined
): PassClosure => {
	const rows = table.dependencies
	let reached = start
	const sequence = Arr.filter(indices(table.width), (c) => (start & (1 << c)) !== 0)
	const by = Arr.map(indices(table.width), () => 0)
	const fired: Array<number> = []
	const named = new Map<number, number>()
	const spent = Arr.map(rows, () => false)
	const askedAt = Arr.map(rows, () => 0)
	const left = Arr.map(rows, () => false)
	let askedAgain = false
	const passes: Array<number> = []
	const round = (naming: boolean): void => {
		let pass = 0
		for (let changed = true; changed; pass++) {
			changed = false
			Arr.forEach(rows, (d, i) => {
				if (
					spent[i] === true ||
					(d.from & ~reached) !== 0 ||
					(naming && askedAt[i] === named.size + 1)
				) {
					return
				}
				const asked = named.size
				const added: Array<number> = []
				let unreached = 0
				let target = 0
				for (let c = 0; c < table.width; c++) {
					if ((d.to & (1 << c)) === 0) {
						continue
					}
					const at = target
					target++
					if ((reached & (1 << c)) !== 0) {
						continue
					}
					unreached++
					if (!naming) {
						added.push(c)
						continue
					}
					const s = defined(sources?.[i]?.[at], "a target's source")
					const value =
						s.kind === "value" ? s.value : s.kind === "copy" ? named.get(s.column) : undefined
					if (value !== undefined) {
						named.set(c, value)
						added.push(c)
					}
				}
				if (left[i] === true && added.length > 0) {
					askedAgain = true
				}
				if (added.length === unreached) {
					spent[i] = true
				} else {
					askedAt[i] = asked + 1
					left[i] = true
				}
				if (added.length === 0) {
					return
				}
				if (!fired.includes(i)) {
					fired.push(i)
				}
				for (const c of added) {
					if ((reached & (1 << c)) !== 0) {
						continue
					}
					reached |= 1 << c
					by[c] = i + 1
					sequence.push(c)
				}
				changed = true
			})
		}
		passes.push(pass)
	}
	if (sources !== undefined) {
		round(true)
	}
	round(false)
	return { sequence, by, fired, named, passes, askedAgain }
}

/** A closure's visit of a due row, and its test of whether a pass would visit a row (logical/closure.ts closure). */
export const visitSites = Object.freeze({
	step: { file: "packages/engine/src/logical/closure.ts", name: "step" },
	visits: { file: "packages/engine/src/logical/closure.ts", name: "visits" }
} satisfies Readonly<Record<string, CountedFunction>>)

/** A closure's test that a set holds an attribute, which its visit of a row reads once for each target it scans. */
export const targetSites = Object.freeze({
	holdsAt: { file: "packages/engine/src/logical/attributes.ts", name: "holdsAt" }
} satisfies Readonly<Record<string, CountedFunction>>)

/**
 * A table of n columns c0, …, c(n − 1) whose every column alone determines every other, each row closed as a parent's
 * carried row is (logical/props.ts carried: a determinant to the whole of its closure): a closure from c0 reaches every
 * column by its first row, and every other row is then due and visited with no target left to reach.
 */
export const closedTable = (n: number) => {
	const columns = Arr.map(indices(n), (i) => `c${i}`)
	const attributes = attributesOver(columns, [])
	const dependencies = Arr.map(columns, (c) =>
		projectionCloses(
			[c],
			Arr.filter(columns, (o) => o !== c),
			implication([c], [])
		)
	)
	return { attributes, dependencies, start: bitsOf(attributes, ["c0"]) }
}

/**
 * Closures over one table, one after another: a drawn table and its sources (namedStartGen), and two to four further
 * starts, each closed with the table's naming or with none.
 */
export interface SharedStarts extends NamedStart {
	readonly starts: ReadonlyArray<{ readonly start: number; readonly named: boolean }>
}

export const sharedStartsGen: Gen<SharedStarts> = (source) => {
	const drawn = source.draw(namedStartGen)
	const width = drawn.table.width
	const starts = Arr.map(indices(source.draw(int(2, 4))), () => ({
		start: source.draw(int(0, 2 ** width - 1)),
		named: source.draw(boolean)
	}))
	return { ...drawn, starts: [{ start: drawn.start, named: true }, ...starts] }
}

/**
 * A drawn table whose every dependency holds through an evidence stage of three, 0 the least demanding, a start, and
 * the stage a closure is asked through.
 */
export interface StagedStart extends Started {
	readonly stages: ReadonlyArray<number>
	readonly through: number
}

export const stagedStartGen: Gen<StagedStart> = (source) => {
	const drawn = source.draw(startedGen)
	return {
		...drawn,
		stages: Arr.map(drawn.table.dependencies, () => source.draw(int(0, 2))),
		through: source.draw(int(0, 2))
	}
}

export type StagedFeature =
	| "a row a stage does not admit that the whole table fires"
	| "a stage admitting every row"
	| "a row of the stage itself that fires"

export type SharedFeature =
	| "a named closure after an unnamed one"
	| "a closure after one that reached every column"
	| "a closure that fires a row the one before it spent"

export type NamingFeature =
	| "a row asked again once a value is named"
	| "a value named"
	| "a column reached by a row that names nothing"

/** A key search's tests of a candidate against the keys found: a scan's subset tests, or a set-trie's node visits. */
export const keySearchSites = Object.freeze({
	subsetOf: { file: "packages/engine/src/logical/attributes.ts", name: "subsetOf" },
	keyWithin: { file: "packages/engine/src/logical/closure.ts", name: "keyWithin" }
} satisfies Readonly<Record<string, CountedFunction>>)

export type CyclePoint = "from n = 4" | "from n = 6"

/** The factor search's firing of a dependency (logical/closure.ts factorClosures). */
export const factorSites = Object.freeze({
	fire: { file: "packages/engine/src/logical/closure.ts", name: "fire" }
} satisfies Readonly<Record<string, CountedFunction>>)

/**
 * A factor search over m dependencies {a_i, b_i} → c_i, each made redundant by a_i → c_i, beside m dependencies of no
 * determinant each fixing a column g_j: columns a_0, b_0, c_0, a_1, …, then g_0, …, each its own position. The minimal
 * keys are every a_i and b_i, so its factors are each of them alone, in that order.
 */
export const redundantTable = (m: number) => {
	const columns = [
		...Arr.flatMap(indices(m), (i) => [`a${i}`, `b${i}`, `c${i}`]),
		...Arr.map(indices(m), (j) => `g${j}`)
	]
	const attributes = attributesOver(columns, [])
	const at = (names: ReadonlyArray<string>) => bitsOf(attributes, names)
	const position = (name: string) => defined(attributes.at.get(name), `the position of ${name}`)
	return {
		attributes,
		columns: attributes.heading,
		stated: [
			...Arr.flatMap(indices(m), (i) => [
				{ from: at([`a${i}`, `b${i}`]), to: [position(`c${i}`)] },
				{ from: at([`a${i}`]), to: [position(`c${i}`)] }
			]),
			...Arr.map(indices(m), (j) => ({ from: at([]), to: [position(`g${j}`)] }))
		],
		factors: Arr.flatMap(indices(m), (i) => [[`a${i}`], [`b${i}`]])
	}
}

export type FactorPoint = "from m = 4" | "from m = 6"

/**
 * Over a relation parameter of m columns c_i, a projection of m computed outputs p_i = c_i + 1, a region binding each
 * p_i to a variable v_i, and a projection of m computed outputs o_i = v_i + 1: each projection's step from what its
 * input's key reaches determines its every output, and the region's from the hidden attributes the first projection's
 * outputs are computed from binds its every variable, so each node has one step of m targets, each read off a reading
 * of m outputs or bindings.
 */
export const indexedReading = (m: number): ValidDag => {
	const q = new Ir(workModel())
	const columns = Arr.map(indices(m), (i) => `c${i}`)
	const rows = q.input(
		"rows",
		Arr.map(columns, (c) => [c, int4] as const)
	)
	const computed = q.project(
		rows,
		Arr.map(columns, (c) => [`p_${c}`, q.op("add", [q.col(rows, c), q.lit(1, int4)])] as const),
		conservativeMeta
	)
	const region = q.region(
		[
			{
				source: computed,
				bind: Rec.fromEntries(Arr.map(columns, (c) => [`p_${c}`, `v${c}`] as const)),
				constants: {}
			}
		],
		conservativeMeta
	)
	return q.build(
		q.project(
			region,
			Arr.map(
				columns,
				(c) => [`o_${c}`, q.op("add", [q.col(region, `v${c}`), q.col(region, `v${c}`)])] as const
			),
			conservativeMeta
		)
	).dag
}

/**
 * Two queries of one compile reading one shared sub-DAG of n nodes, as a compile's queries read one closed import: a
 * chain of n projections over the tasks, each keeping their columns, and each query its own account with its tasks
 * attached; built by one builder, so the queries read the one chain node and hold their own nodes under labels apart.
 * `inner` is the node the chain's last projection reads, a node of the chain no attachment revises.
 */
export const sharedChain = (
	n: number
): {
	readonly shared: RelNode
	readonly inner: RelNode
	readonly queries: readonly [ValidDag, ValidDag]
} => {
	const q = new Ir(workModel())
	let inner = q.base("Task")
	let shared = inner
	for (const _ of indices(n)) {
		inner = shared
		shared = q.project(
			shared,
			[
				["id", "id"],
				["account", "account"],
				["kind", "kind"]
			],
			conservativeMeta
		)
	}
	const query = (name: string): ValidDag =>
		q.build(q.attach(q.base("Account"), shared, name, [["id", "account"]], "array", undefined)).dag
	return { shared, inner, queries: [query("tasks"), query("work")] }
}

/**
 * A shared node S over a correlated attachment A whose child only A reads, under an unshared filter, and three DAGs over
 * them: the filter's own, the filter's with A's child a root too, which gives the child a second reader, and one rooted
 * at A and S, which reaches A inside S's record both through S and as a root of its own (logical/annotate.ts
 * SharedAnalyses readers). `width` is how many columns of the tasks the child keeps.
 */
export const insideRecord = (
	width: number
): {
	readonly shared: RelNode
	readonly dags: readonly [ValidDag, ValidDag, ValidDag]
} => {
	const q = new Ir(workModel())
	const columns = Arr.take(["id", "account", "kind"] as const, width)
	const child = q.project(
		q.base("Task"),
		Arr.map(["account", ...Arr.filter(columns, (c) => c !== "account")], (c) => [c, c] as const),
		conservativeMeta
	)
	const attached = q.attach(
		q.base("Account"),
		child,
		"tasks",
		[["id", "account"]],
		"array",
		undefined
	)
	const shared = q.project(
		attached,
		[
			["id", "id"],
			["name", "name"]
		],
		conservativeMeta
	)
	const top = q.filter(shared, q.eq(q.col(shared, "id"), q.col(shared, "id")))
	return {
		shared,
		dags: [assembledDag([top]), assembledDag([top, child]), assembledDag([attached, shared])]
	}
}

export type SharedPoint = "from n = 4" | "from n = 6"

export type ReadingPoint = "from m = 8" | "from m = 12"

/**
 * Where the analysis interns a node's attributes and its dependencies over them, beside every node's properties built
 * and every closure computed.
 */
export const interning = Object.freeze({
	finish: { file: "packages/engine/src/logical/props.ts", name: "finish" },
	attributesOver: { file: "packages/engine/src/logical/attributes.ts", name: "attributesOver" },
	rowsOf: { file: "packages/engine/src/logical/closure.ts", name: "rowsOf" },
	closure: { file: "packages/engine/src/logical/closure.ts", name: "closure" }
} satisfies Readonly<Record<string, CountedFunction>>)

export type InterningFeature = "one relation" | "several relations"

/** Where a node's logical properties are built, and a Base's and a Delta's physical properties. */
export const readings = Object.freeze({
	finish: { file: "packages/engine/src/logical/props.ts", name: "finish" },
	baseProps: { file: "packages/engine/src/analysis/physical/rules.ts", name: "baseProps" },
	deltaProps: { file: "packages/engine/src/analysis/physical/rules.ts", name: "deltaProps" }
} satisfies Readonly<Record<string, CountedFunction>>)

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
		generated: [],
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
