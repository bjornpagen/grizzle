import { Array as Arr, Effect } from "effect"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	jsonText,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"

import {
	measureTransaction,
	summarizeTransactions,
	type TransactionMeasure
} from "#bench/harness/transaction.ts"
import { settle } from "#bench/query/support/kit.ts"
import {
	installWrites,
	lawObjects,
	loadedByOwner,
	owner,
	plainStatement,
	probeLaws,
	tableScans,
	transactionOf,
	warmedOnce,
	writeConditions,
	writePhases,
	writerSession
} from "#bench/write/support/writes.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { closed, contained, on, relation, schema, select } from "#compiler/public/schema.ts"
import { namesOf } from "#test/support/kernel/naming.ts"

/**
 * R11: keep general containment probes key-local.
 *
 * R11 states no gate paragraph, so its gate is the performance contract's "measurement that can disprove the
 * performance assumption": the law's function needs, "for the affected X from the row event, existence in A
 * and absence in B, not a full join of every witness pair. Use two indexed EXISTS tests over the complete captured X
 * tuple. Source insertion and target deletion can threaten the law; source deletion and target insertion repair it".
 * The admitted case is a selected source contained in a keyed target: `contained(on(select(Shift,
 * { status: "approved" }), "employee", "week"), on(Timesheet, "employee", "week"))`, whose function locks the
 * Timesheet row, the anchor, then probes.
 *
 * Measured: which events call the law (with its triggers IMMEDIATE), the scans its probes make, and the commit-time
 * work of a batch of source insertions at two relation sizes ten times apart. Key-locality is a scaling class: the
 * probes' index scans per law call are the same at both sizes, and neither size scans Shift or Timesheet sequentially.
 */
const ShiftStatus = closed("ShiftStatus", ["draft", "approved"])
const Timesheet = relation("Timesheet", { employee: pg.integer, week: pg.integer }, [
	"employee",
	"week"
])

const Shift = relation(
	"Shift",
	{ id: pg.bigint, employee: pg.integer, week: pg.integer, status: closedId(ShiftStatus) },
	["id"]
)

/** Every approved shift has its timesheet: the law the gate measures. */
const covered = contained(
	on(select(Shift, { status: "approved" }), "employee", "week"),
	on(Timesheet, "employee", "week")
)
const build = (name: string) => schema(name, { ShiftStatus, Timesheet, Shift }, [covered])

interface Options extends Readonly<Record<string, unknown>> {
	/** Employees at the small size (ten times as many at the large one), weeks each, shifts per timesheet. */
	readonly employees: number
	readonly weeks: number
	readonly shifts: number
	/** Source insertions per measured batch. */
	readonly batch: number
	readonly samples: number
}

const weekOf = 1

