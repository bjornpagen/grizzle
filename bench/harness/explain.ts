import { Array as Arr, Data, Effect, Option, Record as Rec, Result, String as Str } from "effect"
import { type Summary, summarize } from "#bench/cold/stats.ts"
import type { BenchSession } from "#bench/harness/session.ts"
import { quoteString } from "#compiler/core/text.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { genericPlans } from "#compiler/physical/ddl/roles.ts"
import type { SqlError } from "#test/support/pg.ts"

/**
 * EXPLAIN capture for the performance gates, and the one reader of EXPLAIN (FORMAT JSON) output the benches and the
 * tests share: the plan's node types, edges and indexes, never a cost, a row estimate or a relation name unless a gate
 * reads it.
 *
 * Node-level EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) investigates a plan with low instrumentation, but its
 * Execution Time is not the complete request cost. Every capture here runs exactly those options, plus:
 * - SETTINGS, so a plan records the planner settings that differ from the defaults it ran under;
 * - WAL when the capture asks for it, so inserts, generated indexes and law-trigger work report their
 *   records, full-page images and bytes, with PG19's separate full-page-image bytes; a capture without it has no WAL
 *   counter on any node, never a zero;
 * - SERIALIZE when the capture asks for it, which exercises output conversion and TOAST fetches without sending the
 *   payload over the network. Under TIMING OFF it reports the output volume, not its time.
 * Every counter PostgreSQL prints for these options is read as printed and required, so a figure is never invented.
 *
 * TIMING OFF leaves every node's actual rows, loops, buffers and WAL in place and drops only the per-node clock
 * readings; Planning Time and Execution Time are still reported (explain.c). A node's buffer and WAL counters are
 * inclusive of the nodes it runs, so the totals of a statement are its root's, never a sum over the tree: inclusive
 * parent and child values are never added together. Work the root does not run is outside them:
 * AFTER triggers fire in ExecutorFinish, and a data-modifying CTE the main plan did not read to its end is completed
 * afterwards, so the transaction's WAL is read per backend (wal.ts), and the triggers are reported by call count.
 *
 * EXPLAIN ANALYZE executes the statement: an explained write writes. Deferred constraint triggers wait for the end of
 * the transaction and never appear here; COMMIT is timed separately (transaction.ts). EXPLAIN ANALYZE
 * runs here for a write: a member's explain runs only a read under EXPLAIN ANALYZE, in a READ ONLY transaction.
 */
export class MalformedPlan extends Data.TaggedError("MalformedPlan")<{
	readonly message: string
}> {}

export interface Buffers {
	readonly sharedHit: number
	readonly sharedRead: number
	readonly sharedDirtied: number
	readonly sharedWritten: number
	readonly localHit: number
	readonly localRead: number
	readonly localDirtied: number
	readonly localWritten: number
	readonly tempRead: number
	readonly tempWritten: number
}

/** A node's WAL counters: present on every node of a capture made with WAL, and on none of one made without. */
export type WalCounters =
	| {
			readonly kind: "captured"
			readonly records: number
			readonly fpi: number
			readonly bytes: number
			/** PG19 reports the full-page-image bytes separately from the total. */
			readonly fpiBytes: number
	  }
	| { readonly kind: "notCaptured" }

/**
 * A Memoize node's cache statistics: a cache node's presence does not mean useful reuse. PostgreSQL reports the lookups
 * only once the cache has missed, so a cache that saw no lookup has none.
 */
export interface CacheStats {
	readonly key: string
	readonly lookups:
		| { readonly kind: "none" }
		| {
				readonly kind: "counted"
				readonly hits: number
				readonly misses: number
				readonly evictions: number
				readonly overflows: number
				readonly peakMemoryKb: number
		  }
}

export interface HashStats {
	readonly buckets: number
	readonly batches: number
	readonly peakMemoryKb: number
}

export interface SortStats {
	readonly method: string
	readonly spaceUsedKb: number
	readonly spaceType: string
}

/**
 * A join's Join Filter as EXPLAIN prints it, or none: a node of another kind, and a join conditioned only by its index
 * or hash keys, prints none.
 */
type JoinFilter =
	| { readonly kind: "none" }
	| { readonly kind: "filter"; readonly condition: string }

/**
 * The per-node keys PostgreSQL prints on the node kinds that have them, estimated or run: a relation on a scan, an
 * index on an index scan, a condition where the node has one. A key EXPLAIN omits is none.
 */
