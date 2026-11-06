import { NodeServices } from "@effect/platform-node"
import { describe, it, layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage, requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Data,
	Effect,
	Exit,
	FileSystem,
	Formatter,
	Option,
	Order,
	Path,
	Record as Rec,
	Result
} from "effect"

import {
	type BenchIdentity,
	benchIdentity,
	readPin,
	repoRoot,
	runIdentity,
	type ServerIdentity,
	serverSettings,
	sourceIdentity
} from "#bench/cold/identity.ts"
import { parseBenchArgs } from "#bench/harness/cli.ts"
import {
	indexAccesses,
	MalformedPlan,
	nodeTypeCounts,
	parsePlan,
	relationsRead,
	rowsGenerated,
	rowsRead,
	statementTotals,
	summarizePlans
} from "#bench/harness/explain.ts"

import {
	type CaseRecord,
	defineGate,
	equivalence,
	gateFindings,
	type GateRun,
	mechanism,
	type RanRecord,
	recordProblems,
	type VerdictInput,
	verdictOf
} from "#bench/harness/gate.ts"

import {
	type OperationResult,
	outcomeTransientReason,
	type RetryOptions,
	type RetryPolicy,
	sqlAttempted,
	withRetries
} from "#bench/harness/load.ts"

import {
	type Constraint,
	failedAt,
	failedAtStatement,
	type FailedOutcome
} from "#bench/harness/outcome.ts"
import { gateCatalog, type GateId, gateOwner, ownerDirectories } from "#bench/harness/rules.ts"
import { discoverGates, recordOf } from "#bench/harness/runner.ts"
import { MalformedRows, resultSet, rowsAgree, textRows } from "#bench/harness/variant.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { assert, assertVariant, defined } from "#test/support/assert.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * The bench harness's pure parts.
 *
 * - EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) output, with WAL and SERIALIZE as captured, is read
 *   exactly: every node's rows, loops, conditions, buffers and WAL, the immediate triggers by call count,
 *   serialization volume and the changed planner settings; a counter PostgreSQL prints is never invented when absent,
 *   and malformed output is refused. Statement totals are the root's inclusive counters, never a sum over the tree.
 * - Plans are read structurally: rows read over all loops with a Bitmap Index Scan never counted twice, index
 *   accesses with their conditions and residual filters.
 * - The harness's caller-side retry retries exactly what grizzle classifies as a TransientFailure (40001, 40P01, a
 *   unique violation the statement names), up to its policy.
 * - Rows are read once as text cells, and two row lists agree when they are one set: the same rows, neither list
 *   repeating one.
 * - A verdict is judged by its tagged checks; a record names each gap it has; a run's record keeps its cases when only
 *   the release fails.
 * - Every gate of the catalog has exactly one bench file, in its owner's directory.
 * - The command line of `pnpm bench` refuses what it cannot read.
 *
 *  The ten block counters of a node, the planner or SERIALIZE, all zero.
 */
const zeroBlocks = {
	"Shared Hit Blocks": 0,
	"Shared Read Blocks": 0,
	"Shared Dirtied Blocks": 0,
	"Shared Written Blocks": 0,
	"Local Hit Blocks": 0,
	"Local Read Blocks": 0,
	"Local Dirtied Blocks": 0,
	"Local Written Blocks": 0,
	"Temp Read Blocks": 0,
	"Temp Written Blocks": 0
}

const zeroBuffers = {
	sharedHit: 0,
	sharedRead: 0,
	sharedDirtied: 0,
	sharedWritten: 0,
	localHit: 0,
	localRead: 0,
	localDirtied: 0,
	localWritten: 0,
	tempRead: 0,
	tempWritten: 0
}

const zeroIoTimes = {
	"Shared I/O Read Time": 0.0,
	"Shared I/O Write Time": 0.0,
	"Local I/O Read Time": 0.0,
	"Local I/O Write Time": 0.0,
	"Temp I/O Read Time": 0.0,
	"Temp I/O Write Time": 0.0
}

const zeroWal = {
	"WAL Records": 0,
	"WAL FPI": 0,
	"WAL Bytes": 0,
	"WAL FPI Bytes": 0,
	"WAL Buffers Full": 0
}

/**
 * EXPLAIN (ANALYZE, BUFFERS, WAL, TIMING OFF, SETTINGS, SERIALIZE TEXT, FORMAT JSON) of `SELECT id, v FROM t WHERE id <
 * 50 ORDER BY v` over a 1000-row table with random_page_cost set, as the local 19rc1 build printed it.
 */
