/**
 * The payroll ledger fixture in IR form: the Payroll schema and its Reporting extension as SchemaDescs, the
 * workload queries and the query members of its ChangeSets as checked relational IR, and the declarations the compiler
 * refuses.
 */
import { Array as Arr, Record as Rec } from "effect"
import { ALLEN } from "#compiler/allen/mask.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { SchemaDesc } from "#compiler/ir/desc.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import { numericValue } from "#compiler/scalar/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import { asc, type BuiltQuery, Ir, keyed, SchemaModel } from "#test/support/fixtures/ir/build.ts"
import {
	type SchemaDesc as AuthoredSchemaDesc,
	type AuthoredStatementDesc,
	alternatives,
	betweenExpr,
	capacity,
	charLength,
	check,
	closed,
	closedWith,
	contained,
	decodedQuery,
	decodedSchema,
	f,
	field,
	ge,
	key,
	le,
	literal,
	mirrors,
	mutable,
	ne,
	on,
	onSelected,
	relation,
	value,
	within
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
const Levy = closedWith(
	"Levy",
	["SocialSecurity", "Medicare", "Futa"],
	{ employeeRate: Rate, employerRate: Rate },
	{
		SocialSecurity: { employeeRate: dec("0.062"), employerRate: dec("0.062") },
		Medicare: { employeeRate: dec("0.0145"), employerRate: dec("0.0145") },
		Futa: { employeeRate: dec("0"), employerRate: dec("0.006") }
	}
)

/** The relations. */
const Employer = relation("Employer", { id: f.uuid, ein: Ein, name: LegalName }, ["id"])
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

const Timesheet = relation("Timesheet", { employee: f.uuid, week: Week, ceiling: Micros }, [
	"employee",
	"week"
])

const Shift = relation(
	"Shift",
	{
		employee: f.uuid,
		during: f.span(Instant, undefined),
		week: Week,
		status: f.closedId("ShiftStatus")
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
const PayLine = relation(
	"PayLine",
	{ id: f.uuid, run: f.uuid, employee: f.uuid, gross: Cents, net: Cents, offCycle: f.boolean },
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
 * source); and scalar-group capacity.
 */
const payrollStatements: ReadonlyArray<AuthoredStatementDesc> = [
	key("Employer", ["ein"]),
	key("Employee", ["employer", "code"]),
	key("PayLine", ["run", "employee"]),
	key("Posting", ["line", "account"]),
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
	contained(on("LevyLine", ["levy", "employeeRate"]), on("Levy", ["id", "employeeRate"])),
	mirrors(on("Employee", ["id"]), on("TaxProfile", ["employee"])),
	mirrors(onSelected("PayLine", ["id"], { offCycle: true }), on("OffCycleReason", ["line"])),
	...alternativeStatements,
	contained(on("Reissue", ["replaces"]), onSelected("PayRun", ["id"], { stage: "voided" })),
	contained(onSelected("PayRun", ["id"], { stage: "approved" }), on("Approval", ["run"])),
	contained(
		onSelected("Shift", ["employee", "week"], { status: "approved" }),
		on("Timesheet", ["employee", "week"])
	),
	mirrors(on("Assignment", ["employee", "during"]), on("Employment", ["employee", "during"])),
	contained(on("Leave", ["employee", "during"]), on("Employment", ["employee", "during"])),
	contained(
		on("Salary", ["employee", "during"]),
		onSelected("Employment", ["employee", "during"], { basis: "salaried" })
	),
	contained(
		onSelected("Shift", ["employee", "during"], { status: "approved" }),
		on("Employment", ["employee", "during"])
	),
	capacity(on("Employer", ["id"]), on("Approver", ["employer"]), within(1n, "*"), {
		kind: "count"
	}),
	capacity(on("PayRun", ["id"]), on("Reissue", ["replaces"]), within(0n, 1n), { kind: "count" }),
	capacity(
		on("PayLine", ["id"]),
		onSelected("Deposit", ["line"], { remainder: true }),
		within(0n, 1n),
		{
			kind: "count"
		}
	),
	capacity(on("PayLine", ["id"]), on("Deposit", ["line"]), within(0n, 4n), { kind: "count" }),
	capacity(on("PayLine", ["id"]), on("Deposit", ["line"]), within("net", "net"), {
		kind: "field",
		field: "amount"
	}),
	capacity(on("PayLine", ["id"]), on("PayLine", ["id"]), within(0n, "gross"), {
		kind: "field",
		field: "net"
	}),
	capacity(
		on("Timesheet", ["employee", "week"]),
		onSelected("Shift", ["employee", "week"], { status: "approved" }),
		within(0n, "ceiling"),
		{ kind: "duration", field: "during" }
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
	name: "Payroll",
	extends: PayrollDesc,
	relations: [{ kind: "derived", name: "RunTotal", level: 1, query: RunTotalDefinition }],
	statements: []
})

/** The fixture schemas owned, their law models compiled and their catalogs built, with this module. */
const payrollFixture = ownedFixture(PayrollDesc)
const reportingFixture = ownedFixture(ReportingDesc)

export const payrollModel = (): SchemaModel => new SchemaModel(payrollFixture, {})

/**
 * RunTotal's inferred fields, run: uuid, lines: pg.bigint, gross and net: sums of bigint cents, computed numerics of
 * a bigint's digits widened by the rows'; its key ["run"].
 */
const reportingModel = (): SchemaModel => {
	const base = payrollModel()
	const numeric = numericValue({ digits: 38, scale: 0 })
	return new SchemaModel(reportingFixture, {
		RunTotal: {
			fields: [
				["run", base.type("PayLine", "run")],
				["lines", base.fieldType(f.bigint, SourceLoc("RunTotal.lines", []))],
				["gross", numeric],
				["net", numeric]
			],
			key: ["run"]
		}
	})
}

/**
 * Declarations the compiler refuses, each as the Reporting schema with the offending declaration
 * added, the reason the harness asserts, and the pass that refuses it: ownership (packages/engine/src/schema/own.ts) checks
 * keys, levels and identities; law recognition refuses the families the first compiler does not admit, over
 * a schema ownership admits, since both declarations typecheck.
 */
interface Refusal {
	readonly name: string
	readonly schema: AuthoredSchemaDesc
	readonly reason:
		| "UnrepresentableKey"
		| "UnsupportedLawFamily"
		| "LawOnDerived"
		| "DuplicateIdentity"
	readonly refusedBy: "ownership" | "law recognition"
}

const withStatement = (s: AuthoredStatementDesc): AuthoredSchemaDesc => ({
	...ReportingDesc,
	statements: [...ReportingDesc.statements, s]
})

export const refusals: ReadonlyArray<Refusal> = [
	{
		name: "an unbounded text key",
		schema: {
			...ReportingDesc,
			relations: [...ReportingDesc.relations, relation("Note", { body: Memo }, ["body"])]
		},
		reason: "UnrepresentableKey",
		refusedBy: "ownership"
	},
	{
		name: "pointwise capacity",
		schema: withStatement(
			capacity(
				on("Employment", ["employee", "during"]),
				on("Shift", ["employee", "during"]),
				within(0n, 1n),
				{
					kind: "count"
				}
			)
		),
		reason: "UnsupportedLawFamily",
		refusedBy: "law recognition"
	},
	{
		name: "coverage into a target without a span key",
		schema: withStatement(contained(on("Shift", ["during"]), on("PayRun", ["period"]))),
		reason: "UnsupportedLawFamily",
		refusedBy: "law recognition"
	},
	{
		name: "a key on a derived relation",
		schema: withStatement(key("RunTotal", ["run"])),
		reason: "LawOnDerived",
		refusedBy: "ownership"
	},
	{
		name: "mutable on a derived relation",
		schema: withStatement(mutable("RunTotal")),
		reason: "LawOnDerived",
		refusedBy: "ownership"
	}
]

/**
 * The line, its person as a bare fact by containment evidence, deposits as an ordered list, levies
 * as a set in no order, the off-cycle reason as an Option by its key.
 */
const payslip = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const m = q.region(
		[
			{
				source: q.base("PayLine"),
				bind: {
					id: "id",
					run: "run",
					employee: "employee",
					gross: "gross",
					net: "net",
					offCycle: "offCycle"
				},
				constants: {}
			}
		],
		conservativeMeta
	)
	const filtered = q.filter(
		m,
		q.eq(q.col(m, "id"), q.param("line", q.column(m, "id").type, "compare"))
	)
	const parent = q.project(
		filtered,
		[
			["id", "id"],
			["run", "run"],
			["employee", "employee"],
			["gross", "gross"],
			["net", "net"],
			["offCycle", "offCycle"]
		],
		keyed([["id"]], "many")
	)
	const person = q.project(
		q.region(
			[
				{
					source: q.base("Employee"),
					bind: { id: "id", code: "code", name: "name" },
					constants: {}
				}
			],
			conservativeMeta
		),
		[
			["id", "id"],
			["code", "code"],
			["name", "name"]
		],
		keyed([["id"]], "one")
	)
	const deposits = q.project(
		q.region(
			[
				{
					source: q.base("Deposit"),
					bind: { line: "line", account: "account", amount: "amount", remainder: "remainder" },
					constants: {}
				}
			],
			conservativeMeta
		),
		[
			["line", "line"],
			["account", "account"],
			["amount", "amount"],
			["remainder", "remainder"]
		],
		keyed([["line", "account"]], "many")
	)
	const levies = q.project(
		q.region(
			[
				{
					source: q.base("LevyLine"),
					bind: { line: "line", levy: "levy", employeeRate: "employeeRate", withheld: "withheld" },
					constants: {}
				}
			],
			conservativeMeta
		),
		[
			["line", "line"],
			["levy", "levy"],
			["employeeRate", "employeeRate"],
			["withheld", "withheld"]
		],
		keyed([["line", "levy"]], "many")
	)
	const reason = q.project(
		q.region(
			[
				{
					source: q.base("OffCycleReason"),
					bind: { line: "line", reason: "reason" },
					constants: {}
				}
			],
			conservativeMeta
		),
		[
			["line", "line"],
			["reason", "reason"]
		],
		keyed([["line"]], "many")
	)
	const withPerson = q.attach(parent, person, "person", [["employee", "id"]], "one", undefined)
	const withDeposits = q.attach(
		withPerson,
		deposits,
		"deposits",
		[["id", "line"]],
		"array",
		asc("account")
	)
	const withLevies = q.attach(withDeposits, levies, "levies", [["id", "line"]], "array", undefined)
	return q.build(
		q.attach(withLevies, reason, "offCycleReason", [["id", "line"]], "option", undefined)
	)
}

/** The profile and the manager, each an Option by its key. */
const employeeCard = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const employee = q.base("Employee")
	const m = q.region(
		[
			{
				source: employee,
				bind: { id: "id", code: "code", name: "name" },
				constants: { employer: q.param("employer", q.column(employee, "employer").type, "compare") }
			}
		],
		conservativeMeta
	)
	const parent = q.project(
		m,
		[
			["id", "id"],
			["code", "code"],
			["name", "name"]
		],
		keyed([["id"]], "many")
	)
	const profile = q.project(
		q.region(
			[
				{
					source: q.base("TaxProfile"),
					bind: { employee: "employee", filing: "filing", extra: "extra" },
					constants: {}
				}
			],
			conservativeMeta
		),
		[
			["employee", "employee"],
			["filing", "filing"],
			["extra", "extra"]
		],
		keyed([["employee"]], "many")
	)
	const manager = q.project(
		q.region(
			[
				{
					source: q.base("ReportsTo"),
					bind: { employee: "employee", manager: "manager" },
					constants: {}
				}
			],
			conservativeMeta
		),
		[
			["employee", "employee"],
			["manager", "manager"]
		],
		keyed([["employee"]], "many")
	)
	const withProfile = q.attach(
		parent,
		profile,
		"profile",
		[["id", "employee"]],
		"option",
		undefined
	)
	return q.build(
		q.attach(withProfile, manager, "manager", [["id", "employee"]], "option", undefined)
	)
}

/** What a stage carries beside its runs: nothing, or the payload of an arm relation keyed by run. */
type StagePayload =
	| { readonly kind: "none" }
	| { readonly kind: "arm"; readonly relation: string; readonly fields: ReadonlyArray<string> }

/** One stage arm of runStages: the employer's runs in `stage`, matched with the arm relation's payload. */
const stageArm = (q: Ir, stage: string, payload: StagePayload) => {
	const fields = payload.kind === "arm" ? payload.fields : []
	const run = q.base("PayRun")
	const occurrences = [
		{
			source: run,
			bind: { id: "id" },
			constants: {
				employer: q.param("employer", q.column(run, "employer").type, "compare"),
				stage: q.litFor(run, "stage", stage)
			}
		},
		...(payload.kind === "none"
			? []
			: [
					{
						source: q.base(payload.relation),
						bind: Rec.fromEntries([
							["run", "id"] as const,
							...Arr.map(payload.fields, (x) => [x, x] as const)
						]),
						constants: {}
					}
				])
	]
	const m = q.region(occurrences, conservativeMeta)
	return q.project(
		m,
		[
			["id", "id"],
			["stage", q.lit(stage, q.column(run, "stage").type)],
			...Arr.map(fields, (x) => [x, x] as const)
		],
		conservativeMeta
	)
}

/** Four heading groups, one statement each, never a padded union. */
const runStages = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	return q.build(
		q.union(
			[
				stageArm(q, "draft", { kind: "none" }),
				stageArm(q, "approved", { kind: "arm", relation: "Approval", fields: ["approver", "at"] }),
				stageArm(q, "paid", { kind: "arm", relation: "Payment", fields: ["settled"] }),
				stageArm(q, "voided", { kind: "arm", relation: "Voiding", fields: ["reason"] })
			],
			["stage"],
			conservativeMeta
		)
	)
}

