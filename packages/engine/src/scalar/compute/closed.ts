import { malformedDescription } from "#compiler/core/errors.ts"
import { captureLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { scalarTerm } from "#compiler/scalar/compute/builders.ts"
import {
	predicateExpr,
	type PredicateValue,
	predicateValue,
	type ScalarTerm,
	type TermCarrier,
	typedTermOf
} from "#compiler/scalar/compute/term.ts"
import { meets } from "#compiler/scalar/compute/types.ts"
import { literalDescFor } from "#compiler/scalar/literal.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import { describeFault } from "#compiler/scalar/values/fault.ts"

/** A value a closed read delivers: its declared type and its carrier, the column that reads its cell and its SQL type. */
export interface ClosedValueTyping {
	readonly type: ScalarType
	readonly carrier: TermCarrier
}

/**
 * What the closed reads of one closed relation are typed by, which its builder resolved from the relation's own field
 * descriptors: its name; each key field in key order, its name and the declared type an argument at its position meets
 * or a handle literal there is of, which C.at and C.has read in full and C.row but its last; each field's declared
 * type; the payload fields, the ones C.at reads; and the set C.row delivers, over the last key field's roster.
 */
export interface ClosedReadTyping {
	readonly relation: string
	readonly key: NonEmptyReadonlyArray<{ readonly field: string; readonly type: ScalarType }>
	readonly types: ReadonlyMap<string, ScalarType>
	readonly payload: ReadonlySet<string>
	readonly row: ClosedValueTyping
}

/** A refusal at the read's own location, which names the relation it reads. */
function refuse(loc: SourceLoc, what: string): never {
	throw malformedDescription(loc, what)
}

/**
 * The argument at one key position: a term that meets the key field's type, or a JavaScript value, which is a literal of
 * that type, a handle of the field's roster. A predicate is no key value.
 */
const keyArgument = (
	value: unknown,
	position: { readonly field: string; readonly type: ScalarType },
	loc: SourceLoc
): OpenExpr => {
	const term = typedTermOf(value)
	if (term !== undefined) {
		if (!meets(term.type, position.type)) {
			return refuse(loc, `a key value of ${position.field}'s type at its position`)
		}
		return term.expr
	}
	if (predicateExpr(value) !== undefined) {
		return refuse(loc, `a key value of ${position.field}, not a predicate`)
	}
	const literal = literalDescFor(position.type, value)
	if (!literal.ok) {
		return refuse(loc, `${position.field}: ${describeFault(literal.error)}`)
	}
	return { kind: "literal", value: literal.value }
}

/** A read whose arguments are not one per key position it reads, refused with the count it needs. */
const miscounted = (loc: SourceLoc, what: string, positions: number): never =>
	refuse(loc, `${what}: ${positions} key value(s), one per key field in key order`)

/** C.row's arguments, its key prefix: one per key field but the last, in key order (keyArgument). */
const prefixArguments = (
	args: ReadonlyArray<unknown>,
	prefix: ReadonlyArray<{ readonly field: string; readonly type: ScalarType }>,
	loc: SourceLoc,
	what: string
): ReadonlyArray<OpenExpr> =>
	args.length === prefix.length
		? prefix.map((p, i) => keyArgument(args[i], p, loc))
		: miscounted(loc, what, prefix.length)

/**
 * A full key of `closed`, the arguments C.at and C.has read it at: one per key field in key order, each checked against
 * its field (keyArgument), as many as the key, which is nonempty, so the key read is too.
 */
const fullKey = (
	closed: ClosedReadTyping,
	args: ReadonlyArray<unknown>,
	loc: SourceLoc,
	what: string
): NonEmptyReadonlyArray<OpenExpr> =>
	args.length === closed.key.length
		? mapNonEmpty(closed.key, (p, i) => keyArgument(args[i], p, loc))
		: miscounted(loc, what, closed.key.length)

/**
 * C.at(field, k…)'s key: `field` a payload field of `closed`, and `args` its full key (fullKey).
 */
export const closedAtKey = (
	closed: ClosedReadTyping,
	field: unknown,
	args: ReadonlyArray<unknown>
): NonEmptyReadonlyArray<OpenExpr> => {
	const loc = captureLoc(`${closed.relation}.at`, [])
	if (typeof field !== "string" || !closed.payload.has(field)) {
		return refuse(
			loc,
			`a payload field of ${closed.relation}, a field beside its key, first; ${JSON.stringify(field)} is none`
		)
	}
	return fullKey(closed, args, loc, `${closed.relation}.at`)
}

/**
 * C.has(k…): the predicate that `closed` holds a row at the key k…, its full key (fullKey). A key no row holds is
 * false, never NULL, so a law states what holds where the key is absent: `or(not(C.has(k…)), φ(C.at(f, k…)))`, or a
 * value there, `Compute.cond(C.has(k…), C.at(f, k…), d)`. A NULL key value is NULL, as at C.at and C.row.
 */
export const closedHasPredicate = (
	closed: ClosedReadTyping,
	args: ReadonlyArray<unknown>
): PredicateValue => {
	const what = `${closed.relation}.has`
	const key = fullKey(closed, args, captureLoc(what, []), what)
	return predicateValue({ kind: "closedHas", relation: closed.relation, args: key })
}

/**
 * C.at(field, k…): the term of field `field` of the row of `closed` whose key is `key` (closedAtKey), of the field's
 * declared type, carried by `carrier`, the field's own descriptor. Its value at a key no row holds is NULL, never a
 * value: the checker admits the read where an absent key is refused, a predicate's IS TRUE and a generated column's
 * NOT NULL.
 */
export const closedAtTerm = <A, S extends SqlTag>(
	closed: ClosedReadTyping,
	field: string,
	key: NonEmptyReadonlyArray<OpenExpr>,
	carrier: TermCarrier<A, S>
): ScalarTerm<A, S> => {
	const type = closed.types.get(field)
	if (type === undefined) {
		return refuse(
			captureLoc(`${closed.relation}.at`, []),
			`a field of ${closed.relation}; ${field} is none`
		)
	}
	return scalarTerm(
		{ kind: "closedAt", relation: closed.relation, field, args: key },
		type,
		carrier
	)
}

/**
 * C.row(k…): the term of the last key field's values of `closed` that complete the key prefix k…, one argument per key
 * field but the last, in key order: a set over the last key field's roster, typed and carried as `closed.row`.
 */
export const closedRowTerm = (
	closed: ClosedReadTyping,
	args: ReadonlyArray<unknown>
): ScalarTerm<unknown, "bits"> => {
	const loc = captureLoc(`${closed.relation}.row`, [])
	const exprs = prefixArguments(
		args,
		closed.key.slice(0, -1),
		loc,
		`${closed.relation}.row, which leaves its last key field open`
	)
	const expr: OpenExpr = { kind: "closedRow", relation: closed.relation, args: exprs }
	return scalarTerm(expr, closed.row.type, { column: closed.row.carrier.column, sql: "bits" })
}
