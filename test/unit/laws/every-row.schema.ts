/** The box of every-row.fixtures.ts: its relations, the values a later arm is held at, its laws and each case's schema. */

import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	key,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"

const T = relation("T", { k: pg.integer, a: pg.integer, b: pg.integer }, ["k"])

const S = relation("S", { id: pg.integer, a: pg.integer }, ["id"])

const G = relation("G", { x: pg.integer }, ["x"])

/** Every relation mutable, each inside the unit of its key, and every rule over D reading T beside S or G away from T's
 * key, so none is unit-local: each is probed, its check its probes over every row. */
const Base = schema(
	"every_row",
	[T, S, G],
	[
		unit("Ts", { k: pg.integer }),
		unit("Ss", { id: pg.integer }),
		unit("Gs", { x: pg.integer }),
		mutable(T),
		mutable(S),
		mutable(G)
	]
)

/**
 * The values a later arm of D is held at: T at b 1 or b 2, a key field bound by a literal, which the drawn rows hold, or
 * at b 9, which no drawn row holds, so the arm, still an arm of D, derives no fact.
 */
export const gates = [1, 2, 9] as const

export type Gate = (typeof gates)[number]

/** A rule over D: its x contained in G, a check that x is never 3, or a key of x. */
export const laws = ["contained", "check", "key"] as const

/** A case's law and the values its later arms are held at, all its schema reads. */
export interface Shape {
	readonly literal: Gate
	readonly negated: Gate
	readonly law: (typeof laws)[number]
}

/**
 * The schema of a case: D of three arms, each delivering T's a and k: T joined to S by b; T at the case's literal b;
 * and T at the case's other b whose a no S holds; under the case's law.
 */
export const boxSchemaOf = (c: Shape) => {
	const D = derived(
		"D",
		query(Base)
			.rule((r) => {
				const { k, a, b } = v(T, "t")
				const { id } = v(S, "s")
				return r.match(T, { k, a, b }).match(S, { id, a: b }).find({ x: a, y: k })
			})
			.rule((r) => {
				const { k, a } = v(T, "t")
				return r.match(T, { k, a, b: c.literal }).find({ x: a, y: k })
			})
			.rule((r) => {
				const { k, a } = v(T, "t")
				return r.match(T, { k, a, b: c.negated }).where(r.not(S, { a })).find({ x: a, y: k })
			})
	)
	switch (c.law) {
		case "contained":
			return schema.extend([Base], "every_row_1", [D], [contained(on(D, "x"), on(G, "x"))])
		case "check":
			return schema.extend([Base], "every_row_1", [D], [check("C", D, (d) => d.ne(d.x, 3))])
		case "key":
			return schema.extend([Base], "every_row_1", [D], [key(on(D, "x"))])
	}
}
