/**
 * The payroll ledger fixture in IR form: the Payroll schema and its Reporting extension as SchemaDescs, the
 * workload queries and the query members of its ChangeSets as checked relational IR, and the declarations the compiler
 * refuses.
 */
import type { SchemaDesc } from "#compiler/ir/desc.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import { SchemaModel } from "#test/support/fixtures/ir/build.ts"
import {
	type AuthoredStatementDesc,
	alternatives,
	betweenExpr,
	charLength,
	check,
	closed,
	closedRelation,
	contained,
	counted,
	decodedQuery,
	decodedSchema,
	eq,
	f,
	field,
	fin,
	fold,
	ge,
	key,
	le,
	literal,
	mirrors,
	mutable,
	ne,
	on,
	onWhere,
	relation,
	value
} from "#test/support/fixtures/ir/desc.ts"

/** Contracts, each a domain named after it, and the structural text refinements. */
const Cents = f.contract("Cents", f.bigint, ge(value, literal(0n)))
const Rate = f.contract("Rate", f.numeric(7, 6), betweenExpr(value, literal(0n), literal(1n)))
const Micros = f.contract("Micros", f.bigint, ge(value, literal(0n)))
const Instant = f.contract("Instant", f.bigint, undefined)
const Week = f.contract("Week", f.bigint, undefined)
const Ein = f.contract("Ein", f.regex("^[0-9]{2}-[0-9]{7}$", "u"), undefined)
const LegalName = f.contract(
	"LegalName",
	f.regex("^.+$", "su"),
	le(charLength(value), literal(300))
)
const EmployeeCode = f.regex("^E[0-9]{6}$", "u")
const CostCenter = f.regex("^CC-[0-9]{4}$", "u")
const AccountNo = f.regex("^[0-9]{4,17}$", "u")
const Digest = f.regex("^[0-9a-f]{64}$", "u")
const Memo = f.wildcard

/** Decimal.of checks the exact string at construction. */
const dec = (exact: string): Decimal => Decimal.of(exact)

/** The closed rosters. */
const Basis = closed("Basis", ["salaried", "hourly"])
const Stage = closed("Stage", ["draft", "approved", "paid", "voided"])
const ShiftStatus = closed("ShiftStatus", ["pending", "approved"])
const LeaveReason = closed("LeaveReason", ["vacation", "sick", "unpaid"])
const Filing = closed("Filing", ["single", "joint", "head"])
const LedgerAccount = closed("LedgerAccount", ["GrossWages", "NetPay", "Withholding"])
const Side = closed("Side", ["debit", "credit"])
const Levy = closed("Levy", ["SocialSecurity", "Medicare", "Futa"])

/** Each levy's rates: a closed relation keyed by its levy. */
const LevyRate = closedRelation(
	"LevyRate",
	{ levy: f.closedId("Levy"), employeeRate: Rate, employerRate: Rate },
	["levy"],
	[
		{ levy: "SocialSecurity", employeeRate: dec("0.062"), employerRate: dec("0.062") },
		{ levy: "Medicare", employeeRate: dec("0.0145"), employerRate: dec("0.0145") },
		{ levy: "Futa", employeeRate: dec("0"), employerRate: dec("0.006") }
	]
)

/** The relations. */
/** An employer: its approvers a counted family, `approvers` their drawn count. */
const Employer = relation(
	"Employer",
	{ id: f.uuid, ein: Ein, name: LegalName, approvers: f.drawn },
	["id"]
)
const Employee = relation(
	"Employee",
	{ id: f.uuid, employer: f.uuid, code: EmployeeCode, name: LegalName },
	["id"]
)
const ReportsTo = relation("ReportsTo", { employee: f.uuid, manager: f.uuid }, ["employee"])
const Approver = relation("Approver", { employer: f.uuid, approver: f.uuid }, [
	"employer",
	"approver"
])

const TaxProfile = relation(
	"TaxProfile",
	{ employee: f.uuid, filing: f.closedId("Filing"), extra: Cents },
	["employee"]
)

const Employment = relation(
	"Employment",
	{ employee: f.uuid, during: f.span(Instant, undefined), basis: f.closedId("Basis") },
	["employee", "during"]
)

const Assignment = relation(
	"Assignment",
	{ employee: f.uuid, during: f.span(Instant, undefined), costCenter: CostCenter },
	["employee", "during"]
)

const Salary = relation(
	"Salary",
	{ employee: f.uuid, during: f.span(Instant, undefined), annual: Cents },
	["employee", "during"]
)

const Leave = relation(
	"Leave",
	{ employee: f.uuid, during: f.span(Instant, undefined), reason: f.closedId("LeaveReason") },
	["employee", "during"]
)

/** A timesheet: its shifts a counted family, `approvedHours` the sum fold of its approved shifts' hours. */
const Timesheet = relation(
	"Timesheet",
	{
		employee: f.uuid,
		week: Week,
		ceiling: Micros,
		shifts: f.drawn,
		approvedHours: f.accumulated(f.bigint, 0n)
	},
	["employee", "week"]
)