interface NodeKeys {
	readonly nodeType: string
	/**
	 * How the node feeds its parent: Outer, Inner, Member, Subquery, or SubPlan and InitPlan for a subquery expression's
	 * plan, which its parent runs once per evaluation of the expression, and InitPlan too for a WITH query's plan, which
	 * the statement runs once for the CTE Scans that read it (`subplanName`); none on the root.
	 */
	readonly parentRelationship: Option.Option<string>
	/**
	 * A SubPlan's or an InitPlan's name, PostgreSQL 19's spelling of the kind of its sub-link and its number (`exists_1`,
	 * `expr_2`, `array_3`), or a CTE's (`CTE r8`), after the relationship; none on every other node.
	 */
	readonly subplanName: Option.Option<string>
	readonly operation: Option.Option<string>
	readonly joinType: Option.Option<string>
	/** An Aggregate's or a SetOp's strategy: Plain, Sorted, Hashed or Mixed. */
	readonly strategy: Option.Option<string>
	readonly relation: Option.Option<string>
	readonly schema: Option.Option<string>
	readonly alias: Option.Option<string>
	readonly index: Option.Option<string>
	readonly cte: Option.Option<string>
	readonly functionName: Option.Option<string>
	readonly indexCond: Option.Option<string>
	readonly recheckCond: Option.Option<string>
	readonly filter: Option.Option<string>
	readonly joinFilter: JoinFilter
	/** A hash join's condition its hash table is probed by, and a merge join's its inputs are merged by. */
	readonly hashCond: Option.Option<string>
	readonly mergeCond: Option.Option<string>
	readonly orderBy: Option.Option<string>
	readonly sortKey: Option.Option<ReadonlyArray<string>>
	/**
	 * Whether the node is parallel-aware: one scan the processes of the Gather above it share, the leader's and each
	 * worker's, whose loops are theirs, every one of them a part of one run of the Gather.
	 */
	readonly parallelAware: boolean
}

/**
 * A node of a plan that never ran (EXPLAIN without ANALYZE, such as a GENERIC_PLAN): its keys and children, with no
 * actual figure, buffer or WAL counter.
 */
export interface EstimatedNode extends NodeKeys {
	/** The rows PostgreSQL estimates the node returns. */
	readonly planRows: number
	readonly children: ReadonlyArray<EstimatedNode>
}

export interface PlanNode extends NodeKeys {
	readonly startupCost: number
	readonly totalCost: number
	readonly planRows: number
	readonly planWidth: number
	/** Per loop, as PostgreSQL reports them: a node's total output is actualRows × actualLoops. */
	readonly actualRows: number
	readonly actualLoops: number
	readonly rowsRemovedByFilter: number
	readonly rowsRemovedByIndexRecheck: number
	readonly rowsRemovedByJoinFilter: number
	readonly indexSearches: Option.Option<number>
	/**
	 * The heap pages an Index Only Scan visited for rows its visibility map did not prove visible; none on any other node.
	 */
	readonly heapFetches: Option.Option<number>
	readonly sort: Option.Option<SortStats>
	readonly hash: Option.Option<HashStats>
	readonly cache: Option.Option<CacheStats>
	readonly workersLaunched: Option.Option<number>
	readonly buffers: Buffers
	readonly wal: WalCounters
	readonly children: ReadonlyArray<PlanNode>
}

export interface TriggerCalls {
	readonly name: string
	readonly constraint: Option.Option<string>
	readonly relation: string
	readonly calls: number
}

/** SERIALIZE's report: present exactly when the capture ran with it. */
export type Serialization =
	| { readonly kind: "notCaptured" }
	| {
			readonly kind: "captured"
			readonly outputKb: number
			readonly format: string
			readonly buffers: Buffers
	  }

/** One EXPLAIN ANALYZE of one statement. */
export interface Explained {
	readonly plan: PlanNode
	readonly planningMs: number
	readonly executionMs: number
	readonly planningBuffers: Buffers
	/** The immediate AFTER triggers the statement fired, by call count; deferred ones fire at COMMIT, not here. */
	readonly triggers: ReadonlyArray<TriggerCalls>
	readonly serialization: Serialization
	/** The planner settings that differed from their defaults. */
	readonly settings: Readonly<Record<string, string>>
}

export type SerializeFormat = "text" | "binary"

export interface ExplainOptions {
	/**
	 * SERIALIZE TEXT or BINARY: output conversion and TOAST fetches. The adapter receives every result column in binary
	 * format, so binary measures what it receives.
	 */
	readonly serialize:
		| { readonly kind: "off" }
		| { readonly kind: "on"; readonly format: SerializeFormat }
	/** WAL counters on every node. */
	readonly wal: boolean
	/** VERBOSE: each node's output columns, and every column its conditions name qualified by its relation's alias. */
	readonly verbose: boolean
}

/**
 * The EXPLAIN options of every capture: ANALYZE, BUFFERS, TIMING OFF, SETTINGS and FORMAT JSON, plus WAL, VERBOSE and
 * SERIALIZE as the options ask.
 */
const explainOptions = (options: ExplainOptions): string =>
	Arr.join(
		[
			"ANALYZE",
			"BUFFERS",
			...(options.wal ? ["WAL"] : []),
			...(options.verbose ? ["VERBOSE"] : []),
			"TIMING OFF",
			"SETTINGS",
			...(options.serialize.kind === "on"
				? [`SERIALIZE ${Str.toUpperCase(options.serialize.format)}`]
				: []),
			"FORMAT JSON"
		],
		", "
	)