const sortedRangeTop = {
	Plan: {
		"Node Type": "Sort",
		"Parallel Aware": false,
		"Async Capable": false,
		"Startup Cost": 4.71,
		"Total Cost": 4.83,
		"Plan Rows": 49,
		"Plan Width": 37,
		"Actual Rows": 49.0,
		"Actual Loops": 1,
		Disabled: false,
		"Sort Key": ["v"],
		"Sort Method": "quicksort",
		"Sort Space Used": 27,
		"Sort Space Type": "Memory",
		...zeroBlocks,
		"Shared Hit Blocks": 3,
		...zeroIoTimes,
		...zeroWal,
		Plans: [
			{
				"Node Type": "Index Scan",
				"Parent Relationship": "Outer",
				"Parallel Aware": false,
				"Async Capable": false,
				"Scan Direction": "Forward",
				"Index Name": "t_pkey",
				"Relation Name": "t",
				Alias: "t",
				"Startup Cost": 0.28,
				"Total Cost": 3.33,
				"Plan Rows": 49,
				"Plan Width": 37,
				"Actual Rows": 49.0,
				"Actual Loops": 1,
				Disabled: false,
				"Index Cond": "(id < 50)",
				"Rows Removed by Index Recheck": 0,
				"Index Searches": 1,
				...zeroBlocks,
				"Shared Hit Blocks": 3,
				...zeroIoTimes,
				...zeroWal
			}
		]
	},
	Settings: { random_page_cost: "1.1" },
	Planning: { ...zeroBlocks, "Shared Hit Blocks": 37, ...zeroIoTimes },
	"Planning Time": 0.081,
	Triggers: [],
	Serialization: { "Output Volume": 3, Format: "text", ...zeroBlocks, ...zeroIoTimes },
	"Execution Time": 0.021
}

const sortedRange = [sortedRangeTop]

/**
 * EXPLAIN (ANALYZE, BUFFERS, WAL, TIMING OFF, SETTINGS, FORMAT JSON) of `INSERT INTO d SELECT g, g FROM
 * generate_series(1, 100) AS g` into a table with an immediate foreign key, as the local 19rc1 build printed it: the RI
 * trigger fires after the plan, by call count.
 */
const insertWithTriggerTop = {
	Plan: {
		"Node Type": "ModifyTable",
		Operation: "Insert",
		"Parallel Aware": false,
		"Async Capable": false,
		"Relation Name": "d",
		Alias: "d",
		"Startup Cost": 0.0,
		"Total Cost": 1.0,
		"Plan Rows": 0,
		"Plan Width": 0,
		"Actual Rows": 0.0,
		"Actual Loops": 1,
		Disabled: false,
		...zeroBlocks,
		"Shared Hit Blocks": 99,
		"Shared Dirtied Blocks": 1,
		"Shared Written Blocks": 1,
		...zeroIoTimes,
		"Shared I/O Write Time": 0.019,
		"WAL Records": 100,
		"WAL FPI": 0,
		"WAL Bytes": 6300,
		"WAL FPI Bytes": 0,
		"WAL Buffers Full": 0,
		Plans: [
			{
				"Node Type": "Function Scan",
				"Parent Relationship": "Outer",
				"Parallel Aware": false,
				"Async Capable": false,
				"Function Name": "generate_series",
				Alias: "g",
				"Startup Cost": 0.0,
				"Total Cost": 1.0,
				"Plan Rows": 100,
				"Plan Width": 8,
				"Actual Rows": 100.0,
				"Actual Loops": 1,
				Disabled: false,
				...zeroBlocks,
				...zeroIoTimes,
				...zeroWal
			}
		]
	},
	Settings: {},
	Planning: { ...zeroBlocks, ...zeroIoTimes },
	"Planning Time": 0.01,
	Triggers: [
		{
			"Trigger Name": "RI_ConstraintTrigger_c_18918",
			"Constraint Name": "d_p_fkey",
			Relation: "d",
			Calls: 100
		}
	],
	"Execution Time": 0.186
}

const insertWithTrigger = [insertWithTriggerTop]

