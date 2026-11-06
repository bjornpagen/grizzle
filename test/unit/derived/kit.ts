import { Compute } from "#compiler/public/compute.ts"
import { closedId, contract, pg, span, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, derived, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

/** A schema whose derived relations cover every aggregate overload, refinement, roster and contract the inference rules
 * name, shared by the unit and pg suites of derived relations. */
const Kind = closed("Kind", ["Automatic", "Manual"])
const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
const Code = str.regex("^[A-Z]{3}$")
const Item = relation(
	"Item",
	{
		id: uuid,
		seq: pg.bigserial,
		kind: closedId(Kind),
		price: Cents,
		qty: pg.integer,
		small: pg.smallint,
		big: pg.bigint,
		amount: pg.numeric(10, 2),
		ratio: pg.real,
		weight: pg["double precision"],
		fee: pg.money,
		code: Code,
		label: str.regex("^.*$", "su"),
		flag: pg.boolean,
		period: span(pg.integer)
	},
	["id"]
)
const Kit = schema("Kit", { Kind, Item }, [])

/**
 * SUM over every numeric overload, grouped by a closed id. A money sum is exact money, which no stored field holds, so
 * the money is summed as numeric, whose sum a numeric field holds.
 */
const sums = query(Kit).rule((r) => {
	const { id, kind, price, qty, small, big, amount, ratio, weight, fee } = v(Item, "item")
	return r.match(Item, { id, kind, price, qty, small, big, amount, ratio, weight, fee }).find({
		kind,
		n: r.count(),
		sumQty: r.sum(qty),
		sumSmall: r.sum(small),
		sumBig: r.sum(big),
		sumAmount: r.sum(amount),
		sumRatio: r.sum(ratio),
		sumWeight: r.sum(weight),
		sumFee: r.sum(Compute.numeric(fee)),
		sumPrice: r.sum(price)
	})
})

/** AVG over every overload it admits. */
const means = query(Kit).rule((r) => {
	const { id, kind, price, qty, small, big, amount, ratio, weight } = v(Item, "item")
	return r.match(Item, { id, kind, price, qty, small, big, amount, ratio, weight }).find({
		kind,
		meanQty: r.mean(qty),
		meanSmall: r.mean(small),
		meanBig: r.mean(big),
		meanAmount: r.mean(amount),
		meanRatio: r.mean(ratio),
		meanWeight: r.mean(weight),
		meanPrice: r.mean(price)
	})
})

/** MIN and MAX return an input unchanged: a contract keeps its domain, a pattern its domain, a typmod its typmod. */
const extremes = query(Kit).rule((r) => {
	const { id, kind, price, amount, code, label } = v(Item, "item")
	return r.match(Item, { id, kind, price, amount, code, label }).find({
		kind,
		minPrice: r.min(price),
		maxPrice: r.max(price),
		minAmount: r.min(amount),
		minCode: r.min(code),
		maxCode: r.max(code),
		maxLabel: r.max(label)
	})
})

/** A plain projection keeps every descriptor; the key id is retained, and a serial reads as its plain width. */
const facts = query(Kit).rule((r) => {
	const { id, seq, kind, price, code, label, flag, period } = v(Item, "item")
	return r
		.match(Item, { id, seq, kind, price, code, label, flag, period })
		.find({ id, seq, kind, price, code, label, flag, period })
})

/** Computed values: a literal of a declared type, and a conditional over two patterns, which keeps neither
 * (the result is the canonical wildcard). */
const computed = query(Kit).rule((r) => {
	const { id, flag, code, label } = v(Item, "item")
	return r.match(Item, { id, flag, code, label }).find({
		id,
		pick: Compute.cond(flag, code, label),
		one: Compute.literal(pg.integer, 1)
	})
})

/**
 * The roster's own facts: every closed id read from no stored column but from the closed relation's codes, which the
 * lowering delivers as smallint literals, and the view still holds at the roster's domain.
 */
const kinds = query(Kit).rule((r) => {
	const { id } = v(Kind, "kind")
	return r.match(Kind, { id }).find({ kind: id })
})

const Sums = derived("Sums", sums)
const Means = derived("Means", means)
const Extremes = derived("Extremes", extremes)
const Facts = derived("Facts", facts)
const Computed = derived("Computed", computed)
const Kinds = derived("Kinds", kinds)

export const KitReports = schema.extend(Kit, { Sums, Means, Extremes, Facts, Computed, Kinds }, [])
