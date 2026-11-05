import { Array as Arr, Effect, Option, Predicate, Result } from "effect"
import { runRefresh } from "#adapter/refresh/run.ts"
import { refreshTargets } from "#adapter/refresh/targets.ts"
import { makePool } from "#adapter/wire/session.ts"
import { summarize } from "#bench/cold/stats.ts"
import { explain, findNodes, type PlanNode, planNodes } from "#bench/harness/explain.ts"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	type GateCheck,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"
import { compareVariants, measureVariant, type VariantOptions } from "#bench/harness/variant.ts"
import {
	agrees,
	autocommit,
	type Compiled,
	compile,
	conditions,
	deliver,
	deliveredAgree,
	fill,
	GateSetupError,
	handwritten,
	handwrittenRows,
	headingOf,
	installedIndexes,
	installFixture,
	judged,
	type MeasureOptions,
	measureQuery,
	optimizedStatement,
	plainExplain,
	queryPhases,
	rawSession,
	runtimeSession,
	settle
} from "#bench/query/support/kit.ts"

import {
	BestThree,
	bestForStudents,
	bestPerStudent,
	bestThreeRows,
	Lab,
	LabReports,
	labData,
	labPrices,
	labPrograms,
	labRefresher,
	labRefreshers,
	labSittings,
	loadLab,
	studentSheetOne,
	studentSheets,
	topPerStudent,
	withNext,
	withNextPrice,
	withPrice,
	withPriceFor
} from "#bench/query/support/lab.ts"

import {
	indexAccessOn,
	nodeTypes,
	outline,
	planOf,
	rowsReadFrom,
	scansOf
} from "#bench/query/support/plans.ts"
import { indices, maxOf } from "#compiler/core/array.ts"
import { lateralParentMax } from "#compiler/core/limits.ts"
import { ledgerStatements } from "#compiler/deploy/ledger/ledger.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import type { OptimizedStatement } from "#compiler/lower/shapes/index.ts"
import { installedDerivedRelations } from "#compiler/physical/derived/objects.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import { parseSchemaInput } from "#compiler/program/schema.ts"
import { roleDescOf } from "#compiler/schema/world.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { testArtifacts } from "#test/support/compile.ts"
import { ledgerPrologue } from "#test/support/flight/model.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import { labeledStatements } from "#test/support/oracle/compare.ts"
import { clusterConnection, clusterPool, parsedConnection } from "#test/support/pg.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * R20, R27 and R42: bounded subsets, successors and as-of selections by the parent set.
 *
 * "The correlated shape is right for a few parents and the wrong default for a whole relation". Each
 * gate runs its shape over a small bound parent set and over every group of the Lab fixture (support/lab.ts), the
 * generated statements against the conservative composition and against handwritten LATERAL and whole-relation SQL:
 *
 * - R20 (:247): a LATERAL plan shows a Limit under the nested loop with an index condition on the correlation key and
 *   reads parents times k rows; a whole-relation plan reads the input once. A pipelined attachment's form is fixed by
 *   its parent rows' bound, since the parent statement shares the child's flight: over a key-lookup parent, bounded at
 *   one row, the take is the LATERAL form, and over a parent statement with no bound it reads every group. A form is
 *   chosen per execution only by a relation parameter's distinct count or a page's size. The take also runs through
 *   `bind` over every student, k = 3 and k = 1, which the policy lowers to row_number and DISTINCT ON; through `bind`
 *   to a relation parameter delivered with a few students and with every student, whose count chooses per execution;
 *   and as a derived relation's definition (support/lab.ts BestThree), which "always wants every group, so it never
 *   takes the correlated form" (:243): refreshed by the runtime's refresh transaction, its refresh time, rows written
 *   and the definition's workers launched recorded. The threshold between the two forms, lateralParentMax
 *   (core/limits.ts), is an operating point between two genuinely different shapes that deliver the same rows, so the
 *   gate also runs both over the same input across the sizes it decides by, for its evidence to be read off the
 *   crossover: take(k) by (score desc, id) per parent, k = 1 and k = 3, for a relation parameter's parents sent as the
 *   runtime sends a relation input, one text array per column read by unnest, as the LATERAL probe, LIMIT k per
 *   parent, and as the whole-relation pass over every group, DISTINCT ON for k = 1 and row_number otherwise, joined to
 *   the parents. Parent counts run from one to past the threshold, and group sizes from a few sittings per student to
 *   many, each group size a band of students of a second Lab install; both shapes are written as grizzle emits them,
 *   over that install's tables and access paths, and the gate checks that they agree.
 * - R27 (:313): the strict successor over every sitting agrees with the LATERAL take(1) on groups of one row, on the
 *   last row of each group (which the bound form removes) and on ties of the day broken by the key.
 * - R42 (:462): the latest price at or before each sitting, and the mirror, agree with the LATERAL form on ties at
 *   equal prefixes, on parents before the first price and on groups without prices; the ordered pass over whole inputs
 *   probes no parent; a relation parameter's few students take the LATERAL probe.
 */
interface Options extends Readonly<Record<string, unknown>> {
	readonly students: number
	readonly perStudent: number
	readonly samples: number
	/** Students in each group-size band of the both-forms measurement of lateralParentMax. */
	readonly studentsPerBand: number
	readonly groupSizes: Arr.NonEmptyReadonlyArray<number>
	readonly parentCounts: Arr.NonEmptyReadonlyArray<number>
}

type Gates = "R20" | "R27" | "R42"

/** A band of students with `groupSize` sittings each: its first student, and its first sitting's id. */
interface Band {
	readonly groupSize: number
	readonly firstStudent: number
	readonly firstSitting: number
}

