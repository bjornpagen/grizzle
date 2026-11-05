import * as Result from "#compiler/core/result.ts"
import type { ExprDesc, FieldDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import type { IndexRequest } from "#compiler/ir/products.ts"
import { noTextDomainUses } from "#compiler/physical/ddl/domains.ts"
import { type InstallExtension, noContribution } from "#compiler/physical/install/extension.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { eq, key, on, onWhere, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import * as payroll from "#test/support/fixtures/ir/payroll.ts"
import * as queue from "#test/support/fixtures/ir/queue.ts"
import * as work from "#test/support/fixtures/ir/work.ts"

/** The local cluster's migration identity (scripts/pg/init.sh), which an installation names as its owner.
 *
 * Schemas for the fresh-install compiler's tests (): the language's examples
 * beside the IR fixtures of Work, the work queue and Payroll, plus one schema that reaches every native object the
 * fresh-install compiler installs. */
export const owner = "grizzle_dev"

/** An installer extension that contributes `requests` to the index engine, as the workload extension contributes its
 * programs' access paths. */
export const requesting = (requests: ReadonlyArray<IndexRequest>): InstallExtension => ({
	contribute: () => Result.ok({ ...noContribution, indexRequests: requests }),
	textDomainUses: noTextDomainUses
})

const value: ExprDesc = { kind: "value" }
const lit = (v: LiteralDesc): ExprDesc => ({ kind: "literal", value: v, type: undefined })
const field = (name: string): ExprDesc => ({ kind: "field", field: name })

const F = {
	uuid: { kind: "uuid" },
	smallint: { kind: "pg", type: "smallint" },
	integer: { kind: "pg", type: "integer" },
	bigint: { kind: "pg", type: "bigint" },
	real: { kind: "pg", type: "real" },
	double: { kind: "pg", type: "double precision" },
	money: { kind: "pg", type: "money" },
	boolean: { kind: "pg", type: "boolean" },
	numeric186: { kind: "numeric", precision: 18, scale: 6 },
	prose: { kind: "text", source: "^.*$", flags: "su" },
	serial: { kind: "serial", type: "serial" },
	bigserial: { kind: "serial", type: "bigserial" },
	vector3: { kind: "vector", dimensions: 3 }
} as const satisfies Readonly<Record<string, FieldDesc>>

/** A finite-language pattern, a regex pattern, the wildcard, and a contract bounding
 * length with charLength over a pattern. */
const State: FieldDesc = { kind: "text", source: "^(?:draft|published)$", flags: "u" }
const Slug: FieldDesc = { kind: "text", source: "^[a-z][a-z0-9-]*$", flags: "u" }
const Handle: FieldDesc = {
	kind: "contract",
	name: "Handle",
	base: { kind: "text", source: "^[a-z][a-z0-9-]*$", flags: "u" },
	predicate: {
		kind: "compare",
		op: "le",
		left: { kind: "compute", fn: "charLength", args: [value] },
		right: lit(1000)
	},
	facts: []
}

const Content: SchemaDesc = {
	name: "Content",
	relations: [
		{
			kind: "relation",
			name: "Article",
			fields: { id: F.uuid, state: State, slug: Slug, title: F.prose, handle: Handle },
			primaryKey: ["id"]
		}
	],
	statements: [],
	extends: undefined
}

/** Two primary keys, a foreign key, and the referencing-side index the containment justifies. */
const Accounts: SchemaDesc = {
	name: "Work",
	relations: [
		{
			kind: "relation",
			name: "Account",
			fields: { id: F.uuid, name: F.prose },
			primaryKey: ["id"]
		},
		{ kind: "relation", name: "Task", fields: { id: F.uuid, account: F.uuid }, primaryKey: ["id"] }
	],
	statements: [
		{
			kind: "contained",
			left: on("Task", ["account"]),
			right: on("Account", ["id"]),
			origin: undefined
		}
	],
	extends: undefined
}

/** Contracts over numeric types, a contract over a contract, serial identities. */
const Cents: FieldDesc = {
	kind: "contract",
	name: "Cents",
	base: F.bigint,
	predicate: { kind: "compare", op: "ge", left: value, right: lit(0n) },
	facts: []
}

const Rate: FieldDesc = {
	kind: "contract",
	name: "Rate",
	base: { kind: "numeric", precision: 7, scale: 6 },
	predicate: { kind: "between", arg: value, low: lit(0n), high: lit(1n) },
	facts: []
}

const Refund: FieldDesc = {
	kind: "contract",
	name: "Refund",
	base: Cents,
	predicate: { kind: "compare", op: "le", left: value, right: lit(100000n) },
	facts: []
}

const EpochDay: FieldDesc = {
	kind: "contract",
	name: "EpochDay",
	base: F.bigint,
	predicate: undefined,
	facts: []
}
const Code: FieldDesc = { kind: "text", source: "^[A-Z]{3}$", flags: "u" }

/** Every native object kind the fresh-install compiler installs outside spans: an enum with a text and contract payload,
 * structural and contract domains, serial identities, a candidate key, a mutable relation, a row CHECK, a capacity at
 * most one over a selected source, a containment into closed facts (a finite CHECK), a selected target (a constant law
 * column, a generated composite unique and a deferred foreign key ending in that column), money, floats, numeric(p, s),
 * booleans and a vector. */
export const Ledger: SchemaDesc = {
	name: "Ledger",
	relations: [
		{
			kind: "closed",
			name: "Currency",
			handles: ["Usd", "Eur"],
			payload: { code: Code, minor: Cents },
			facts: { Usd: { code: "USD", minor: 100n }, Eur: { code: "EUR", minor: 100n } }
		},
		{ kind: "closed", name: "Purpose", handles: ["Payroll", "Refund"], payload: {}, facts: {} },
		{
			kind: "relation",
			name: "Account",
			fields: {
				id: F.bigserial,
				code: Code,
				currency: { kind: "closedId", roster: "Currency" },
				opened: EpochDay
			},
			primaryKey: ["id"]
		},
		{
			kind: "relation",
			name: "Entry",
			fields: {
				id: F.serial,
				account: F.bigint,
				purpose: { kind: "closedId", roster: "Purpose" },
				amount: Cents,
				refund: Refund,
				remainder: F.boolean,
				rate: Rate,
				fee: F.money,
				weight: F.real,
				score: F.double,
				ratio: F.numeric186,
				embedding: F.vector3,
				memo: F.prose
			},
			primaryKey: ["id"]
		},
		{
			kind: "relation",
			name: "Rounding",
			fields: { currency: { kind: "closedId", roster: "Currency" }, minor: Cents },
			primaryKey: ["currency"]
		},
		{
			kind: "relation",
			name: "Payout",
			fields: { entry: F.integer, purpose: { kind: "closedId", roster: "Purpose" } },
			primaryKey: ["entry"]
		}
	],
	statements: [
		key(on("Account", ["code"])),
		{ kind: "mutable", relation: "Entry" },
		{
			kind: "check",
			name: "RefundWithinAmount",
			relation: "Entry",
			predicate: {
				kind: "compare",
				op: "le",
				left: { kind: "base", arg: field("refund") },
				right: { kind: "base", arg: field("amount") }
			}
		},
		{
			kind: "contained",
			left: on("Entry", ["account"]),
			right: on("Account", ["id"]),
			origin: undefined
		},
		{
			kind: "contained",
			left: on("Rounding", ["currency", "minor"]),
			right: on("Currency", ["id", "minor"]),
			origin: undefined
		},
		{
			kind: "contained",
			left: on("Payout", ["entry"]),
			right: onWhere("Entry", ["id"], eq(field("purpose"), lit("Payroll"))),
			origin: undefined
		},
		{
			kind: "capacity",
			target: on("Account", ["id"]),
			from: onWhere("Entry", ["account"], eq(field("remainder"), lit(true))),
			within: { low: 0n, high: 1n },
			weight: { kind: "count" }
		}
	],
	extends: undefined
}

/** Money constants in persistent expressions: a contract over money whose domain CHECK compares VALUE with
 * money literals, a row CHECK comparing a money column with a literal, and an at-most-one capacity selected on a money
 * field, whose selection holds a money literal. Each literal is folded at DDL time, so none depends on the writing
 * session's lc_monetary. */
const Fee: FieldDesc = {
	kind: "contract",
	name: "Fee",
	base: F.money,
	predicate: {
		kind: "between",
		arg: value,
		low: lit(Money.of(100n)),
		high: lit(Money.of(100000n))
	},
	facts: []
}

export const Charges: SchemaDesc = {
	name: "Charges",
	relations: [
		{ kind: "relation", name: "Account", fields: { id: F.uuid }, primaryKey: ["id"] },
		{
			kind: "relation",
			name: "Charge",
			fields: { id: F.uuid, account: F.uuid, fee: Fee, surcharge: F.money },
			primaryKey: ["id"]
		}
	],
	statements: [
		{
			kind: "check",
			name: "SurchargeNotPenny",
			relation: "Charge",
			predicate: { kind: "compare", op: "ne", left: field("surcharge"), right: lit(Money.of(1n)) }
		},
		{
			kind: "capacity",
			target: on("Account", ["id"]),
			from: onWhere("Charge", ["account"], eq(field("fee"), lit(Money.of(125n)))),
			within: { low: 0n, high: 1n },
			weight: { kind: "count" }
		}
	],
	extends: undefined
}

/** The examples' fixtures, each a schema the fresh-install compiler installs completely or with its residual laws
 * deferred. */
export const fixtures: ReadonlyArray<{ readonly name: string; readonly desc: SchemaDesc }> = [
	{ name: "Work", desc: work.WorkDesc },
	{ name: "Plans", desc: work.PlansDesc },
	{ name: "Queue", desc: queue.Queue },
	{ name: "Payroll", desc: payroll.PayrollDesc },
	{ name: "Content", desc: Content },
	{ name: "Accounts", desc: Accounts },
	{ name: "Ledger", desc: Ledger },
	{ name: "Charges", desc: Charges }
]
