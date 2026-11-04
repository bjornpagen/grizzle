import { closedId, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	alternatives,
	closed,
	contained,
	derived,
	login,
	on,
	relation,
	role,
	schema
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
	const reader = role(s, "reader", s.relations)
	const writer = role(s, "writer", s.relations, { write: ["Customer", "Order"] })
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
		server: login(s, "server", [reader, writer], { workload: owned }),
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
	const reader = role(s, "reader", s.relations)
	const writer = role(s, "writer", s.relations, { write: ["Customer", "Order"] })
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
		server: login(s, "server", [reader, writer], { workload: owned }),
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
 * And a ledger (`ledger`), whose generate output needs both installer extensions that a
 * plain shop does not. Payment's plan selects one of two arm relations through `alternatives`, a residual law with its
 * law function and constraint triggers; a derived relation CustomerSpend sums each
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
		const { customer, cents } = v(Payment, "payment")
		return r
			.match(Payment, { customer, cents })
			.find({ customer, payments: r.count(), cents: r.sum(cents) })
	})
	const CustomerSpend = derived("CustomerSpend", spend)
	const s = schema.extend(base, { CustomerSpend }, [])
	const reader = role(s, "reader", s.relations)
	const writer = role(s, "writer", s.relations, {
		write: ["Customer", "Payment", "CardPayment", "InvoicePayment"]
	})
	const refresher = role(s, "refresher", s.relations, { refresh: ["CustomerSpend"] })
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
			workload: [workload(s, { customersByName, frequentSpenders })]
		}),
		Customer,
		Payment,
		CardPayment,
		CustomerSpend,
		customersByName,
		frequentSpenders
	}
}
