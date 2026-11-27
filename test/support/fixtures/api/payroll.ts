import { Struct } from "effect"
import { ALLEN } from "#compiler/public/allen.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Logic, Num, Range, Text, Type } from "#compiler/public/compute.ts"
import {
	accumulated,
	closedId,
	contract,
	Decimal,
	drawn,
	generated,
	mintOf,
	natural,
	pg,
	span
} from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	closed,
	contained,
	counted,
	derived,
	fin,
	fold,
	key,
	login,
	Monoid,
	mirrors,
	mutable,
	on,
	relation,
	role,
	type Schema,
	schema,
	select,
	type StatementsByName,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import { Cents, centsKey, Instant, toCents } from "#test/support/fixtures/api/contracts.ts"
import { Id } from "#test/support/ids.ts"

const rateKey = Symbol("Rate")
export const Rate = contract<typeof rateKey>()("Rate", pg.numeric(7, 6), (x) =>
	Logic.between(x, 0n, 1n)
)
export const toRate = mintOf(rateKey)
const microsKey = Symbol("Micros")
export const Micros = contract<typeof microsKey>()("Micros", pg.bigint, (x) => Logic.ge(x, 0n))
const weekKey = Symbol("Week")
export const Week = contract<typeof weekKey>()("Week", pg.bigint)
const einKey = Symbol("Ein")
export const Ein = contract<typeof einKey>()("Ein", str.regex("^[0-9]{2}-[0-9]{7}$"))
const legalNameKey = Symbol("LegalName")
export const LegalName = contract<typeof legalNameKey>()(
	"LegalName",
	str.regex("^.+$", "su"),
	(x) => Logic.le(Text.charLength(x), 300)
)

const EmployeeCode = str.regex("^E[0-9]{6}$")
const CostCenter = str.regex("^CC-[0-9]{4}$")
const AccountNo = str.regex("^[0-9]{4,17}$")
const Digest = str.regex("^[0-9a-f]{64}$")
const Memo = str.regex("^.*$", "su")

const dec = (exact: string): Decimal => Decimal.of(exact)

const Basis = closed.ordered("Basis", ["salaried", "hourly"])
const Stage = closed.ordered("Stage", ["draft", "approved", "paid", "voided"])
const ShiftStatus = closed.ordered("ShiftStatus", ["pending", "approved"])
const LeaveReason = closed.ordered("LeaveReason", ["vacation", "sick", "unpaid"])
const Filing = closed.ordered("Filing", ["single", "joint", "head"])
const LedgerAccount = closed.ordered("LedgerAccount", ["GrossWages", "NetPay", "Withholding"])
const Side = closed.ordered("Side", ["debit", "credit"])
const Levy = closed.ordered("Levy", ["SocialSecurity", "Medicare", "Futa"])

/** Each levy's rates: a closed relation keyed by its levy (OPEN-3 (b)). */
const LevyRate = closed.relation(
	"LevyRate",
	{ levy: closedId(Levy), employeeRate: Rate, employerRate: Rate },
	["levy"],
	[
		{
			levy: "SocialSecurity",
			employeeRate: toRate(dec("0.062")),
			employerRate: toRate(dec("0.062"))
		},
		{ levy: "Medicare", employeeRate: toRate(dec("0.0145")), employerRate: toRate(dec("0.0145")) },
		{ levy: "Futa", employeeRate: toRate(dec("0")), employerRate: toRate(dec("0.006")) }
	]
)

/** An employer: its approvers a counted family, `approvers` their drawn count. */
export const Employer = relation(
	"Employer",
	{ id: Id, ein: Ein, name: LegalName, approvers: drawn(natural) },
	["id"]
)
export const Employee = relation(
	"Employee",
	{ id: Id, employer: Id, code: EmployeeCode, name: LegalName },
	["id"]
)
export const ReportsTo = relation("ReportsTo", { employee: Id, manager: Id }, ["employee"])
export const Approver = relation("Approver", { employer: Id, approver: Id }, [
	"employer",
	"approver"
])

export const TaxProfile = relation(
	"TaxProfile",
	{ employee: Id, filing: closedId(Filing), extra: Cents },
	["employee"]
)

