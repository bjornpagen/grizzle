import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { Expr, TypeSchema } from "#compiler/sql/ast.ts"
import { and, binary, or, row } from "#compiler/sql/build.ts"

/** The installation's names a comparison's operator resolves through: the schema of each type an extension defines. */
export type OperatorNames = Pick<PhysicalNames, "vectorSchema">

/**
 * The schema of the operators that compare two values of `type`, by its base carrier: the schema of the extension that
 * defines the type, for a vector pgvector's; none for a builtin type or a domain over one, whose operators pg_catalog
 * holds. PostgreSQL resolves an operator spelled bare through the search_path, and the one grizzle sets
 * (sql/ast.ts closedSearchPath) holds pg_catalog and no extension's schema, so an operator outside pg_catalog is spelled
 * qualified, `a OPERATOR("vector_ext".=) b`, or no role that runs it finds it (42883).
 */
export const operatorSchemaOf = (
	names: OperatorNames,
	type: ScalarType
): TypeSchema | undefined => {
	const b = baseOf(type)
	switch (b.carrier) {
		case "vector":
			return names.vectorSchema
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bytes":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}

/** A comparison grizzle emits between two values of one column type. */
type ComparisonOperator = "=" | "<>" | "<" | "<=" | ">" | ">="

/** `left op right` at the operators of the schema `operators`, or pg_catalog's spelled bare for none. */
export const compareAt = (
	op: ComparisonOperator,
	operators: TypeSchema | undefined,
	left: Expr,
	right: Expr
): Expr => ({ kind: "binary", op, left, right, schema: operators })

/** `left op right` for two values of `type`, at the operator its type resolves (`operatorSchemaOf`). */
export const typedCompare = (
	op: ComparisonOperator,
	type: ScalarType,
	left: Expr,
	right: Expr,
	names: OperatorNames
): Expr => compareAt(op, operatorSchemaOf(names, type), left, right)

/**
 * Type-aware equality for every comparison grizzle emits between two values of one column type.
 *
 * A match binding shared by two occurrences, a constant or parameter binding, a variable equality, a correlation, a
 * semi-join, attach, union or take stitch, a read-back's delivery check, the insert protocol's DO SELECT predicate and
 * inserted marker, a put's key and payload, a family's keys and groups, a probe function's key and an exact or
 * displacing deletion all compare two values of one heading column, each at the operator its type resolves
 * (`operatorSchemaOf`): over a vector the extension's own B-tree operator, `a OPERATOR("vector_ext".=) b` (native
 * float32 component equality, -0 = +0), and over every other type the builtin operator, unqualified.
 *
 * A row comparison resolves each column's operator by name too (make_row_comparison_op), so a row that holds a column
 * whose operators are qualified is spelled as the comparisons it stands for: `(a, v) = (b, w)` is
 * `a = b AND v OPERATOR(<ext>.=) w`, and `(a, v) <> (b, w)` is `a <> b OR v OPERATOR(<ext>.<>) w`. The emitted SQL holds
 * no NULL, so the expansion is exact. A row of builtin columns alone stays one row comparison.
 */
export const typedEq = (type: ScalarType, left: Expr, right: Expr, names: OperatorNames): Expr =>
	typedCompare("=", type, left, right, names)

/** A row of `items`, or the one item alone. */
const rowOrSingle = (items: NonEmptyReadonlyArray<Expr>): Expr =>
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

const rowCompare = <F>(op: "=" | "<>", sides: RowSides<F>, names: OperatorNames): Expr => {
	const { fields, typeOf, left, right } = sides
	if (fields.every((f) => operatorSchemaOf(names, typeOf(f)) === undefined)) {
		return binary(
			op,
			rowOrSingle(mapNonEmpty(fields, left)),
			rowOrSingle(mapNonEmpty(fields, right))
		)
	}
	const terms = mapNonEmpty(fields, (f) => typedCompare(op, typeOf(f), left(f), right(f), names))
	return op === "=" ? and(terms) : or(terms)
}

/** `(left) = (right)` over the fields; one field compares as a scalar. */
export const rowEq = <F>(sides: RowSides<F>, names: OperatorNames): Expr =>
	rowCompare("=", sides, names)

/** `(left) <> (right)` over the fields; one field compares as a scalar. */
export const rowNe = <F>(sides: RowSides<F>, names: OperatorNames): Expr =>
	rowCompare("<>", sides, names)