/** A node of a capture without WAL: its estimates and its zero block counters beside `fields`. */
const node = (fields: Record<string, unknown>, plans: ReadonlyArray<Record<string, unknown>>) => ({
	"Startup Cost": 0,
	"Total Cost": 1,
	"Plan Rows": 1,
	"Plan Width": 8,
	...zeroBlocks,
	...fields,
	...(plans.length === 0 ? {} : { Plans: plans })
})

/** A capture without WAL or SERIALIZE of `plan`. */
const capture = (plan: Record<string, unknown>) => [
	{
		Plan: plan,
		Settings: {},
		Planning: zeroBlocks,
		"Planning Time": 0.1,
		Triggers: [],
		"Execution Time": 0.2
	}
]

const parsed = (value: unknown) => Result.getOrThrow(parsePlan(value))

/** A nested loop probing an index per outer row, beside a bitmap scan whose index scan yields TIDs only. */
const nestedLoop = capture(
	node({ "Node Type": "Nested Loop", "Actual Rows": 30, "Actual Loops": 1, "Join Type": "Inner" }, [
		node(
			{
				"Node Type": "Bitmap Heap Scan",
				"Relation Name": "parent",
				"Actual Rows": 10,
				"Actual Loops": 1,
				"Recheck Cond": "(k < 10)",
				"Rows Removed by Index Recheck": 2,
				"Rows Removed by Filter": 3
			},
			[
				node(
					{
						"Node Type": "Bitmap Index Scan",
						"Index Name": "parent_k",
						"Actual Rows": 15,
						"Actual Loops": 1,
						"Index Cond": "(k < 10)"
					},
					[]
				)
			]
		),
		node(
			{
				"Node Type": "Index Scan",
				"Relation Name": "child",
				"Index Name": "child_parent",
				"Actual Rows": 3,
				"Actual Loops": 10,
				"Index Cond": "(parent = parent.k)",
				Filter: "(flag)",
				"Rows Removed by Filter": 1
			},
			[]
		)
	])
)

