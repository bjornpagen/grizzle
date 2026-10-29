/**
 * The golden capture's own schema histories: versions built with the public builders only, in the call forms both the
 * baseline and the working tree accept, so capture.ts drafts each one in either tree. They reach what the fixture
 * modules do not: candidate renames (a relation, a field, a login, two relations swapping names), a field's type
 * change, a closed type's handles reordered, added and removed, a residual law added to a schema, and a residual law
 * kept while only a participant's mutability changes and then only the roles that read its relation whole.
 */
import { closedId, pg, uuid } from "#compiler/public/fields.ts"
import {
	alternatives,
	closed,
	contained,
	login,
	mutable,
	on,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

/** One version of a history: its schema value and the logins its worlds declare. */
export interface ScenarioVersion {
	readonly schema: unknown
	readonly logins: ReadonlyArray<unknown>
}

const name = str.regex("^[a-z]{1,40}$")

/** A shop renamed and retyped step by step, with a login renamed and two relations that swap names. */
const renames = (): ReadonlyArray<ScenarioVersion> => {
	const v1Customer = relation("Customer", { id: uuid, name, code: pg.integer }, ["id"])
	const v1Order = relation("Order", { id: uuid, customer: uuid, cents: pg.bigint }, ["id"])
	const v1 = schema("golden_renames", { Customer: v1Customer, Order: v1Order }, [
		contained(on(v1Order, "customer"), on(v1Customer, "id"))
	])
	const v1Reader = role(v1, "reader", v1.relations)
	const v2Client = relation("Client", { id: uuid, name, code: pg.integer }, ["id"])
	const v2Order = relation("Order", { id: uuid, client: uuid, amount: pg.bigint }, ["id"])
	const v2 = schema("golden_renames", { Client: v2Client, Order: v2Order }, [
		contained(on(v2Order, "client"), on(v2Client, "id"))
	])
	const v2Reader = role(v2, "reader", v2.relations)
	const v3Client = relation("Client", { id: uuid, name, code: pg.bigint }, ["id"])
	const v3 = schema("golden_renames", { Client: v3Client, Order: v2Order }, [
		contained(on(v2Order, "client"), on(v3Client, "id"))
	])
	const v3Reader = role(v3, "reader", v3.relations)
	const v4Order = relation("Client", { id: uuid, client: uuid, amount: pg.bigint }, ["id"])
	const v4Client = relation("Order", { id: uuid, name, code: pg.bigint }, ["id"])
	const v4 = schema("golden_renames", { Client: v4Order, Order: v4Client }, [
		contained(on(v4Order, "client"), on(v4Client, "id"))
	])
	return [
		{ schema: v1, logins: [login(v1, "server", [v1Reader])] },
		{ schema: v2, logins: [login(v2, "backend", [v2Reader])] },
		{ schema: v3, logins: [login(v3, "backend", [v3Reader])] },
		{ schema: v4, logins: [] }
	]
}

/** A closed type whose handles are reordered and extended, then one removed. */
const enums = (): ReadonlyArray<ScenarioVersion> => {
	const at = (handles: readonly [string, ...Array<string>]): ScenarioVersion => {
		const Status = closed("Status", handles)
		const Ticket = relation("Ticket", { id: uuid, status: closedId(Status), title: name }, ["id"])
		return { schema: schema("golden_enums", { Status, Ticket }, []), logins: [] }
	}
	return [at(["Open", "Closed"]), at(["Closed", "Open", "Archived"]), at(["Open", "Archived"])]
}

/** A payment schema that gains a residual law (an alternatives choice over two arms), then loses an arm's field. */
const laws = (): ReadonlyArray<ScenarioVersion> => {
	const Plan = closed("Plan", ["Card", "Invoice"])
	const Payment = relation("Payment", { id: uuid, plan: closedId(Plan), cents: pg.bigint }, ["id"])
	const CardPayment = relation("CardPayment", { payment: uuid, last4: str.regex("^[0-9]{4}$") }, [
		"payment"
	])
	const InvoicePayment = relation("InvoicePayment", { payment: uuid, days: pg.integer }, [
		"payment"
	])
	const plain = schema("golden_laws", { Plan, Payment, CardPayment, InvoicePayment }, [])
	const lawful = schema("golden_laws", { Plan, Payment, CardPayment, InvoicePayment }, [
		alternatives(Payment, "plan", Plan, { Card: CardPayment, Invoice: InvoicePayment })
	])
	const ShortInvoice = relation("InvoicePayment", { payment: uuid }, ["payment"])
	const narrowed = schema(
		"golden_laws",
		{ Plan, Payment, CardPayment, InvoicePayment: ShortInvoice },
		[alternatives(Payment, "plan", Plan, { Card: CardPayment, Invoice: ShortInvoice })]
	)
	return [
		{ schema: plain, logins: [] },
		{ schema: lawful, logins: [] },
		{ schema: narrowed, logins: [] }
	]
}

/**
 * A residual law kept exactly as it is: first one of its arms becomes mutable (the law's triggers are rebuilt around its
 * function, with no validate file), then a login's role comes to read the law's relations whole (the law function's
 * witness keys change, and only the function is replaced).
 */
const lawSteps = (): ReadonlyArray<ScenarioVersion> => {
	const Plan = closed("Plan", ["Card", "Invoice"])
	const Payment = relation("Payment", { id: uuid, plan: closedId(Plan), cents: pg.bigint }, ["id"])
	const CardPayment = relation("CardPayment", { payment: uuid, last4: str.regex("^[0-9]{4}$") }, [
		"payment"
	])
	const InvoicePayment = relation("InvoicePayment", { payment: uuid, days: pg.integer }, [
		"payment"
	])
	const law = alternatives(Payment, "plan", Plan, { Card: CardPayment, Invoice: InvoicePayment })
	const fixed = schema("golden_law_steps", { Plan, Payment, CardPayment, InvoicePayment }, [law])
	const mutableArm = schema("golden_law_steps", { Plan, Payment, CardPayment, InvoicePayment }, [
		law,
		mutable(CardPayment)
	])
	const reader = role(mutableArm, "reader", mutableArm.relations)
	return [
		{ schema: fixed, logins: [] },
		{ schema: mutableArm, logins: [] },
		{ schema: mutableArm, logins: [login(mutableArm, "server", [reader])] }
	]
}

/** The scenarios by name, each built fresh. */
export const scenarios: ReadonlyArray<readonly [string, () => ReadonlyArray<ScenarioVersion>]> = [
	["renames", renames],
	["enums", enums],
	["laws", laws],
	["law-steps", lawSteps]
]