export const Employment = relation(
	"Employment",
	{ employee: Id, during: span(Instant), basis: closedId(Basis) },
	["employee", "during"]
)

export const Assignment = relation(
	"Assignment",
	{ employee: Id, during: span(Instant), costCenter: CostCenter },
	["employee", "during"]
)

export const Salary = relation("Salary", { employee: Id, during: span(Instant), annual: Cents }, [
	"employee",
	"during"
])

export const Leave = relation(
	"Leave",
	{ employee: Id, during: span(Instant), reason: closedId(LeaveReason) },
	["employee", "during"]
)

/**
 * A timesheet: its approved shifts' hours are a sum fold over its counted family of shifts (fin.md §6, "duration" then
 * "weighted"), `shifts` their drawn count and `approvedHours` the fold's end, which a check holds to `ceiling`.
 */
export const Timesheet = relation(
	"Timesheet",
	{
		employee: Id,
		week: Week,
		ceiling: Micros,
		shifts: drawn(natural),
		approvedHours: accumulated(pg.bigint, 0n)
	},
	["employee", "week"]
)

/** A shift, whose `hours` PostgreSQL generates from its span: the width `upper − lower` (fin.md §6, "duration"). */
export const Shift = relation.generated(
	"Shift",
	{ employee: Id, during: span(Instant), week: Week, status: closedId(ShiftStatus) },
	["employee", "during"],
	(r) => ({
		hours: generated(
			pg.bigint,
			Logic.when(
				Num.within(Range.width(r.during, Instant), 0n, 9223372036854775807n),
				(width) => Type.cast(width, pg.bigint),
				0n
			)
		)
	})
)

export const PayRun = relation(
	"PayRun",
	{ id: Id, employer: Id, period: span(Instant), stage: closedId(Stage) },
	["id"]
)
export const Approval = relation("Approval", { run: Id, approver: Id, at: Instant }, ["run"])
export const Payment = relation("Payment", { run: Id, settled: Instant }, ["run"])
export const Voiding = relation("Voiding", { run: Id, reason: Memo }, ["run"])
export const Reissue = relation("Reissue", { run: Id, replaces: Id }, ["run"])
/**
 * A pay line: its deposits are a counted family, `deposits` their drawn count, and `deposited` the sum fold of their
 * amounts (fin.md §6, "count in [lo, hi]" and "weighted").
 */
export const PayLine = relation(
	"PayLine",
	{
		id: Id,
		run: Id,
		employee: Id,
		gross: Cents,
		net: Cents,
		offCycle: pg.boolean,
		deposits: drawn(natural),
		deposited: accumulated(Cents, toCents(0n), centsKey)
	},
	["id"]
)
export const OffCycleReason = relation("OffCycleReason", { line: Id, reason: Memo }, ["line"])
export const Deposit = relation(
	"Deposit",
	{ line: Id, account: AccountNo, amount: Cents, remainder: pg.boolean },
	["line", "account"]
)

export const LevyLine = relation(
	"LevyLine",
	{ line: Id, levy: closedId(Levy), employeeRate: Rate, withheld: Cents },
	["line", "levy"]
)

export const Posting = relation(
	"Posting",
	{
		line: Id,
		account: closedId(LedgerAccount),
		side: closedId(Side),
		amount: Cents
	},
	["line", "account"]
)
export const Request = relation("Request", { id: Id, digest: Digest, result: Memo }, ["id"])

/**
 * The payroll ledger fixture, in public-API form: the Payroll schema and its
 * Reporting extension built by the real schema constructors, every law family of the first compiler among their
 * statements, and the workload queries and the ChangeSets' query members built by the real query builder through the
 * typed facade. Each query is checked into the IR test/support/fixtures/ir/payroll.ts states for it.
 *
 * A ChangeSet value is the write package's, so the members of approveShifts, withhold, pay and reverse are
 * exported one query each, as the IR form does.
 *
 * Its statements hold every law family of the first compiler: candidate keys; opt-ins to in-place change; a row check;
 * containments into keyed relations and into closed facts (a roster, and closed tuples); keyed equality, unconditional
 * and conditional; a run's stage as a tagged header whose paid and voided runs each mirror their payload, where draft
 * and approved runs carry none; a selected target and selected sources; span coverage (mirrors, plain, selected target,
 * selected source); and the counting and summing laws, each by fin.md §6: at most one reissue per run and one remainder
 * deposit per line, keys over a side; at least one approver per employer and at most four deposits per line, counted
 * families with a row check on the owner's count; the deposits' amounts summing to the line's net and its approved
 * shifts' hours within its timesheet's ceiling, sum folds with a row check on the end; and a line's net within its
 * gross, a row check.
 */