/** The postings of a run with their line's run bound: the body ledger and ledgerBalance share. */
const runPostings = (q: Ir, bind: Readonly<Record<string, string>>): RelNode => {
	const m = q.region(
		[
			{ source: q.base("Posting"), bind, constants: {} },
			{ source: q.base("PayLine"), bind: { id: "line", run: "run" }, constants: {} }
		],
		conservativeMeta
	)
	return q.filter(m, q.eq(q.col(m, "run"), q.param("run", q.column(m, "run").type, "compare")))
}

/** The ledger of a run in entry order. */
const ledger = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const filtered = runPostings(q, {
		entry: "entry",
		line: "line",
		account: "account",
		side: "side",
		amount: "amount"
	})
	const rows = q.project(
		filtered,
		[
			["entry", "entry"],
			["line", "line"],
			["account", "account"],
			["side", "side"],
			["amount", "amount"]
		],
		keyed([["entry"]], "many")
	)
	return q.build(q.ordered(rows, asc("entry")))
}

/**
 * Entry is bound although the head omits it, so every posting contributes; each conditional sum is
 * sum(CASE WHEN ... THEN amount ELSE 0 END), never a FILTER sum.
 */
const ledgerBalance = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const filtered = runPostings(q, { entry: "entry", line: "line", side: "side", amount: "amount" })
	const sideType = q.column(filtered, "side").type
	const amountBase = baseOf(q.column(filtered, "amount").type)
	const conditional = (side: string): ScalarExpr =>
		q.cond(
			q.eq(q.col(filtered, "side"), q.lit(side, sideType)),
			q.cast(q.col(filtered, "amount"), amountBase),
			q.lit(0n, amountBase)
		)
	return q.build(
		q.group(
			filtered,
			["entry", "line", "side", "amount", "run"],
			[],
			[
				{ name: "debits", agg: "sum", arg: conditional("debit") },
				{ name: "credits", agg: "sum", arg: conditional("credit") }
			],
			keyed([[]], "atMostOne")
		)
	)
}