describe("EXPLAIN capture", () => {
	it("reads every node's figures, conditions, buffers and WAL, and the statement's planning and serialization", () => {
		const e = parsed(sortedRange)
		assert.equal(e.planningMs, 0.081)
		assert.equal(e.executionMs, 0.021)
		assert.equal(e.plan.nodeType, "Sort")
		assert.deepEqual(e.plan.sortKey, Option.some(["v"]))
		assert.deepEqual(
			e.plan.sort,
			Option.some({ method: "quicksort", spaceUsedKb: 27, spaceType: "Memory" })
		)
		assert.equal(e.plan.buffers.sharedHit, 3)
		const scan = defined(e.plan.children[0])
		assert.equal(scan.nodeType, "Index Scan")
		assert.deepEqual(scan.index, Option.some("t_pkey"))
		assert.deepEqual(scan.relation, Option.some("t"))
		assert.deepEqual(scan.indexCond, Option.some("(id < 50)"))
		assert.deepEqual(scan.indexSearches, Option.some(1))
		assert.deepEqual(scan.filter, Option.none())
		assert.deepEqual(scan.wal, { kind: "captured", records: 0, fpi: 0, bytes: 0, fpiBytes: 0 })
		assert.deepEqual(e.planningBuffers, { ...zeroBuffers, sharedHit: 37 })
		assert.deepEqual(e.serialization, {
			kind: "captured",
			outputKb: 3,
			format: "text",
			buffers: zeroBuffers
		})
		assert.deepEqual(e.settings, { random_page_cost: "1.1" })
		assert.deepEqual(e.triggers, [])
		assert.deepEqual(parsed(jsonText(sortedRange)), e)
		/** A capture without WAL or SERIALIZE carries neither, on any node. */
		const plain = parsed(nestedLoop)
		assert.deepEqual(plain.plan.wal, { kind: "notCaptured" })
		assert.deepEqual(defined(plain.plan.children[0]).wal, { kind: "notCaptured" })
		assert.deepEqual(plain.serialization, { kind: "notCaptured" })
		assert.deepEqual(plain.plan.joinFilter, { kind: "none" })
		/** A nested loop that joins by testing each pair of rows reports the test as its Join Filter. */
		const filtered = parsed(
			capture(
				node(
					{
						"Node Type": "Nested Loop",
						"Actual Rows": 4,
						"Actual Loops": 1,
						"Join Type": "Inner",
						"Join Filter": "(e1.dst = e2.src)",
						"Rows Removed by Join Filter": 6
					},
					[
						node(
							{
								"Node Type": "Seq Scan",
								"Relation Name": "edge",
								Alias: "e1",
								"Actual Rows": 2,
								"Actual Loops": 1
							},
							[]
						),
						node({ "Node Type": "Materialize", "Actual Rows": 5, "Actual Loops": 2 }, [
							node(
								{
									"Node Type": "Seq Scan",
									"Relation Name": "edge",
									Alias: "e2",
									"Actual Rows": 5,
									"Actual Loops": 1
								},
								[]
							)
						])
					]
				)
			)
		)
		assert.deepEqual(filtered.plan.joinFilter, { kind: "filter", condition: "(e1.dst = e2.src)" })
		assert.equal(filtered.plan.rowsRemovedByJoinFilter, 6)
	})

	it("keeps a statement's totals at its root and reports AFTER triggers by call count", () => {
		const e = parsed(insertWithTrigger)
		assert.deepEqual(e.plan.operation, Option.some("Insert"))
		assert.deepEqual(e.plan.wal, {
			kind: "captured",
			records: 100,
			fpi: 0,
			bytes: 6300,
			fpiBytes: 0
		})
		assert.deepEqual(e.triggers, [
			{
				name: "RI_ConstraintTrigger_c_18918",
				constraint: Option.some("d_p_fkey"),
				relation: "d",
				calls: 100
			}
		])
		const totals = statementTotals(e)
		assert.deepEqual(totals.wal, e.plan.wal)
		assert.equal(totals.buffers.sharedHit, 99)
		assert.equal(totals.triggerCalls, 100)
		assert.deepEqual(totals.serialization, { kind: "notCaptured" })
		assert.deepEqual(relationsRead(e.plan), [])
	})

	it("refuses output it cannot read exactly, and never invents a counter PostgreSQL did not print", () => {
		const refused = (value: unknown, why: string): void => {
			const read = parsePlan(value)
			assert.ok(Result.isFailure(read), why)
			assert.ok(read.failure instanceof MalformedPlan, why)
		}
		const scan = defined(sortedRangeTop.Plan.Plans[0])
		const { "WAL Bytes": _bytes, ...scanWithoutWalBytes } = scan
		const { "Shared Read Blocks": _read, ...planWithoutReads } = sortedRangeTop.Plan
		const { Planning: _planning, ...withoutPlanning } = sortedRangeTop
		refused([], "no result")
		refused([sortedRangeTop, sortedRangeTop], "two results")
		refused([{ Plan: {} }], "an empty plan")
		refused(
			[{ ...sortedRangeTop, Plan: { ...sortedRangeTop.Plan, "Plan Rows": "49" } }],
			"a figure as text"
		)
		refused([{ ...insertWithTriggerTop, Triggers: [{ Calls: 1 }] }], "a trigger without its name")
		refused(
			[{ ...sortedRangeTop, Plan: { ...sortedRangeTop.Plan, Plans: [scanWithoutWalBytes] } }],
			"a WAL key"
		)
		refused([{ ...sortedRangeTop, Plan: planWithoutReads }], "a block counter")
		refused([withoutPlanning], "the planner's buffers")
	})
})

/**
 * `WITH c AS MATERIALIZED (SELECT id FROM a) SELECT count(*) FROM c, (SELECT id FROM a OFFSET 0) s WHERE c.id = s.id
 * AND s.id > 10` over a 100-row table, in the shape the local PostgreSQL 19 build planned it: the CTE's subplan scans
 * `a` once and a CTE Scan re-reads its 100 rows; a Subquery Scan filters the 100 rows its own Seq Scan read.
 */
const cteAndSubquery = capture(
	node({ "Node Type": "Aggregate", Strategy: "Plain", "Actual Rows": 1, "Actual Loops": 1 }, [
		node(
			{
				"Node Type": "Seq Scan",
				"Parent Relationship": "InitPlan",
				"Subplan Name": "CTE c",
				"Relation Name": "a",
				Alias: "a_1",
				"Actual Rows": 100,
				"Actual Loops": 1
			},
			[]
		),
		node(
			{
				"Node Type": "Hash Join",
				"Parent Relationship": "Outer",
				"Join Type": "Inner",
				"Actual Rows": 90,
				"Actual Loops": 1,
				"Hash Cond": "(c.id = s.id)"
			},
			[
				node(
					{
						"Node Type": "CTE Scan",
						"Parent Relationship": "Outer",
						"CTE Name": "c",
						Alias: "c",
						"Actual Rows": 100,
						"Actual Loops": 1
					},
					[]
				),
				node(
					{
						"Node Type": "Hash",
						"Parent Relationship": "Inner",
						"Actual Rows": 90,
						"Actual Loops": 1
					},
					[
						node(
							{
								"Node Type": "Subquery Scan",
								"Parent Relationship": "Outer",
								Alias: "s",
								"Actual Rows": 90,
								"Actual Loops": 1,
								Filter: "(s.id > 10)",
								"Rows Removed by Filter": 10
							},
							[
								node(
									{
										"Node Type": "Seq Scan",
										"Parent Relationship": "Subquery",
										"Relation Name": "a",
										Alias: "a",
										"Actual Rows": 100,
										"Actual Loops": 1
									},
									[]
								)
							]
						)
					]
				)
			]
		)
	])
)

