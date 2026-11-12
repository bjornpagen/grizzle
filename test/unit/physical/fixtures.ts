import * as Result from "#compiler/core/result.ts"
import type { ExprDesc, FieldDecl, FieldDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import type { IndexRequest } from "#compiler/ir/products.ts"
import { noLive } from "#compiler/live/notify.ts"
import { noTextDomainUses } from "#compiler/physical/ddl/domains.ts"
import {
	type InstallExtension,
	noCarriers,
	noCertificates,
	noContribution,
	noHolds
} from "#compiler/physical/install/extension.ts"
import { eq, key, on, onWhere, type SchemaDesc, textDesc } from "#test/support/fixtures/ir/desc.ts"

/** The local cluster's migration identity (scripts/pg/init.sh), which an installation names as its owner.
 *
 * Beside it, Ledger: one schema for the fresh-install compiler's tests that reaches every native object it installs. */
export const owner = "grizzle_dev"

/** An installer extension that contributes `requests` to the index engine, as the workload extension contributes its
 * programs' access paths. */
export const requesting = (requests: ReadonlyArray<IndexRequest>): InstallExtension => ({
	contribute: () => Result.ok({ ...noContribution, indexRequests: requests }),
	textDomainUses: noTextDomainUses,
	certifies: noCertificates,
	carriers: noCarriers,
	holds: noHolds,
	live: noLive
})

const value: ExprDesc = { kind: "value" }
const lit = (v: LiteralDesc): ExprDesc => ({ kind: "literal", value: v })
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
	prose: textDesc("^.*$", "su"),
	vector3: { kind: "vector", dimensions: 3 }
} as const satisfies Readonly<Record<string, FieldDesc>>

/** A field its caller writes. */
const c = (type: FieldDesc): FieldDecl<object> => ({ type, writing: { kind: "caller" } })

/** An integer field its sequence draws, GENERATED ALWAYS AS IDENTITY. */
const serial = (type: FieldDesc): FieldDecl<object> => ({ type, writing: { kind: "serial" } })

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
const Code: FieldDesc = textDesc("^[A-Z]{3}$", "u")

/** Every native object kind the fresh-install compiler installs outside spans: two rosters' domains and a closed
 * relation over both, with a text and contract payload, structural and contract domains, serial identities, a
 * candidate key, a mutable relation, a row CHECK, a key over a selected source, a containment into the closed relation
 * (a closed CHECK), a selected target (a constant law column, a generated composite unique and a deferred foreign key
 * ending in that column), money, floats, numeric(p, s), booleans and a vector. */
export const Ledger: SchemaDesc = {
	name: "Ledger",
	relations: [
		{ kind: "closed", name: "Currency", handles: ["Usd", "Eur"] },
		{ kind: "closed", name: "Purpose", handles: ["Payroll", "Refund"] },
		{
			kind: "closedRelation",
			name: "Settlement",
			fields: {
				currency: { kind: "closedId", roster: "Currency" },
				purpose: { kind: "closedId", roster: "Purpose" },
				code: Code,
				minor: Cents
			},
			key: ["currency", "purpose"],
			slots: [],
			rows: [
				{ currency: "Usd", purpose: "Payroll", code: "USD", minor: 100n },
				{ currency: "Eur", purpose: "Refund", code: "EUR", minor: 100n }
			]
		},
		{
			kind: "relation",
			name: "Account",
			fields: {
				id: serial(F.bigint),
				code: c(Code),
				currency: c({ kind: "closedId", roster: "Currency" }),
				opened: c(EpochDay)
			},
			primaryKey: ["id"]
		},
		{
			kind: "relation",
			name: "Entry",
			fields: {
				id: serial(F.integer),
				account: c(F.bigint),
				purpose: c({ kind: "closedId", roster: "Purpose" }),
				amount: c(Cents),
				refund: c(Refund),
				remainder: c(F.boolean),
				rate: c(Rate),
				fee: c(F.money),
				weight: c(F.real),
				score: c(F.double),
				ratio: c(F.numeric186),
				embedding: c(F.vector3),
				memo: c(F.prose)
			},
			primaryKey: ["id"]
		},
		{
			kind: "relation",
			name: "Rounding",
			fields: {
				currency: c({ kind: "closedId", roster: "Currency" }),
				purpose: c({ kind: "closedId", roster: "Purpose" }),
				minor: c(Cents)
			},
			primaryKey: ["currency"]
		},
		{
			kind: "relation",
			name: "Payout",
			fields: { entry: c(F.integer), purpose: c({ kind: "closedId", roster: "Purpose" }) },
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
		{ kind: "contained", left: on("Entry", ["account"]), right: on("Account", ["id"]) },
		{
			kind: "contained",
			left: on("Rounding", ["currency", "purpose"]),
			right: on("Settlement", ["currency", "purpose"])
		},
		{
			kind: "contained",
			left: on("Payout", ["entry"]),
			right: onWhere("Entry", ["id"], eq(field("purpose"), lit("Payroll")))
		},
		key(onWhere("Entry", ["account"], eq(field("remainder"), lit(true))))
	],
	extends: undefined
}
