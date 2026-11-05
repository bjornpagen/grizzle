import { malformedDescription } from "#compiler/core/errors.ts"
import { captureLoc, type SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { scalarTerm } from "#compiler/scalar/compute/builders.ts"
import {
	predicateExpr,
	type ScalarTerm,
	type TermCarrier,
	typedTermOf
} from "#compiler/scalar/compute/term.ts"
import { meets } from "#compiler/scalar/compute/types.ts"
import { literalDescFor, type SqlTag } from "#compiler/scalar/registry.ts"
import { describeFault } from "#compiler/scalar/values/fault.ts"

/** A value a closed read delivers: its declared type and its carrier, the column that reads its cell and its SQL type. */
export interface ClosedValueTyping {
	readonly type: ScalarType
	readonly carrier: TermCarrier
}

/**
 * What the closed reads of one closed relation are typed by, which its builder resolved from the relation's own field
 * descriptors: its name; each key field in key order, its name and the declared type an argument at its position meets
 * or a handle literal there is of; each field's declared type; the payload fields, the ones C.at reads; and the set
 * C.row delivers, over the last key field's roster.
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
	return { kind: "literal", value: literal.value, type: undefined }
}

/** The arguments of a read over the key positions `positions`, one each, in key order. */
const keyArguments = (
	args: ReadonlyArray<unknown>,
	positions: ReadonlyArray<{ readonly field: string; readonly type: ScalarType }>,
	loc: SourceLoc,
	what: string
): ReadonlyArray<OpenExpr> => {
	if (args.length !== positions.length) {
		return refuse(loc, `${what}: ${positions.length} key value(s), one per key field in key order`)
	}
	return positions.map((p, i) => keyArgument(args[i], p, loc))
}

/**
 * C.at(field, k…)'s key: `field` a payload field of `closed`, and `args` one value per key field in key order, each
 * checked against its field (keyArgument).
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
	const [first, ...rest] = keyArguments(args, closed.key, loc, `${closed.relation}.at`)
	return first === undefined
		? refuse(loc, `${closed.relation}.at: a key of one field at least`)
		: [first, ...rest]
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
	const exprs = keyArguments(
		args,
		closed.key.slice(0, -1),
		loc,
		`${closed.relation}.row, which leaves its last key field open`
	)
	const expr: OpenExpr = { kind: "closedRow", relation: closed.relation, args: exprs }
	return scalarTerm(expr, closed.row.type, { column: closed.row.carrier.column, sql: "bits" })
}