/** A shift, whose `hours` PostgreSQL generates from its span: its width (fin.md §6, "duration"). */
const Shift = relation(
	"Shift",
	{
		employee: f.uuid,
		during: f.span(Instant, undefined),
		week: Week,
		status: f.closedId("ShiftStatus"),
		hours: f.generated(f.bigint, {
			kind: "when",
			guard: { kind: "within", low: 0n, high: 9223372036854775807n },
			subject: { kind: "compute", fn: "width", args: [field("during")] },
			proved: {
				kind: "cast",
				to: f.bigint,
				arg: { kind: "compute", fn: "width", args: [field("during")] }
			},
			otherwise: literal(0n)
		})
	},
	["employee", "during"]
)

const PayRun = relation(
	"PayRun",
	{ id: f.uuid, employer: f.uuid, period: f.span(Instant, undefined), stage: f.closedId("Stage") },
	["id"]
)
const Approval = relation("Approval", { run: f.uuid, approver: f.uuid, at: Instant }, ["run"])
const Payment = relation("Payment", { run: f.uuid, settled: Instant }, ["run"])
const Voiding = relation("Voiding", { run: f.uuid, reason: Memo }, ["run"])
const Reissue = relation("Reissue", { run: f.uuid, replaces: f.uuid }, ["run"])
/** A pay line: its deposits a counted family, `deposited` the sum fold of their amounts. */
const PayLine = relation(
	"PayLine",
	{
		id: f.uuid,
		run: f.uuid,
		employee: f.uuid,
		gross: Cents,
		net: Cents,
		offCycle: f.boolean,
		deposits: f.drawn,
		deposited: f.accumulated(Cents, 0n)
	},
	["id"]
)
const OffCycleReason = relation("OffCycleReason", { line: f.uuid, reason: Memo }, ["line"])
const Deposit = relation(
	"Deposit",
	{ line: f.uuid, account: AccountNo, amount: Cents, remainder: f.boolean },
	["line", "account"]
)

const LevyLine = relation(
	"LevyLine",
	{ line: f.uuid, levy: f.closedId("Levy"), employeeRate: Rate, withheld: Cents },
	["line", "levy"]
)

const Posting = relation(
	"Posting",
	{
		entry: f.bigserial,
		line: f.uuid,
		account: f.closedId("LedgerAccount"),
		side: f.closedId("Side"),
		amount: Cents
	},
	["entry"]
)
const Request = relation("Request", { id: f.uuid, digest: Digest, result: Memo }, ["id"])

const payrollRelations = [
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
] as const

const alternativeStatements = alternatives(PayRun, "stage", Stage, {
	paid: Payment,
	voided: Voiding
})

/**
 * The laws, statement by statement.
 *
 * Its statements hold every law family of the first compiler: candidate keys; opt-ins to in-place change; a row check;
 * containments into keyed relations and into closed facts (a roster, and closed tuples); keyed equality, unconditional
 * and conditional outside alternatives; exhaustive alternatives with a partial arm map, where draft and approved runs
 * carry no payload; a selected target and selected sources; span coverage (mirrors, plain, selected target, selected
 * source); and the counting and summing laws, each by fin.md §6, as test/support/fixtures/api/payroll.ts states them: at
 * most one reissue per run and one remainder deposit per line, keys over a side; at least one approver per employer
 * and at most four deposits per line, counted families with a row check on the owner's count; the deposits' amounts
 * summing to the line's net and its approved shifts' hours within its timesheet's ceiling, sum folds with a row check
 * on the end; and a line's net within its gross, a row check.
 */