/**
 * Salary segments that share a point with the run's period and cover neither way, the mask
 * ALLEN.overlaps | ALLEN.overlappedBy from the shipped table.
 */
const splitSegments = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const m = q.region(
		[
			{
				source: q.base("PayRun"),
				bind: { id: "run", employer: "employer", period: "period" },
				constants: {}
			},
			{ source: q.base("Employee"), bind: { id: "employee", employer: "employer" }, constants: {} },
			{
				source: q.base("Salary"),
				bind: { employee: "employee", during: "during", annual: "annual" },
				constants: {}
			}
		],
		conservativeMeta
	)
	const pred = q.op("and", [
		q.eq(q.col(m, "run"), q.param("run", q.column(m, "run").type, "compare")),
		q.allen(q.col(m, "during"), ALLEN.overlaps | ALLEN.overlappedBy, q.col(m, "period"))
	])
	return q.build(
		q.project(
			q.filter(m, pred),
			[
				["employee", "employee"],
				["during", "during"],
				["annual", "annual"]
			],
			conservativeMeta
		)
	)
}

/**
 * Gross times the roster's rate, rounded half away from zero, back into Cents; its head is
 * LevyLine's heading, so it is the insert member of withhold.
 */
const withholdingFor = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const line = q.base("PayLine")
	const levy = q.closed("Levy")
	const m = q.region(
		[
			{
				source: line,
				bind: { id: "id", gross: "gross" },
				constants: { run: q.param("run", q.column(line, "run").type, "compare") }
			},
			{ source: levy, bind: { id: "levy", employeeRate: "employeeRate" }, constants: {} }
		],
		conservativeMeta
	)
	const numeric = numericValue({ digits: 19, scale: 0 })
	const rate = q.column(m, "employeeRate").type
	const withheld = q.domainCast(
		q.op("round", [
			q.op("mul", [
				q.cast(q.col(m, "gross"), numeric),
				q.cast(q.col(m, "employeeRate"), baseOf(rate))
			])
		]),
		q.model.type("LevyLine", "withheld")
	)
	return q.build(
		q.project(
			m,
			[
				["line", "id"],
				["levy", "levy"],
				["employeeRate", "employeeRate"],
				["withheld", withheld]
			],
			conservativeMeta
		)
	)
}