const bandsOf = (options: Options): ReadonlyArray<Band> => {
	const bands: Array<Band> = []
	let student = 1
	let sitting = 1
	for (const groupSize of options.groupSizes) {
		bands.push({ groupSize, firstStudent: student, firstSitting: sitting })
		student += options.studentsPerBand
		sitting += options.studentsPerBand * groupSize
	}
	return bands
}

/** The SQL text of an int4 array of `values`, as a relation input's column travels. */
const intArray = (values: ReadonlyArray<number>): string =>
	`{${Arr.join(Arr.map(values, String), ",")}}`

/** How many of a template's optimized statements hold a whole-relation form chosen per execution. */
const chosenForms = (template: QueryTemplate): number =>
	Arr.filter(flight(template.programs.optimized.roots), (s) => s.forms.kind === "chosen").length

const k = 3

/** Whether every delivered parent's `best` array is in the take's completed order, score descending, then id. */
const inTakeOrder = (rows: ReadonlyArray<unknown>): boolean =>
	Arr.every(rows, (row) => {
		if (!Predicate.hasProperty(row, "best") || !Arr.isArray(row.best)) {
			return false
		}
		const keys = Arr.map(row.best, (c: unknown) =>
			Predicate.hasProperty(c, "score") &&
			Predicate.hasProperty(c, "id") &&
			typeof c.score === "number" &&
			typeof c.id === "bigint"
				? { score: c.score, id: c.id }
				: undefined
		)
		return Arr.every(keys, (x, i) => {
			const prev = i === 0 ? undefined : keys[i - 1]
			if (x === undefined) {
				return false
			}
			return (
				prev === undefined || prev.score > x.score || (prev.score === x.score && prev.id < x.id)
			)
		})
	})

/**
 * The pipelined attachment statement `name` of a compiled read: its position in the optimized artifact, which is its
 * position among the statements a delivery sends, and its compiled form.
 */
const attachmentOf = (
	compiled: Compiled,
	name: string
): { readonly index: number; readonly statement: OptimizedStatement } => {
	const statements = labeledStatements(compiled.compiled.template.programs.optimized.roots)
	return Option.getOrThrowWith(
		Arr.findFirst(
			Arr.map(statements, ({ statement, attach }, index) => ({ index, statement, attach })),
			(s) => s.attach?.name === name
		),
		() => new GateSetupError({ what: `the optimized artifact pipelines no attachment ${name}` })
	)
}

/** The loops of the most often run scan of `table`. */
const scanLoops = (plan: PlanNode, table: string): number => {
	const scans = scansOf(plan, table)
	if (scans.length === 0) {
		throw new GateSetupError({ what: `the plan scans no ${table}` })
	}
	return maxOf(
		Arr.map(scans, (n) => n.actualLoops),
		Number.NEGATIVE_INFINITY
	)
}