export const explainStatementWith = (sql: string, options: ExplainOptions): string =>
	`EXPLAIN (${explainOptions(options)}) ${sql}`

type Json = Readonly<Record<string, unknown>>

/** A list of unknown elements, each of which its reader checks: Array.isArray would narrow to any[]. */
const isList = (value: unknown): value is ReadonlyArray<unknown> => Arr.isArray(value)

const isRecord = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !isList(value)

/** The readers below throw MalformedPlan, which parsePlan and parsePlanTree return as their failure. */
const fail = (what: string): never => {
	throw new MalformedPlan({ message: `EXPLAIN output: ${what}` })
}

const listOf = (o: Json, key: string): ReadonlyArray<unknown> => {
	const value = o[key]
	if (!isList(value)) {
		return fail(`${key} is not a list`)
	}
	return value
}

const objectAt = (o: Json, key: string): Json => {
	const value = o[key]
	if (!isRecord(value)) {
		return fail(`${key} is not an object`)
	}
	return value
}

const num = (o: Json, key: string): number => {
	const value = o[key]
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fail(`${key} is not a number`)
	}
	return value
}

/** A number EXPLAIN may omit, read once: none when it is absent. */
const optNum = (o: Json, key: string): Option.Option<number> =>
	o[key] === undefined ? Option.none() : Option.some(num(o, key))

/**
 * PostgreSQL prints the rows a filter, an index recheck or a join filter removed only on a node that has such a filter:
 * the absence is a genuine none, so these three counters alone read it as 0.
 */
const removedRows = (o: Json, key: string): number => Option.getOrElse(optNum(o, key), () => 0)

/** A text key EXPLAIN may omit, read once: none when it is absent. */
const optStr = (o: Json, key: string): Option.Option<string> => {
	const value = o[key]
	if (value === undefined) {
		return Option.none()
	}
	if (typeof value !== "string") {
		return fail(`${key} is not a string`)
	}
	return Option.some(value)
}

const str = (o: Json, key: string): string =>
	Option.getOrElse(optStr(o, key), () => fail(`${key} is missing`))

/** A list of text EXPLAIN may omit, read once: none when it is absent. */
const optStrings = (o: Json, key: string): Option.Option<ReadonlyArray<string>> => {
	const value = o[key]
	if (value === undefined) {
		return Option.none()
	}
	if (!isList(value)) {
		return fail(`${key} is not a list of text`)
	}
	return Option.some(
		Arr.map(value, (v: unknown) =>
			typeof v === "string" ? v : fail(`${key} is not a list of text`)
		)
	)
}

const buffers = (o: Json): Buffers => ({
	sharedHit: num(o, "Shared Hit Blocks"),
	sharedRead: num(o, "Shared Read Blocks"),
	sharedDirtied: num(o, "Shared Dirtied Blocks"),
	sharedWritten: num(o, "Shared Written Blocks"),
	localHit: num(o, "Local Hit Blocks"),
	localRead: num(o, "Local Read Blocks"),
	localDirtied: num(o, "Local Dirtied Blocks"),
	localWritten: num(o, "Local Written Blocks"),
	tempRead: num(o, "Temp Read Blocks"),
	tempWritten: num(o, "Temp Written Blocks")
})

/** Whether a capture ran with WAL: its root then carries the WAL counters, and so does every node under it. */
const walCaptured = (root: Json): boolean => root["WAL Records"] !== undefined

const wal = (o: Json, captured: boolean): WalCounters =>
	captured
		? {
				kind: "captured",
				records: num(o, "WAL Records"),
				fpi: num(o, "WAL FPI"),
				bytes: num(o, "WAL Bytes"),
				fpiBytes: num(o, "WAL FPI Bytes")
			}
		: { kind: "notCaptured" }

const children = (o: Json): ReadonlyArray<Json> =>
	o["Plans"] === undefined
		? []
		: Arr.map(listOf(o, "Plans"), (c) => (isRecord(c) ? c : fail("a child plan is not an object")))

const joinFilterOf = (condition: Option.Option<string>): JoinFilter =>
	Option.match(condition, {
		onNone: () => ({ kind: "none" }),
		onSome: (c) => ({ kind: "filter", condition: c })
	})

const nodeKeys = (o: Json): NodeKeys => ({
	nodeType: str(o, "Node Type"),
	parentRelationship: optStr(o, "Parent Relationship"),
	subplanName: optStr(o, "Subplan Name"),
	operation: optStr(o, "Operation"),
	joinType: optStr(o, "Join Type"),
	strategy: optStr(o, "Strategy"),
	relation: optStr(o, "Relation Name"),
	schema: optStr(o, "Schema"),
	alias: optStr(o, "Alias"),
	index: optStr(o, "Index Name"),
	cte: optStr(o, "CTE Name"),
	functionName: optStr(o, "Function Name"),
	indexCond: optStr(o, "Index Cond"),
	recheckCond: optStr(o, "Recheck Cond"),
	filter: optStr(o, "Filter"),
	joinFilter: joinFilterOf(optStr(o, "Join Filter")),
	hashCond: optStr(o, "Hash Cond"),
	mergeCond: optStr(o, "Merge Cond"),
	orderBy: optStr(o, "Order By"),
	sortKey: optStrings(o, "Sort Key"),
	parallelAware: o["Parallel Aware"] === true
})