const payrollStatements: ReadonlyArray<AuthoredStatementDesc> = [
	key(on("Employer", ["ein"])),
	key(on("Employee", ["employer", "code"])),
	key(on("PayLine", ["run", "employee"])),
	key(on("Posting", ["line", "account"])),
	mutable("PayRun"),
	mutable("Shift"),
	mutable("Timesheet"),
	check("NotOwnManager", "ReportsTo", ne(field("employee"), field("manager"))),
	contained(on("Employee", ["employer"]), on("Employer", ["id"])),
	contained(on("ReportsTo", ["employee"]), on("Employee", ["id"])),
	contained(on("ReportsTo", ["manager"]), on("Employee", ["id"])),
	contained(on("Approver", ["employer"]), on("Employer", ["id"])),
	contained(on("Approver", ["approver"]), on("Employee", ["id"])),
	contained(on("Employment", ["employee"]), on("Employee", ["id"])),
	contained(on("Timesheet", ["employee"]), on("Employee", ["id"])),
	contained(on("Shift", ["employee"]), on("Employee", ["id"])),
	contained(on("PayRun", ["employer"]), on("Employer", ["id"])),
	contained(on("Approval", ["run"]), on("PayRun", ["id"])),
	contained(on("Approval", ["approver"]), on("Employee", ["id"])),
	contained(on("Payment", ["run"]), on("Approval", ["run"])),
	contained(on("Reissue", ["run"]), on("PayRun", ["id"])),
	contained(on("PayLine", ["run"]), on("PayRun", ["id"])),
	contained(on("PayLine", ["employee"]), on("Employee", ["id"])),
	contained(on("Deposit", ["line"]), on("PayLine", ["id"])),
	contained(on("LevyLine", ["line"]), on("PayLine", ["id"])),
	contained(on("Posting", ["line"]), on("PayLine", ["id"])),
	contained(on("Employment", ["basis"]), on("Basis", ["id"])),
	contained(on("LevyLine", ["levy", "employeeRate"]), on("LevyRate", ["levy", "employeeRate"])),
	...mirrors(on("Employee", ["id"]), on("TaxProfile", ["employee"])),
	...mirrors(
		onWhere("PayLine", ["id"], eq(field("offCycle"), literal(true))),
		on("OffCycleReason", ["line"])
	),
	alternativeStatements,
	contained(
		on("Reissue", ["replaces"]),
		onWhere("PayRun", ["id"], eq(field("stage"), literal("voided")))
	),
	contained(
		onWhere("PayRun", ["id"], eq(field("stage"), literal("approved"))),
		on("Approval", ["run"])
	),
	contained(
		onWhere("Shift", ["employee", "week"], eq(field("status"), literal("approved"))),
		on("Timesheet", ["employee", "week"])
	),
	...mirrors(on("Assignment", ["employee", "during"]), on("Employment", ["employee", "during"])),
	contained(on("Leave", ["employee", "during"]), on("Employment", ["employee", "during"])),
	key(onWhere("Employment", ["employee", "during"], eq(field("basis"), literal("salaried")))),
	contained(
		on("Salary", ["employee", "during"]),
		onWhere("Employment", ["employee", "during"], eq(field("basis"), literal("salaried")))
	),
	contained(
		onWhere("Shift", ["employee", "during"], eq(field("status"), literal("approved"))),
		on("Employment", ["employee", "during"])
	),
	counted(on("Approver", ["employer"]), fin("Employer", "approvers")),
	check("AtLeastOneApprover", "Employer", ge(field("approvers"), literal(1n))),
	key(on("Reissue", ["replaces"])),
	key(onWhere("Deposit", ["line"], eq(field("remainder"), literal(true)))),
	counted(on("Deposit", ["line"]), fin("PayLine", "deposits")),
	check("AtMostFourDeposits", "PayLine", le(field("deposits"), literal(4n))),
	fold(
		fin("PayLine", "deposits"),
		"sum",
		on("Deposit", ["line", "amount"]),
		on("PayLine", ["id", "deposited"])
	),
	check("DepositsSumToNet", "PayLine", eq(field("deposited"), field("net"))),
	check("NetWithinGross", "PayLine", le(field("net"), field("gross"))),
	counted(on("Shift", ["employee", "week"]), fin("Timesheet", "shifts")),
	fold(
		fin("Timesheet", "shifts"),
		"sum",
		onWhere("Shift", ["employee", "week", "hours"], eq(field("status"), literal("approved"))),
		on("Timesheet", ["employee", "week", "approvedHours"])
	),
	check(
		"ApprovedHoursWithinCeiling",
		"Timesheet",
		le(field("approvedHours"), { kind: "base", arg: field("ceiling") })
	)
]

export const PayrollDesc: SchemaDesc = decodedSchema({
	name: "Payroll",
	relations: payrollRelations,
	statements: payrollStatements,
	extends: undefined
})

/** The Reporting level. RunTotal's definition is the runTotals IR below; the level carries it as its rules stage. */
const RunTotalDefinition = decodedQuery({
	kind: "rules",
	arms: [
		{
			vars: [
				{ id: "id", origin: { relation: "PayLine", field: "id" } },
				{ id: "run", origin: { relation: "PayLine", field: "run" } },
				{ id: "gross", origin: { relation: "PayLine", field: "gross" } },
				{ id: "net", origin: { relation: "PayLine", field: "net" } }
			],
			matches: [
				{
					source: { kind: "relation", name: "PayLine" },
					bindings: {
						id: { kind: "var", var: "id" },
						run: { kind: "var", var: "run" },
						gross: { kind: "var", var: "gross" },
						net: { kind: "var", var: "net" }
					}
				}
			],
			where: [],
			head: {
				run: { kind: "var", var: "run" },
				lines: { kind: "aggregate", fn: "count" },
				gross: { kind: "aggregate", fn: "sum", arg: { kind: "var", var: "gross" } },
				net: { kind: "aggregate", fn: "sum", arg: { kind: "var", var: "net" } }
			},
			interiors: [],
			attach: []
		}
	]
})

export const ReportingDesc: SchemaDesc = decodedSchema({
	name: "Reporting",
	extends: PayrollDesc,
	relations: [
		{
			kind: "derived",
			name: "RunTotal",
			level: 1,
			storage: "materialized",
			query: RunTotalDefinition
		}
	],
	statements: []
})

/** The fixture schemas owned, their law models compiled and their catalogs built, with this module. */
const payrollFixture = ownedFixture(PayrollDesc)

export const payrollModel = (): SchemaModel => new SchemaModel(payrollFixture, {})
