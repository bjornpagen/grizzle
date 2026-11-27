import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import {
	baseOf,
	type NonIdentityCarrier,
	nonIdentityCarrierOf,
	type ScalarType
} from "#compiler/ir/scalar.ts"
import type { Expr, FromItem, SetCore, Target, TypeSchema } from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	distinctCore,
	negativeZero,
	or,
	provedCore,
	row,
	sameZeroSign,
	target,
	zerosOfTwoSigns
} from "#compiler/sql/build.ts"

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
		case "inet":
		case "cidr":
		case "text":
		case "bytes":
		case "sha256":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "tsvector":
		case "exactInteger":
		case "exactMoney":
		case "variant":
			return undefined
	}
}

/** A comparison grizzle emits between two values of one column type. */
type ComparisonOperator = "=" | "<>" | "<" | "<=" | ">" | ">="

/** `left op right` at the operators of the schema `operators`, or pg_catalog's spelled bare for none. */
const compareAt = (
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
 * inserted marker, a put's key, a family's keys and groups, a probe function's key and a deletion's key all compare two
 * values of one heading column, each at the operator its type resolves (`operatorSchemaOf`): over a vector the
 * extension's own B-tree operator, `a OPERATOR("vector_ext".=) b` (native float32 component equality, -0 = +0), and
 * over every other type the builtin operator, unqualified. Two stored and requested facts of one key compare as facts
 * (factEq, factNe): a put's payload, the insert protocol's exact repeat, an exact or displacing deletion's fields.
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
const rowEq = <F>(sides: RowSides<F>, names: OperatorNames): Expr => rowCompare("=", sides, names)

/** `(left) <> (right)` over the fields; one field compares as a scalar. */
const rowNe = <F>(sides: RowSides<F>, names: OperatorNames): Expr => rowCompare("<>", sides, names)

/** Each field of `sides` whose equality is no identity (ir/scalar.ts nonIdentityCarrierOf), a float's, with its carrier. */
const floatFields = <F>(
	sides: RowSides<F>
): ReadonlyArray<{ readonly field: F; readonly carrier: NonIdentityCarrier }> =>
	sides.fields.flatMap((field) => {
		const carrier = nonIdentityCarrierOf(sides.typeOf(field))
		return carrier === undefined ? [] : [{ field, carrier }]
	})

/**
 * Whether two rows of one heading are one fact, as its identity reads them (scalar/values/identity.ts canonicalText),
 * where a key compares them under its equality (rowEq): equal, each float field a zero of one sign where it is a zero,
 * since -0 and +0 are one key and two facts. A row of no float field compares as rowEq does.
 */
export const factEq = <F>(sides: RowSides<F>, names: OperatorNames): Expr => {
	const signs = floatFields(sides).map(({ field, carrier }) =>
		sameZeroSign(sides.left(field), sides.right(field), carrier)
	)
	return and([rowEq(sides, names), ...signs])
}

/**
 * Whether two values of `type` are one fact's field, as factEq compares each field of two facts: equal under the type's
 * equality and, for a float, zeros of one sign where they are zeros; a value of any other type compares as typedEq
 * does. A stored row's field checked against a fact's, an exact repeat's, an unchanged row's or a changed one's, reads
 * it (write/probe.ts Equal).
 */
export const factFieldEq = (
	type: ScalarType,
	left: Expr,
	right: Expr,
	names: OperatorNames
): Expr => factEq({ fields: [type], typeOf: (t) => t, left: () => left, right: () => right }, names)

/** Whether two rows of one heading are two facts (factEq's negation): unequal, or a float field -0 in one and +0 in the other. */
export const factNe = <F>(sides: RowSides<F>, names: OperatorNames): Expr => {
	const signs = floatFields(sides).map(({ field, carrier }) =>
		zerosOfTwoSigns(sides.left(field), sides.right(field), carrier)
	)
	return or([rowNe(sides, names), ...signs])
}

/** One column of a set of facts as a statement reads it: its target and its type. */
export interface FactColumn {
	readonly target: Target
	readonly type: ScalarType
}

/**
 * Each float column's being -0 (sql/build.ts negativeZero), in column order: what a fact's identity adds to
 * PostgreSQL's equality, which holds -0 = 0 and every NaN one value. No NaN and no nonzero value is -0, so two rows of
 * equal columns agree on every sign exactly when factEq holds them one fact.
 */
const zeroSigns = (columns: ReadonlyArray<FactColumn>): ReadonlyArray<Expr> =>
	columns.flatMap((c) => {
		const carrier = nonIdentityCarrierOf(c.type)
		return carrier === undefined ? [] : [negativeZero(c.target.expr, carrier)]
	})

/**
 * The rows of `columns` over `from` where `where` holds, as a set of facts: two rows are one exactly when factEq holds
 * them one, equal and each float a zero of one sign where it is a zero, as their identity reads them
 * (scalar/values/identity.ts canonicalText). So a caller's -0 and +0 stay two facts, where SELECT DISTINCT, under
 * PostgreSQL's equality, keeps one of them, the one its plan meets first. Rows of no float column are SELECT DISTINCT
 * itself; rows holding one are grouped by every column and by each float's being -0 (zeroSigns), which splits no class
 * of PostgreSQL's equality but a zero's.
 */
export const factSet = (
	columns: NonEmptyReadonlyArray<FactColumn>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): SetCore => {
	const targets = mapNonEmpty(columns, (c) => c.target)
	const signs = zeroSigns(columns)
	if (signs.length === 0) {
		return distinctCore(targets, from, where)
	}
	return {
		...provedCore("facts", targets, from, where),
		groupBy: [...targets.map((t) => t.expr), ...signs]
	}
}

/**
 * An operand of a set operation that compares facts, a fact difference (EXCEPT): its columns' targets, then each float
 * column's being -0 (zeroSigns), `signs` of them. The operation compares its operands' rows under PostgreSQL's
 * equality, which the signs refine to the facts' identity, so it holds two rows one exactly when factEq does: a stored
 * -0 is no repeat of a +0 beside it. Its reader takes the columns before the signs.
 */
export interface FactOperand {
	readonly targets: NonEmptyReadonlyArray<Target>
	readonly signs: number
}

/** `columns` as an operand of a set operation that compares facts (FactOperand). */
export const factOperand = (columns: NonEmptyReadonlyArray<FactColumn>): FactOperand => {
	const signs = zeroSigns(columns).map(target)
	const [first, ...rest] = mapNonEmpty(columns, (c) => c.target)
	return { targets: [first, ...rest, ...signs], signs: signs.length }
}