/** Each employer's approvers, a counted family: "at least one" over an unkeyed side is a count (fin.md §6). */
const employerApprovers = counted(on(Approver, "employer"), fin(Employer, "approvers"))

/** Each pay line's deposits, a counted family: their order is no fact of the ledger. */
const lineDeposits = counted(on(Deposit, "line"), fin(PayLine, "deposits"))

/** Each timesheet's shifts, a counted family over the timesheet's key. */
const timesheetShifts = counted(on(Shift, "employee", "week"), fin(Timesheet, "shifts"))

export const Payroll = schema(
	"Payroll",
	[
		Basis,
		Stage,
		ShiftStatus,
		LeaveReason,
		Filing,
		LedgerAccount,
		Side,
		Levy,
		LevyRate,
		Employer,
		Employee,
		ReportsTo,
		Approver,
		TaxProfile,
		Employment,
		Assignment,
		Salary,
		Leave,
		Timesheet,
		Shift,
		PayRun,
		Approval,
		Payment,
		Voiding,
		Reissue,
		PayLine,
		OffCycleReason,
		Deposit,
		LevyLine,
		Posting,
		Request
	],
	[
		key(on(Employer, "ein")),
		key(on(Employee, "employer", "code")),
		key(on(PayLine, "run", "employee")),
		unit("Entity", { id: Id }),
		unit("Employee", { employee: Id }),
		mutable(PayRun),
		mutable(Shift),
		mutable(Timesheet),
		check("NotOwnManager", ReportsTo, (x) => x.ne(x.employee, x.manager)),
		contained(on(Employee, "employer"), on(Employer, "id")),
		contained(on(ReportsTo, "employee"), on(Employee, "id")),
		contained(on(ReportsTo, "manager"), on(Employee, "id")),
		contained(on(Approver, "employer"), on(Employer, "id")),
		contained(on(Approver, "approver"), on(Employee, "id")),
		contained(on(Employment, "employee"), on(Employee, "id")),
		contained(on(Timesheet, "employee"), on(Employee, "id")),
		contained(on(Shift, "employee"), on(Employee, "id")),
		contained(on(PayRun, "employer"), on(Employer, "id")),
		contained(on(Approval, "run"), on(PayRun, "id")),
		contained(on(Approval, "approver"), on(Employee, "id")),
		contained(on(Payment, "run"), on(Approval, "run")),
		contained(on(Reissue, "run"), on(PayRun, "id")),
		contained(on(PayLine, "run"), on(PayRun, "id")),
		contained(on(PayLine, "employee"), on(Employee, "id")),
		contained(on(Deposit, "line"), on(PayLine, "id")),
		contained(on(LevyLine, "line"), on(PayLine, "id")),
		contained(on(Posting, "line"), on(PayLine, "id")),
		contained(on(Employment, "basis"), on(Basis, "id")),
		contained(on(LevyLine, "levy", "employeeRate"), on(LevyRate, "levy", "employeeRate")),
		mirrors(on(Employee, "id"), on(TaxProfile, "employee")),
		mirrors(
			on(
				select(PayLine, (r) => r.eq(r.offCycle, true)),
				"id"
			),
			on(OffCycleReason, "line")
		),
		mirrors(
			on(Payment, "run"),
			on(
				select(PayRun, (r) => r.eq(r.stage, "paid")),
				"id"
			)
		),
		mirrors(
			on(Voiding, "run"),
			on(
				select(PayRun, (r) => r.eq(r.stage, "voided")),
				"id"
			)
		),
		contained(
			on(Reissue, "replaces"),
			on(
				select(PayRun, (r) => r.eq(r.stage, "voided")),
				"id"
			)
		),
		contained(
			on(
				select(PayRun, (r) => r.eq(r.stage, "approved")),
				"id"
			),
			on(Approval, "run")
		),
		contained(
			on(
				select(Shift, (r) => r.eq(r.status, "approved")),
				"employee",
				"week"
			),
			on(Timesheet, "employee", "week")
		),
		mirrors(on(Assignment, "employee", "during"), on(Employment, "employee", "during")),
		contained(on(Leave, "employee", "during"), on(Employment, "employee", "during")),
		key(
			on(
				select(Employment, (r) => r.eq(r.basis, "salaried")),
				"employee",
				"during"
			)
		),
		contained(
			on(Salary, "employee", "during"),
			on(
				select(Employment, (r) => r.eq(r.basis, "salaried")),
				"employee",
				"during"
			)
		),
		contained(
			on(
				select(Shift, (r) => r.eq(r.status, "approved")),
				"employee",
				"during"
			),
			on(Employment, "employee", "during")
		),
		employerApprovers,
		check("AtLeastOneApprover", Employer, (e) => e.ge(e.approvers, 1n)),
		key(on(Reissue, "replaces")),
		key(
			on(
				select(Deposit, (r) => r.eq(r.remainder, true)),
				"line"
			)
		),
		lineDeposits,
		check("AtMostFourDeposits", PayLine, (l) => l.le(l.deposits, 4n)),
		fold(lineDeposits, Monoid.sum, on(Deposit, "line", "amount"), on(PayLine, "id", "deposited")),
		check("DepositsSumToNet", PayLine, (l) => l.eq(l.deposited, l.net)),
		check("NetWithinGross", PayLine, (l) => l.le(l.net, l.gross)),
		timesheetShifts,
		fold(
			timesheetShifts,
			Monoid.sum,
			on(
				select(Shift, (r) => r.eq(r.status, "approved")),
				"employee",
				"week",
				"hours"
			),
			on(Timesheet, "employee", "week", "approvedHours")
		),
		check("ApprovedHoursWithinCeiling", Timesheet, (t) =>
			t.le(t.approvedHours, Type.base(t.ceiling))
		)
	]
)