/** @internal */
export default defineGate({
	name: "write-containment",
	gates: ["R11"],
	title:
		"Selected-source containment: key-local probes, the threatening events, sizes ten times apart",
	scope:
		"A selected source contained in a keyed target: the law's calls per event, its probes' scans, and the " +
		"commit-time work of a batch of source insertions at two relation sizes ten times apart.",
	phases: writePhases,
	options: {
		full: { employees: 20000, weeks: 10, shifts: 2, batch: 200, samples: 9 },
		quick: { employees: 200, weeks: 4, shifts: 2, batch: 20, samples: 2 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const fx = yield* installWrites(build("Shifts"), "benchcontain", {
				programs: {},
				logins: []
			})
			const law = namesOf(fx.installed).lawOf(covered)
			const objects = yield* lawObjects(fx)
			const T = fx.table("Timesheet")
			const S = fx.table("Shift")
			const shiftTable = fx.relationName("Shift")
			const timesheetTable = fx.relationName("Timesheet")
			const c = (rel: string, f: string) => fx.column(rel, f)
			const status = fx.enumType("ShiftStatus")
			const writer = yield* writerSession(fx, fx.world.app, "m15c containment writer")
			let loadedEmployees = 0
			let nextShift = 1
			/**
			 * Grows the fixture to `employees` employees, each with `weeks` timesheets and `shifts` approved shifts per
			 * timesheet.
			 */
			const grow = Effect.fn("grow")(function* (employees: number) {
				const from = loadedEmployees + 1
				const sheets = `SELECT e, w FROM pg_catalog.generate_series(${from}, ${employees}) AS e, pg_catalog.generate_series(1, ${options.weeks}) AS w`
				const shifts = `SELECT ${nextShift} + (row_number() OVER ())::int8, e, w, 'approved'::${status} FROM (${sheets}) AS x(e, w), pg_catalog.generate_series(1, ${options.shifts}) AS k`
				yield* owner(
					"BEGIN",
					`INSERT INTO ${T} (${c("Timesheet", "employee")}, ${c("Timesheet", "week")}) ${sheets}`,
					`INSERT INTO ${S} (${Arr.join(
						Arr.map(["id", "employee", "week", "status"], (f) => c("Shift", f)),
						", "
					)}) ${shifts}`,
					"COMMIT"
				)
				nextShift += (employees - loadedEmployees) * options.weeks * options.shifts
				loadedEmployees = employees
				yield* settle(fx)
			})
			const shiftCols = `(${Arr.join(
				Arr.map(["id", "employee", "week", "status"], (f) => c("Shift", f)),
				", "
			)})`
			/** A batch of `n` approved shifts, each on a distinct existing timesheet of week `weekOf`. */
			const batchSql = (first: number) =>
				`INSERT INTO ${S} ${shiftCols} SELECT ${first} + g, 1 + ((g * 7919) % ${loadedEmployees}), ${weekOf}, 'approved'::${status} FROM pg_catalog.generate_series(1, ${options.batch}) AS g`
			const measureAt = Effect.fn("measureAt")(function* (label: string) {
				const generated: Array<TransactionMeasure> = []
				for (let i = 0; i < options.samples; i++) {
					const first = 100000000 + nextShift
					nextShift += options.batch
					const generatedRun = yield* measureTransaction(
						writer,
						transactionOf([plainStatement("shifts", batchSql(first), [])], "split")
					)
					generated.push(generatedRun)
				}
				const probe = yield* probeLaws(writer, fx, law, [batchSql(900000000 + nextShift)], [])
				return { label, generated: summarizeTransactions(generated), probe }
			})
			yield* grow(options.employees)
			const small = yield* measureAt("small")
			yield* grow(options.employees * 10)
			const large = yield* measureAt("large")

			/** The event table, each event probed alone at the large size. */
			const sheetOf = `(${c("Timesheet", "employee")}, ${c("Timesheet", "week")})`
			const lonely = loadedEmployees + 1
			const events = {
				approvedInsert: yield* probeLaws(
					writer,
					fx,
					law,
					[`INSERT INTO ${S} ${shiftCols} VALUES (-1, 1, ${weekOf}, 'approved'::${status})`],
					[]
				),
				draftInsert: yield* probeLaws(
					writer,
					fx,
					law,
					[`INSERT INTO ${S} ${shiftCols} VALUES (-2, 1, ${weekOf}, 'draft'::${status})`],
					[]
				),
				sourceDelete: yield* probeLaws(
					writer,
					fx,
					law,
					[`DELETE FROM ${S} WHERE ${c("Shift", "id")} = 1`],
					[]
				),
				targetInsert: yield* probeLaws(
					writer,
					fx,
					law,
					[`INSERT INTO ${T} ${sheetOf} VALUES (${lonely}, 1)`],
					[]
				),
				targetDelete: yield* probeLaws(
					writer,
					fx,
					law,
					[
						`INSERT INTO ${T} ${sheetOf} VALUES (${lonely}, 2)`,
						`DELETE FROM ${T} WHERE ${sheetOf} = (${lonely}, 2)`
					],
					[]
				)
			}
			/** Behaviour at COMMIT, as a direct writer sees it. */
			const atCommit = (label: string, sql: string) =>
				measureTransaction(writer, transactionOf([plainStatement(label, sql, [])], "plain"))
			const orphan = yield* atCommit(
				"orphan",
				`INSERT INTO ${S} ${shiftCols} VALUES (-3, ${lonely + 1}, 1, 'approved'::${status})`
			)
			const draft = yield* atCommit(
				"draft",
				`INSERT INTO ${S} ${shiftCols} VALUES (-4, ${lonely + 1}, 1, 'draft'::${status})`
			)
			const removeSheet = yield* atCommit(
				"sheet",
				`DELETE FROM ${T} WHERE ${sheetOf} = (1, ${weekOf})`
			)
			/** The law's refusal at COMMIT: its SQLSTATE with the law's identity as the constraint name. */
			const lawFailure = (o: TransactionMeasure["outcome"]) =>
				o.kind === "failed" &&
				o.at === "commit" &&
				o.sqlstate === sqlstates.integrityConstraintViolation &&
				o.constraint.kind === "named" &&
				o.constraint.name === law
			const seqScans = (p: (typeof events)["approvedInsert"]) =>
				tableScans(p.scans, shiftTable).seq + tableScans(p.scans, timesheetTable).seq
			/** The index scans of Timesheet per law call, the probes' cost per event. */
			const timesheetScansPerCall = (p: (typeof events)["approvedInsert"]) =>
				tableScans(p.scans, timesheetTable).idx / p.total
			const at = (m: typeof small, employees: number): CaseRecord<"R11"> => ({
				name: `a batch of ${options.batch} approved shifts, ${employees} employees`,
				gates: ["R11"],
				conditions: writeConditions({
					workload: `one INSERT of ${options.batch} approved shifts on distinct existing timesheets, then the deferred checks and COMMIT`,
					schemaState: loadedByOwner,
					data: `${employees} employees with ${options.weeks} timesheets each and ${options.shifts} approved shifts per timesheet`,
					parameters: { employees, batch: options.batch },
					semantics: "every shift has its timesheet; the batch commits",
					cache: warmedOnce
				}),
				phases: {},
				variants: [],
				comparisons: [],
				transactions: { generated: m.generated },
				loads: {},
				measures: {
					lawCalls: m.probe.total,
					shiftSeqScans: tableScans(m.probe.scans, shiftTable).seq,
					timesheetSeqScans: tableScans(m.probe.scans, timesheetTable).seq,
					shiftIndexScans: tableScans(m.probe.scans, shiftTable).idx,
					timesheetIndexScans: tableScans(m.probe.scans, timesheetTable).idx
				}
			})
			/** The commit-time work's growth from the small size to the large, recorded only when both sizes timed it. */
			const smallP50 = small.generated.phases.deferredChecksMs?.p50
			const largeP50 = large.generated.phases.deferredChecksMs?.p50
			const cases: Array<CaseRecord<"R11">> = [
				at(small, options.employees),
				at(large, options.employees * 10),
				{
					name: "the threatening events",
					gates: ["R11"],
					conditions: writeConditions({
						workload: "each event alone with the law's triggers IMMEDIATE, rolled back",
						schemaState: loadedByOwner,
						data: `${loadedEmployees} employees`,
						parameters: {},
						semantics: "every probed statement keeps the law",
						cache: warmedOnce
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						approvedInsertCalls: events.approvedInsert.total,
						draftInsertCalls: events.draftInsert.total,
						sourceDeleteCalls: events.sourceDelete.total,
						targetInsertCalls: events.targetInsert.total,
						targetDeleteCalls: events.targetDelete.total,
						...(smallP50 === undefined || largeP50 === undefined || smallP50 <= 0 || largeP50 <= 0
							? {}
							: { deferredChecksGrowthGenerated: largeP50 / smallP50 })
					}
				}
			]
			const r11: VerdictInput = {
				checks: [
					mechanism(
						"one residual law, whose unit functions are installed",
						fx.installed.installation.laws.residuals.length === 1 &&
							Arr.every(namesOf(fx.installed).residual(law).units, (u) =>
								objects.functions.includes(u.function)
							),
						`${Arr.join(
							Arr.map(fx.installed.installation.laws.residuals, (r) => r.lawId),
							", "
						)} | ${Arr.join(objects.functions, ", ")}`
					),
					mechanism(
						"a source insertion and a target deletion call the law; a source deletion and a target insertion do not",
						events.approvedInsert.total === 1 &&
							events.targetDelete.total === 1 &&
							events.sourceDelete.total === 0 &&
							events.targetInsert.total === 0,
						jsonText({
							approvedInsert: events.approvedInsert.calls,
							targetDelete: events.targetDelete.calls,
							sourceDelete: events.sourceDelete.calls,
							targetInsert: events.targetInsert.calls
						})
					),
					mechanism(
						"a batch's law calls are one per inserted source row, at both sizes",
						small.probe.total === options.batch && large.probe.total === options.batch,
						`${small.probe.total}, ${large.probe.total}`
					),
					mechanism(
						"the probes are indexed: no sequential scan of Shift or Timesheet at either size",
						seqScans(small.probe) === 0 && seqScans(large.probe) === 0,
						`${jsonText(small.probe.scans)} | ${jsonText(large.probe.scans)}`
					),
					mechanism(
						"the probes' index scans per law call are equal at both sizes",
						timesheetScansPerCall(small.probe) === timesheetScansPerCall(large.probe),
						`${timesheetScansPerCall(small.probe)} at ${options.employees} employees, ${timesheetScansPerCall(large.probe)} at ${options.employees * 10}`
					),
					equivalence(
						"an approved shift without its timesheet is refused at COMMIT with the law's identity",
						lawFailure(orphan.outcome),
						jsonText(orphan.outcome)
					),
					equivalence(
						"a draft shift without its timesheet commits",
						draft.outcome.kind === "committed",
						jsonText(draft.outcome)
					),
					equivalence(
						"removing a timesheet an approved shift needs is refused at COMMIT with the law's identity",
						lawFailure(removeSheet.outcome),
						jsonText(removeSheet.outcome)
					),
					equivalence(
						"every generated batch committed",
						Arr.every(
							[small, large],
							(m) => m.generated.outcomes.committed === m.generated.samples
						),
						Arr.join(
							Arr.map([small, large], (m) => jsonText(m.generated.outcomes)),
							" | "
						)
					)
				]
			}
			return { cases, verdicts: { R11: r11 } }
		})
})