const cacheLookups = (o: Json): CacheStats["lookups"] =>
	o["Cache Hits"] === undefined
		? { kind: "none" }
		: {
				kind: "counted",
				hits: num(o, "Cache Hits"),
				misses: num(o, "Cache Misses"),
				evictions: num(o, "Cache Evictions"),
				overflows: num(o, "Cache Overflows"),
				peakMemoryKb: num(o, "Peak Memory Usage")
			}

const parseNode = (o: Json, walCapture: boolean): PlanNode => {
	const sortMethod = optStr(o, "Sort Method")
	const hashBuckets = optNum(o, "Hash Buckets")
	const cacheKey = optStr(o, "Cache Key")
	return {
		...nodeKeys(o),
		startupCost: num(o, "Startup Cost"),
		totalCost: num(o, "Total Cost"),
		planRows: num(o, "Plan Rows"),
		planWidth: num(o, "Plan Width"),
		/** Under ANALYZE PostgreSQL prints both for every node, 0 and 0 for one the executor never ran. */
		actualRows: num(o, "Actual Rows"),
		actualLoops: num(o, "Actual Loops"),
		rowsRemovedByFilter: removedRows(o, "Rows Removed by Filter"),
		rowsRemovedByIndexRecheck: removedRows(o, "Rows Removed by Index Recheck"),
		rowsRemovedByJoinFilter: removedRows(o, "Rows Removed by Join Filter"),
		indexSearches: optNum(o, "Index Searches"),
		heapFetches: optNum(o, "Heap Fetches"),
		sort: Option.map(sortMethod, (method) => ({
			method,
			spaceUsedKb: num(o, "Sort Space Used"),
			spaceType: str(o, "Sort Space Type")
		})),
		hash: Option.map(hashBuckets, (buckets) => ({
			buckets,
			batches: num(o, "Hash Batches"),
			peakMemoryKb: num(o, "Peak Memory Usage")
		})),
		cache: Option.map(cacheKey, (key) => ({ key, lookups: cacheLookups(o) })),
		workersLaunched: optNum(o, "Workers Launched"),
		buffers: buffers(o),
		wal: wal(o, walCapture),
		children: Arr.map(children(o), (c) => parseNode(c, walCapture))
	}
}

const parseEstimated = (o: Json): EstimatedNode => ({
	...nodeKeys(o),
	planRows: num(o, "Plan Rows"),
	children: Arr.map(children(o), parseEstimated)
})

const parseTrigger = (t: unknown): TriggerCalls => {
	if (!isRecord(t)) {
		return fail("a trigger is not an object")
	}
	return {
		name: str(t, "Trigger Name"),
		constraint: optStr(t, "Constraint Name"),
		relation: str(t, "Relation"),
		calls: num(t, "Calls")
	}
}

/**
 * The one object of an EXPLAIN (..., FORMAT JSON) result: the json value as the driver returns it, parsed or as text.
 */
const topOf = (value: unknown): Json => {
	const parsed: unknown = typeof value === "string" ? trustedJson<unknown>(value) : value
	if (!isList(parsed) || parsed.length !== 1) {
		return fail("not a one-element array of objects")
	}
	const [top] = parsed
	if (!isRecord(top)) {
		return fail("not a one-element array of objects")
	}
	return top
}

/** Runs a reader, returning the MalformedPlan it throws as the failure; any other throw is a defect. */
const reading = <A>(read: () => A): Result.Result<A, MalformedPlan> => {
	try {
		return Result.succeed(read())
	} catch (error) {
		if (error instanceof MalformedPlan) {
			return Result.fail(error)
		}
		throw error
	}
}

const serialized = (o: Json): Serialization => ({
	kind: "captured",
	outputKb: num(o, "Output Volume"),
	format: str(o, "Format"),
	buffers: buffers(o)
})

const readPlan = (value: unknown): Explained => {
	const top = topOf(value)
	const plan = objectAt(top, "Plan")
	return {
		plan: parseNode(plan, walCaptured(plan)),
		planningMs: num(top, "Planning Time"),
		executionMs: num(top, "Execution Time"),
		planningBuffers: buffers(objectAt(top, "Planning")),
		triggers: Arr.map(listOf(top, "Triggers"), parseTrigger),
		serialization:
			top["Serialization"] === undefined
				? { kind: "notCaptured" }
				: serialized(objectAt(top, "Serialization")),
		settings: Rec.fromEntries(
			Arr.map(Rec.toEntries(objectAt(top, "Settings")), ([k, v]): readonly [string, string] =>
				typeof v === "string" ? [k, v] : fail(`setting ${k} is not text`)
			)
		)
	}
}