/** Payroll under another name, as an installation under a unique schema name opens it. */
export type PayrollNamed<N extends string> = Schema<
	N,
	(typeof Payroll)["relations"],
	StatementsByName<(typeof Payroll)["statements"], (typeof Payroll)["relations"]>
>

/** RunTotal's definition over the Payroll it is given. */
const runTotalsOver = <const N extends string>(installed: PayrollNamed<N>) =>
	query(installed).rule((r) => {
		const { id, run, gross, net } = v(PayLine, "payLine")
		return r
			.match(PayLine, { id, run, gross, net })
			.find({ run, lines: r.count(), gross: r.sum(gross), net: r.sum(net) })
	})

export const runTotals = runTotalsOver(Payroll)
const RunTotal = derived("RunTotal", runTotals)
export const Reporting = schema.extend([Payroll], "Reporting", [RunTotal], [])

/**
 * Reporting and its worlds over the Payroll they are given (the declared one, or the one an installation rebuilds under
 * its unique name): four full roles in one login. hr keeps the people and their time, the clerk runs payroll and the
 * ledger, the approver approves, and the auditor reads. The login's workload holds
 * hr's writes a schedule races: the empty ChangeSet its first call applies, and a leave of the facts each call gives.
 */
export const reportingWorlds = (installed: PayrollNamed<string>) => {
	const reporting = schema.extend(
		[installed],
		`${installed.name}_1`,
		[derived("RunTotal", runTotalsOver(installed))],
		[]
	)
	/**
	 * Every relation a role holds: all but LevyRate, a closed relation, which installs as constants and no table, and
	 * RunTotal, a live derived relation, which a role reads through the relations its definition reads.
	 */
	const entries = Struct.omit(reporting.relations, ["LevyRate", "RunTotal"])
	const hr = role(reporting, "hr", entries, {
		insert: [
			"Employer",
			"Employee",
			"ReportsTo",
			"Approver",
			"TaxProfile",
			"Employment",
			"Assignment",
			"Salary",
			"Leave"
		],
		write: ["Timesheet"]
	})
	const clerk = role(reporting, "clerk", entries, {
		insert: [
			"PayLine",
			"OffCycleReason",
			"Deposit",
			"LevyLine",
			"Posting",
			"Payment",
			"Voiding",
			"Reissue"
		],
		write: ["PayRun", "Shift"]
	})
	const approver = role(reporting, "approver", entries, {
		insert: ["Approval", "Request"],
		write: ["PayRun"]
	})
	const auditor = role(reporting, "auditor", entries)
	return {
		Reporting: reporting,
		hr,
		clerk,
		approver,
		auditor,
		server: login(reporting, "server", [hr, clerk, approver, auditor], {
			workload: [
				workload(hr, {
					noop: ChangeSet.empty(installed),
					insertLeave: ChangeSet.empty(installed).insert(Leave, [])
				})
			]
		})
	}
}

