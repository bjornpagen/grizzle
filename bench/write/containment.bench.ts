import { Array as Arr, Effect, Formatter } from "effect"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"

import {
	measureTransaction,
	summarizeTransactions,
	type TransactionMeasure
} from "#bench/harness/transaction.ts"
import { rawSession, settle } from "#bench/query/support/kit.ts"
import {
	installWrites,
	loadedByOwner,
	owner,
	plainStatement,
	probeScans,
	tableScans,
	transactionOf,
	warmedOnce,
	writePhases
} from "#bench/write/support/writes.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { closed, contained, on, relation, schema, select } from "#compiler/public/schema.ts"
import { namesOf } from "#test/support/kernel/naming.ts"

/**
 * R11: keep general containment probes key-local.
 *
 * R11 states no gate paragraph, so its gate is the performance contract's "measurement that can disprove the
 * performance assumption": a containment's check needs, "for the affected X from the row event, existence in A
 * and absence in B, not a full join of every witness pair. Use two indexed EXISTS tests over the complete captured X
 * tuple. Source insertion and target deletion can threaten the law; source deletion and target insertion repair it".
 * The admitted case is a selected source contained in a keyed target: `contained(on(select(Shift, (r) =>
 * r.eq(r.status, "approved")), "employee", "week"), on(Timesheet, "employee", "week"))`. It is a native foreign key,
 * MATCH SIMPLE, from Shift's law columns, each its field where the shift is approved and null elsewhere, into
 * Timesheet's key; its referencing columns are indexed. PostgreSQL's own RI checks are the two indexed tests: a source
 * insertion probes Timesheet's key, and a target deletion probes Shift through the referencing columns' index.
 *
 * Measured: the scans each event's checks make (every constraint IMMEDIATE), and the commit-time work of a batch of
 * source insertions at two relation sizes ten times apart. Key-locality is a scaling class: the checks' index scans per
 * inserted row are the same at both sizes, and neither size scans Shift or Timesheet sequentially.
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
	on(
		select(Shift, (r) => r.eq(r.status, "approved")),
		"employee",
		"week"
	),
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

export default defineGate({
	name: "write-containment",
	gates: ["R11"],
	title:
		"A selected source's foreign key: key-local checks, the threatening events, sizes ten times apart",
	scope:
		"A selected source contained in a keyed target, a native foreign key: the scans its checks make per event, " +
		"and the commit-time work of a batch of source insertions at two relation sizes ten times apart.",
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
			const names = namesOf(fx.installed)
			const law = names.lawOf(covered)
			const foreignKey = names.constraintOf(law, "ForeignKey")
			const T = fx.table("Timesheet")
			const S = fx.table("Shift")
			const shiftTable = fx.relationName("Shift")
			const timesheetTable = fx.relationName("Timesheet")
			const c = (rel: string, f: string) => fx.column(rel, f)
			const status = (handle: string) => fx.handle("ShiftStatus", handle)
			const writer = yield* rawSession(fx, fx.world.app, "m15c containment writer")
			let loadedEmployees = 0
			let nextShift = 1
			/**
			 * Grows the fixture to `employees` employees, each with `weeks` timesheets and `shifts` approved shifts per
			 * timesheet.
			 */
			const grow = Effect.fn("grow")(function* (employees: number) {
				const from = loadedEmployees + 1
				const sheets = `SELECT e, w FROM pg_catalog.generate_series(${from}, ${employees}) AS e, pg_catalog.generate_series(1, ${options.weeks}) AS w`
				const shifts = `SELECT ${nextShift} + (row_number() OVER ())::int8, e, w, ${status("approved")} FROM (${sheets}) AS x(e, w), pg_catalog.generate_series(1, ${options.shifts}) AS k`
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
				`INSERT INTO ${S} ${shiftCols} SELECT ${first} + g, 1 + ((g * 7919) % ${loadedEmployees}), ${weekOf}, ${status("approved")} FROM pg_catalog.generate_series(1, ${options.batch}) AS g`
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
				const scans = yield* probeScans(writer, fx, [batchSql(900000000 + nextShift)])
				return { label, generated: summarizeTransactions(generated), scans }
			})
			yield* grow(options.employees)
			const small = yield* measureAt("small")
			yield* grow(options.employees * 10)
			const large = yield* measureAt("large")

			/** The event table, each event probed alone at the large size. */
			const sheetOf = `(${c("Timesheet", "employee")}, ${c("Timesheet", "week")})`
			const lonely = loadedEmployees + 1
			const events = {
				approvedInsert: yield* probeScans(writer, fx, [
					`INSERT INTO ${S} ${shiftCols} VALUES (-1, 1, ${weekOf}, ${status("approved")})`
				]),
				draftInsert: yield* probeScans(writer, fx, [
					`INSERT INTO ${S} ${shiftCols} VALUES (-2, 1, ${weekOf}, ${status("draft")})`
				]),
				sourceDelete: yield* probeScans(writer, fx, [
					`DELETE FROM ${S} WHERE ${c("Shift", "id")} = 1`
				]),
				targetInsert: yield* probeScans(writer, fx, [
					`INSERT INTO ${T} ${sheetOf} VALUES (${lonely}, 1)`
				]),
				targetDelete: yield* probeScans(writer, fx, [
					`INSERT INTO ${T} ${sheetOf} VALUES (${lonely}, 2)`,
					`DELETE FROM ${T} WHERE ${sheetOf} = (${lonely}, 2)`
				])
			}
			/** Behaviour at its statement or at COMMIT, as a direct writer sees it. */
			const atCommit = (label: string, sql: string) =>
				measureTransaction(writer, transactionOf([plainStatement(label, sql, [])], "plain"))
			const orphan = yield* atCommit(
				"orphan",
				`INSERT INTO ${S} ${shiftCols} VALUES (-3, ${lonely + 1}, 1, ${status("approved")})`
			)
			const draft = yield* atCommit(
				"draft",
				`INSERT INTO ${S} ${shiftCols} VALUES (-4, ${lonely + 1}, 1, ${status("draft")})`
			)
			const removeSheet = yield* atCommit(
				"sheet",
				`DELETE FROM ${T} WHERE ${sheetOf} = (1, ${weekOf})`
			)
			/**
			 * The foreign key's refusal: 23503 under its own name, at the statement where it is immediate or at COMMIT
			 * where the compiler defers it.
			 */
			const foreignKeyFailure = (o: TransactionMeasure["outcome"]) =>
				o.kind === "failed" &&
				o.sqlstate === sqlstates.foreignKeyViolation &&
				o.constraint.kind === "named" &&
				o.constraint.name === foreignKey
			type Scans = (typeof events)["approvedInsert"]
			const seqScans = (s: Scans) =>
				tableScans(s, shiftTable).seq + tableScans(s, timesheetTable).seq
			/** The index scans of Timesheet per inserted row of a batch, the checks' cost per source insertion. */
			const timesheetScansPerRow = (s: Scans) => tableScans(s, timesheetTable).idx / options.batch
			const at = (m: typeof small, employees: number): CaseRecord<"R11"> => ({
				name: `a batch of ${options.batch} approved shifts, ${employees} employees`,
				gates: ["R11"],
				conditions: {
					workload: `one INSERT of ${options.batch} approved shifts on distinct existing timesheets, then the deferred checks and COMMIT`,
					schemaState: loadedByOwner,
					dataDistribution: `${employees} employees with ${options.weeks} timesheets each and ${options.shifts} approved shifts per timesheet`,
					parameters: { employees, batch: options.batch },
					resultSemantics: "every shift has its timesheet; the batch commits",
					cacheState: warmedOnce
				},
				phases: {},
				variants: [],
				comparisons: [],
				transactions: { generated: m.generated },
				loads: {},
				measures: {
					shiftSeqScans: tableScans(m.scans, shiftTable).seq,
					timesheetSeqScans: tableScans(m.scans, timesheetTable).seq,
					shiftIndexScans: tableScans(m.scans, shiftTable).idx,
					timesheetIndexScans: tableScans(m.scans, timesheetTable).idx
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
					conditions: {
						workload: "each event alone with every constraint IMMEDIATE, rolled back",
						schemaState: loadedByOwner,
						dataDistribution: `${loadedEmployees} employees`,
						parameters: {},
						resultSemantics: "every probed statement keeps the law",
						cacheState: warmedOnce
					},
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						approvedInsertTimesheetScans: tableScans(events.approvedInsert, timesheetTable).idx,
						draftInsertTimesheetScans: tableScans(events.draftInsert, timesheetTable).idx,
						sourceDeleteTimesheetScans: tableScans(events.sourceDelete, timesheetTable).idx,
						targetInsertShiftScans: tableScans(events.targetInsert, shiftTable).idx,
						targetDeleteShiftScans: tableScans(events.targetDelete, shiftTable).idx,
						...(smallP50 === undefined || largeP50 === undefined || smallP50 <= 0 || largeP50 <= 0
							? {}
							: { deferredChecksGrowthGenerated: largeP50 / smallP50 })
					}
				}
			]
			const r11: VerdictInput = {
				checks: [
					mechanism(
						"the selected containment is a native foreign key, installed under the name its law reports",
						Arr.some(
							fx.installed.installation.laws.constraints,
							(c) => c.name === foreignKey && Arr.some(c.laws, (l) => l.law === law)
						),
						foreignKey
					),
					mechanism(
						"an approved insertion probes Timesheet and a target deletion probes Shift; a draft insertion, a source deletion and a target insertion probe nothing",
						tableScans(events.approvedInsert, timesheetTable).idx === 1 &&
							tableScans(events.targetDelete, shiftTable).idx === 1 &&
							tableScans(events.draftInsert, timesheetTable).idx === 0 &&
							tableScans(events.sourceDelete, timesheetTable).idx === 0 &&
							tableScans(events.targetInsert, shiftTable).idx === 0 &&
							Arr.every(
								[
									events.approvedInsert,
									events.draftInsert,
									events.sourceDelete,
									events.targetInsert,
									events.targetDelete
								],
								(e) => seqScans(e) === 0
							),
						Formatter.format(events)
					),
					mechanism(
						"the checks are indexed: no sequential scan of Shift or Timesheet at either size",
						seqScans(small.scans) === 0 && seqScans(large.scans) === 0,
						`${Formatter.format(small.scans)} | ${Formatter.format(large.scans)}`
					),
					mechanism(
						"the checks' index scans per inserted row are equal at both sizes",
						timesheetScansPerRow(small.scans) === timesheetScansPerRow(large.scans),
						`${timesheetScansPerRow(small.scans)} at ${options.employees} employees, ${timesheetScansPerRow(large.scans)} at ${options.employees * 10}`
					),
					equivalence(
						"an approved shift without its timesheet is refused by the foreign key",
						foreignKeyFailure(orphan.outcome),
						Formatter.format(orphan.outcome)
					),
					equivalence(
						"a draft shift without its timesheet commits",
						draft.outcome.kind === "committed",
						Formatter.format(draft.outcome)
					),
					equivalence(
						"removing a timesheet an approved shift needs is refused by the foreign key",
						foreignKeyFailure(removeSheet.outcome),
						Formatter.format(removeSheet.outcome)
					),
					equivalence(
						"every generated batch committed",
						Arr.every(
							[small, large],
							(m) => m.generated.outcomes.committed === m.generated.samples
						),
						Arr.join(
							Arr.map([small, large], (m) => Formatter.format(m.generated.outcomes)),
							" | "
						)
					)
				]
			}
			return { cases, verdicts: { R11: r11 } }
		})
})