describe("reading plans structurally", () => {
	it("counts rows read over every loop, and a bitmap scan's rows once", () => {
		const plan = parsed(nestedLoop).plan
		assert.equal(rowsRead(plan), 15 + 40)
		assert.deepEqual(relationsRead(plan), ["parent", "child"])
		assert.deepEqual(nodeTypeCounts(plan), {
			"Nested Loop": 1,
			"Bitmap Heap Scan": 1,
			"Bitmap Index Scan": 1,
			"Index Scan": 1
		})
		assert.deepEqual(indexAccesses(plan), [
			{
				nodeType: "Bitmap Index Scan",
				relation: Option.none(),
				index: "parent_k",
				indexCond: Option.some("(k < 10)"),
				orderBy: Option.none(),
				filter: Option.none()
			},
			{
				nodeType: "Index Scan",
				relation: Option.some("child"),
				index: "child_parent",
				indexCond: Option.some("(parent = parent.k)"),
				orderBy: Option.none(),
				filter: Option.some("(flag)")
			}
		])
	})

	it("counts a CTE's and a subquery's rows where they were read, never again where they are re-read", () => {
		const plan = parsed(cteAndSubquery).plan
		assert.equal(rowsRead(plan), 100 + 100)
		assert.equal(rowsGenerated(plan), 0)
		/** An insert from generate_series generates its rows and reads none. */
		const insert = parsed(insertWithTrigger).plan
		assert.deepEqual([rowsRead(insert), rowsGenerated(insert)], [0, 100])
		assert.equal(summarizePlans([parsed(insertWithTrigger)]).rowsGenerated.p50, 100)
	})
})

const reasons = (r: OperationResult) => Arr.map(r.retries, (x) => x.reason)