/**
 * One EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) result, WAL and SERIALIZE as the capture ran, read
 * exactly: a reader never guesses at a field, and anything it cannot read is MalformedPlan.
 */
export const parsePlan = (value: unknown): Result.Result<Explained, MalformedPlan> =>
	reading(() => readPlan(value))

/**
 * Whether a plan node roots a plan of its own, a SubPlan's or an InitPlan's (NodeKeys `parentRelationship`): a subquery
 * expression its parent's conditions run, once or for each row they are evaluated over, so its scans are read apart from
 * its parent's, their bindings their own conditions' equalities to the outer row's columns.
 */
export const plansApart = (node: Pick<NodeKeys, "parentRelationship">): boolean =>
	Option.match(node.parentRelationship, {
		onNone: () => false,
		onSome: (r) => r === "InitPlan" || r === "SubPlan"
	})

/**
 * The plan tree of one EXPLAIN (..., FORMAT JSON) result without ANALYZE, such as a GENERIC_PLAN: no actual figures,
 * buffers or timings, so only the tree is read.
 */
export const parsePlanTree = (value: unknown): Result.Result<EstimatedNode, MalformedPlan> =>
	reading(() => parseEstimated(objectAt(topOf(value), "Plan")))

/**
 * The plan tree of one EXPLAIN (FORMAT JSON) result cell, its json text or the value the driver parsed it into, with or
 * without ANALYZE. A cell that is not one plan throws its MalformedPlan: a test reading the plan fails, and a gate
 * reading it is a defect.
 */
const planTreeOf = (cell: unknown): EstimatedNode => Result.getOrThrow(parsePlanTree(cell))

/** Every node's type of a cell's plan, in plan order (a node before its children). */
export const planNodeTypes = (cell: unknown): ReadonlyArray<string> =>
	Arr.fromIterable(planNodes(planTreeOf(cell)).map((node) => node.nodeType))

/** The node types that deduplicate or group rows. */
const groupingNodeTypes: ReadonlySet<string> = new Set(["Unique", "Aggregate", "Group"])

/**
 * The deduplication and grouping steps among a plan's node types, in their order: each Unique, Aggregate (sorted, hashed
 * or plain) and Group. PostgreSQL deduplicates a DISTINCT by a Unique over ordered rows or by a hashed Aggregate,
 * whichever it costs lower, so in a plan that folds nothing each step is a deduplication, whichever form it takes.
 */