/**
 * Everyone below a manager through any number of levels; the state is the employee alone, so the
 * closure terminates on a cycle.
 */
const orgOf = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const uuid = q.model.type("ReportsTo", "employee")
	const baseReports = q.base("ReportsTo")
	const base = q.project(
		q.region(
			[
				{
					source: baseReports,
					bind: { employee: "employee" },
					constants: {
						manager: q.param("manager", q.column(baseReports, "manager").type, "compare")
					}
				}
			],
			conservativeMeta
		),
		[["employee", "employee"]],
		conservativeMeta
	)
	const org = q.recursive("Org", [["employee", uuid]], base, (self) =>
		q.project(
			q.region(
				[
					{ source: self, bind: { employee: "middle" }, constants: {} },
					{
						source: q.base("ReportsTo"),
						bind: { employee: "employee", manager: "middle" },
						constants: {}
					}
				],
				conservativeMeta
			),
			[["employee", "employee"]],
			conservativeMeta
		)
	)
	return q.build(
		q.project(
			q.region([{ source: org, bind: { employee: "employee" }, constants: {} }], conservativeMeta),
			[["employee", "employee"]],
			conservativeMeta
		)
	)
}

/** The same answer for at most two levels, as connected matches. */
const withinTwo = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const one = (() => {
		const reports = q.base("ReportsTo")
		return q.project(
			q.region(
				[
					{
						source: reports,
						bind: { employee: "employee" },
						constants: { manager: q.param("manager", q.column(reports, "manager").type, "compare") }
					}
				],
				conservativeMeta
			),
			[["employee", "employee"]],
			conservativeMeta
		)
	})()
	const two = (() => {
		const upper = q.base("ReportsTo")
		return q.project(
			q.region(
				[
					{
						source: upper,
						bind: { employee: "middle" },
						constants: { manager: q.param("manager", q.column(upper, "manager").type, "compare") }
					},
					{
						source: q.base("ReportsTo"),
						bind: { employee: "employee", manager: "middle" },
						constants: {}
					}
				],
				conservativeMeta
			),
			[["employee", "employee"]],
			conservativeMeta
		)
	})()
	return q.build(q.union([one, two], [], conservativeMeta))
}

