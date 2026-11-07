/**
 * Generated EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) captures for the plan readers' tests
 * (harness.test.ts): a plan tree whose every node is generated in a role (a stored scan, a Bitmap Index Scan under its
 * heap scan, a scan that re-reads rows, a generating scan, a write, or a node over children) with the keys PostgreSQL
 * prints for its type and none it leaves out, WAL counters on every node or on none, and the statement's planning,
 * triggers, serialization and settings; the reading each must read back; its text as PostgreSQL prints it, keys no
 * reader reads among them; and faults PostgreSQL never prints, planted in it.
 */
import { array, boolean, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import type { Source } from "@grizzle/testing/source"
import { Array as Arr, Option, Record as Rec } from "effect"
import type {
	Buffers,
	EstimatedNode,
	Explained,
	PlanNode,
	TriggerCalls,
	WalCounters
} from "#bench/harness/explain.ts"

type Json = Readonly<Record<string, unknown>>

/** What a plan node's rows are to the plan readers, by the part its type plays. */
export type Role =
	| "stored scan"
	| "bitmap index scan"
	| "re-read"
	| "generating"
	| "modify"
	| "inner"

/** A plan node without its children: what a generated node states of itself. */
type Fields = Omit<PlanNode, "children">

/** A generated plan node: its role, its fields as the reader must return them, PostgreSQL's keys no reader reads, and its children. */
interface Sketch {
	readonly role: Role
	readonly fields: Fields
	readonly noise: Json
	readonly children: ReadonlyArray<Sketch>
}

/** A generated EXPLAIN (ANALYZE, BUFFERS, ...) result: the plan, and the statement's own figures. */
interface CaptureSketch {
	readonly plan: Sketch
	readonly planningMs: number
	readonly executionMs: number
	readonly planningBuffers: Buffers
	readonly triggers: ReadonlyArray<TriggerCalls>
	readonly serialization: Explained["serialization"]
	readonly settings: Readonly<Record<string, string>>
}

/** The keys of a node no type of it states. */
const bareKeys = () => ({
	parentRelationship: Option.none<string>(),
	operation: Option.none<string>(),
	joinType: Option.none<string>(),
	strategy: Option.none<string>(),
	relation: Option.none<string>(),
	schema: Option.none<string>(),
	alias: Option.none<string>(),
	index: Option.none<string>(),
	cte: Option.none<string>(),
	functionName: Option.none<string>(),
	indexCond: Option.none<string>(),
	recheckCond: Option.none<string>(),
	filter: Option.none<string>(),
	joinFilter: { kind: "none" } as const,
	orderBy: Option.none<string>(),
	sortKey: Option.none<ReadonlyArray<string>>()
})

const small: Gen<number> = int(0, 40)

const buffersGen: Gen<Buffers> = (source) => ({
	sharedHit: source.draw(small),
	sharedRead: source.draw(small),
	sharedDirtied: source.draw(small),
	sharedWritten: source.draw(small),
	localHit: source.draw(small),
	localRead: source.draw(small),
	localDirtied: source.draw(small),
	localWritten: source.draw(small),
	tempRead: source.draw(small),
	tempWritten: source.draw(small)
})

/** A figure PostgreSQL prints with a fraction, as costs and PG19's actual rows are. */
const figure: Gen<number> = (source) =>
	source.draw(int(0, 400)) / source.draw(element([1, 4, 100] as const))

const optional =
	<A>(gen: Gen<A>): Gen<Option.Option<A>> =>
	(source) =>
		source.draw(boolean) ? Option.some(source.draw(gen)) : Option.none()

const condition = element([
	"(id < 50)",
	"(k = $1)",
	"(flag)",
	"(e1.dst = e2.src)",
	"((a)::text ~~ 'x%'::text)"
] as const)
const relationGen = element(["t", "parent", "child", "edge"] as const)
const relationshipGen = element([
	"Outer",
	"Inner",
	"Member",
	"Subquery",
	"SubPlan",
	"InitPlan"
] as const)
const indexGen = element(["t_pkey", "parent_k", "child_parent", "edge_src"] as const)

const walGen = (captured: boolean): Gen<WalCounters> =>
	captured
		? (source) => ({
				kind: "captured",
				records: source.draw(small),
				fpi: source.draw(small),
				bytes: source.draw(int(0, 9000)),
				fpiBytes: source.draw(small)
			})
		: () => ({ kind: "notCaptured" })

/** A node of `nodeType`: its figures and counters, with no key its type states and nothing removed. */
const nodeOf =
	(nodeType: string, wal: boolean): Gen<Fields> =>
	(source) => ({
		...bareKeys(),
		nodeType,
		parentRelationship: source.draw(optional(relationshipGen)),
		startupCost: source.draw(figure),
		totalCost: source.draw(figure),
		planRows: source.draw(small),
		planWidth: source.draw(small),
		actualRows: source.draw(figure),
		actualLoops: source.draw(int(0, 6)),
		rowsRemovedByFilter: 0,
		rowsRemovedByIndexRecheck: 0,
		rowsRemovedByJoinFilter: 0,
		indexSearches: Option.none(),
		heapFetches: Option.none(),
		sort: Option.none(),
		hash: Option.none(),
		cache: Option.none(),
		workersLaunched: Option.none(),
		buffers: source.draw(buffersGen),
		wal: source.draw(walGen(wal))
	})

/** Keys EXPLAIN prints on a node that no reader reads. */
const noiseGen: Gen<Json> = (source) =>
	source.draw(boolean)
		? {
				"Parallel Aware": source.draw(boolean),
				"Async Capable": false,
				Disabled: false,
				"Shared I/O Read Time": 0.0,
				"Temp I/O Write Time": 0.0,
				"WAL Buffers Full": 0
			}
		: {}

/** A filter, with the rows it removed, on a node; or none, which removed nothing. */
const withFilter = (source: Source, fields: Fields): Fields => {
	const filter = source.draw(optional(condition))
	return {
		...fields,
		filter,
		rowsRemovedByFilter: Option.isSome(filter) ? source.draw(small) : 0
	}
}

const sketch = (
	source: Source,
	role: Role,
	fields: Fields,
	children: ReadonlyArray<Sketch>
): Sketch => ({
	role,
	fields,
	noise: source.draw(noiseGen),
	children
})

/** A node that reads a stored relation; a Bitmap Heap Scan's one child is its Bitmap Index Scan. */
const storedScan =
	(wal: boolean): Gen<Sketch> =>
	(source) => {
		const nodeType = source.draw(
			element([
				"Seq Scan",
				"Index Scan",
				"Index Only Scan",
				"Bitmap Heap Scan",
				"Tid Scan",
				"Sample Scan"
			] as const)
		)
		const base = withFilter(source, {
			...source.draw(nodeOf(nodeType, wal)),
			relation: Option.some(source.draw(relationGen)),
			schema: source.draw(optional(element(["public", "gzs_1"] as const))),
			alias: source.draw(optional(element(["t", "e1", "e2"] as const)))
		})
		switch (nodeType) {
			case "Index Scan":
			case "Index Only Scan":
				return sketch(
					source,
					"stored scan",
					{
						...base,
						index: Option.some(source.draw(indexGen)),
						indexCond: source.draw(optional(condition)),
						orderBy: source.draw(optional(element(["(v <-> '[1,2]'::vector)"] as const))),
						indexSearches: source.draw(optional(small)),
						heapFetches:
							nodeType === "Index Only Scan" ? Option.some(source.draw(small)) : Option.none(),
						rowsRemovedByIndexRecheck: source.draw(small)
					},
					[]
				)
			case "Bitmap Heap Scan":
				return sketch(
					source,
					"stored scan",
					{
						...base,
						recheckCond: Option.some(source.draw(condition)),
						rowsRemovedByIndexRecheck: source.draw(small)
					},
					[
						sketch(
							source,
							"bitmap index scan",
							{
								...source.draw(nodeOf("Bitmap Index Scan", wal)),
								index: Option.some(source.draw(indexGen)),
								indexCond: Option.some(source.draw(condition)),
								indexSearches: source.draw(optional(small))
							},
							[]
						)
					]
				)
			case "Seq Scan":
			case "Tid Scan":
			case "Sample Scan":
				return sketch(source, "stored scan", base, [])
		}
	}

/** A node that generates its rows: a set-returning function, a table function, a VALUES list. */
const generating =
	(wal: boolean): Gen<Sketch> =>
	(source) => {
		const nodeType = source.draw(
			element(["Function Scan", "Table Function Scan", "Values Scan"] as const)
		)
		const fields = withFilter(source, source.draw(nodeOf(nodeType, wal)))
		return sketch(
			source,
			"generating",
			nodeType === "Function Scan"
				? { ...fields, functionName: Option.some("generate_series"), alias: Option.some("g") }
				: fields,
			[]
		)
	}

/** A leaf: a stored scan, a generating scan, or a scan that re-reads a CTE's or a work table's rows. */
const leaf = (wal: boolean): Gen<Sketch> =>
	weighted<Sketch>([
		[4, storedScan(wal)],
		[2, generating(wal)],
		[
			1,
			(source) => {
				const nodeType = source.draw(
					element(["CTE Scan", "WorkTable Scan", "Named Tuplestore Scan"] as const)
				)
				const fields = withFilter(source, source.draw(nodeOf(nodeType, wal)))
				return sketch(
					source,
					"re-read",
					nodeType === "CTE Scan"
						? { ...fields, cte: Option.some("c"), alias: Option.some("c") }
						: fields,
					[]
				)
			}
		]
	])

/** A node over children: a join, a hash, a sort, an aggregate, a cache, a subquery scan or a write. */
const inner =
	(wal: boolean, depth: number): Gen<Sketch> =>
	(source) => {
		const below = (count: number): ReadonlyArray<Sketch> =>
			source.draw(array(planGen(wal, depth - 1), { min: count, max: count }))
		const kind = source.draw(
			element([
				"Nested Loop",
				"Hash Join",
				"Hash",
				"Sort",
				"Aggregate",
				"Memoize",
				"Gather",
				"Append",
				"Subquery Scan",
				"ModifyTable"
			] as const)
		)
		const fields = source.draw(nodeOf(kind, wal))
		switch (kind) {
			case "Nested Loop":
			case "Hash Join": {
				const joinFilter = source.draw(optional(condition))
				return sketch(
					source,
					"inner",
					{
						...fields,
						joinType: Option.some(source.draw(element(["Inner", "Left", "Semi", "Anti"] as const))),
						joinFilter: Option.match(joinFilter, {
							onNone: () => ({ kind: "none" }) as const,
							onSome: (c) => ({ kind: "filter", condition: c }) as const
						}),
						rowsRemovedByJoinFilter: Option.isSome(joinFilter) ? source.draw(small) : 0
					},
					below(2)
				)
			}
			case "Hash":
				return sketch(
					source,
					"inner",
					{
						...fields,
						hash: Option.some({
							buckets: source.draw(element([1024, 2048] as const)),
							batches: source.draw(int(1, 4)),
							peakMemoryKb: source.draw(small)
						})
					},
					below(1)
				)
			case "Sort":
				return sketch(
					source,
					"inner",
					{
						...fields,
						sortKey: Option.some(
							source.draw(array(element(["v", "id DESC", "k"] as const), { min: 1, max: 2 }))
						),
						sort: Option.some({
							method: source.draw(
								element(["quicksort", "top-N heapsort", "external merge"] as const)
							),
							spaceUsedKb: source.draw(small),
							spaceType: source.draw(element(["Memory", "Disk"] as const))
						})
					},
					below(1)
				)
			case "Aggregate":
				return sketch(
					source,
					"inner",
					withFilter(source, {
						...fields,
						strategy: Option.some(
							source.draw(element(["Plain", "Sorted", "Hashed", "Mixed"] as const))
						)
					}),
					below(1)
				)
			case "Memoize":
				return sketch(
					source,
					"inner",
					{
						...fields,
						cache: Option.some({
							key: "e1.dst",
							lookups: source.draw(boolean)
								? {
										kind: "counted",
										hits: source.draw(small),
										misses: source.draw(small),
										evictions: source.draw(small),
										overflows: source.draw(small),
										peakMemoryKb: source.draw(small)
									}
								: { kind: "none" }
						})
					},
					below(1)
				)
			case "Gather":
				return sketch(
					source,
					"inner",
					{ ...fields, workersLaunched: Option.some(source.draw(int(0, 4))) },
					below(1)
				)
			case "Append":
				return sketch(source, "inner", fields, below(source.draw(int(1, 3))))
			case "Subquery Scan":
				return sketch(
					source,
					"re-read",
					withFilter(source, { ...fields, alias: Option.some("s") }),
					below(1)
				)
			case "ModifyTable":
				return sketch(
					source,
					"modify",
					{
						...fields,
						operation: Option.some(
							source.draw(element(["Insert", "Update", "Delete", "Merge"] as const))
						),
						relation: Option.some(source.draw(relationGen)),
						alias: Option.some("d")
					},
					below(1)
				)
		}
	}

/** A plan of `depth` levels at most under a node, each node's WAL counters captured or none of them. */
const planGen = (wal: boolean, depth: number): Gen<Sketch> =>
	depth === 0
		? leaf(wal)
		: weighted<Sketch>([
				[2, leaf(wal)],
				[3, inner(wal, depth)]
			])

/** A capture: its plan, and the statement's planning, triggers, serialization and settings. */
export const captureGen: Gen<CaptureSketch> = (source) => {
	const wal = source.draw(boolean)
	return {
		plan: source.draw(planGen(wal, 3)),
		planningMs: source.draw(figure),
		executionMs: source.draw(figure),
		planningBuffers: source.draw(buffersGen),
		triggers: source.draw(
			array(
				(s): TriggerCalls => ({
					name: s.draw(
						element(["RI_ConstraintTrigger_c_18918", "RI_ConstraintTrigger_a_2"] as const)
					),
					constraint: s.draw(optional(element(["d_p_fkey", "fam_copy"] as const))),
					relation: s.draw(relationGen),
					calls: s.draw(int(0, 100))
				}),
				{ min: 0, max: 2 }
			)
		),
		serialization: source.draw(boolean)
			? {
					kind: "captured",
					outputKb: source.draw(small),
					format: source.draw(element(["text", "binary"] as const)),
					buffers: source.draw(buffersGen)
				}
			: { kind: "notCaptured" },
		settings: Rec.fromEntries(
			source.draw(
				array(
					(s) =>
						[
							s.draw(element(["random_page_cost", "work_mem", "jit"] as const)),
							s.draw(element(["1.1", "64MB", "off"] as const))
						] as const,
					{ min: 0, max: 2 }
				)
			)
		)
	}
}

/** The plan the reader must return for a sketch. */
const planOf = (s: Sketch): PlanNode => ({ ...s.fields, children: Arr.map(s.children, planOf) })

/** The plan tree without figures a reader of an unanalyzed plan must return for a sketch. */
export const estimatedOf = (s: Sketch): EstimatedNode => ({
	nodeType: s.fields.nodeType,
	parentRelationship: s.fields.parentRelationship,
	operation: s.fields.operation,
	joinType: s.fields.joinType,
	strategy: s.fields.strategy,
	relation: s.fields.relation,
	schema: s.fields.schema,
	alias: s.fields.alias,
	index: s.fields.index,
	cte: s.fields.cte,
	functionName: s.fields.functionName,
	indexCond: s.fields.indexCond,
	recheckCond: s.fields.recheckCond,
	filter: s.fields.filter,
	joinFilter: s.fields.joinFilter,
	orderBy: s.fields.orderBy,
	sortKey: s.fields.sortKey,
	children: Arr.map(s.children, estimatedOf)
})

/** The Explained a reader must return for a capture. */
export const explainedOf = (c: CaptureSketch): Explained => ({
	plan: planOf(c.plan),
	planningMs: c.planningMs,
	executionMs: c.executionMs,
	planningBuffers: c.planningBuffers,
	triggers: c.triggers,
	serialization: c.serialization,
	settings: c.settings
})

const blocksOf = (b: Buffers): Json => ({
	"Shared Hit Blocks": b.sharedHit,
	"Shared Read Blocks": b.sharedRead,
	"Shared Dirtied Blocks": b.sharedDirtied,
	"Shared Written Blocks": b.sharedWritten,
	"Local Hit Blocks": b.localHit,
	"Local Read Blocks": b.localRead,
	"Local Dirtied Blocks": b.localDirtied,
	"Local Written Blocks": b.localWritten,
	"Temp Read Blocks": b.tempRead,
	"Temp Written Blocks": b.tempWritten
})

/** The keys of an Option that holds a value, none for one that holds none. */
const some = <A>(key: string, value: Option.Option<A>): Json =>
	Option.match(value, { onNone: () => ({}), onSome: (v) => ({ [key]: v }) })

/** An edit of a node as printed: the identity, or a fault planted at one node. */
type NodeEdit = (s: Sketch, printed: Json) => Json

/** No edit. */
const unedited: NodeEdit = (_, printed) => printed

/**
 * A node as EXPLAIN (FORMAT JSON) prints it, every key its fields state and no key they leave out, each node as `edit`
 * leaves it.
 */
const printedNode = (s: Sketch, edit: NodeEdit): Json => {
	const f = s.fields
	return edit(s, {
		...s.noise,
		"Node Type": f.nodeType,
		...some("Parent Relationship", f.parentRelationship),
		...some("Operation", f.operation),
		...some("Join Type", f.joinType),
		...some("Strategy", f.strategy),
		...some("Relation Name", f.relation),
		...some("Schema", f.schema),
		...some("Alias", f.alias),
		...some("Index Name", f.index),
		...some("CTE Name", f.cte),
		...some("Function Name", f.functionName),
		...some("Index Cond", f.indexCond),
		...some("Recheck Cond", f.recheckCond),
		...some("Filter", f.filter),
		...(f.joinFilter.kind === "filter" ? { "Join Filter": f.joinFilter.condition } : {}),
		...some("Order By", f.orderBy),
		...some("Sort Key", f.sortKey),
		"Startup Cost": f.startupCost,
		"Total Cost": f.totalCost,
		"Plan Rows": f.planRows,
		"Plan Width": f.planWidth,
		"Actual Rows": f.actualRows,
		"Actual Loops": f.actualLoops,
		...(Option.isSome(f.filter) ? { "Rows Removed by Filter": f.rowsRemovedByFilter } : {}),
		...(Option.isSome(f.recheckCond) || (Option.isSome(f.index) && Option.isSome(f.relation))
			? { "Rows Removed by Index Recheck": f.rowsRemovedByIndexRecheck }
			: {}),
		...(f.joinFilter.kind === "filter"
			? { "Rows Removed by Join Filter": f.rowsRemovedByJoinFilter }
			: {}),
		...some("Index Searches", f.indexSearches),
		...some("Heap Fetches", f.heapFetches),
		...Option.match(f.sort, {
			onNone: () => ({}),
			onSome: (sort) => ({
				"Sort Method": sort.method,
				"Sort Space Used": sort.spaceUsedKb,
				"Sort Space Type": sort.spaceType
			})
		}),
		...Option.match(f.hash, {
			onNone: () => ({}),
			onSome: (hash) => ({
				"Hash Buckets": hash.buckets,
				"Hash Batches": hash.batches,
				"Peak Memory Usage": hash.peakMemoryKb
			})
		}),
		...Option.match(f.cache, {
			onNone: () => ({}),
			onSome: (cache) => ({
				"Cache Key": cache.key,
				...(cache.lookups.kind === "counted"
					? {
							"Cache Hits": cache.lookups.hits,
							"Cache Misses": cache.lookups.misses,
							"Cache Evictions": cache.lookups.evictions,
							"Cache Overflows": cache.lookups.overflows,
							"Peak Memory Usage": cache.lookups.peakMemoryKb
						}
					: {})
			})
		}),
		...some("Workers Launched", f.workersLaunched),
		...blocksOf(f.buffers),
		...(f.wal.kind === "captured"
			? {
					"WAL Records": f.wal.records,
					"WAL FPI": f.wal.fpi,
					"WAL Bytes": f.wal.bytes,
					"WAL FPI Bytes": f.wal.fpiBytes
				}
			: {}),
		...(s.children.length === 0 ? {} : { Plans: Arr.map(s.children, (c) => printedNode(c, edit)) })
	})
}

/** A capture's statement object as EXPLAIN (FORMAT JSON) prints it, each node as `edit` leaves it. */
const printedTop = (c: CaptureSketch, edit: NodeEdit): Json => ({
	Plan: printedNode(c.plan, edit),
	Settings: c.settings,
	Planning: blocksOf(c.planningBuffers),
	"Planning Time": c.planningMs,
	Triggers: Arr.map(c.triggers, (t) => ({
		"Trigger Name": t.name,
		...some("Constraint Name", t.constraint),
		Relation: t.relation,
		Calls: t.calls
	})),
	...(c.serialization.kind === "captured"
		? {
				Serialization: {
					"Output Volume": c.serialization.outputKb,
					Format: c.serialization.format,
					...blocksOf(c.serialization.buffers)
				}
			}
		: {}),
	"Execution Time": c.executionMs
})

/** A capture as EXPLAIN (FORMAT JSON) prints it: a one-element array of the statement's object. */
export const printedCapture = (c: CaptureSketch): ReadonlyArray<Json> => [printedTop(c, unedited)]

/** Every node of a sketch, depth first, the root first. */
export const sketchNodes = (s: Sketch): ReadonlyArray<Sketch> => [
	s,
	...Arr.flatMap(s.children, sketchNodes)
]

/** A fault planted in a capture's printed output, each one PostgreSQL never prints and the reader must refuse. */
type PlanFault =
	| "no result"
	| "two results"
	| "a lone object"
	| "the plan missing"
	| "a figure missing"
	| "a figure as text"
	| "a figure not finite"
	| "a block counter missing"
	| "a WAL counter missing"
	| "the node type missing"
	| "the node type not text"
	| "a child not an object"
	| "children not a list"
	| "a sort's space missing"
	| "a sort key not text"
	| "a hash's batches missing"
	| "a cache's misses missing"
	| "a trigger's name missing"
	| "a trigger's calls as text"
	| "a trigger not an object"
	| "the planner's buffers missing"
	| "a planner block counter missing"
	| "the planning time missing"
	| "the execution time missing"
	| "a setting not text"
	| "serialization's volume missing"

export const planFaults: Arr.NonEmptyReadonlyArray<PlanFault> = [
	"no result",
	"two results",
	"a lone object",
	"the plan missing",
	"a figure missing",
	"a figure as text",
	"a figure not finite",
	"a block counter missing",
	"a WAL counter missing",
	"the node type missing",
	"the node type not text",
	"a child not an object",
	"children not a list",
	"a sort's space missing",
	"a sort key not text",
	"a hash's batches missing",
	"a cache's misses missing",
	"a trigger's name missing",
	"a trigger's calls as text",
	"a trigger not an object",
	"the planner's buffers missing",
	"a planner block counter missing",
	"the planning time missing",
	"the execution time missing",
	"a setting not text",
	"serialization's volume missing"
]

/** The faults the plan tree's reader, which reads no figure, refuses as well. */
export const treeFaults: ReadonlySet<PlanFault> = new Set([
	"no result",
	"two results",
	"a lone object",
	"the plan missing",
	"the node type missing",
	"the node type not text",
	"a child not an object",
	"children not a list",
	"a sort key not text"
])

const figureKeys = [
	"Startup Cost",
	"Total Cost",
	"Plan Rows",
	"Plan Width",
	"Actual Rows",
	"Actual Loops"
] as const

const blockKeys = [
	"Shared Hit Blocks",
	"Shared Read Blocks",
	"Shared Dirtied Blocks",
	"Shared Written Blocks",
	"Local Hit Blocks",
	"Local Read Blocks",
	"Local Dirtied Blocks",
	"Local Written Blocks",
	"Temp Read Blocks",
	"Temp Written Blocks"
] as const

/** An edit of the one node `target` of a printed plan. */
const at =
	(target: Sketch, edit: (printed: Json) => Json): NodeEdit =>
	(s, printed) =>
		s === target ? edit(printed) : printed

/** The capture's printed output with `fault` planted, or none where the capture holds nothing to plant it in. */
export const plantedFault =
	(c: CaptureSketch, fault: PlanFault): Gen<Option.Option<unknown>> =>
	(source) => {
		const nodes = sketchNodes(c.plan)
		const anyNode = (where: (s: Sketch) => boolean): Option.Option<Sketch> => {
			const found = Arr.filter(nodes, where)
			return Arr.isReadonlyArrayNonEmpty(found)
				? Option.some(source.draw(element(found)))
				: Option.none()
		}
		const atNode = (where: (s: Sketch) => boolean, edit: (printed: Json) => Json) =>
			Option.map(anyNode(where), (target) => [printedTop(c, at(target, edit))])
		const top = (edit: (printed: Json) => Json) => Option.some([edit(printedTop(c, unedited))])
		const everywhere = () => true
		switch (fault) {
			case "no result":
				return Option.some([])
			case "two results":
				return Option.some([printedTop(c, unedited), printedTop(c, unedited)])
			case "a lone object":
				return Option.some(printedTop(c, unedited))
			case "the plan missing":
				return top((p) => Rec.remove(p, "Plan"))
			case "a figure missing": {
				const key = source.draw(element(figureKeys))
				return atNode(everywhere, (p) => Rec.remove(p, key))
			}
			case "a figure as text": {
				const key = source.draw(element(figureKeys))
				return atNode(everywhere, (p) => ({ ...p, [key]: String(p[key]) }))
			}
			case "a figure not finite": {
				const key = source.draw(element(figureKeys))
				const value = source.draw(element([Number.NaN, Number.POSITIVE_INFINITY] as const))
				return atNode(everywhere, (p) => ({ ...p, [key]: value }))
			}
			case "a block counter missing": {
				const key = source.draw(element(blockKeys))
				return atNode(everywhere, (p) => Rec.remove(p, key))
			}
			case "a WAL counter missing": {
				const key = source.draw(
					element(["WAL Records", "WAL FPI", "WAL Bytes", "WAL FPI Bytes"] as const)
				)
				return atNode(
					(s) => s.fields.wal.kind === "captured" && (key !== "WAL Records" || s !== c.plan),
					(p) => Rec.remove(p, key)
				)
			}
			case "the node type missing":
				return atNode(everywhere, (p) => Rec.remove(p, "Node Type"))
			case "the node type not text":
				return atNode(everywhere, (p) => ({ ...p, "Node Type": 7 }))
			case "a child not an object":
				return atNode(
					(s) => s.children.length > 0,
					(p) => ({ ...p, Plans: [1] })
				)
			case "children not a list":
				return atNode(
					(s) => s.children.length > 0,
					(p) => ({ ...p, Plans: {} })
				)
			case "a sort's space missing":
				return atNode(
					(s) => Option.isSome(s.fields.sort),
					(p) => Rec.remove(p, "Sort Space Used")
				)
			case "a sort key not text":
				return atNode(
					(s) => Option.isSome(s.fields.sortKey),
					(p) => ({ ...p, "Sort Key": [1] })
				)
			case "a hash's batches missing":
				return atNode(
					(s) => Option.isSome(s.fields.hash),
					(p) => Rec.remove(p, "Hash Batches")
				)
			case "a cache's misses missing":
				return atNode(
					(s) => Option.exists(s.fields.cache, (cache) => cache.lookups.kind === "counted"),
					(p) => Rec.remove(p, "Cache Misses")
				)
			case "a trigger's name missing":
			case "a trigger's calls as text":
			case "a trigger not an object": {
				if (!Arr.isReadonlyArrayNonEmpty(c.triggers)) {
					return Option.none()
				}
				const [first, ...rest] = c.triggers
				const printed = {
					"Trigger Name": first.name,
					...some("Constraint Name", first.constraint),
					Relation: first.relation,
					Calls: first.calls
				}
				const planted: unknown =
					fault === "a trigger's name missing"
						? Rec.remove(printed, "Trigger Name")
						: fault === "a trigger's calls as text"
							? { ...printed, Calls: String(first.calls) }
							: 1
				return top((p) => ({
					...p,
					Triggers: [
						planted,
						...Arr.map(rest, (t) => ({
							"Trigger Name": t.name,
							...some("Constraint Name", t.constraint),
							Relation: t.relation,
							Calls: t.calls
						}))
					]
				}))
			}
			case "the planner's buffers missing":
				return top((p) => Rec.remove(p, "Planning"))
			case "a planner block counter missing": {
				const key = source.draw(element(blockKeys))
				return top((p) => ({ ...p, Planning: Rec.remove(blocksOf(c.planningBuffers), key) }))
			}
			case "the planning time missing":
				return top((p) => Rec.remove(p, "Planning Time"))
			case "the execution time missing":
				return top((p) => Rec.remove(p, "Execution Time"))
			case "a setting not text":
				return top((p) => ({ ...p, Settings: { ...c.settings, work_mem: 64 } }))
			case "serialization's volume missing": {
				const serialization = c.serialization
				return serialization.kind === "captured"
					? top((p) => ({
							...p,
							Serialization: { Format: serialization.format, ...blocksOf(serialization.buffers) }
						}))
					: Option.none()
			}
		}
	}
