import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { provisionalTheory } from "#compiler/analysis/theory/theory.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { claimedColumns } from "#compiler/ir/keys.ts"
import {
	conservativeMeta,
	type NodeOf,
	type RelDag,
	type RelNode,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { analyzeLogical, checkerEvidence } from "#compiler/logical/annotate.ts"
import { assert, defined, matchesObject, succeeded } from "#test/support/assert.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import { type BuiltQuery, Ir, SchemaModel } from "#test/support/fixtures/ir/build.ts"
import { f, relation } from "#test/support/fixtures/ir/desc.ts"
import * as P from "#test/support/fixtures/ir/payroll.ts"
import * as W from "#test/support/fixtures/ir/work.ts"
import { caseHang } from "#test/support/limits.ts"
import { analyze, logicalEnv, theoryOf } from "#test/unit/analysis/logical/support.ts"

/**
 * Normative logical evidence: the delivered type of attachments, on the shapes the small-scope suite
 * (test/unit/analysis/small) and the generated evidence suite (evidence.test.ts) do not draw. Keys and cardinality
 * relative to parameters, get eligibility, aggregate-only and parameter-fixed groups, unions of several headings,
 * closed facts, relation parameters and filters fixing a key are judged there against the universe's truth.
 */

const work = theoryOf(W.ReportsDesc, provisionalTheory)
const payroll = theoryOf(P.ReportingDesc, provisionalTheory)

const attachments = (dag: RelDag) =>
	Arr.sort(
		Arr.map(
			Arr.filter(topoOrder(dag), (n): n is NodeOf<"Attach"> => n.kind === "Attach"),
			(n) => [n.name, n.delivered] as const
		),
		Order.Tuple([Order.String, Order.String])
	)

/** A region variable of `name` and `type`, under a fresh label. */
const declare = (q: Ir, name: string, type: VarDecl["type"]): VarDecl => ({
	id: q.b.ids.var(),
	name,
	type
})

const region = (q: Ir, parent: RelNode, form: "an equality" | "a correlated approver"): RelNode => {
	const approval = q.base("Approval")
	const uuid = q.column(approval, "run").type
	const vars = { run: declare(q, "run", uuid), who: declare(q, "who", uuid) }
	return q.b.node({
		kind: "MatchRegion",
		scope: q.b.ids.scope(),
		vars: [vars.run, vars.who],
		occurrences: [
			{
				id: q.b.ids.occurrence(),
				source: approval,
				bindings: [
					{ column: "run", var: vars.run },
					{ column: "approver", var: vars.who }
				],
				constants: []
			}
		],
		equalities: form === "an equality" ? [{ a: vars.run, b: vars.who }] : [],
		correlated:
			form === "a correlated approver"
				? [{ var: vars.who, expr: q.outerCol(parent.id, "employer", uuid) }]
				: [],
		heading: [{ name: "run", type: uuid }],
		loc: undefined,
		meta: conservativeMeta
	})
}

const scan = (
	q: Ir,
	bind: Readonly<Record<string, string>>,
	out: ReadonlyArray<readonly [string, string]>
) =>
	q.project(
		q.region([{ source: q.base("Approval"), bind, constants: {} }], conservativeMeta),
		out,
		conservativeMeta
	)

describe("the delivered type of an attachment", () => {
	const model = P.payrollModel()
	/** The parent: pay runs fixed to a stage, or any run, with their employer. */
	type Stage = "approved" | "draft" | "any"
	const runs = (q: Ir, stage: Stage): RelNode => {
		const run = q.base("PayRun")
		const m = q.region(
			[
				{
					source: run,
					bind: { id: "id", employer: "employer" },
					constants: stage === "any" ? {} : { stage: q.litFor(run, "stage", stage) }
				}
			],
			conservativeMeta
		)
		return q.project(
			m,
			[
				["id", "id"],
				["employer", "employer"]
			],
			conservativeMeta
		)
	}
	/**
	 * The Approval child: a plain scan of both columns or of the run alone, the run bound to the approver's variable in
	 * either order, a constant approver, an equality between them, the approver correlated with the parent's employer,
	 * or the run copied into a second column.
	 */
	type Child =
		| "a plain scan"
		| "a plain scan of the run"
		| "approver bound to the run first"
		| "run bound first, then the approver"
		| "a constant approver"
		| "an equality"
		| "a correlated approver"
		| "the run copied"
	const childOf = (q: Ir, parent: RelNode, child: Child): RelNode => {
		switch (child) {
			case "a plain scan":
				return scan(q, { run: "run", approver: "approver" }, [
					["run", "run"],
					["approver", "approver"]
				])
			case "a plain scan of the run":
				return scan(q, { run: "run" }, [["run", "run"]])
			case "approver bound to the run first":
				return scan(q, { approver: "run", run: "run" }, [["run", "run"]])
			case "run bound first, then the approver":
				return scan(q, { run: "run", approver: "run" }, [["run", "run"]])
			case "a constant approver": {
				const approval = q.base("Approval")
				return q.project(
					q.region(
						[
							{
								source: approval,
								bind: { run: "run" },
								constants: {
									approver: q.litFor(approval, "approver", "00000000-0000-4000-8000-000000000001")
								}
							}
						],
						conservativeMeta
					),
					[["run", "run"]],
					conservativeMeta
				)
			}
			case "an equality":
			case "a correlated approver":
				return region(q, parent, child)
			case "the run copied":
				return scan(q, { run: "run" }, [
					["run", "run"],
					["run2", "run"]
				])
		}
	}
	/**
	 * The correlations a child's heading admits: the run by the parent's id, that and the employer on a second column,
	 * or the run by the employer.
	 */
	const correlationsOf = (
		child: Child
	): Arr.NonEmptyReadonlyArray<ReadonlyArray<readonly [string, string]>> => {
		const byKey: ReadonlyArray<readonly [string, string]> = [["id", "run"]]
		const byEmployer: ReadonlyArray<readonly [string, string]> = [["employer", "run"]]
		if (child === "a plain scan") {
			return [
				byKey,
				byEmployer,
				[
					["id", "run"],
					["employer", "approver"]
				]
			]
		}
		if (child === "the run copied") {
			return [
				byKey,
				[
					["employer", "run2"],
					["id", "run"]
				],
				[
					["id", "run"],
					["employer", "run2"]
				]
			]
		}
		return [byKey, byEmployer]
	}
	type BareFeature = `${Child} ${"one" | "option"}` | `stage ${Stage}`

	it.effect(
		"delivers the bare child exactly where the selected-source containment proves one per parent",
		(ctx) => {
			const children: Arr.NonEmptyReadonlyArray<Child> = [
				"a plain scan",
				"a plain scan of the run",
				"approver bound to the run first",
				"run bound first, then the approver",
				"a constant approver",
				"an equality",
				"a correlated approver",
				"the run copied"
			]
			const stages: Arr.NonEmptyReadonlyArray<Stage> = ["approved", "draft", "any"]
			/** Every child, under every stage, with every correlation its heading admits. */
			const cases: Gen<{
				readonly child: Child
				readonly stage: Stage
				readonly correlation: ReadonlyArray<readonly [string, string]>
			}> = (source) => {
				const child = source.draw(element(children))
				return {
					child,
					stage: source.draw(element(stages)),
					correlation: source.draw(element(correlationsOf(child)))
				}
			}
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/logical/bare-approval",
						generator: cases,
						literal: Formatter.format,
						limit: 100,
						coverage: requiredInSpace<BareFeature>([
							"a plain scan one",
							"a plain scan of the run one",
							"the run copied one",
							...Arr.map(children, (child): BareFeature => `${child} option`),
							"stage draft",
							"stage any"
						]),
						caseHang
					},
					({ child, stage, correlation }, c) =>
						Effect.sync(() => {
							const q = new Ir(model)
							const parent = runs(q, stage)
							const built = q.build(
								q.attach(
									parent,
									childOf(q, parent, child),
									"approval",
									correlation,
									"array",
									undefined
								)
							)
							const bare =
								stage === "approved" &&
								(child === "a plain scan" ||
									child === "a plain scan of the run" ||
									child === "the run copied") &&
								correlation.length === 1 &&
								correlation[0]?.[0] === "id" &&
								correlation[0][1] === "run"
							c.note(`${child} ${bare ? "one" : "option"}`)
							c.note(`stage ${stage}`)
							assert.deepEqual(attachments(analyze(built.dag, logicalEnv(payroll))), [
								["approval", bare ? "one" : "option"]
							])
						})
				)
			)
		}
	)

	/**
	 * The ordinal of a sitting is the count of the student's sittings at or before it; attached, the group is never
	 * empty because the parent's own sitting satisfies the inclusive comparison. Variants: strict predecessors, a
	 * correlation beyond the group key or the group key paired with two parent columns, the scan's student read from the
	 * parent's id, a second scan in the child's region, and a further conjunct scoreDate <> 0 in its filter.
	 */
	type Correlation = "the group key" | "beyond the group key" | "the group key twice"
	interface OrdinalVariant {
		readonly inclusive: boolean
		readonly correlation: Correlation
		readonly studentFromId: boolean
		readonly secondScan: boolean
		readonly nonzero: boolean
	}
	const correlations: Readonly<Record<Correlation, ReadonlyArray<readonly [string, string]>>> = {
		"the group key": [["id", "pid"]],
		"beyond the group key": [
			["id", "pid"],
			["scoreDate", "ordinal"]
		],
		"the group key twice": [
			["student", "pid"],
			["id", "pid"]
		]
	}
	const ordinals = (variant: OrdinalVariant): BuiltQuery => {
		const Sitting = relation("Sitting", { id: f.uuid, student: f.uuid, scoreDate: f.bigint }, [
			"id"
		])
		const q = new Ir(
			new SchemaModel(
				ownedFixture({ name: "S", relations: [Sitting], statements: [], extends: undefined }),
				{}
			)
		)
		const parent = q.project(
			q.region(
				[
					{
						source: q.base("Sitting"),
						bind: { id: "id", student: "student", scoreDate: "scoreDate" },
						constants: {}
					}
				],
				conservativeMeta
			),
			[
				["id", "id"],
				["student", "student"],
				["scoreDate", "scoreDate"]
			],
			conservativeMeta
		)
		const t = q.base("Sitting")
		const idType = q.column(t, "id").type
		const dateType = q.column(t, "scoreDate").type
		const vars = {
			tid: declare(q, "tid", idType),
			tdate: declare(q, "tdate", dateType),
			pid: declare(q, "pid", idType),
			pdate: declare(q, "pdate", dateType)
		}
		const zero = q.litFor(t, "scoreDate", 0n)
		/** A sitting scored on day 0, any sitting: the child is empty when there is none. */
		const second = {
			id: q.b.ids.occurrence(),
			source: t,
			bindings: [{ column: "id", var: vars.tid }],
			constants: [{ column: "scoreDate", expr: zero }]
		}
		const region = q.b.node({
			kind: "MatchRegion",
			scope: q.b.ids.scope(),
			vars: [vars.tid, vars.tdate, vars.pid, vars.pdate],
			occurrences: [
				{
					id: q.b.ids.occurrence(),
					source: t,
					bindings: [
						{ column: "id", var: vars.tid },
						{ column: "scoreDate", var: vars.tdate }
					],
					constants: [
						{
							column: "student",
							expr: q.outerCol(parent.id, variant.studentFromId ? "id" : "student", idType)
						}
					]
				},
				...(variant.secondScan ? [second] : [])
			],
			equalities: [],
			correlated: [
				{ var: vars.pid, expr: q.outerCol(parent.id, "id", idType) },
				{ var: vars.pdate, expr: q.outerCol(parent.id, "scoreDate", dateType) }
			],
			heading: [
				{ name: "tid", type: idType },
				{ name: "tdate", type: dateType },
				{ name: "pid", type: idType },
				{ name: "pdate", type: dateType }
			],
			loc: undefined,
			meta: conservativeMeta
		})
		const col = (n: string): ScalarExpr =>
			q.outerCol(
				region.id,
				n,
				Option.getOrThrow(Arr.findFirst(region.heading, (c) => c.name === n)).type
			)
		const before = q.op("lt", [col("tdate"), col("pdate")])
		const tie = q.op("and", [
			q.op("eq", [col("tdate"), col("pdate")]),
			q.op(variant.inclusive ? "le" : "lt", [col("tid"), col("pid")])
		])
		const filtered = q.b.node({
			kind: "Filter",
			input: region,
			pred: variant.nonzero
				? q.op("and", [q.op("or", [before, tie]), q.op("not", [q.op("eq", [col("tdate"), zero])])])
				: q.op("or", [before, tie]),
			heading: region.heading,
			loc: undefined,
			meta: conservativeMeta
		})
		/** The group key is the parent-bound variable the attachment correlates. */
		const count = q.group(
			filtered,
			["tid", "tdate", "pid", "pdate"],
			["pid"],
			[{ name: "ordinal", agg: "count" }],
			conservativeMeta
		)
		return q.build(
			q.attach(parent, count, "ordinal", correlations[variant.correlation], "array", undefined)
		)
	}

	type OrdinalFeature = `${keyof OrdinalVariant} varied` | "one" | "option"
	it.effect(
		"an aggregate whose group a reflexive self-match proves nonempty is the bare child, and nothing else is",
		(ctx) => {
			const variants: Gen<OrdinalVariant> = (source) => ({
				inclusive: source.draw(boolean),
				correlation: source.draw(
					element<Correlation>(["the group key", "beyond the group key", "the group key twice"])
				),
				studentFromId: source.draw(boolean),
				secondScan: source.draw(boolean),
				nonzero: source.draw(boolean)
			})
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/logical/bare-ordinal",
						generator: variants,
						literal: Formatter.format,
						limit: 100,
						coverage: requiredInSpace<OrdinalFeature>([
							"one",
							"option",
							"inclusive varied",
							"correlation varied",
							"studentFromId varied",
							"secondScan varied",
							"nonzero varied"
						]),
						caseHang
					},
					(v, c) =>
						Effect.sync(() => {
							/**
							 * The self-match proves the group nonempty only for the inclusive comparison over the parent's own fact: the
							 * child correlated by the group key alone, its scan's student the parent's, one scan, no further conjunct
							 * (not(scoreDate = 0) is unknown under the substitution, and so is its negation).
							 */
							const varied: ReadonlyArray<keyof OrdinalVariant> = [
								...(v.inclusive ? [] : (["inclusive"] as const)),
								...(v.correlation === "the group key" ? [] : (["correlation"] as const)),
								...(v.studentFromId ? (["studentFromId"] as const) : []),
								...(v.secondScan ? (["secondScan"] as const) : []),
								...(v.nonzero ? (["nonzero"] as const) : [])
							]
							if (varied.length === 1) {
								c.note(`${defined(varied[0])} varied`)
							}
							const bare = varied.length === 0
							c.note(bare ? "one" : "option")
							assert.deepEqual(attachments(analyze(ordinals(v).dag, checkerEvidence)), [
								["ordinal", bare ? "one" : "option"]
							])
						})
				)
			)
		}
	)

	/**
	 * Planted shapes no generator draws, each with the delivered type its rule gives: a span coverage proves coverage of
	 * the leave by the union of the employee's spans, which usually holds no span equal to it, so never a bare child; a
	 * containment over several fields proves one per parent only where both fields come from one source fact; a child
	 * another reader shares keeps its own evidence, and the attachment is no narrower; and the fixtures' attachments,
	 * bare by a declared containment, a mirrors' two included: mirrors is sugar for them, so the employee's tax profile
	 * is one by Employee(id) ⊆ TaxProfile(employee) under the profile's key.
	 */
	type Planted =
		| "a span coverage"
		| "both fields from one shift"
		| "the fields from two shifts"
		| "a shared child"
		| "Work's task cards"
		| "Work's account cards"
		| "Payroll's payslip"
		| "Payroll's employee card"
	it.effect(
		"delivers each planted shape's type: coverage no bare child, a several-field containment from one fact, a shared child its own evidence, the fixtures' by their declared containments",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/logical/bare-planted",
						generator: element<Planted>([
							"a span coverage",
							"both fields from one shift",
							"the fields from two shifts",
							"a shared child",
							"Work's task cards",
							"Work's account cards",
							"Payroll's payslip",
							"Payroll's employee card"
						]),
						literal: Formatter.format,
						limit: 8,
						coverage: requiredInSpace<Planted>([
							"a span coverage",
							"both fields from one shift",
							"the fields from two shifts",
							"a shared child",
							"Work's task cards",
							"Work's account cards",
							"Payroll's payslip",
							"Payroll's employee card"
						]),
						caseHang
					},
					(planted, c) =>
						Effect.sync(() => {
							c.note(planted)
							switch (planted) {
								case "a span coverage": {
									const payrollOnly = theoryOf(P.PayrollDesc, provisionalTheory)
									assert.ok(
										Arr.some(
											payrollOnly.evidence.containments,
											(x) => x.coverage && x.from.relation === "Leave"
										)
									)
									assert.deepEqual(attachments(analyze(coverage().dag, logicalEnv(payrollOnly))), [
										["employment", "option"]
									])
									return
								}
								case "both fields from one shift":
								case "the fields from two shifts":
									assert.deepEqual(
										attachments(
											analyze(
												shifts(planted === "both fields from one shift" ? 1 : 2).dag,
												logicalEnv(payroll)
											)
										),
										[["sheet", planted === "both fields from one shift" ? "one" : "option"]]
									)
									return
								case "a shared child": {
									const { dag, notes } = sharedNotes()
									const analysis = succeeded(analyzeLogical(dag, logicalEnv(work)))
									assert.deepEqual(attachments(analysis.dag), [["note", "option"]])
									const meta = analysis.of(notes).node.meta
									matchesObject(meta, { card: "many" })
									assert.deepEqual(Arr.map(meta.logicalKeys, claimedColumns), [["task"]])
									return
								}
								case "Work's task cards":
									assert.deepEqual(
										attachments(analyze(W.workQueries.taskCards().dag, logicalEnv(work))),
										[
											["automatic", "option"],
											["note", "option"]
										]
									)
									return
								case "Work's account cards":
									assert.deepEqual(
										attachments(analyze(W.workQueries.accountCards().dag, logicalEnv(work))),
										[
											["automaticTasks", "option"],
											["tasks", "array"]
										]
									)
									return
								case "Payroll's payslip":
									assert.deepEqual(
										attachments(analyze(P.payrollQueries.payslip().dag, logicalEnv(payroll))),
										[
											["deposits", "array"],
											["levies", "array"],
											["offCycleReason", "option"],
											["person", "one"]
										]
									)
									return
								case "Payroll's employee card":
									assert.deepEqual(
										attachments(analyze(P.payrollQueries.employeeCard().dag, logicalEnv(payroll))),
										[
											["manager", "option"],
											["profile", "one"]
										]
									)
							}
						})
				)
			)
	)
})

