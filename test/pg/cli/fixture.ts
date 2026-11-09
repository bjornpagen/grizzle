import { ChangeSet } from "#compiler/public/changeset.ts"
import { closedId, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	alternatives,
	closed,
	contained,
	context,
	derived,
	login,
	mutable,
	on,
	relation,
	role,
	schema,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"

const customerName = str.regex("^[a-z]{1,40}$")

/**
 * The programs the shop's login owns in its workload: both, ordersOf alone once customersByName is removed, or none.
 */
export type ShopWorkload = "full" | "withoutByName" | "none"

const Order = relation("Order", { id: uuid, customer: uuid, cents: pg.bigint }, ["id"])

/**
 * The shop schema under `name` at version 1, Customer(id, name), its login owning the workload `programs` names. Each
 * call builds a schema of its own: a schema and its login are read from one call.
 */
export const shopV1 = (name: string, programs: ShopWorkload) => {
	const Customer = relation("Customer", { id: uuid, name: customerName }, ["id"])
	const s = schema(name, { Customer, Order }, [
		contained(on(Order, "customer"), on(Customer, "id"))
	])
	const reader = role(s, "reader", wholeEntriesOf(s))
	const writer = role(s, "writer", wholeEntriesOf(s), { write: writableNamesOf(s) })
	/** A customer by name: an equality lookup on a bounded text field, which drafts `customer__ix__name`. */
	const customersByName = query(s).rule((r) => {
		const c = v(Customer, "customer")
		return r
			.match(Customer, { id: c.id, name: c.name })
			.where(r.eq(c.name, r.param("name", Customer.fields.name)))
			.find({ id: c.id, name: c.name })
	})
	/** A customer's orders: served by the foreign key's reverse index, which law maintenance already requests. */
	const ordersOf = query(s).rule((r) => {
		const o = v(Order, "order")
		return r
			.match(Order, { id: o.id, customer: o.customer, cents: o.cents })
			.where(r.eq(o.customer, r.param("customer", uuid)))
			.find({ id: o.id, cents: o.cents })
	})
	const owned =
		programs === "full"
			? [workload(s, { customersByName, ordersOf })]
			: programs === "withoutByName"
				? [workload(s, { ordersOf })]
				: []
	return {
		schema: s,
		reader,
		writer,
		server: login(s, "server", [reader, writer], {
			workload: [
				workload(s, { customer: Customer }),
				workload(writer, { addCustomer: ChangeSet.empty(writer).insert(Customer, []) }),
				...owned
			]
		}),
		Customer,
		Order,
		customersByName,
		ordersOf
	}
}

/**
 * The shop schema under `name` at version 2, Customer(id, name, tier), its login owning the workload `programs` names.
 * Each call builds a schema of its own: a schema and its login are read from one call.
 */
export const shopV2 = (name: string, programs: ShopWorkload) => {
	const Customer = relation("Customer", { id: uuid, name: customerName, tier: pg.integer }, ["id"])
	const s = schema(name, { Customer, Order }, [
		contained(on(Order, "customer"), on(Customer, "id"))
	])
	const reader = role(s, "reader", wholeEntriesOf(s))
	const writer = role(s, "writer", wholeEntriesOf(s), { write: writableNamesOf(s) })
	const customersByName = query(s).rule((r) => {
		const c = v(Customer, "customer")
		return r
			.match(Customer, { id: c.id, name: c.name })
			.where(r.eq(c.name, r.param("name", Customer.fields.name)))
			.find({ id: c.id, name: c.name })
	})
	const ordersOf = query(s).rule((r) => {
		const o = v(Order, "order")
		return r
			.match(Order, { id: o.id, customer: o.customer, cents: o.cents })
			.where(r.eq(o.customer, r.param("customer", uuid)))
			.find({ id: o.id, cents: o.cents })
	})
	const owned =
		programs === "full"
			? [workload(s, { customersByName, ordersOf })]
			: programs === "withoutByName"
				? [workload(s, { ordersOf })]
				: []
	return {
		schema: s,
		reader,
		writer,
		server: login(s, "server", [reader, writer], {
			workload: [
				workload(s, { customer: Customer }),
				workload(writer, { addCustomer: ChangeSet.empty(writer).insert(Customer, []) }),
				...owned
			]
		}),
		Customer,
		Order,
		customersByName,
		ordersOf
	}
}

/**
 * The schemas the CLI tests migrate, built by the typed public builders under a name the test
 * chooses: logins and roles are cluster-wide, so every test installs its schema under a unique name. A test's
 * grizzle.config.ts imports `shop` and calls it with that name and the workload its login owns, and the test calls
 * `shopV1` or `shopV2` with the same arguments for an equal schema value and its worlds, whose login's layer is given
 * the committed snapshot. The same arguments build equal values, so the configuration's schema and logins and the
 * test's agree. Every schema's worlds are full roles in the login `server`, which owns the workload: `reader`,
 * which writes nothing, and `writer`, which writes every stored relation, so a program over the schema runs on either;
 * the ledger adds `refresher`, which refreshes its derived relation.
 *
 * A small shop. Customer has a bounded name, so an equality lookup on it is a representable
 * access path; Order references Customer. Version 2 adds Customer.tier, a field that needs a reviewer's value for the
 * existing rows. The full workload looks customers up by name, which drafts `customer__ix__name`; its
 * ordersOf program is a lookup the foreign key's own index already serves.
 *
 * Besides the programs its configuration names, every fixture's login serves the round trip the CLI suites make through
 * the served file `grizzle generate` writes: `customer`, a customer by its id, on every role, and `addCustomer`, the
 * writer's insert of the customers each call supplies. A key on the primary key and an insert draft no index, so they
 * change no folder a configuration drafts.
 *
 * And a ledger (`ledger`), whose generate output needs what a plain shop's does not. Payment's plan selects one of two
 * arm relations through `alternatives`, whose forward and reverse containments are native foreign keys, the reverse
 * deferred on the cycle with a generated law column per armed handle (fin.md §7); a derived relation CustomerSpend sums each
 * customer's payments into a materialized view; and the workload reads CustomerSpend by a range on its payment
 * count, an access path on a derived relation that drafts `customer_spend__ix__payments` on the view, beside a lookup
 * of customers by name.
 */
export type ShopV1 = ReturnType<typeof shopV1>
export type ShopV2 = ReturnType<typeof shopV2>

/** The shop under `name` at `version`, its login owning `programs`, as a grizzle.config.ts names it. */
export const shop = (name: string, version: 1 | 2, programs: ShopWorkload): ShopV1 | ShopV2 =>
	version === 1 ? shopV1(name, programs) : shopV2(name, programs)

/**
 * The ledger schema and its derived extension under `name`, its login owning its workload. Each call builds a schema of
 * its own: a schema and its login are read from one call.
 */
export const ledger = (name: string) => {
	const Plan = closed("Plan", ["Card", "Invoice"])
	const Customer = relation("Customer", { id: uuid, name: customerName }, ["id"])
	const Payment = relation(
		"Payment",
		{ id: uuid, customer: uuid, plan: closedId(Plan), cents: pg.bigint },
		["id"]
	)
	const CardPayment = relation("CardPayment", { payment: uuid, last4: str.regex("^[0-9]{4}$") }, [
		"payment"
	])
	const InvoicePayment = relation("InvoicePayment", { payment: uuid, days: pg.integer }, [
		"payment"
	])
	const base = schema(name, { Plan, Customer, Payment, CardPayment, InvoicePayment }, [
		contained(on(Payment, "customer"), on(Customer, "id")),
		alternatives(Payment, "plan", Plan, { Card: CardPayment, Invoice: InvoicePayment })
	])
	/** Each customer's payment count and total: a stored query, keyed by customer. */
	const spend = query(base).rule((r) => {
		const { id, customer, cents } = v(Payment, "payment")
		return r
			.match(Payment, { id, customer, cents })
			.find({ customer, payments: r.count(), cents: r.sum(cents) })
	})
	const CustomerSpend = derived.materialized("CustomerSpend", spend)
	const s = schema.extend(base, `${name}_1`, { CustomerSpend }, [])
	const reader = role(s, "reader", wholeEntriesOf(s))
	const writer = role(s, "writer", wholeEntriesOf(s), {
		write: writableNamesOf(s)
	})
	const refresher = role(s, "refresher", wholeEntriesOf(s), { refresh: ["CustomerSpend"] })
	const customersByName = query(s).rule((r) => {
		const c = v(Customer, "customer")
		return r
			.match(Customer, { id: c.id, name: c.name })
			.where(r.eq(c.name, r.param("name", Customer.fields.name)))
			.find({ id: c.id, name: c.name })
	})
	/**
	 * The customers with at least `least` payments: a range on the derived relation's payment count, which an index on
	 * its materialized view serves.
	 */
	const frequentSpenders = query(s).rule((r) => {
		const { customer, payments, cents } = v(CustomerSpend, "customerSpend")
		return r
			.match(CustomerSpend, { customer, payments, cents })
			.where(r.ge(payments, r.param("least", pg.bigint)))
			.find({ customer, cents })
	})
	return {
		schema: s,
		reader,
		writer,
		refresher,
		server: login(s, "server", [reader, writer, refresher], {
			workload: [
				workload(s, { customer: Customer }),
				workload(writer, { addCustomer: ChangeSet.empty(writer).insert(Customer, []) }),
				workload(s, { customersByName, frequentSpenders })
			]
		}),
		Customer,
		Payment,
		CardPayment,
		CustomerSpend,
		customersByName,
		frequentSpenders
	}
}

/** A session's subject, as a document's owner and a note's author name it. */
const subject = str.regex("^u_[a-z]{1,8}$")

/**
 * The worlds schema under `name`, for the drift suite: documents and the notes on them, and the session's subject;
 * `editor` reads Doc and writes Mine, the notes of the documents the session's subject owns, under row security through
 * a filter that reads Doc beside Note; `viewer` reads Doc; both in the login `desk`. Each call builds a schema of its
 * own.
 */
export const worlds = (name: string) => {
	const Doc = relation("Doc", { id: uuid, owner: subject, words: pg.integer }, ["id"])
	const Note = relation("Note", { id: uuid, doc: uuid, author: subject }, ["id"])
	const Session = context("Session", { sub: subject })
	const base = schema(name, { Doc, Note }, [
		mutable(Doc),
		contained(on(Note, "doc"), on(Doc, "id"))
	])
	const mine = query(base).rule((r) => {
		const { id, doc, author } = v(Note, "note")
		const { owner } = v(Doc, "doc")
		return r
			.match(Note, { id, doc, author })
			.match(Doc, { id: doc, owner })
			.match(Session, { sub: owner })
			.find({ id, doc, author })
	})
	const editor = role(base, "editor", { Doc, Mine: mine }, { write: ["Mine"] })
	const viewer = role(base, "viewer", { Doc })
	return { schema: base, editor, viewer, desk: login(base, "desk", [editor, viewer]) }
}
