import { int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fn, relation, row, rows, schema } from "#compiler/public/schema.ts"

/**
 * The schema and the rows arguments of the bound-argument agreement (test/support/agreement/bound-arguments.ts): f,
 * which Fn.rows calls, and g, which Fn.row calls, each of rows of K and a bigint, f returning rows of K and g one row
 * whose field `out` holds rows of K; Item and Note, which the arguments read; and each query a cell passes as rows, one
 * of no parameters and one of each kind of parameter a query has: a scalar parameter, a relation parameter, a
 * parameter of a union's second arm, of a take's count and of an attachment's child.
 */
const K = rows({ k: int8 })
const Out = rows({ out: K })

export const f = fn("f", {
	calls: [],
	args: { a: K, x: int8 },
	returns: K,
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT * FROM unnest(a)`
})
export const g = fn("g", {
	calls: [],
	args: { a: K, x: int8 },
	returns: row(Out),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT ROW(a)::${Out}`
})
export const Item = relation("Item", { s: int4, k: int8 }, ["s", "k"])
const Note = relation("Note", { k: int8, n: int4 }, ["k", "n"])
export const Bound = schema("Bound", [Item, Note, f, g], [])

/** Every item's k: a query of no parameters. */
export const none = query(Bound).rule((r) => {
	const { k } = v(Item, "item")
	return r.match(Item, { k }).find({ k })
})

/** The k of the items of s, a scalar parameter. */
export const scalar = query(Bound).rule((r) => {
	const { k } = v(Item, "item")
	return r.match(Item, { s: r.param("s", int4), k }).find({ k })
})

/** The k of the rows of rel, a relation parameter. */
export const relational = query(Bound).rule((r) => {
	const rel = r.relation("rel", { k: int8 })
	const { k } = v(rel, "rel")
	return r.match(rel, { k }).find({ k })
})

/** none's rows, and a second arm of scalar's. */
export const union = none.rule((r) => {
	const { k } = v(Item, "item")
	return r.match(Item, { s: r.param("s", int4), k }).find({ k })
})

/** none's first n rows by k, n a parameter. */
export const taken = none.orderBy(["k", "asc"]).take("n")

/** none's rows, each holding its k's notes past m, a parameter its child reads. */
export const attached = none.attach(
	"notes",
	(p) =>
		query(Bound).rule((r) => {
			const { n } = v(Note, "note")
			return r
				.match(Note, { k: p.k, n })
				.where(r.gt(n, r.param("m", int4)))
				.find({ n })
		}),
	"array"
)