/**
 * contained(Leave(employee, during) -> Employment(employee, during)), a span coverage: each leave with its employee's
 * employments attached by employee and span.
 */
const coverage = (): BuiltQuery => {
	const q = new Ir(P.payrollModel())
	const parent = q.project(
		q.region(
			[
				{ source: q.base("Leave"), bind: { employee: "employee", during: "during" }, constants: {} }
			],
			conservativeMeta
		),
		[
			["employee", "employee"],
			["during", "during"]
		],
		conservativeMeta
	)
	const employment = q.project(
		q.region(
			[
				{
					source: q.base("Employment"),
					bind: { employee: "employee", during: "during", basis: "basis" },
					constants: {}
				}
			],
			conservativeMeta
		),
		[
			["employee", "employee"],
			["during", "during"],
			["basis", "basis"]
		],
		conservativeMeta
	)
	return q.build(
		q.attach(
			parent,
			employment,
			"employment",
			[
				["employee", "employee"],
				["during", "during"]
			],
			"array",
			undefined
		)
	)
}

/**
 * contained(on(select(Shift, (s) => s.eq(s.status, "approved")), "employee", "week"), on(Timesheet, "employee",
 * "week")): approved shifts' employee and week read from one scan or two, with the timesheet attached by both.
 */
const shifts = (scans: 1 | 2): BuiltQuery => {
	const q = new Ir(P.payrollModel())
	const shift = q.base("Shift")
	const approved = { status: q.litFor(shift, "status", "approved") }
	const m = q.region(
		scans === 1
			? [{ source: shift, bind: { employee: "e", week: "w" }, constants: approved }]
			: [
					{ source: shift, bind: { employee: "e" }, constants: approved },
					{ source: shift, bind: { week: "w" }, constants: approved }
				],
		conservativeMeta
	)
	const parent = q.project(
		m,
		[
			["e", "e"],
			["w", "w"]
		],
		conservativeMeta
	)
	const sheet = q.project(
		q.region(
			[
				{
					source: q.base("Timesheet"),
					bind: { employee: "employee", week: "week", ceiling: "ceiling" },
					constants: {}
				}
			],
			conservativeMeta
		),
		[
			["employee", "employee"],
			["week", "week"],
			["ceiling", "ceiling"]
		],
		conservativeMeta
	)
	return q.build(
		q.attach(
			parent,
			sheet,
			"sheet",
			[
				["e", "employee"],
				["w", "week"]
			],
			"array",
			undefined
		)
	)
}

/** Tasks with their notes attached, the notes also a root of their own. */
const sharedNotes = () => {
	const q = new Ir(W.workModel())
	const parent = q.project(
		q.region([{ source: q.base("Task"), bind: { id: "id" }, constants: {} }], conservativeMeta),
		[["id", "id"]],
		conservativeMeta
	)
	const notes = q.project(
		q.region(
			[{ source: q.base("TaskNote"), bind: { task: "task", note: "note" }, constants: {} }],
			conservativeMeta
		),
		[
			["task", "task"],
			["note", "note"]
		],
		conservativeMeta
	)
	const attached = q.attach(parent, notes, "note", [["id", "task"]], "array", undefined)
	return { dag: q.b.build([attached, notes]), notes }
}