/** RunTotal's definition; the rule binds id, PayLine's key, so every binding is one line. */
const runTotals = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const m = q.region(
		[
			{
				source: q.base("PayLine"),
				bind: { id: "id", run: "run", gross: "gross", net: "net" },
				constants: {}
			}
		],
		conservativeMeta
	)
	return q.build(
		q.group(
			m,
			["id", "run", "gross", "net"],
			["run"],
			[
				{ name: "lines", agg: "count" },
				{ name: "gross", agg: "sum", arg: q.col(m, "gross") },
				{ name: "net", agg: "sum", arg: q.col(m, "net") }
			],
			conservativeMeta
		)
	)
}

/** An at-most-one query by the inherited key. */
const runTotalOf = (): BuiltQuery => {
	const q = new Ir(reportingModel())
	const totals = q.base("RunTotal")
	const m = q.region(
		[
			{
				source: totals,
				bind: { lines: "lines", gross: "gross", net: "net" },
				constants: { run: q.param("run", q.column(totals, "run").type, "compare") }
			}
		],
		conservativeMeta
	)
	return q.build(
		q.project(
			m,
			[
				["lines", "lines"],
				["gross", "gross"],
				["net", "net"]
			],
			conservativeMeta
		)
	)
}

/** Employees of an employer by name prefix, two comparisons against a prefix's code-point interval. */
const employeesByPrefix = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const employee = q.base("Employee")
	const m = q.region(
		[
			{
				source: employee,
				bind: { id: "id", code: "code", name: "name" },
				constants: { employer: q.param("employer", q.column(employee, "employer").type, "compare") }
			}
		],
		conservativeMeta
	)
	const nameType = q.column(m, "name").type
	const pred = q.op("and", [
		q.op("ge", [q.col(m, "name"), q.param("lo", nameType, "compare")]),
		q.op("lt", [q.col(m, "name"), q.param("hi", nameType, "compare")])
	])
	return q.build(
		q.project(
			q.filter(m, pred),
			[
				["id", "id"],
				["code", "code"],
				["name", "name"]
			],
			conservativeMeta
		)
	)
}