export const groupingSteps = (nodeTypes: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.filter(nodeTypes, (t) => groupingNodeTypes.has(t))

/**
 * A plan node as a plan feature reads it: its type, refined by its join type or its aggregate or set operation
 * strategy where EXPLAIN prints one.
 */
export interface PlanLabel {
	readonly nodeType: string
	readonly joinType: Option.Option<string>
	readonly strategy: Option.Option<string>
}

const labelOf = (node: PlanLabel): PlanLabel => ({
	nodeType: node.nodeType,
	joinType: node.joinType,
	strategy: node.strategy
})

/**
 * Every edge of a cell's plan, a node under its parent, labelled, in plan order (a parent's edges in its children's
 * order, before its children's own).
 */
export const planEdges = (
	cell: unknown
): ReadonlyArray<{ readonly parent: PlanLabel; readonly child: PlanLabel }> =>
	Arr.flatMap([...planNodes(planTreeOf(cell))], (parent) =>
		Arr.map(parent.children, (child) => ({ parent: labelOf(parent), child: labelOf(child) }))
	)

const parseRows = (
	rows: ReadonlyArray<ReadonlyArray<unknown>>
): Effect.Effect<Explained, MalformedPlan> => Effect.fromResult(parsePlan(rows[0]?.[0]))

/**
 * Runs `sql` under EXPLAIN on `session`, with `params` bound as the statement's own parameters: a custom plan for those
 * values.
 */
export const explain = (
	session: BenchSession,
	sql: string,
	params: ReadonlyArray<unknown>,
	options: ExplainOptions
): Effect.Effect<Explained, SqlError | MalformedPlan> =>
	Effect.flatMap(session.values(explainStatementWith(sql, options), params), parseRows)

export type PlanMode = "generic" | "custom"

/**
 * `use` run on `session` under the generic plans every session grizzle opens plans its statements under
 * (physical/ddl/roles.ts genericPlans, the setting ownerStartupOptions and every login's defaults state), applied by
 * reference and reset after, however it ends: the one way a measurement reads a generic plan, since a generic plan run
 * needs EXPLAIN ANALYZE, which EXPLAIN (GENERIC_PLAN) cannot combine with, and a statement's parameters bound over the
 * extended protocol, the one every session here speaks, EXPLAIN (GENERIC_PLAN) plans at their values. No other
 * planner setting is ever set beside it. A reset that fails leaves the session in a state no later measurement may run
 * on, so it is a defect.
 */
export const underGenericPlans = <A, E, R>(
	session: BenchSession,
	use: Effect.Effect<A, E, R>
): Effect.Effect<A, E | SqlError, R> =>
	Effect.acquireUseRelease(
		session.values(`SET ${genericPlans.parameter} = ${quoteString(genericPlans.value)}`, []),
		() => use,
		() => Effect.orDie(session.values(`RESET ${genericPlans.parameter}`, []))
	)

/** A statement's EXECUTE arguments: none, or each of `terms` in order. */
const executeArguments = (terms: ReadonlyArray<string>): string =>
	terms.length === 0 ? "" : `(${Arr.join(terms, ", ")})`

/**
 * `sql` PREPAREd on `session` as `name`, `explain` of its EXECUTE with the arguments `args` run under `mode`, and the
 * statement released before the effect ends, however it ends: a generic plan under grizzle's own generic plans
 * (`underGenericPlans`), a custom one as the first execution of a statement just prepared, which PostgreSQL plans at
 * its values (plancache.c choose_custom_plan, its first five executions). A release that fails is a defect.
 */
const preparedExplain = (
	session: BenchSession,
	name: string,
	sql: string,
	args: string,
	mode: PlanMode,
	explain: (execute: string) => string
): Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError> => {
	const explained = session.values(explain(`EXECUTE ${name}${args}`), [])
	return Effect.acquireUseRelease(
		session.values(`PREPARE ${name} AS ${sql}`, []),
		() => (mode === "generic" ? underGenericPlans(session, explained) : explained),
		() => Effect.orDie(session.values(`DEALLOCATE ${name}`, []))
	)
}

/**
 * A server statement planned as `mode`: R04 "test generic and custom plans separately". The statement is PREPAREd
 * with its own casts typing its parameters and EXPLAIN EXECUTEd once with `params` as literals (`preparedExplain`). Its
 * name is the mode's alone: the statement is released before the effect ends, so no two are prepared on a session at
 * once. Like every EXPLAIN here it executes the statement. The session must not be in a failed transaction.
 */
export const explainServerStatement = (
	session: BenchSession,
	sql: string,
	params: ReadonlyArray<string>,
	mode: PlanMode,
	options: ExplainOptions
): Effect.Effect<Explained, SqlError | MalformedPlan> =>
	Effect.flatMap(
		preparedExplain(
			session,
			`gz_bench_${mode}`,
			sql,
			executeArguments(Arr.map(params, quoteString)),
			mode,
			(execute) => explainStatementWith(execute, options)
		),
		parseRows
	)

/**
 * The generic plan of `sql` as every session grizzle opens plans it (`underGenericPlans`), estimated, never run: EXPLAIN
 * (VERBOSE, FORMAT JSON) of its EXECUTE with every one of its `parameters` NULL, which a generic plan never reads.
 */
export const genericPlanOf = (
	session: BenchSession,
	sql: string,
	parameters: number
): Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError> =>
	preparedExplain(
		session,
		"gz_generic",
		sql,
		executeArguments(Array.from({ length: parameters }, () => "NULL")),
		"generic",
		(execute) => `EXPLAIN (VERBOSE, FORMAT JSON) ${execute}`
	)

/** Every node of a plan, depth first, the root first. */
export function* planNodes<N extends { readonly children: ReadonlyArray<N> }>(
	node: N
): Generator<N> {
	yield node
	for (const child of node.children) {
		yield* planNodes(child)
	}
}

/**
 * What a scan node read over all of its loops: what it returned and what its filter and its index recheck removed.
 * A scan that read at most one row in all is a probe its parent starts with and stops after: a hash or merge join's
 * first row of one side, read before it finds the other side empty, or an EXISTS's one row. The planner takes or
 * skips such a probe by its estimates, whatever a write's size, so it is no read that grows with the write and counts
 * nothing; every other scan counts what it read.
 */
const readByScan = (n: PlanNode): number => {
	const read = (n.actualRows + n.rowsRemovedByFilter + n.rowsRemovedByIndexRecheck) * n.actualLoops
	return read > 1 ? read : 0
}

/**
 * The rows a plan read and paired: each scan's rows over all of its loops (`readByScan`), a scan of a stored relation's,
 * of a carrier's, of a CTE's, of a recursion's worktable or of a function's; and every pair a join examined and its
 * join filter removed. A sort, a hash, a window or an aggregate reads rows a scan below it counted, and so does a
 * Subquery Scan, which passes on the rows of the plan beneath it and which the planner keeps or elides by the plan it
 * picks for that subquery, so whichever of them the planner chooses for a step, the figure is the same; a scan run
 * again for each row of another, a worktable reread at every step, or a join examining pairs past its keys is counted
 * every time.
 */
export const rowsScannedAndPaired = (plan: PlanNode): number =>
	Math.round(
		Iterator.from(planNodes(plan)).reduce(
			(sum, n) =>
				sum +
				(Str.endsWith(" Scan")(n.nodeType) &&
				n.nodeType !== "Bitmap Index Scan" &&
				n.nodeType !== "Subquery Scan"
					? readByScan(n)
					: 0) +
				n.rowsRemovedByJoinFilter * n.actualLoops,
			0
		)
	)

export const findNodes = (
	plan: PlanNode,
	test: string | ((node: PlanNode) => boolean)
): ReadonlyArray<PlanNode> =>
	planNodes(plan)
		.filter(typeof test === "string" ? (n) => n.nodeType === test : test)
		.toArray()

const nodeTypeCounts = (plan: PlanNode): Readonly<Record<string, number>> => {
	const counts: Record<string, number> = {}
	for (const n of planNodes(plan)) {
		const seen = counts[n.nodeType]
		counts[n.nodeType] = seen === undefined ? 1 : seen + 1
	}
	return counts
}

/**
 * The plan's shape: node types and the relations and indexes they read, nested, without any figure. Two executions with
 * the same shape ran the same plan (R22: "plan shape is independent of input size except through estimates").
 */
const planShape = (node: PlanNode): string => {
	const label = Arr.join(
		[
			node.nodeType,
			...Option.toArray(node.relation),
			...Option.toArray(node.index),
			...Option.toArray(node.cte)
		],
		" "
	)
	return node.children.length === 0
		? label
		: `${label}(${Arr.join(Arr.map(node.children, planShape), ", ")})`
}

/**
 * The nodes that read a stored relation: Seq Scan, Index Scan, Index Only Scan, Bitmap Heap Scan, Tid and Tid Range
 * Scan, Sample Scan, each naming its relation. A Bitmap Index Scan yields TIDs for its heap scan, which reads the rows;
 * a CTE Scan, Subquery Scan, WorkTable Scan or Named Tuplestore Scan re-reads rows another node of the same plan
 * produced, whose own scans are counted; a ModifyTable names the relation it writes. None of them is counted, so no row
 * is counted twice.
 */
const storedScan = (n: PlanNode): boolean =>
	Option.isSome(n.relation) && Option.isNone(n.operation) && n.nodeType !== "Bitmap Index Scan"

/** The nodes that generate rows rather than read them: a set-returning function, a table function, a VALUES list. */
const generatingScan = (n: PlanNode): boolean =>
	n.nodeType === "Function Scan" ||
	n.nodeType === "Table Function Scan" ||
	n.nodeType === "Values Scan"

/** A scan's rows over all of its loops: its output plus what its filter and index recheck removed. */
export const scannedRows = (n: PlanNode): number =>
	(n.actualRows + n.rowsRemovedByFilter + n.rowsRemovedByIndexRecheck) * n.actualLoops

/** The rows scans read over all of their loops (scannedRows). */
const scanned = (nodes: Iterable<PlanNode>): number =>
	Iterator.from(nodes).reduce((sum, n) => sum + scannedRows(n), 0)

/** The nodes that descend into an index themselves, each counting its descents under ANALYZE (Index Searches). */
const indexDescending: ReadonlySet<string> = new Set([
	"Index Scan",
	"Index Only Scan",
	"Bitmap Index Scan"
])

/** The nodes that combine or read bitmaps their children built, each descent made by a bitmap index scan beneath. */
const bitmapReading: ReadonlySet<string> = new Set(["Bitmap Heap Scan", "BitmapAnd", "BitmapOr"])

/**
 * The descents a node made into an index over all of its loops, the one count of them: an index scan's PostgreSQL's
 * own (Index Searches), which a skip scan or an array of keys makes more than one a loop, else one a loop; a bitmap's,
 * those of the bitmap index scans beneath it; none for any other node, a sequential scan's among them.
 */
export const descentsOf = (n: PlanNode): number =>
	indexDescending.has(n.nodeType)
		? Option.getOrElse(n.indexSearches, () => n.actualLoops)
		: bitmapReading.has(n.nodeType)
			? Arr.reduce(n.children, 0, (sum, child) => sum + descentsOf(child))
			: 0

/** Rows the plan read from stored relations. */
export const rowsRead = (plan: PlanNode): number => scanned(planNodes(plan).filter(storedScan))

/**
 * Every row a plan's nodes handled, over all of their loops: each node's output, and the rows its filter, its index
 * recheck and its join filter removed, so a join counts every pair it examined. A row is counted at each node it passes,
 * a worktable's rows at every step that rereads them and a subquery's at every run of it, so the figure prices the
 * plan's work by rows, where rowsRead counts what it read from stored relations once.
 */
export const rowsTouched = (plan: PlanNode): number =>
	Math.round(
		Iterator.from(planNodes(plan)).reduce(
			(sum, n) =>
				sum +
				(n.actualRows +
					n.rowsRemovedByFilter +
					n.rowsRemovedByIndexRecheck +
					n.rowsRemovedByJoinFilter) *
					n.actualLoops,
			0
		)
	)

/** Rows the plan generated from functions and VALUES lists, a figure kept apart from the rows it read. */
export const rowsGenerated = (plan: PlanNode): number =>
	scanned(planNodes(plan).filter(generatingScan))

export interface AccessCondition {
	readonly nodeType: string
	readonly relation: Option.Option<string>
	readonly index: string
	readonly indexCond: Option.Option<string>
	readonly orderBy: Option.Option<string>
	readonly filter: Option.Option<string>
}

/** Every index access in the plan with its access conditions and residual filter. */
export const indexAccesses = (plan: PlanNode): ReadonlyArray<AccessCondition> =>
	planNodes(plan)
		.flatMap((n) =>
			Arr.map(Option.toArray(n.index), (index) => ({
				nodeType: n.nodeType,
				relation: n.relation,
				index,
				indexCond: n.indexCond,
				orderBy: n.orderBy,
				filter: n.filter
			}))
		)
		.toArray()

export interface PlanSummary {
	readonly samples: number
	readonly planningMs: Summary
	readonly executionMs: Summary
	/** Root-inclusive counters per execution. */
	readonly sharedHit: Summary
	readonly sharedRead: Summary
	readonly tempWritten: Summary
	readonly wal:
		| { readonly kind: "notCaptured" }
		| {
				readonly kind: "captured"
				readonly records: Summary
				readonly bytes: Summary
				readonly fpiBytes: Summary
		  }
	readonly rowsRead: Summary
	readonly rowsGenerated: Summary
	readonly serializationKb:
		| { readonly kind: "notCaptured" }
		| { readonly kind: "captured"; readonly kb: Summary }
	/** Whether every sample ran one plan shape, and that shape. */
	readonly shapeStable: boolean
	readonly shape: string
	readonly nodeTypes: Readonly<Record<string, number>>
	readonly indexAccesses: ReadonlyArray<AccessCondition>
	readonly triggers: ReadonlyArray<TriggerCalls>
	readonly settings: Readonly<Record<string, string>>
	/** The first sample's plan, every figure included. */
	readonly plan: PlanNode
}

/**
 * The samples of one summary are captures of one statement with one set of options, so they all carry WAL and
 * serialization, or none does; a mix is a defect of the caller.
 */
const capturedOf = <A>(
	samples: ReadonlyArray<Explained>,
	read: (e: Explained) => A | undefined,
	what: string
): ReadonlyArray<A> => {
	const values = Arr.flatMap(samples, (s) => {
		const value = read(s)
		return value === undefined ? [] : [value]
	})
	if (values.length > 0 && values.length !== samples.length) {
		throw new RangeError(
			`summarizePlans: ${values.length} of ${samples.length} samples captured ${what}`
		)
	}
	return values
}

export const summarizePlans = (samples: ReadonlyArray<Explained>): PlanSummary => {
	const first = samples[0]
	if (first === undefined) {
		throw new Error("summarizePlans: no samples")
	}
	const shapes = new Set(Arr.map(samples, (s) => planShape(s.plan)))
	const of = (f: (e: Explained) => number): Summary => summarize(Arr.map(samples, f))
	const wals = capturedOf(
		samples,
		(s) => (s.plan.wal.kind === "captured" ? s.plan.wal : undefined),
		"WAL"
	)
	const outputKb = capturedOf(
		samples,
		(s) => (s.serialization.kind === "captured" ? s.serialization.outputKb : undefined),
		"serialization"
	)
	return {
		samples: samples.length,
		planningMs: of((s) => s.planningMs),
		executionMs: of((s) => s.executionMs),
		sharedHit: of((s) => s.plan.buffers.sharedHit),
		sharedRead: of((s) => s.plan.buffers.sharedRead),
		tempWritten: of((s) => s.plan.buffers.tempWritten),
		wal:
			wals.length === 0
				? { kind: "notCaptured" }
				: {
						kind: "captured",
						records: summarize(Arr.map(wals, (w) => w.records)),
						bytes: summarize(Arr.map(wals, (w) => w.bytes)),
						fpiBytes: summarize(Arr.map(wals, (w) => w.fpiBytes))
					},
		rowsRead: of((s) => rowsRead(s.plan)),
		rowsGenerated: of((s) => rowsGenerated(s.plan)),
		serializationKb:
			outputKb.length === 0
				? { kind: "notCaptured" }
				: { kind: "captured", kb: summarize(outputKb) },
		shapeStable: shapes.size === 1,
		shape: planShape(first.plan),
		nodeTypes: nodeTypeCounts(first.plan),
		indexAccesses: indexAccesses(first.plan),
		triggers: first.triggers,
		settings: first.settings,
		plan: first.plan
	}
}