describe("outcomes, retries and loads", () => {
	/** Two retries with no delay, so the attempts run synchronously. */
	const policy: RetryPolicy = { times: 2, baseMs: 0 }
	const unlabelled: RetryOptions = { uniqueAborts: [], label: () => undefined }
	/** One scripted attempt: it commits, or PostgreSQL refuses it with `code` at a statement or at COMMIT. */
	type Step =
		| { readonly kind: "commits" }
		| {
				readonly kind: "refused"
				readonly code: string
				readonly constraint: Constraint
				readonly at: "statement" | "commit"
		  }
	const commits: Step = { kind: "commits" }
	const atCommit = (code: string): Step => ({
		kind: "refused",
		code,
		constraint: { kind: "none" },
		at: "commit"
	})
	const failedOf = (step: Extract<Step, { readonly kind: "refused" }>): FailedOutcome => {
		const error = {
			code: step.code,
			...(step.constraint.kind === "named" ? { constraint: step.constraint.name } : {})
		}
		return Option.getOrThrow(
			step.at === "statement" ? failedAtStatement(error, "write") : failedAt(error, step.at)
		)
	}
	const scripted = (steps: ReadonlyArray<Step>, options: RetryOptions) => (n: number) => {
		const step = defined(steps[n - 1], `the script has an attempt ${n}`)
		return Effect.succeed(
			sqlAttempted(step.kind === "commits" ? { kind: "committed" } : failedOf(step), options)
		)
	}

	it.effect(
		"retries what grizzle classifies as a TransientFailure, up to the caller's policy",
		() =>
			Effect.gen(function* () {
				const ran = yield* withRetries(
					scripted([atCommit("40001"), atCommit("40P01"), commits], unlabelled),
					policy
				)
				assert.deepEqual(
					[ran.outcome, ran.attempts, reasons(ran)],
					[{ kind: "committed" }, 3, ["SerializationFailure", "Deadlock"]]
				)
				assert.deepEqual(ran.retries[0]?.failed, {
					kind: "failed",
					at: "commit",
					sqlstate: "40001",
					cause: "serialization",
					constraint: { kind: "none" }
				})
				/** The policy ran out: the last attempt stands, and only the ones before it were discarded. */
				const exhausted = yield* withRetries(
					scripted([atCommit("40001"), atCommit("40001"), atCommit("40001"), commits], unlabelled),
					policy
				)
				assert.equal(exhausted.attempts, 3)
				assert.equal(
					exhausted.outcome.kind === "failed" && exhausted.outcome.cause,
					"serialization"
				)
				assert.deepEqual(reasons(exhausted), ["SerializationFailure", "SerializationFailure"])
				const refused = yield* withRetries(
					scripted([atCommit("23000"), commits], unlabelled),
					policy
				)
				assert.equal(refused.attempts, 1)
				assert.deepEqual(refused.retries, [])
			})
	)

	it.effect(
		"retries a 23505 only where the operation names its constraint, at its statement",
		(ctx) =>
			Effect.gen(function* () {
				/** The constraints are matched by equality, so the names are opaque tokens. */
				const itemKey = wild.constraint("item_pkey")
				const serial: Step = {
					kind: "refused",
					code: "23505",
					constraint: { kind: "named", name: itemKey },
					at: "statement"
				}
				const naming: RetryOptions = {
					uniqueAborts: [
						{ constraint: itemKey, relation: "Item", reason: "GeneratedSerialUnique" }
					],
					label: () => undefined
				}
				const apply = yield* withRetries(scripted([serial, commits], naming), policy)
				assert.deepEqual(
					[apply.outcome, reasons(apply)],
					[{ kind: "committed" }, ["GeneratedSerialUnique"]]
				)
				assert.deepEqual(apply.retries[0]?.failed?.constraint, { kind: "named", name: itemKey })
				/** Without the rule, another constraint, or the same one at COMMIT, it is a key law, never transient. */
				const others: Arr.NonEmptyReadonlyArray<readonly [Step, RetryOptions]> = [
					[serial, unlabelled],
					[
						{ ...serial, constraint: { kind: "named", name: wild.constraint("item_name_key") } },
						naming
					],
					[{ ...serial, at: "commit" }, naming]
				]
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/bench/unique-not-retried",
							generator: element(others),
							literal: Formatter.format,
							limit: 3,
							coverage: noCoverage,
							caseHang
						},
						([step, options]) =>
							Effect.map(withRetries(scripted([step, commits], options), policy), (once) => {
								assert.deepEqual([once.attempts, once.retries], [1, []])
							})
					)
				)
				assert.equal(
					outcomeTransientReason(
						{
							kind: "failed",
							at: "statement",
							statement: "write",
							sqlstate: "40P01",
							cause: "deadlock",
							constraint: { kind: "none" }
						},
						[]
					)?._tag,
					"Deadlock"
				)
				assert.equal(
					outcomeTransientReason(
						{
							kind: "failed",
							at: "commit",
							sqlstate: "23000",
							cause: "lawViolation",
							constraint: { kind: "none" }
						},
						[]
					),
					undefined
				)
			})
	)
})

describe("result rows", () => {
	it("reads rows as text cells, and agrees on one set of rows only, a repeated row on neither side", () => {
		const read = textRows(
			[
				["1", null],
				["2", 3]
			],
			0
		)
		assertVariant(read, "_tag", "Failure")
		assert.ok(read.failure instanceof MalformedRows)
		assert.deepEqual([read.failure.statement, read.failure.row, read.failure.column], [0, 1, 1])
		const distinct = [
			["1", "x"],
			["2", null]
		]
		assert.deepEqual(
			rowsAgree(distinct, [
				["2", null],
				["1", "x"]
			]),
			Option.none()
		)
		assert.notDeepEqual(
			rowsAgree(distinct, [
				["1", "x"],
				["2", "y"]
			]),
			Option.none()
		)
		const rows = [
			["1", "x"],
			["2", null],
			["2", null]
		]
		const permuted = [
			["2", null],
			["1", "x"],
			["2", null]
		]
		assert.notDeepEqual(rowsAgree(rows, permuted), Option.none())
		assert.notDeepEqual(rowsAgree(distinct, rows), Option.none())
		const a = resultSet(rows)
		assert.deepEqual(
			{ rows: a.rows, distinct: a.distinct, repeated: a.repeated },
			{ rows: 3, distinct: 2, repeated: 1 }
		)
		assert.equal(resultSet(permuted).digest, a.digest)
		assert.notEqual(resultSet([["2", null]]).digest, a.digest)
		assert.notEqual(resultSet([[null]]).digest, resultSet([["N"]]).digest)
		assert.notEqual(resultSet([["a", "b"]]).digest, resultSet([["ab"]]).digest)
	})
})