/**
 * ApproveShifts' put member, the pending shifts of one employee and week made approved. A ChangeSet's query member's
 * rows are the facts it requests.
 */
const approveShiftsMember = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const shift = q.base("Shift")
	const m = q.region(
		[
			{
				source: shift,
				bind: { during: "during" },
				constants: {
					employee: q.param("employee", q.column(shift, "employee").type, "compare"),
					week: q.param("week", q.column(shift, "week").type, "compare"),
					status: q.litFor(shift, "status", "pending")
				}
			}
		],
		conservativeMeta
	)
	return q.build(
		q.project(
			m,
			[
				["employee", q.param("employee", q.column(shift, "employee").type, "emit")],
				["during", "during"],
				["week", q.param("week", q.column(shift, "week").type, "emit")],
				["status", q.lit("approved", q.column(shift, "status").type)]
			],
			conservativeMeta
		)
	)
}

/** Withhold's Posting member, three arms with distinct literal accounts and no entry. */
const postingMember = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const arm = (
		account: string,
		side: string,
		amount: (m: RelNode) => ScalarExpr,
		bind: Readonly<Record<string, string>>
	) => {
		const line = q.base("PayLine")
		const m = q.region(
			[
				{
					source: line,
					bind: { id: "id", ...bind },
					constants: { run: q.param("run", q.column(line, "run").type, "compare") }
				}
			],
			conservativeMeta
		)
		return q.project(
			m,
			[
				["line", "id"],
				["account", q.lit(account, q.model.type("Posting", "account"))],
				["side", q.lit(side, q.model.type("Posting", "side"))],
				["amount", amount(m)]
			],
			conservativeMeta
		)
	}
	return q.build(
		q.union(
			[
				arm("GrossWages", "debit", (m) => q.col(m, "gross"), { gross: "gross" }),
				arm("NetPay", "credit", (m) => q.col(m, "net"), { net: "net" }),
				arm(
					"Withholding",
					"credit",
					(m) =>
						q.domainCast(
							q.op("sub", [q.col(m, "gross"), q.col(m, "net")]),
							q.model.type("Posting", "amount")
						),
					{ gross: "gross", net: "net" }
				)
			],
			[],
			conservativeMeta
		)
	)
}

