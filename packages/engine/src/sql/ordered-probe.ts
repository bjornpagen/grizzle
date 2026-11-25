import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Expr, FromItem, OperandSelect, OrderItem } from "#compiler/sql/ast.ts"
import { and, asc, binary, desc, lit, simpleSelect, target, types } from "#compiler/sql/build.ts"

/**
 * An ordered probe: the row of an index nearest past a cut of its order, read from one descent.
 *
 * A B-tree whose leading columns are fixed by equality orders the rows there by its next column, `order`, so the row
 * whose order lies nearest below a bound, or nearest above it, is the first the index meets walking from the bound away
 * from it: `(SELECT take FROM from WHERE prefix AND order op bound ORDER BY order LIMIT 1)`, a scalar subquery of no
 * row where none lies past the cut. The cut's operator fixes the walk: below the bound (`<`, `<=`) the index is read
 * backward, the predecessor; above it (`>`, `>=`) forward, the successor; so a probe's direction and its cut never
 * disagree. Every part reads the probe's own FROM item under its own alias, which no other relation of the statement
 * takes.
 */
export interface OrderedProbe {
	readonly from: FromItem
	/** The equalities fixing the index's leading columns, each over the FROM item's alias. */
	readonly prefix: NonEmptyReadonlyArray<Expr>
	/** The index's column after the prefix, over the alias. */
	readonly order: Expr
	readonly cut: { readonly op: ProbeCut; readonly bound: Expr }
	/** What the probe yields of the row it finds, over the alias. */
	readonly take: Expr
}

/** The operators of a cut: below a bound or at most it, above it or at least it. */
export type ProbeCut = "<" | "<=" | ">" | ">="

/** The direction a cut's walk reads its index in: backward below a bound, forward above it. */
const walks: { readonly [C in ProbeCut]: (order: Expr) => OrderItem } = {
	"<": desc,
	"<=": desc,
	">": asc,
	">=": asc
}

/** The probe's scalar subquery (`OrderedProbe`). */
export const orderedProbe = (p: OrderedProbe): Expr => {
	const read: OperandSelect = {
		...simpleSelect(
			[target(p.take)],
			[p.from],
			and([...p.prefix, binary(p.cut.op, p.order, p.cut.bound)])
		),
		orderBy: [walks[p.cut.op](p.order)],
		limit: lit.int(1, types.bigint)
	}
	return { kind: "subquery", query: read }
}