/** @internal */
export default defineGate({
	name: "query-take",
	gates: ["R20", "R27", "R42"],
	title:
		"Bounded subsets, successors and as-of selections by the parent set against handwritten SQL",
	scope:
		"take(k) per parent through an attachment, bind and a relation parameter, for a few parents and for every group, " +
		"and as the LATERAL probe and the whole-relation pass across parent counts and group sizes, for lateralParentMax " +
		"(R20); the successor of every sitting (R27); the as-of price of every sitting, its mirror, and of a relation " +
		"parameter's students (R42). A tutoring timeline is represented by the whole-input as-of over every sitting.",
	phases: queryPhases,
	options: {
		full: {
			students: 3000,
			perStudent: 30,
			samples: 15,
			studentsPerBand: 20_000,
			groupSizes: [2, 8, 32, 128],
			parentCounts: [1, 4, 16, 64, 256, 1024, 4096, 16_384]
		},
		quick: {
			students: 400,
			perStudent: 16,
			samples: 2,
			studentsPerBand: 300,
			groupSizes: [2, 32],
			parentCounts: [1, 16, 300]
		}
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const fx = yield* installFixture(Lab, labPrograms, "benchtake", [])
			const size = { students: options.students, perStudent: options.perStudent }
			yield* loadLab(fx, size)
			const runtime = yield* runtimeSession(fx, fx.world.app)
			const raw = yield* rawSession(fx, fx.world.app, "m15b take raw")
			const indexes = yield* installedIndexes(fx)
			const sitting = fx.relationName("Sitting")
			const price = fx.relationName("Price")
			const S = fx.table("Sitting")
			const St = fx.table("Student")
			const P = fx.table("Price")
			const s = (f: string) => fx.column("Sitting", f)
			const p = (f: string) => fx.column("Price", f)
			const data = labData(size)
			const sittings = labSittings(size)
			const reading = { role: fx.world.app, context: "snapshot", warm: 3, read: "rows" } as const
			const measure: MeasureOptions = {
				samples: options.samples,
				explainSamples: 1,
				serverPlans: [],
				explain: plainExplain,
				conservativeSamples: 1
			}
			const installed =
				"fresh install of Lab with its workload's access paths; facts loaded, then VACUUM (ANALYZE) of every table"
			const warm = "warm: each variant runs once before its timed samples"
			const cases: Array<CaseRecord<Gates>> = []
			const hand = (compiled: Compiled, label: string, sql: string) =>
				measureVariant(
					raw,
					handwritten(
						label,
						[{ sql: handwrittenRows(headingOf(compiled), sql), params: [] }],
						autocommit
					),
					{
						samples: options.samples,
						warmup: 0,
						explainSamples: 1,
						explain: plainExplain,
						serverPlans: []
					}
				)
			const studentKey = fx.columnName("Sitting", "student")
			/**
			 * The LATERAL take's probe: a Limit under a nested loop, and an Index Cond on the Sitting index whose key leads with
			 * the correlation key.
			 */
			const lateralProbe = (plan: PlanNode): boolean =>
				Arr.some(findNodes(plan, "Nested Loop"), (loop) => findNodes(loop, "Limit").length > 0) &&
				Arr.some(
					indexAccessOn(plan, sitting, indexes),
					(a) => a.columns[0] === studentKey && a.condition === "index cond"
				)
			const wholeOnce = (plan: PlanNode) =>
				scansOf(plan, sitting).length === 1 &&
				Arr.every(scansOf(plan, sitting), (n) => n.actualLoops === 1)

			/**
			 * R20 through a pipelined attachment: a key-lookup parent, then a parent statement with no bound over more than
			 * lateralParentMax students.
			 */
			const sheetOne = compile(fx, studentSheetOne, reading)
			const oneParent = 7
			const fewM = yield* measureQuery(runtime, raw, sheetOne, { id: oneParent }, measure)
			const fewAttachment = attachmentOf(sheetOne, "best")
			const fewChild = planOf(fewM.generated, fewAttachment.index)
			const sheets = compile(fx, studentSheets, reading)
			const manyParents = Math.min(options.students, lateralParentMax.value * 2)
			const manyM = yield* measureQuery(runtime, raw, sheets, { upto: manyParents }, measure)
			const manyChild = planOf(manyM.generated, attachmentOf(sheets, "best").index)
			cases.push({
				name: "a student by key and the students up to an id, each with its three best sittings attached, pipelined",
				gates: ["R20"],
				conditions: conditions({
					workload:
						"an attachment take(3) by (score desc, id), five array fields, over a key-lookup parent and over a parent " +
						"statement with no bound",
					schemaState: installed,
					data,
					parameters: {
						id: oneParent,
						many: manyParents,
						lateralParentMax: lateralParentMax.value
					},
					semantics: "each parent student with its three best sittings",
					cache: warm
				}),
				phases: {},
				variants: [fewM.generated, fewM.conservative, manyM.generated, manyM.conservative],
				comparisons: [],
				transactions: {},
				loads: {},
				measures: {
					fewRowsRead: rowsReadFrom(fewChild, sitting),
					/** One parent times k. */
					fewBound: k,
					manyRowsRead: rowsReadFrom(manyChild, sitting),
					manyScanLoops: scanLoops(manyChild, sitting),
					/**
					 * Whether the conservative artifact delivers each array in the take's order too: its statement's outer DISTINCT
					 * does not keep the LATERAL's order, which the runtime's stitching relies on.
					 */
					conservativeChildOrder: inTakeOrder(fewM.delivered.conservative.rows),
					generatedChildOrder: inTakeOrder(fewM.delivered.generated.rows)
				}
			})

			/** R20 through bind over every student, k = 3 and k = 1, and to a relation parameter. */
			const every = compile(fx, bestPerStudent, reading)
			const everyM = yield* measureQuery(runtime, raw, every, {}, measure)
			const everyLateral = yield* hand(
				every,
				"handwritten LATERAL",
				`SELECT st.${fx.column("Student", "id")} AS student, b.id, b.score FROM ${St} AS st JOIN LATERAL ` +
					`(SELECT x.${s("id")} AS id, x.${s("score")} AS score FROM ${S} AS x WHERE x.${s("student")} = st.${fx.column("Student", "id")} ` +
					`ORDER BY x.${s("score")} DESC, x.${s("id")} LIMIT ${k}) AS b ON true`
			)
			const everyWindow = yield* hand(
				every,
				"handwritten row_number",
				`SELECT w.student, w.id, w.score FROM (SELECT x.${s("student")} AS student, x.${s("id")} AS id, x.${s("score")} AS score, ` +
					`row_number() OVER (PARTITION BY x.${s("student")} ORDER BY x.${s("score")} DESC, x.${s("id")}) AS rn FROM ${S} AS x ` +
					`JOIN ${St} AS st ON st.${fx.column("Student", "id")} = x.${s("student")}) AS w WHERE w.rn <= ${k}`
			)
			const one = compile(fx, topPerStudent, reading)
			const oneM = yield* measureQuery(runtime, raw, one, {}, measure)
			const oneDistinctOn = yield* hand(
				one,
				"handwritten DISTINCT ON",
				`SELECT DISTINCT ON (x.${s("student")}) x.${s("student")} AS student, x.${s("id")} AS id, x.${s("score")} AS score FROM ${S} AS x ` +
					`JOIN ${St} AS st ON st.${fx.column("Student", "id")} = x.${s("student")} ORDER BY x.${s("student")}, x.${s("score")} DESC, x.${s("id")}`
			)
			const wanted = Arr.map(indices(8), (i) => ({ id: 2 + i * 3 }))
			/** Every student: more distinct parents than lateralParentMax at both scales. */
			const everyone = Arr.map(indices(options.students), (i) => ({ id: i + 1 }))
			const forParam = compile(fx, bestForStudents, reading)
			const forParamM = yield* measureQuery(runtime, raw, forParam, { students: wanted }, measure)
			const forManyM = yield* measureQuery(runtime, raw, forParam, { students: everyone }, measure)
			const forParamPlan = planOf(forParamM.generated, 0)
			const forManyPlan = planOf(forManyM.generated, 0)
			const studentsParam = Option.getOrThrowWith(
				Arr.findFirst(forParam.compiled.template.params, (d) => d.name === "students"),
				() => new GateSetupError({ what: "bestForStudents declares no students parameter" })
			)
			const choosesByStudents = Arr.some(
				flight(forParam.compiled.template.programs.optimized.roots),
				(st) =>
					st.forms.kind === "chosen"
						? Arr.some(st.forms.choices, (c) => c.source.param === studentsParam.id)
						: false
			)
			const everyPlan = planOf(everyM.generated, 0)
			const onePlan = planOf(oneM.generated, 0)
			cases.push(
				{
					name: "every student's three best sittings, bound",
					gates: ["R20"],
					conditions: conditions({
						workload: "take(3) by (score desc, id) bound to every Student",
						schemaState: installed,
						data,
						parameters: {},
						semantics: "each student with its three best sittings",
						cache: warm
					}),
					phases: {},
					variants: [everyM.generated, everyM.conservative, everyLateral, everyWindow],
					comparisons: [
						compareVariants(everyM.generated, everyLateral),
						compareVariants(everyM.generated, everyWindow)
					],
					transactions: {},
					loads: {},
					measures: {
						sittingRowsReadGenerated: rowsReadFrom(everyPlan, sitting),
						sittingRowsReadWindow: rowsReadFrom(planOf(everyWindow, 0), sitting),
						sittingRowsReadLateral: rowsReadFrom(planOf(everyLateral, 0), sitting),
						sittings
					}
				},
				{
					name: "every student's best sitting, bound, k = 1",
					gates: ["R20"],
					conditions: conditions({
						workload: "take(1) by (score desc, id) bound to every Student",
						schemaState: installed,
						data,
						parameters: {},
						semantics: "each student with its best sitting",
						cache: warm
					}),
					phases: {},
					variants: [oneM.generated, oneM.conservative, oneDistinctOn],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: { sittingScanLoopsK1: scanLoops(onePlan, sitting) }
				},
				{
					name: "a relation parameter's students with their three best sittings",
					gates: ["R20"],
					conditions: conditions({
						workload:
							"take(3) bound to the facts of a relation parameter, delivered with a few students and with every student",
						schemaState: installed,
						data,
						parameters: {
							fewStudents: Arr.map(wanted, (w) => w.id),
							manyStudents: everyone.length,
							lateralParentMax: lateralParentMax.value
						},
						semantics: "each named student with its three best sittings",
						cache: warm
					}),
					phases: {},
					variants: [
						forParamM.generated,
						forParamM.conservative,
						forManyM.generated,
						forManyM.conservative
					],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						variants: chosenForms(forParam.compiled.template),
						fewParamRowsRead: rowsReadFrom(forParamPlan, sitting),
						fewParamBound: wanted.length * (k + 1),
						manyParamRowsRead: rowsReadFrom(forManyPlan, sitting),
						manyParamScanLoops: scanLoops(forManyPlan, sitting)
					}
				}
			)
			/**
			 * R20 as a derived relation's definition: the every-student take installed as BestThree's materialized view,
			 * refreshed by the runtime's refresh transaction (packages/grizzle/src/adapter/refresh) as the refreshing identity. The definition is
			 * the compiled one the installation created the view from, read from its manifest, and its plan, as the refresh
			 * evaluates it, is captured by EXPLAIN on the same data.
			 */
			const reports = yield* installFixture(LabReports, {}, "benchtakerefresh", [labRefreshers])
			const reportsLedgerResult = ledgerStatements(reports.installed.schema)
			if (!reportsLedgerResult.ok) {
				return yield* Effect.die(
					new GateSetupError({ what: `the ledger statements of ${reports.installed.schema}` })
				)
			}
			const reportsLedger = reportsLedgerResult.value
			yield* loadLab(reports, size)
			const substrate = yield* Substrate
			const refresherLogin = reports.installed.as(labRefreshers)
			const pool = yield* makePool({
				connection: parsedConnection(
					clusterConnection(substrate.cluster, substrate.database, refresherLogin.password),
					refresherLogin.role
				),
				bounds: clusterPool,
				attachPool: () => undefined
			})
			const reportsInput = parseSchemaInput(LabReports)
			if (!reportsInput.ok) {
				throw new GateSetupError({
					what: `LabReports' schema input: ${reportsInput.error.message}`
				})
			}
			const reportArtifacts = testArtifacts(reportsInput.value, reports.naming)
			if (!reportArtifacts.ok) {
				throw new GateSetupError({
					what: `LabReports' artifacts: ${reportArtifacts.error.message}`
				})
			}
			const refresherDesc = roleDescOf(labRefresher)
			if (refresherDesc === undefined) {
				throw new GateSetupError({ what: "the refresher is a role value" })
			}
			const targets = refreshTargets(refresherDesc, reportArtifacts.value, [BestThree])
			if (Result.isFailure(targets)) {
				throw new GateSetupError({ what: `the refresh targets: ${targets.failure.message}` })
			}
			const [target] = targets.success
			const views = installedDerivedRelations(reports.installed.installation.manifest)
			if (!views.ok) {
				throw new GateSetupError({ what: `the installed views: ${views.error.message}` })
			}
			const view = Option.getOrThrowWith(
				Arr.findFirst(
					views.value,
					(v) => v.view.schema === target.view.schema && v.view.name === target.view.name
				),
				() => new GateSetupError({ what: `the manifest installs no view ${target.view.name}` })
			)
			const definition = view.create.query
			const definitionShape = shapeOf(definition)
			const refreshOnce = Effect.gen(function* () {
				const start = performance.now()
				const report = yield* runRefresh(
					{
						pool,
						prologue: ledgerPrologue(
							reportsLedger,
							reports.installed.role(labRefresher),
							"",
							reports.installed.snapshot.fingerprint
						)
					},
					targets.success
				)
				return { report, ms: Math.round((performance.now() - start) * 1000) / 1000 }
			})
			const firstRefresh = yield* refreshOnce
			const laterRefreshes: Array<number> = []
			for (let i = 0; i < Math.max(2, options.samples); i++) {
				laterRefreshes.push((yield* refreshOnce).ms)
			}
			/**
			 * The refresh evaluates the definition as the view's owner, the migration identity: the refresher holds MAINTAIN on
			 * the view and no privilege on the tables its definition reads.
			 */
			const owner = yield* substrate.session({ ...ownerSession(), label: "m15b take definition" })
			const definitionPlan = (yield* explain(owner, printStatement(definition), [], plainExplain))
				.plan
			const definitionSitting = reports.relationName("Sitting")
			const definitionWorkers = planNodes(definitionPlan)
				.flatMap((node) => Option.toArray(node.workersLaunched))
				.reduce((n, launched) => n + launched, 0)
			const reportsRuntime = yield* runtimeSession(reports, labRefresher)
			const refreshed = yield* deliver(
				reportsRuntime,
				compile(reports, bestThreeRows, {
					role: labRefresher,
					context: "snapshot",
					warm: 3,
					read: "rows"
				}),
				"optimized",
				{}
			)
			const definitionWhole =
				scansOf(definitionPlan, definitionSitting).length > 0 &&
				Arr.every(scansOf(definitionPlan, definitionSitting), (n) => n.actualLoops === 1) &&
				rowsReadFrom(definitionPlan, definitionSitting) <=
					sittings * scansOf(definitionPlan, definitionSitting).length
			cases.push({
				name: "every student's three best sittings as a derived relation, refreshed",
				gates: ["R20"],
				conditions: conditions({
					workload:
						"BestThree = derived(take(3) by (score desc, id) bound to every Student), refreshed by db.refresh's " +
						"transaction as the refreshing identity",
					schemaState:
						"fresh install of LabReports (Lab extended with BestThree) with the derived relation's view, the Lab facts " +
						"loaded, then VACUUM (ANALYZE) of every base table",
					data,
					parameters: {},
					semantics: "the view holds each student with its three best sittings",
					cache:
						"the first refresh populates the view; the later ones run CONCURRENTLY over an unchanged base"
				}),
				phases: {},
				variants: [],
				comparisons: [],
				transactions: {},
				loads: {},
				measures: {
					firstRefreshMs: firstRefresh.ms,
					refreshMsP50: summarize(laterRefreshes).p50,
					refreshMsP95: summarize(laterRefreshes).p95,
					rowsWritten: refreshed.rows.length,
					definitionWorkersLaunched: definitionWorkers,
					definitionSittingRowsRead: rowsReadFrom(definitionPlan, definitionSitting),
					sittings
				}
			})

			/**
			 * R20's threshold, both forms over one input: a second Lab install whose students come in bands of one group size
			 * each (bandsOf), every count of a band's students read as the LATERAL probe and as the whole-relation pass.
			 */
			const forms = yield* installFixture(Lab, labPrograms, "benchtakeforms", [])
			const bands = bandsOf(options)
			const bandStudents = bands.length * options.studentsPerBand
			const bandSittings = Arr.reduce(bands, 0, (n, b) => n + options.studentsPerBand * b.groupSize)
			/**
			 * Each sitting's student: the band its id falls in, the last band tested first, then its place among the band's
			 * students.
			 */
			const studentOf = Arr.reduce(
				bands,
				"NULL::int4",
				(rest, b) =>
					`CASE WHEN g >= ${b.firstSitting} THEN (${b.firstStudent} + (g - ${b.firstSitting}) / ${b.groupSize})::int4 ELSE ${rest} END`
			)
			yield* fill(forms, "Student", bandStudents, { id: "g::int4", cohort: "(g % 10)::int4" })
			yield* fill(forms, "Sitting", bandSittings, {
				id: "g::int8",
				student: studentOf,
				day: "(1 + g % 30)::int4",
				score: "(((pg_catalog.hashint8(g) & 2147483647) % 33)::float8 / 4::float8)",
				points: "((pg_catalog.hashint8(g + 1) & 2147483647) % 100)::int4",
				room: "(1 + (g - 1) / 100)::int4"
			})
			yield* settle(forms)
			const formsRaw = yield* rawSession(forms, forms.world.app, "m15b take forms raw")
			const bandTable = forms.table("Sitting")
			const bandColumn = (f: string) => forms.column("Sitting", f)
			const formsVariants: VariantOptions = {
				samples: options.samples,
				warmup: 1,
				explainSamples: 1,
				explain: plainExplain,
				serverPlans: []
			}
			const formsInstalled =
				"fresh install of Lab with its workload's access paths; facts loaded in group-size bands, then VACUUM (ANALYZE)"
			const formsData = `${bandStudents} students in ${bands.length} bands of ${options.studentsPerBand}, each band's students with ${Arr.join(
				Arr.map(bands, (b) => String(b.groupSize)),
				", "
			)} sittings each; dyadic scores`
			const formChecks: Array<GateCheck> = []
			for (const band of bands) {
				for (const perParent of [1, k]) {
					for (const parents of Arr.filter(
						options.parentCounts,
						(n) => n <= options.studentsPerBand
					)) {
						const ids = intArray(Arr.map(indices(parents), (i) => band.firstStudent + i))
						const lateral = yield* measureVariant(
							formsRaw,
							handwritten(
								"LATERAL ... LIMIT k per parent",
								[
									{
										sql:
											`SELECT p.id::text, b.id::text, b.score::text FROM pg_catalog.unnest($1::int4[]) AS p(id) ` +
											`CROSS JOIN LATERAL (SELECT x.${bandColumn("id")} AS id, x.${bandColumn("score")} AS score FROM ${bandTable} AS x ` +
											`WHERE x.${bandColumn("student")} = p.id ORDER BY x.${bandColumn("score")} DESC, x.${bandColumn("id")} LIMIT ${perParent}) AS b`,
										params: [ids]
									}
								],
								autocommit
							),
							formsVariants
						)
						const perGroup =
							perParent === 1
								? `SELECT DISTINCT ON (x.${bandColumn("student")}) x.${bandColumn("student")} AS student, x.${bandColumn("id")} AS id, x.${bandColumn("score")} AS score ` +
									`FROM ${bandTable} AS x ORDER BY x.${bandColumn("student")}, x.${bandColumn("score")} DESC, x.${bandColumn("id")}`
								: `SELECT w.student, w.id, w.score FROM (SELECT x.${bandColumn("student")} AS student, x.${bandColumn("id")} AS id, ` +
									`x.${bandColumn("score")} AS score, pg_catalog.row_number() OVER (PARTITION BY x.${bandColumn("student")} ` +
									`ORDER BY x.${bandColumn("score")} DESC, x.${bandColumn("id")}) AS rn FROM ${bandTable} AS x) AS w WHERE w.rn <= ${perParent}`
						const whole = yield* measureVariant(
							formsRaw,
							handwritten(
								perParent === 1 ? "DISTINCT ON over every group" : "row_number over every group",
								[
									{
										sql:
											`SELECT p.id::text, d.id::text, d.score::text FROM pg_catalog.unnest($1::int4[]) AS p(id) ` +
											`JOIN (${perGroup}) AS d ON d.student = p.id`,
										params: [ids]
									}
								],
								autocommit
							),
							formsVariants
						)
						const name = `take(${perParent}) for ${parents} parents of ${band.groupSize} sittings each`
						const comparison = compareVariants(lateral, whole)
						formChecks.push(
							equivalence(
								`${name}: both forms deliver the same rows`,
								comparison.sameResult,
								`${lateral.label}: ${lateral.result.digest}; ${whole.label}: ${whole.result.digest}`
							)
						)
						cases.push({
							name,
							gates: ["R20"],
							conditions: conditions({
								workload: `take(${perParent}) by (score desc, id) bound to a relation parameter's students`,
								schemaState: formsInstalled,
								data: formsData,
								parameters: {
									parents,
									groupSize: band.groupSize,
									k: perParent,
									lateralParentMax: lateralParentMax.value
								},
								semantics: "each named student with its best sittings",
								cache: warm
							}),
							phases: {},
							variants: [lateral, whole],
							comparisons: [comparison],
							transactions: {},
							loads: {},
							measures: { parents, groupSize: band.groupSize, k: perParent }
						})
					}
				}
			}
			const r20: VerdictInput = {
				checks: [
					mechanism(
						"both take forms measured at every parent count and group size",
						formChecks.length > 0,
						`${formChecks.length} cases`
					),
					...formChecks,
					mechanism(
						"a key-lookup parent's attachment takes the LATERAL form",
						has(shapeOf(fewAttachment.statement.ast), "lateral") && lateralProbe(fewChild),
						outline(fewChild, 0)
					),
					mechanism(
						"the LATERAL form reads at most k + 1 rows per parent",
						rowsReadFrom(fewChild, sitting) <= k + 1,
						`${rowsReadFrom(fewChild, sitting)} rows for one parent`
					),
					mechanism(
						"a pipelined attachment over a parent statement with no bound reads its input once",
						wholeOnce(manyChild),
						outline(manyChild, 0)
					),
					mechanism(
						"a take bound to every student is lowered over every group (row_number), reading the input once",
						nodeTypes(everyPlan).has("WindowAgg") && wholeOnce(everyPlan),
						outline(everyPlan, 0)
					),
					mechanism(
						"a take(1) bound to every student is DISTINCT ON, reading the input once",
						has(shapeOf(optimizedStatement(one, 0).ast), "distinct on") && wholeOnce(onePlan),
						outline(onePlan, 0)
					),
					mechanism(
						"a derived-relation definition never takes the correlated form: row_number or DISTINCT ON, no LIMIT",
						(has(definitionShape, "window row_number") || has(definitionShape, "distinct on")) &&
							!has(definitionShape, "limit literal") &&
							!has(definitionShape, "limit param") &&
							!has(definitionShape, "limit expression"),
						Arr.join([...definitionShape.counts.keys()], ", ")
					),
					mechanism(
						"the refresh-evaluated definition reads the input once",
						definitionWhole,
						outline(definitionPlan, 0)
					),
					mechanism(
						"a take bound to a relation parameter chooses its form per execution by the parameter's count",
						choosesByStudents &&
							chosenForms(forParam.compiled.template) > 0 &&
							lateralProbe(forParamPlan) &&
							nodeTypes(forManyPlan).has("WindowAgg") &&
							!lateralProbe(forManyPlan),
						`${chosenForms(forParam.compiled.template)} variants\n` +
							`few: ${outline(forParamPlan, 0)}\nmany: ${outline(forManyPlan, 0)}`
					),
					mechanism(
						"a relation parameter's few students take LATERAL: a Limit under the nested loop, an Index Cond on the student",
						lateralProbe(forParamPlan),
						outline(forParamPlan, 0)
					),
					mechanism(
						"a relation parameter's few students read rows proportional to parents times k",
						rowsReadFrom(forParamPlan, sitting) <= wanted.length * (k + 1),
						`${rowsReadFrom(forParamPlan, sitting)} rows for ${wanted.length} parents`
					),
					mechanism(
						"more than lateralParentMax students in the parameter take row_number, reading the input once",
						nodeTypes(forManyPlan).has("WindowAgg") && wholeOnce(forManyPlan),
						outline(forManyPlan, 0)
					),
					judged(
						"the attachment delivers the composition's sets for a key-lookup parent",
						deliveredAgree("multiset"),
						fewM.delivered.generated.rows,
						fewM.delivered.conservative.rows
					),
					judged(
						"the attachment delivers the composition's sets for many parents",
						deliveredAgree("multiset"),
						manyM.delivered.generated.rows,
						manyM.delivered.conservative.rows
					),
					equivalence(
						"the generated attachment delivers each parent's subset in the take's completed order",
						inTakeOrder(fewM.delivered.generated.rows) &&
							inTakeOrder(manyM.delivered.generated.rows),
						`${fewM.delivered.generated.rows.length} and ${manyM.delivered.generated.rows.length} parents`
					),
					agrees("every student's take agrees with the composition", everyM),
					equivalence(
						"every student's take agrees with handwritten LATERAL",
						compareVariants(everyM.generated, everyLateral).sameResult,
						`${everyM.generated.result.rows} generated rows, ${everyLateral.result.rows} handwritten`
					),
					equivalence(
						"every student's take agrees with handwritten row_number",
						compareVariants(everyM.generated, everyWindow).sameResult,
						`${everyM.generated.result.rows} generated rows, ${everyWindow.result.rows} handwritten`
					),
					equivalence(
						"the take(1) agrees with handwritten DISTINCT ON",
						compareVariants(oneM.generated, oneDistinctOn).sameResult,
						`${oneM.generated.result.rows} generated rows, ${oneDistinctOn.result.rows} handwritten`
					),
					agrees("the relation parameter's take agrees with the composition", forParamM),
					judged(
						"the refreshed derived relation holds the bound take's answer",
						deliveredAgree("ordered"),
						refreshed.rows,
						everyM.delivered.generated.rows
					),
					agrees(
						"the relation parameter's take over every student agrees with the composition",
						forManyM
					)
				]
			}

			/** R27. */
			const next = compile(fx, withNext, reading)
			const nextM = yield* measureQuery(runtime, raw, next, {}, measure)
			const nextLateral = yield* hand(
				next,
				"handwritten LATERAL take(1)",
				`SELECT x.${s("id")} AS id, n.id AS nid, n.score AS nscore FROM ${S} AS x JOIN LATERAL (SELECT y.${s("id")} AS id, y.${s("score")} AS score ` +
					`FROM ${S} AS y WHERE y.${s("student")} = x.${s("student")} AND (y.${s("day")}, y.${s("id")}) > (x.${s("day")}, x.${s("id")}) ` +
					`ORDER BY y.${s("day")}, y.${s("id")} LIMIT 1) AS n ON true`
			)
			const nextLead = yield* hand(
				next,
				"handwritten LEAD",
				`SELECT w.id, w.nid, w.nscore FROM (SELECT x.${s("id")} AS id, lead(x.${s("id")}, 1, x.${s("id")}) OVER o AS nid, ` +
					`lead(x.${s("score")}, 1, x.${s("score")}) OVER o AS nscore, count(*) OVER (o ROWS BETWEEN 1 FOLLOWING AND 1 FOLLOWING) AS present ` +
					`FROM ${S} AS x WINDOW o AS (PARTITION BY x.${s("student")} ORDER BY x.${s("day")}, x.${s("id")})) AS w WHERE w.present = 1`
			)
			const nextPlan = planOf(nextM.generated, 0)
			cases.push({
				name: "every sitting with its student's next sitting by (day, id)",
				gates: ["R27"],
				conditions: conditions({
					workload: "take(1) of the strict successor by (day, id), bound to every sitting",
					schemaState: installed,
					data,
					parameters: {},
					semantics: "each sitting that has a successor, with the successor's id and score",
					cache: warm
				}),
				phases: {},
				variants: [nextM.generated, nextM.conservative, nextLateral, nextLead],
				comparisons: [compareVariants(nextM.generated, nextLateral)],
				transactions: {},
				loads: {},
				measures: {
					delivered: nextM.delivered.generated.rows.length,
					expected: sittings - options.students,
					sittingRowsReadGenerated: rowsReadFrom(nextPlan, sitting),
					sittingRowsReadLateral: rowsReadFrom(planOf(nextLateral, 0), sitting)
				}
			})
			const r27: VerdictInput = {
				checks: [
					mechanism(
						"LEAD with the row's own default and a presence count over one scan",
						has(shapeOf(optimizedStatement(next, 0).ast), "window lead") &&
							wholeOnce(nextPlan) &&
							nodeTypes(nextPlan).has("WindowAgg"),
						outline(nextPlan, 0)
					),
					agrees("the successor agrees with the composition", nextM),
					equivalence(
						"the successor agrees with handwritten LATERAL take(1)",
						compareVariants(nextM.generated, nextLateral).sameResult,
						`${nextM.generated.result.rows} generated rows, ${nextLateral.result.rows} handwritten`
					),
					equivalence(
						"the successor agrees with handwritten LEAD",
						compareVariants(nextM.generated, nextLead).sameResult,
						`${nextM.generated.result.rows} generated rows, ${nextLead.result.rows} handwritten`
					),
					equivalence(
						"the last row of every group, and the single row of a one-row group, has no successor",
						nextM.delivered.generated.rows.length === sittings - options.students,
						`${nextM.delivered.generated.rows.length} delivered, ${sittings - options.students} expected`
					)
				]
			}

			/** R42. */
			const asOf = compile(fx, withPrice, reading)
			const asOfM = yield* measureQuery(runtime, raw, asOf, {}, measure)
			const asOfLateral = yield* hand(
				asOf,
				"handwritten LATERAL",
				`SELECT x.${s("id")} AS id, q.id AS pid, q.amount FROM ${S} AS x JOIN LATERAL (SELECT y.${p("id")} AS id, y.${p("amount")} AS amount ` +
					`FROM ${P} AS y WHERE y.${p("student")} = x.${s("student")} AND y.${p("day")} <= x.${s("day")} ` +
					`ORDER BY y.${p("day")} DESC, y.${p("id")} DESC LIMIT 1) AS q ON true`
			)
			const mirror = compile(fx, withNextPrice, reading)
			const mirrorM = yield* measureQuery(runtime, raw, mirror, {}, measure)
			const mirrorLateral = yield* hand(
				mirror,
				"handwritten LATERAL, mirror",
				`SELECT x.${s("id")} AS id, q.id AS pid, q.amount FROM ${S} AS x JOIN LATERAL (SELECT y.${p("id")} AS id, y.${p("amount")} AS amount ` +
					`FROM ${P} AS y WHERE y.${p("student")} = x.${s("student")} AND y.${p("day")} >= x.${s("day")} ` +
					`ORDER BY y.${p("day")}, y.${p("id")} LIMIT 1) AS q ON true`
			)
			const few = Arr.map(indices(6), (i) => ({ id: 3 + i * 5 }))
			const bound = compile(fx, withPriceFor, reading)
			const boundM = yield* measureQuery(runtime, raw, bound, { students: few }, measure)
			const asOfPlan = planOf(asOfM.generated, 0)
			const mirrorPlan = planOf(mirrorM.generated, 0)
			const boundPlan = planOf(boundM.generated, 0)
			const noProbe = (plan: PlanNode) =>
				Arr.every([...scansOf(plan, sitting), ...scansOf(plan, price)], (n) => n.actualLoops === 1)
			const fewSittings = Arr.reduce(few, 0, (n, w) => n + (w.id === 1 ? 1 : options.perStudent))
			const prices = labPrices(size)
			cases.push(
				{
					name: "every sitting with its student's latest price at or before its day",
					gates: ["R42"],
					conditions: conditions({
						workload:
							"take(1) by (day desc, id desc) of Price with day <= the sitting's day, bound to every sitting",
						schemaState: installed,
						data,
						parameters: {},
						semantics: "each sitting with a price at or before its day, with the latest such price",
						cache: warm
					}),
					phases: {},
					variants: [asOfM.generated, asOfM.conservative, asOfLateral],
					comparisons: [compareVariants(asOfM.generated, asOfLateral)],
					transactions: {},
					loads: {},
					measures: {
						sittingRowsRead: rowsReadFrom(asOfPlan, sitting),
						priceRowsRead: rowsReadFrom(asOfPlan, price),
						sittingScans: scansOf(asOfPlan, sitting).length,
						priceScans: scansOf(asOfPlan, price).length,
						sittings,
						prices,
						lateralPriceRowsRead: rowsReadFrom(planOf(asOfLateral, 0), price)
					}
				},
				{
					name: "every sitting with its student's earliest price at or after its day (the mirror)",
					gates: ["R42"],
					conditions: conditions({
						workload:
							"take(1) by (day, id) of Price with day >= the sitting's day, bound to every sitting",
						schemaState: installed,
						data,
						parameters: {},
						semantics:
							"each sitting with a price at or after its day, with the earliest such price",
						cache: warm
					}),
					phases: {},
					variants: [mirrorM.generated, mirrorM.conservative, mirrorLateral],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {}
				},
				{
					name: "a relation parameter's students' sittings with their as-of price",
					gates: ["R42"],
					conditions: conditions({
						workload: "the as-of take bound to the sittings of a relation parameter's six students",
						schemaState: installed,
						data,
						parameters: { students: Arr.map(few, (w) => w.id) },
						semantics: "each such sitting with its latest price at or before its day",
						cache: warm
					}),
					phases: {},
					variants: [boundM.generated, boundM.conservative],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						boundSittingRowsRead: rowsReadFrom(boundPlan, sitting),
						boundPriceRowsRead: rowsReadFrom(boundPlan, price),
						parentSittings: fewSittings
					}
				}
			)
			const r42: VerdictInput = {
				checks: [
					mechanism(
						"the ordered pass over whole inputs probes no parent: every scan runs once",
						noProbe(asOfPlan) && noProbe(mirrorPlan),
						outline(asOfPlan, 0)
					),
					mechanism(
						"the ordered pass reads Price once",
						rowsReadFrom(asOfPlan, price) === prices && rowsReadFrom(mirrorPlan, price) === prices,
						`${rowsReadFrom(asOfPlan, price)} of ${prices}`
					),
					mechanism(
						"the ordered pass reads the parents once",
						rowsReadFrom(asOfPlan, sitting) === sittings &&
							rowsReadFrom(mirrorPlan, sitting) === sittings,
						`${rowsReadFrom(asOfPlan, sitting)} and ${rowsReadFrom(mirrorPlan, sitting)} of ${sittings}`
					),
					mechanism(
						"a relation parameter's few students take the LATERAL probe, reading their sittings, not every sitting",
						rowsReadFrom(boundPlan, sitting) <= 2 * fewSittings,
						`${rowsReadFrom(boundPlan, sitting)} sitting rows for ${fewSittings} parent sittings\n${outline(boundPlan, 0)}`
					),
					agrees("the as-of agrees with the composition", asOfM),
					equivalence(
						"the as-of agrees with handwritten LATERAL",
						compareVariants(asOfM.generated, asOfLateral).sameResult,
						`${asOfM.generated.result.rows} generated rows, ${asOfLateral.result.rows} handwritten`
					),
					agrees("the mirror agrees with the composition", mirrorM),
					equivalence(
						"the mirror agrees with handwritten LATERAL",
						compareVariants(mirrorM.generated, mirrorLateral).sameResult,
						`${mirrorM.generated.result.rows} generated rows, ${mirrorLateral.result.rows} handwritten`
					),
					agrees("the bound form agrees with the composition", boundM)
				]
			}
			return { cases, verdicts: { R20: r20, R27: r27, R42: r42 } }
		})
})