/** Pay's put of PayRun, an arm switch from approved to paid, and its Payment member. */
const payPutMember = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const run = q.base("PayRun")
	const m = q.region(
		[
			{
				source: run,
				bind: { employer: "employer", period: "period" },
				constants: {
					id: q.param("run", q.column(run, "id").type, "compare"),
					stage: q.litFor(run, "stage", "approved")
				}
			}
		],
		conservativeMeta
	)
	return q.build(
		q.project(
			m,
			[
				["id", q.param("run", q.column(run, "id").type, "emit")],
				["employer", "employer"],
				["period", "period"],
				["stage", q.lit("paid", q.column(run, "stage").type)]
			],
			conservativeMeta
		)
	)
}

const payPaymentMember = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const run = q.base("PayRun")
	const m = q.region(
		[
			{
				source: run,
				constants: {
					id: q.param("run", q.column(run, "id").type, "compare"),
					stage: q.litFor(run, "stage", "approved")
				},
				bind: {}
			}
		],
		conservativeMeta
	)
	return q.build(
		q.project(
			m,
			[
				["run", q.param("run", q.column(run, "id").type, "emit")],
				["settled", q.param("now", q.model.type("Payment", "settled"), "emit")]
			],
			conservativeMeta
		)
	)
}

/** Reverse's three members, an arm switch from Payment to Voiding. */
const reversePutMember = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const run = q.base("PayRun")
	const m = q.region(
		[
			{
				source: run,
				bind: { employer: "employer", period: "period" },
				constants: {
					id: q.param("run", q.column(run, "id").type, "compare"),
					stage: q.litFor(run, "stage", "paid")
				}
			}
		],
		conservativeMeta
	)
	return q.build(
		q.project(
			m,
			[
				["id", q.param("run", q.column(run, "id").type, "emit")],
				["employer", "employer"],
				["period", "period"],
				["stage", q.lit("voided", q.column(run, "stage").type)]
			],
			conservativeMeta
		)
	)
}

const reverseDeleteMember = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const payment = q.base("Payment")
	const m = q.region(
		[
			{
				source: payment,
				bind: { settled: "settled" },
				constants: { run: q.param("run", q.column(payment, "run").type, "compare") }
			}
		],
		conservativeMeta
	)
	return q.build(
		q.project(
			m,
			[
				["run", q.param("run", q.column(payment, "run").type, "emit")],
				["settled", "settled"]
			],
			conservativeMeta
		)
	)
}

const reverseVoidingMember = (): BuiltQuery => {
	const q = new Ir(payrollModel())
	const run = q.base("PayRun")
	const m = q.region(
		[
			{
				source: run,
				constants: {
					id: q.param("run", q.column(run, "id").type, "compare"),
					stage: q.litFor(run, "stage", "paid")
				},
				bind: {}
			}
		],
		conservativeMeta
	)
	return q.build(
		q.project(
			m,
			[
				["run", q.param("run", q.column(run, "id").type, "emit")],
				["reason", q.param("reason", q.model.type("Voiding", "reason"), "emit")]
			],
			conservativeMeta
		)
	)
}

/** The payroll example's queries as checked relational IR, by the name of the program each one states. */
export const payrollQueries = {
	payslip,
	employeeCard,
	runStages,
	ledger,
	ledgerBalance,
	splitSegments,
	withholdingFor,
	orgOf,
	withinTwo,
	runTotals,
	runTotalOf,
	employeesByPrefix,
	approveShiftsMember,
	postingMember,
	payPutMember,
	payPaymentMember,
	reversePutMember,
	reverseDeleteMember,
	reverseVoidingMember
} as const satisfies Readonly<Record<string, () => BuiltQuery>>
