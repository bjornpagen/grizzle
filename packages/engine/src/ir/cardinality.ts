/**
 * An upper bound on how many rows a relation has: at most `rows`, or none known. Bounds are ordered as the naturals
 * with infinity above them, and every way the analyses combine them is stated here once.
 */
export type Cardinality =
	| { readonly kind: "atMost"; readonly rows: bigint }
	| { readonly kind: "unbounded" }

export const unbounded: Cardinality = Object.freeze({ kind: "unbounded" })

export const atMost = (rows: bigint): Cardinality => ({ kind: "atMost", rows })

/** The tightest of several bounds on one relation (its input's, a take's, a key's): the least. */
export const leastCardinality = (...bounds: ReadonlyArray<Cardinality>): Cardinality =>
	bounds.reduce<Cardinality>(
		(a, b) => (a.kind === "unbounded" ? b : b.kind === "unbounded" ? a : b.rows < a.rows ? b : a),
		unbounded
	)

/** The bound of a concatenation of relations: the sum of theirs, unbounded when any is. */
export const sumCardinality = (bounds: ReadonlyArray<Cardinality>): Cardinality => {
	let rows = 0n
	for (const b of bounds) {
		if (b.kind === "unbounded") {
			return unbounded
		}
		rows += b.rows
	}
	return atMost(rows)
}

/**
 * The bound of a product of relations: the product of theirs; an empty factor bounds it at none whatever the others
 * are, and otherwise it is unbounded when any factor is.
 */
export const productCardinality = (bounds: ReadonlyArray<Cardinality>): Cardinality => {
	let rows = 1n
	let open = false
	for (const b of bounds) {
		if (b.kind === "unbounded") {
			open = true
		} else if (b.rows === 0n) {
			return atMost(0n)
		} else {
			rows *= b.rows
		}
	}
	return open ? unbounded : atMost(rows)
}

/** Whether a bound proves the relation has at most `rows` rows. */
export const boundsAtMost = (bound: Cardinality, rows: bigint): boolean =>
	bound.kind === "atMost" && bound.rows <= rows