export const payslip = query(Payroll)
	.rule((r) => {
		const { id, run, employee, gross, net, offCycle } = v(PayLine, "payLine")
		return r
			.match(PayLine, { id, run, employee, gross, net, offCycle })
			.where(r.eq(id, r.param("line", Id)))
			.find({ id, run, employee, gross, net, offCycle })
	})
	.attach(
		"person",
		(l) =>
			query(Payroll).rule((r) => {
				const { code, name } = v(Employee, "employee")
				return r.match(Employee, { id: l.employee, code, name }).find({ code, name })
			}),
		"one"
	)
	.attach(
		"deposits",
		(l) =>
			query(Payroll)
				.rule((r) => {
					const { account, amount, remainder } = v(Deposit, "deposit")
					return r
						.match(Deposit, { line: l.id, account, amount, remainder })
						.find({ account, amount, remainder })
				})
				.orderBy(["account", "asc"]),
		"array"
	)
	.attach(
		"levies",
		(l) =>
			query(Payroll).rule((r) => {
				const { levy, employeeRate, withheld } = v(LevyLine, "levyLine")
				return r
					.match(LevyLine, { line: l.id, levy, employeeRate, withheld })
					.find({ levy, employeeRate, withheld })
			}),
		"array"
	)
	.attach(
		"offCycleReason",
		(l) =>
			query(Payroll).rule((r) => {
				const { reason } = v(OffCycleReason, "offCycleReason")
				return r.match(OffCycleReason, { line: l.id, reason }).find({ reason })
			}),
		"option"
	)

export const employeeCard = query(Payroll)
	.rule((r) => {
		const { id, code, name } = v(Employee, "employee")
		return r
			.match(Employee, { id, employer: r.param("employer", Employee.fields.employer), code, name })
			.find({ id, code, name })
	})
	.attach(
		"profile",
		(e) =>
			query(Payroll).rule((r) => {
				const { filing, extra } = v(TaxProfile, "taxProfile")
				return r.match(TaxProfile, { employee: e.id, filing, extra }).find({ filing, extra })
			}),
		"option"
	)
	.attach(
		"manager",
		(e) =>
			query(Payroll).rule((r) => {
				const { manager } = v(ReportsTo, "reportsTo")
				return r.match(ReportsTo, { employee: e.id, manager }).find({ manager })
			}),
		"option"
	)

export const runStages = query(Payroll)
	.rule((r) => {
		const { id } = v(PayRun, "payRun")
		return r
			.match(PayRun, { id, employer: r.param("employer", PayRun.fields.employer), stage: "draft" })
			.find({ id, stage: Stage.handle("draft") })
	})
	.rule((r) => {
		const { id } = v(PayRun, "payRun")
		const { approver, at } = v(Approval, "approval")
		return r
			.match(PayRun, {
				id,
				employer: r.param("employer", PayRun.fields.employer),
				stage: "approved"
			})
			.match(Approval, { run: id, approver, at })
			.find({ id, stage: Stage.handle("approved"), approver, at })
	})
	.rule((r) => {
		const { id } = v(PayRun, "payRun")
		const { settled } = v(Payment, "payment")
		return r
			.match(PayRun, { id, employer: r.param("employer", PayRun.fields.employer), stage: "paid" })
			.match(Payment, { run: id, settled })
			.find({ id, stage: Stage.handle("paid"), settled })
	})
	.rule((r) => {
		const { id } = v(PayRun, "payRun")
		const { reason } = v(Voiding, "voiding")
		return r
			.match(PayRun, { id, employer: r.param("employer", PayRun.fields.employer), stage: "voided" })
			.match(Voiding, { run: id, reason })
			.find({ id, stage: Stage.handle("voided"), reason })
	})

