import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { and, binary, or, row } from "#compiler/sql/build.ts"

const isVectorType = (t: ScalarType): boolean => baseOf(t).carrier === "vector"

/** `left op right` for two values of `type`: the extension's qualified operator over a vector. */
const compare = (
	op: "=" | "<>",
	type: ScalarType,
	left: Expr,
	right: Expr,
	vectorSchema: string
): Expr =>
	isVectorType(type)
		? { kind: "binary", op, left, right, schema: vectorSchema }
		: binary(op, left, right)

/**
 * Type-aware equality for every comparison grizzle emits between two values of one column type.
 *
 * A match binding shared by two occurrences, a constant or parameter binding, a variable equality, a correlation, a
 * semi-join, attach, union or take stitch, the insert protocol's DO SELECT predicate and inserted marker, and an
 * exact or displacing deletion all compare two values of one heading column. PostgreSQL resolves an unqualified `=`
 * or `<>` through the search_path, and a role's search_path never holds the extension schema, so a bare
 * `=` between two vectors fails with 42883 for the role that runs it. Over a vector type the comparison is the
 * extension's own B-tree operator, `a OPERATOR("vector_ext".=) b` (native float32 component equality, -0 = +0), and
 * over every other type the builtin operator, unqualified as before.
 *
 * A row comparison resolves each column's operator by name too (make_row_comparison_op), so a row that holds a vector
 * is spelled as the comparisons it stands for: `(a, v) = (b, w)` is `a = b AND v OPERATOR(<ext>.=) w`, and
 * `(a, v) <> (b, w)` is `a <> b OR v OPERATOR(<ext>.<>) w`. The emitted SQL holds no NULL, so the expansion is exact.
 * A row without a vector stays one row comparison.
 */
export const typedEq = (type: ScalarType, left: Expr, right: Expr, vectorSchema: string): Expr =>
	compare("=", type, left, right, vectorSchema)

/** A row of `items`, or the one item alone. */
export const rowOrSingle = (items: NonEmptyReadonlyArray<Expr>): Expr =>
	items.length === 1 ? items[0] : row(items)

/**
 * Two rows of one heading compared column by column: each of `fields`, at least one, read as `left` and as `right`, of
 * its type.
 */
interface RowSides<F> {
	readonly fields: NonEmptyReadonlyArray<F>
	readonly typeOf: (field: F) => ScalarType
	readonly left: (field: F) => Expr
	readonly right: (field: F) => Expr
}

const rowCompare = <F>(op: "=" | "<>", sides: RowSides<F>, vectorSchema: string): Expr => {
	const { fields, typeOf, left, right } = sides
	if (!fields.some((f) => isVectorType(typeOf(f)))) {
		return binary(
			op,
			rowOrSingle(mapNonEmpty(fields, left)),
			rowOrSingle(mapNonEmpty(fields, right))
		)
	}
	const terms = mapNonEmpty(fields, (f) => compare(op, typeOf(f), left(f), right(f), vectorSchema))
	return op === "=" ? and(terms) : or(terms)
}

/** `(left) = (right)` over the fields; one field compares as a scalar. */
export const rowEq = <F>(sides: RowSides<F>, vectorSchema: string): Expr =>
	rowCompare("=", sides, vectorSchema)

/** `(left) <> (right)` over the fields; one field compares as a scalar. */
export const rowNe = <F>(sides: RowSides<F>, vectorSchema: string): Expr =>
	rowCompare("<>", sides, vectorSchema)