describe("verdicts judge a gate by its tagged checks", () => {
	it("fails on a failing check and passes when every check holds", () => {
		const seek = mechanism("Index Cond on the seek", false, "Filter only")
		const page = equivalence("same page", true, "40 rows each")
		assert.deepEqual(verdictOf("R05", { checks: [seek, page] }), {
			gate: "R05",
			outcome: "fail",
			failing: ["Index Cond on the seek"],
			checks: [seek, page]
		})
		assert.deepEqual(verdictOf("R05", { checks: [page] }), {
			gate: "R05",
			outcome: "pass",
			checks: [page]
		})
	})
})

/** A server identity that matches the pin, as a run against the local cluster reports it. */
const pinnedServer = (pinVersion: string): ServerIdentity => ({
	version: `PostgreSQL ${pinVersion} on test`,
	serverVersion: pinVersion,
	serverVersionNum: 190000,
	jitAvailable: true,
	settings: Rec.fromEntries(Arr.map(serverSettings, (s) => [s, "x"] as const)),
	extensions: {}
})

const seekCase: CaseRecord<GateId> = {
	name: "seek",
	gates: ["R05"],
	conditions: {
		workload: "w",
		schemaState: "s",
		dataDistribution: "d",
		parameters: {},
		resultSemantics: "r",
		cacheState: "c"
	},
	phases: { executeMs: { n: 1, min: 1, p50: 1, p95: 1, p99: 1, max: 1, mean: 1 } },
	variants: [],
	comparisons: [],
	transactions: {},
	loads: {},
	measures: {}
}

const seekIdentity = Effect.gen(function* () {
	const pin = yield* readPin
	const identity: BenchIdentity = yield* benchIdentity({
		benchmark: "gate/row-seek",
		server: pinnedServer(pin.version),
		phases: ["executeMs"],
		scope: "a seek",
		options: {},
		source: yield* sourceIdentity
	})
	return identity
})