export const ledger = query(Payroll)
	.rule((r) => {
		const { line, account, side, amount } = v(Posting, "posting")
		const { run } = v(PayLine, "payLine")
		return r
			.match(Posting, { line, account, side, amount })
			.match(PayLine, { id: line, run })
			.where(r.eq(run, r.param("run", Id)))
			.find({ line, account, side, amount })
	})
	.orderBy(["line", "asc"], ["account", "asc"])

export const ledgerBalance = query(Payroll).rule((r) => {
	const { line, account, side, amount } = v(Posting, "posting")
	const { run } = v(PayLine, "payLine")
	return r
		.match(Posting, { line, account, side, amount })
		.match(PayLine, { id: line, run })
		.where(r.eq(run, r.param("run", Id)))
		.find({
			debits: r.sum(Logic.cond(r.eq(side, "debit"), Type.base(amount), 0n)),
			credits: r.sum(Logic.cond(r.eq(side, "credit"), Type.base(amount), 0n))
		})
})

export const splitSegments = query(Payroll).rule((r) => {
	const { id: run, employer, period } = v(PayRun, "payRun")
	const { employee, during, annual } = v(Salary, "salary")
	return r
		.match(PayRun, { id: run, employer, period })
		.match(Employee, { id: employee, employer })
		.match(Salary, { employee, during, annual })
		.where(
			r.eq(run, r.param("run", Id)),
			r.allen(during, ALLEN.overlaps | ALLEN.overlappedBy, period)
		)
		.find({ employee, during, annual })
})

export const withholdingFor = query(Payroll).rule((r) => {
	const { id, gross } = v(PayLine, "payLine")
	const { levy, employeeRate } = v(LevyRate, "levyRate")
	return r
		.match(PayLine, { id, run: r.param("run", PayLine.fields.run), gross })
		.match(LevyRate, { levy, employeeRate })
		.find({
			line: id,
			levy,
			employeeRate,
			withheld: Logic.when(
				Num.within(
					Num.round(Num.mul(Num.numeric(gross), Type.base(employeeRate))),
					0n,
					9223372036854775807n
				),
				(cents) => Type.cast(cents, Cents, centsKey),
				toCents(0n)
			)
		})
})

/**
 * Everyone below a manager, through any number of levels. Exported because the compile profile
 * (scripts/dev/profile/phases.ts) lowers every query a fixture module exports.
 */
export const Org = query(Payroll).recursive("Org", {
	row: { employee: Id },
	base: [
		(r) => {
			const { employee } = v(ReportsTo, "reportsTo")
			return r
				.match(ReportsTo, { employee, manager: r.param("manager", ReportsTo.fields.manager) })
				.find({ employee })
		}
	],
	rec: [
		(r, self) => {
			const { employee: middle } = v(self, "self")
			const { employee } = v(ReportsTo, "reportsTo")
			return r
				.match(self, { employee: middle })
				.match(ReportsTo, { employee, manager: middle })
				.find({ employee })
		}
	]
})

export const orgOf = query(Payroll).rule((r) => {
	const source = Org.bind({ manager: r.param("manager", ReportsTo.fields.manager) })
	const { employee } = v(source, "source")
	return r.match(source, { employee }).find({ employee })
})

