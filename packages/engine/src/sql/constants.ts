import { defined } from "#compiler/core/invariant.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type {
	AlterDomain,
	CreateConstant,
	DomainConstraint,
	DropFunction,
	Expr,
	ObjectName,
	PackConstant,
	PackRow
} from "#compiler/sql/ast.ts"
import { binary, call, cast, eq, gt, lit, qualifiedCall, types } from "#compiler/sql/build.ts"

/**
 * The builders of the installation's constants, over sql/ast.ts Expr and its statements, which sql/print.ts prints. A
 * closed relation, and every closed side a law or query reads, compiles to one bit string, a string of cells read w
 * bits at a time: the body of an IMMUTABLE SQL function named by its contents, so a changed relation is a new function
 * and never a function replaced in place. Cell i holds bits i * w to (i + 1) * w - 1; 0 is absent, and 1 + c is present
 * with payload code c. A tuple's cell is its row-major mixed-radix index over its key's codes.
 *
 * This module builds what reads and installs those strings: the expressions of a cell read, and the migration
 * statements that pack a relation, re-point a domain at a new constant and drop the old constant.
 */

/** An integer literal PostgreSQL types integer: a nonnegative one prints bare. */
const int = (value: number): Expr => lit.int(value, types.integer)

/** A constant's value: a call of its function with no arguments, F(). */
export const constantValue = (fn: ObjectName): Expr => qualifiedCall(fn.schema, fn.name, [])

const plus = (left: Expr, right: Expr): Expr => binary("+", left, right)

/** `e` times `factor`: `e` itself for a factor of one. */
const times = (e: Expr, factor: number): Expr => (factor === 1 ? e : binary("*", e, int(factor)))

/** One coordinate of a tuple: its code, and the size of its code space, holes included. */
export interface Coordinate {
	readonly digit: Expr
	readonly radix: number
}

/**
 * The row-major mixed-radix index of a tuple, ((k1 * r2 + k2) * r3 + k3) ...: Horner's rule over its coordinates in key
 * order. The first coordinate's radix bounds the index and multiplies nothing. Every digit is below its radix, which
 * its field's type proves, so no digit carries into its neighbour and the index is in range.
 */
export const mixedRadix = (coordinates: NonEmptyReadonlyArray<Coordinate>): Expr =>
	coordinates
		.slice(1)
		.reduce<Expr>((index, next) => plus(times(index, next.radix), next.digit), coordinates[0].digit)

/**
 * Cell `index` of the constant F, `width` bits: substring(F(), index * width + 1, width), positions counted from 1.
 * `index` is an integer: substring takes no bigint position. A range past either end is the empty string, which equals
 * no '1'::bit(1) and reads as the integer 0, so an index out of range reads as absent and no range check is needed.
 * With `width` the size of a prefix's completions, the same read is that prefix's set of completions.
 */
export const cellAt = (constant: ObjectName, index: Expr, width: number): Expr =>
	call("substring", [constantValue(constant), plus(times(index, width), int(1)), int(width)])

/** A cell's value as an integer: 0 absent, 1 + c present with payload code c. */
const cellCode = (constant: ObjectName, index: Expr, width: number): Expr =>
	cast(cellAt(constant, index, width), types.integer)

/** The bit string of one set bit, '1'::bit(1): a set's member's cell. */
const member = lit.text("1", types.bit(1))

/** A set's member, a cell of one bit equal to '1'::bit(1): a code is live, or a tuple is in a set. */
export const inSet = (constant: ObjectName, index: Expr): Expr =>
	eq(cellAt(constant, index, 1), member)

/** A key is present: its cell is not 0. */
export const keyIn = (constant: ObjectName, index: Expr, width: number): Expr =>
	gt(cellCode(constant, index, width), int(0))

/** A key and its payload code are in the relation: the key's cell is 1 + the payload's code. */
export const pairIn = (constant: ObjectName, index: Expr, width: number, payload: Expr): Expr =>
	eq(cellCode(constant, index, width), plus(int(1), payload))

/**
 * A function's application to a key, its payload code: NULLIF(cell, 0) - 1. An absent key is NULL, never -1, so a
 * lookup fed by it reads NULL instead of carrying into a neighbour's cell, and the IS TRUE of a check refuses it.
 */
export const applied = (constant: ObjectName, index: Expr, width: number): Expr =>
	binary("-", { kind: "nullif", expr: cellCode(constant, index, width), absent: int(0) }, int(1))

/**
 * Payload coordinate `position` of the cell at `index`, among a payload of the coordinates `radices`: the cell's payload
 * code c = NULLIF(cell, 0) - 1, then c / (the product of the radices after `position`) % (its own radix). The division
 * is skipped where no coordinate follows, and the modulo for the first coordinate, whose quotient is already below its
 * radix. An absent key is NULL, never a code.
 */
export const payloadDigit = (
	constant: ObjectName,
	index: Expr,
	width: number,
	radices: ReadonlyArray<number>,
	position: number
): Expr => {
	const after = radices.slice(position + 1).reduce((product, radix) => product * radix, 1)
	const code = applied(constant, index, width)
	const shifted = after === 1 ? code : binary("/", code, int(after))
	return position === 0
		? shifted
		: binary("%", shifted, int(defined(radices[position], "a payload coordinate's radix")))
}

/**
 * An open-typed payload, read through the dictionary D of its values in code order: (D())[cell]. Arrays count from 1, so
 * cell 1 + c is D's value for code c, and cell 0, absent, is NULL.
 */
export const payloadAt = (
	dictionary: ObjectName,
	constant: ObjectName,
	index: Expr,
	width: number
): Expr => ({
	kind: "subscript",
	array: constantValue(dictionary),
	index: cellCode(constant, index, width)
})

/** A code's name, read from its roster's names constant: (names())[code + 1]::text, a hole the empty name. */
export const nameOf = (names: ObjectName, code: Expr): Expr =>
	cast({ kind: "subscript", array: constantValue(names), index: plus(code, int(1)) }, types.text)

/**
 * The migration's pack of a relation into its constant: `radices` are the key fields' code spaces, whose product is the
 * count of cells, and `width` is w. Each row's codes are below their radices and its payload code below 2^w - 1, and no
 * two rows share a key: the caller checks the relation's key before it packs (ir/cells.ts constantOf). No row packs a
 * string of zeros.
 */
export const pack = (
	fn: ObjectName,
	radices: NonEmptyReadonlyArray<number>,
	width: number,
	rows: ReadonlyArray<PackRow>
): PackConstant => ({ kind: "packConstant", function: fn, radices, width, rows })

/** The drop of a created constant, by the signature it was created with. */
export const dropOf = (created: CreateConstant): DropFunction => ({
	kind: "dropFunction",
	name: { ...created.name, args: created.params.map((p) => p.type) },
	ifExists: false
})

/**
 * A domain re-pointed at a new constant, its check keeping its name: the old check dropped, the new one added NOT VALID,
 * then validated. VALIDATE reads every column of the domain's type, which PostgreSQL finds itself, and names the table
 * and column of a value the new constant refuses.
 */
export const repoint = (
	domain: ObjectName,
	check: DomainConstraint
): readonly [AlterDomain, AlterDomain, AlterDomain] => [
	{ kind: "alterDomain", name: domain, action: { kind: "dropConstraint", name: check.name } },
	{
		kind: "alterDomain",
		name: domain,
		action: { kind: "addConstraint", constraint: check, notValid: true }
	},
	{ kind: "alterDomain", name: domain, action: { kind: "validateConstraint", name: check.name } }
]
