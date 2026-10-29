import type { SpanCarrier } from "#compiler/ir/scalar.ts"
import type { BuiltinTypeName, Expr, TypeRef } from "#compiler/sql/ast.ts"
import { binary, builtinType, cast, lit } from "#compiler/sql/build.ts"

/** The multirange type a coverage value over spans of `carrier` has. */
const multirangeNames: Readonly<Record<SpanCarrier, BuiltinTypeName>> = {
	range4: "int4multirange",
	range8: "int8multirange"
}

export const multirangeTypeOf = (carrier: SpanCarrier): TypeRef =>
	builtinType(multirangeNames[carrier])

/** The empty coverage, `'{}'::int8multirange`: the identity of the union, never a NULL.
 *
 * The empty coverage, the identity of the union of a group's spans as a multirange. Coverage is about all points: a source span is covered when the union of its scalar group's target spans contains
 * it, not when one target row does. PostgreSQL's multiranges normalize overlapping and adjacent
 * components, which is exactly the coverage operation's meaning and nowhere else appropriate, and
 * `multirange @> range` is the containment test. range_agg of an empty group is NULL, which grizzle never produces;
 * the empty multirange `'{}'` is a real non-null coverage identity, and adding each span to it with the
 * multirange union `+` yields the group's range_agg without a NULL for an empty group:
 *
 *   cover := '{}'::int8multirange;
 *   ... for each span s of the group: cover := cover + s::int8multirange;
 *   ... a source span x is covered exactly when cover @> x
 *
 * An int4range span accumulates into int4multirange and an int8range span into int8multirange; a span over
 * a contract is stored as its base range, so it accumulates the same way. */
export const emptyCover = (carrier: SpanCarrier): Expr => lit.text("{}", multirangeTypeOf(carrier))

/** The coverage `cover` extended by one span: `cover + span::int8multirange`. */
export const coverWith = (cover: Expr, span: Expr, carrier: SpanCarrier): Expr =>
	binary("+", cover, cast(span, multirangeTypeOf(carrier)))

/** Whether `cover` contains every point of `span`: `cover @> span`. */
export const covers = (cover: Expr, span: Expr): Expr => binary("@>", cover, span)