export const withinTwo = query(Payroll)
	.rule((r) => {
		const { employee } = v(ReportsTo, "reportsTo")
		return r
			.match(ReportsTo, { employee, manager: r.param("manager", ReportsTo.fields.manager) })
			.find({ employee })
	})
	.rule((r) => {
		const { employee: middle } = v(ReportsTo, "middle")
		const { employee } = v(ReportsTo, "reportsTo")
		return r
			.match(ReportsTo, { employee: middle, manager: r.param("manager", ReportsTo.fields.manager) })
			.match(ReportsTo, { employee, manager: middle })
			.find({ employee })
	})

export const runTotalOf = query(Reporting).rule((r) => {
	const { lines, gross, net } = v(RunTotal, "runTotal")
	return r
		.match(RunTotal, { run: r.param("run", Id), lines, gross, net })
		.find({ lines, gross, net })
})

export const employeesByPrefix = query(Payroll).rule((r) => {
	const { id, code, name } = v(Employee, "employee")
	return r
		.match(Employee, { id, employer: r.param("employer", Employee.fields.employer), code, name })
		.where(r.ge(name, r.param("lo", LegalName)), r.lt(name, r.param("hi", LegalName)))
		.find({ id, code, name })
})

/**
 * The ChangeSets' query members.
 *
 * approveShifts' put of Shift.
 */
export const approveShiftsMember = query(Payroll).rule((r) => {
	const { during } = v(Shift, "shift")
	return r
		.match(Shift, {
			employee: r.param("employee", Shift.fields.employee),
			during,
			week: r.param("week", Shift.fields.week),
			status: "pending"
		})
		.find({
			employee: r.param("employee", Shift.fields.employee),
			during,
			week: r.param("week", Shift.fields.week),
			status: "approved"
		})
})

/** withhold's insert of Posting; its insert of LevyLine is withholdingFor. */
export const postingMember = query(Payroll)
	.rule((r) => {
		const { id, gross } = v(PayLine, "payLine")
		return r
			.match(PayLine, { id, run: r.param("run", PayLine.fields.run), gross })
			.find({ line: id, account: "GrossWages", side: "debit", amount: gross })
	})
	.rule((r) => {
		const { id, net } = v(PayLine, "payLine")
		return r
			.match(PayLine, { id, run: r.param("run", PayLine.fields.run), net })
			.find({ line: id, account: "NetPay", side: "credit", amount: net })
	})
	.rule((r) => {
		const { id, gross, net } = v(PayLine, "payLine")
		return r.match(PayLine, { id, run: r.param("run", PayLine.fields.run), gross, net }).find({
			line: id,
			account: "Withholding",
			side: "credit",
			amount: Logic.when(
				Num.within(Num.sub(gross, net), 0n, 9223372036854775807n),
				(withheld) => Type.cast(withheld, Cents, centsKey),
				toCents(0n)
			)
		})
	})

/** pay's put of PayRun and its insert of Payment. */
export const payPutMember = query(Payroll).rule((r) => {
	const { employer, period } = v(PayRun, "payRun")
	return r
		.match(PayRun, { id: r.param("run", PayRun.fields.id), employer, period, stage: "approved" })
		.find({ id: r.param("run", Id), employer, period, stage: "paid" })
})

export const payPaymentMember = query(Payroll).rule((r) =>
	r
		.match(PayRun, { id: r.param("run", PayRun.fields.id), stage: "approved" })
		.find({ run: r.param("run", Id), settled: r.param("now", Instant) })
)

/** reverse's put of PayRun, its deletion of Payment and its insert of Voiding. */
export const reversePutMember = query(Payroll).rule((r) => {
	const { employer, period } = v(PayRun, "payRun")
	return r
		.match(PayRun, { id: r.param("run", PayRun.fields.id), employer, period, stage: "paid" })
		.find({ id: r.param("run", Id), employer, period, stage: "voided" })
})

export const reverseDeleteMember = query(Payroll).rule((r) => {
	const { settled } = v(Payment, "payment")
	return r
		.match(Payment, { run: r.param("run", Payment.fields.run), settled })
		.find({ run: r.param("run", Id), settled })
})

export const reverseVoidingMember = query(Payroll).rule((r) =>
	r
		.match(PayRun, { id: r.param("run", PayRun.fields.id), stage: "paid" })
		.find({ run: r.param("run", Id), reason: r.param("reason", Voiding.fields.reason) })
)