layer(NodeServices.layer, { excludeTestServices: true })(
	"gate records carry their identity and phases",
	(suite) => {
		suite.effect("finds nothing missing in a complete record, and names each gap", () =>
			Effect.gen(function* () {
				const record: RanRecord = {
					kind: "ran",
					identity: yield* seekIdentity,
					name: "row-seek",
					file: "bench/query/row-seek.bench.ts",
					title: "Row seeks",
					gates: ["R05"],
					quick: true,
					runPhases: { setupMs: 1, runMs: 2 },
					release: { kind: "clean" },
					verdicts: [verdictOf("R05", { checks: [mechanism("Index Cond", true, "on the seek")] })],
					cases: [seekCase],
					problems: []
				}
				assert.deepEqual(recordProblems(record), [])
				const broken: RanRecord = {
					...record,
					identity: { ...record.identity, phases: ["commitMs"] },
					verdicts: [],
					cases: [
						{ ...seekCase, conditions: { ...seekCase.conditions, cacheState: "" }, gates: ["R06"] }
					]
				}
				assert.deepEqual(recordProblems(broken), [
					{ kind: "no verdict", gate: "R05" },
					{ kind: "condition", case: "seek", field: "cacheState" },
					{ kind: "case gate", case: "seek", gate: "R06" },
					{ kind: "phase undeclared", case: "seek", phase: "executeMs" }
				])
				assert.deepEqual(recordProblems({ ...record, cases: [] }), [{ kind: "no phase timings" }])
			})
		)

		type RecordFeature = "run failed" | "release clean" | "release leaked" | "failed run leaked"

		/** What a run or a release failed with. */
		class Failure extends Data.TaggedError("Failure")<{ readonly what: string }> {}

		suite.effect("a run's record keeps its cases when only the release fails", (ctx) =>
			Effect.gen(function* () {
				const pin = yield* readPin
				const gate = defineGate({
					name: "row-seek",
					gates: ["R05"],
					title: "Row seeks",
					scope: "a seek",
					phases: ["executeMs"],
					options: { full: {}, quick: {} },
					run: () => Effect.die(new Error("recordOf never runs a gate"))
				})
				const base = {
					identity: yield* runIdentity({
						benchmark: "gate/row-seek",
						phases: ["executeMs"],
						scope: "a seek",
						options: {},
						source: yield* sourceIdentity
					}),
					file: "bench/query/row-seek.bench.ts",
					quick: true,
					runPhases: { setupMs: 1, runMs: 2 }
				}
				const input: VerdictInput = { checks: [mechanism("Index Cond", true, "on the seek")] }
				const result: GateRun = { cases: [seekCase], verdicts: [{ gate: "R05", input }] }
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/bench/record-of",
							generator: (source) =>
								[
									source.draw(element<"passed" | "failed">(["passed", "failed"])),
									source.draw(element<"clean" | "leaked">(["clean", "leaked"]))
								] as const,
							literal: Formatter.format,
							limit: 4,
							coverage: requiredInSpace<RecordFeature>([
								"run failed",
								"release clean",
								"release leaked",
								"failed run leaked"
							]),
							caseHang
						},
						([ran, released], c) =>
							Effect.sync(() => {
								const run =
									ran === "passed"
										? Exit.succeed({ server: pinnedServer(pin.version), result })
										: Exit.fail(new Failure({ what: "the run failed" }))
								const release =
									released === "clean"
										? Exit.void
										: Exit.fail(new Failure({ what: "a role still had sessions" }))
								const record = recordOf(gate, base, run, release)
								if (ran === "failed") {
									c.note("run failed")
									assertVariant(record, "kind", "failed")
									assert.equal(record.release.kind, released)
									assert.equal(
										Arr.some(gateFindings([record]), (f) => f.kind === "leaked"),
										released === "leaked"
									)
									if (released === "leaked") {
										c.note("failed run leaked")
									}
									return
								}
								assertVariant(record, "kind", "ran")
								assert.deepEqual(record.cases, result.cases)
								switch (released) {
									case "clean":
										c.note("release clean")
										assert.deepEqual(record.release, { kind: "clean" })
										assert.deepEqual(record.verdicts, [verdictOf("R05", input)])
										return
									case "leaked":
										c.note("release leaked")
										assert.equal(record.release.kind, "leaked")
										assert.deepEqual(
											Arr.map(record.verdicts, (v) => v.outcome),
											["error"]
										)
										return
								}
							})
					)
				)
			})
		)
	}
)

layer(NodeServices.layer, { excludeTestServices: true })("the gate catalog", (suite) => {
	suite.effect("every catalog gate has exactly one bench file in its owner's directory", () =>
		Effect.gen(function* () {
			const discovered = yield* discoverGates(
				Arr.map(
					[...ownerDirectories.query, ...ownerDirectories.write],
					(dir) => `${repoRoot}/${dir}`
				)
			)
			const path = yield* Path.Path
			assert.deepEqual(
				Arr.sort(
					Arr.flatMap(discovered, (d) => d.gate.gates),
					Order.String
				),
				Arr.sort(
					Arr.map(gateCatalog, (e) => e.id),
					Order.String
				)
			)
			for (const d of discovered) {
				for (const id of d.gate.gates) {
					assert.ok(
						Arr.contains(ownerDirectories[gateOwner(id)], path.dirname(d.file)),
						`${d.file} covers ${id}`
					)
				}
				assert.deepEqual(
					Arr.sort(Rec.keys(d.gate.options(true)), Order.String),
					Arr.sort(Rec.keys(d.gate.options(false)), Order.String),
					d.file
				)
			}
		})
	)
})

layer(NodeServices.layer, { excludeTestServices: true })("pnpm bench's command line", (suite) => {
	suite.effect("refuses an unknown command or argument, and a gate file that exports no gate", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			yield* Effect.flip(parseBenchArgs(["bogus"]))
			yield* Effect.flip(parseBenchArgs(["full", "x"]))
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-bench-" })
			yield* fs.writeFileString(path.join(dir, "package.json"), '{ "type": "module" }\n')
			yield* fs.writeFileString(path.join(dir, "broken.bench.ts"), "export default 1\n")
			const refused = yield* Effect.flip(discoverGates([dir]))
			assert.ok(refused._tag === "GateDiscoveryError" && refused.problems.length === 1)
		})
	)
})
