import { defect, defined } from "#compiler/core/invariant.ts"
import {
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { Expr, ObjectName, PackConstant, TypeRef } from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	call,
	cast,
	eq,
	gt,
	lit,
	lt,
	qualifiedCall,
	types
} from "#compiler/sql/build.ts"

/**
 * The builders of the installation's constants, over sql/ast.ts Expr and its statements, which sql/print.ts prints. A
 * closed relation, and every closed side a law or query reads, compiles to one bit string, a string of cells read w
 * bits at a time: the body of an IMMUTABLE SQL function named by its contents, so a changed relation is a new function
 * and never a function replaced in place. Cell i holds bits i * w to (i + 1) * w - 1; 0 is absent, and 1 + c is present
 * with payload code c. A tuple's cell is the index its key gives its codes (ir/physical.ts ClosedKey): their row-major
 * mixed radix over a product of closed ids, or over a dependent sum its owner's base plus its block's mixed radix at the
 * owner's own counts.
 *
 * This module builds what reads and installs those strings: the expressions of a cell read, and the migration
 * statement that states a relation's constant as its hex literal.
 */

/** A key coordinate a closed read addresses by a closed id's code: its field, and its radix, the size of its roster's
 * code space, holes included. */
export interface ClosedCoordinate {
	readonly field: string
	readonly radix: number
}

/**
 * A function of a dependent key's owner, installed as a closed relation over the owner prefix: its cell at the owner's
 * index, `width` bits, holds 1 + the owner's value, a block's first cell or one count, for every owner of the prefix's
 * product, so it never reads absent at a code its domain admits.
 */
export interface OwnerFunction {
	readonly function: ObjectName
	readonly width: number
}

/**
 * How a closed relation's key indexes its cells:
 *
 * - a product of closed ids, in mixed radix, row-major in key order;
 * - a dependent sum over the owner prefix `owner`: the owner's index is the mixed radix of the prefix's codes, its
 *   block the mixed radix of the block's coordinates at the radices the owner gives them, a closed id's size or, for a
 *   slot, the owner's count `count` (`counts[count]`), and the cell the owner's base (`bases`) plus that. A slot code
 *   at or past its owner's count reads the cell `cells`, past the string, so it reads absent instead of aliasing the
 *   owner's next slot or the next owner's block.
 */
export type ClosedKey =
	| { readonly kind: "product"; readonly coordinates: NonEmptyReadonlyArray<ClosedCoordinate> }
	| {
			readonly kind: "dependent"
			readonly owner: NonEmptyReadonlyArray<ClosedCoordinate>
			readonly block: NonEmptyReadonlyArray<
				| { readonly kind: "codes"; readonly field: string; readonly radix: number }
				| { readonly kind: "slots"; readonly field: string; readonly count: number }
			>
			readonly bases: OwnerFunction
			readonly counts: NonEmptyReadonlyArray<OwnerFunction>
			readonly cells: number
	  }

/**
 * A closed relation as its installed constants hold it, what a closed law's CHECK and a closed read read: its string of
 * cells' function, read `width` bits a cell at the index its key gives its key fields' codes (ClosedKey); its payload
 * fields in declared order, each with its radix and, for an open-typed field, the function of its dictionary, the
 * field's values in code order, none for a closed id; the function of its key set, one bit per cell of the key space,
 * set where the relation holds a tuple; and every function a read of it calls, which each role that reads it is
 * granted EXECUTE on.
 */
export interface ClosedConstant {
	readonly function: ObjectName
	readonly key: ClosedKey
	readonly width: number
	readonly payload: ReadonlyArray<{
		readonly field: string
		readonly radix: number
		readonly dictionary: ObjectName | undefined
	}>
	readonly keys: ObjectName
	readonly functions: NonEmptyReadonlyArray<ObjectName>
}

/** An integer literal PostgreSQL types integer: a nonnegative one prints bare. */
const int = (value: number): Expr => lit.int(value, types.integer)

/** A constant's value: a call of its function with no arguments, F(). */
export const constantValue = (fn: ObjectName): Expr => qualifiedCall(fn.schema, fn.name, [])

const plus = (left: Expr, right: Expr): Expr => binary("+", left, right)

/** `e` times `factor`: `e` itself for a factor of one. */
const times = (e: Expr, factor: number): Expr => (factor === 1 ? e : binary("*", e, int(factor)))

/** One coordinate of a tuple: its code, and the size of its code space, holes included. */
interface Coordinate {
	readonly digit: Expr
	readonly radix: number | Expr
}

/**
 * The row-major mixed-radix index of a tuple, ((k1 * r2 + k2) * r3 + k3) ...: Horner's rule over its coordinates in key
 * order. The first coordinate's radix bounds the index and multiplies nothing. Every digit is below its radix, which
 * its field's type proves for a closed id and its read's range check for a slot, so no digit carries into its
 * neighbour and the index is in range.
 */
const mixedRadix = (coordinates: NonEmptyReadonlyArray<Coordinate>): Expr =>
	coordinates
		.slice(1)
		.reduce<Expr>(
			(index, next) =>
				plus(
					typeof next.radix === "number"
						? times(index, next.radix)
						: binary("*", index, next.radix),
					next.digit
				),
			coordinates[0].digit
		)

/**
 * A payload's mixed-radix code over its coordinates' codes, ((c1 * r2 + c2) * r3 + c3) ...: the payload code c whose
 * cell holds 1 + c.
 */
export const payloadCode = (
	coordinates: NonEmptyReadonlyArray<{ readonly digit: Expr; readonly radix: number }>
): Expr => mixedRadix(coordinates)

/** The fields a closed key reads, one digit each, in key order: a product's coordinates, a dependent sum's owner prefix
 * then its block. */
const closedKeyFields = (key: ClosedKey): NonEmptyReadonlyArray<string> =>
	key.kind === "product"
		? mapNonEmpty(key.coordinates, (c) => c.field)
		: extendNonEmpty(
				mapNonEmpty(key.owner, (c) => c.field),
				key.block.map((c) => c.field)
			)

/** An owner's value, its function's cell at the owner's index less one: the cell is never absent. */
const ownerValue = (f: OwnerFunction, owner: Expr): Expr => applied(f.function, owner, f.width)

/**
 * A dependent key's reading of the digits `digits`, its owner prefix's then a leading run of its block's: the owner's
 * base, the block digits' mixed radix at the owner's radices, and the range checks of its slot digits, each below its
 * owner's count; with the radix of the block coordinate that follows them, the one a prefix's completions run over.
 */
const dependentReading = (
	key: Extract<ClosedKey, { readonly kind: "dependent" }>,
	digits: ReadonlyArray<Expr>
): {
	readonly base: Expr
	readonly local: Expr | undefined
	readonly checks: ReadonlyArray<Expr>
	readonly next: Expr | undefined
} => {
	const owner = mapNonEmpty(key.owner, (c, i) => ({
		digit: defined(digits[i], "a digit per owner coordinate"),
		radix: c.radix
	}))
	const index = mixedRadix(owner)
	const radixOf = (c: (typeof key.block)[number]): Expr =>
		c.kind === "codes"
			? int(c.radix)
			: ownerValue(defined(key.counts[c.count], "a slot's count is one of its key's"), index)
	const block = digits.slice(key.owner.length).map((digit, i) => {
		const c = defined(key.block[i], "a block digit per block coordinate")
		return { digit, radix: radixOf(c), slot: c.kind === "slots" }
	})
	const following = key.block[block.length]
	return {
		base: ownerValue(key.bases, index),
		local: isNonEmpty(block) ? mixedRadix(block) : undefined,
		checks: block.flatMap((b) => (b.slot ? [lt(b.digit, b.radix)] : [])),
		next: following === undefined ? undefined : radixOf(following)
	}
}

/** `index` where every range check holds, and `cells`, the first cell past the string, which reads absent, otherwise. */
const guarded = (checks: ReadonlyArray<Expr>, index: Expr, cells: number): Expr =>
	isNonEmpty(checks)
		? {
				kind: "case",
				operand: undefined,
				whens: [{ when: and(checks), result: index }],
				else: int(cells)
			}
		: index

/**
 * The cell of a full key's codes `digits`, one per key field in key order (closedKeyFields). Over a product, their
 * mixed radix; over a dependent sum, `CASE WHEN every slot code < its owner's count THEN base + block ELSE cells END`.
 * A slot code at or past its owner's count would carry into the owner's next slot or the next owner's block, so it
 * reads the first cell past the string, which is absent: a set's membership is false there, an application NULL. The
 * block is computed only where its digits are in range, so its arithmetic never leaves the string's cells.
 */
export const cellOfKey = (key: ClosedKey, digits: NonEmptyReadonlyArray<Expr>): Expr => {
	if (key.kind === "product") {
		return mixedRadix(
			mapNonEmpty(key.coordinates, (c, i) => ({
				digit: defined(digits[i], "a digit per key field"),
				radix: c.radix
			}))
		)
	}
	const reading = dependentReading(key, digits)
	if (reading.local === undefined || reading.next !== undefined) {
		throw defect("a full key's digits include every block coordinate's")
	}
	return guarded(reading.checks, plus(reading.base, reading.local), key.cells)
}

/**
 * The completions of a key prefix in the key set `keys`: the prefix's codes `prefix`, every key field but the last, and
 * the run of the last field's cells after it, as bit varying, one bit per code of the last field, set where the
 * relation holds the completed key. Over a product, `substring(K(), p * r + 1, r)`, p the prefix's mixed radix and r
 * the last field's radix; over a dependent sum, its run at base + block * r, r a slot's count at the owner or a closed
 * id's size, read past the string, so empty, where a slot code of the prefix is past its owner's count.
 */
const completions = (keys: ObjectName, key: ClosedKey, prefix: ReadonlyArray<Expr>): Expr => {
	if (prefix.length !== closedKeyFields(key).length - 1) {
		throw defect("a closed row's prefix is every key field but the last")
	}
	if (key.kind === "product") {
		const last = defined(key.coordinates[prefix.length], "a prefix leaves one key field open")
		const coordinates = prefix.map((digit, i) => ({
			digit,
			radix: defined(key.coordinates[i], "a digit per prefix field").radix
		}))
		return cellAt(keys, isNonEmpty(coordinates) ? mixedRadix(coordinates) : int(0), last.radix)
	}
	const reading = dependentReading(key, prefix)
	const length = defined(reading.next, "a prefix leaves its key's last block coordinate open")
	const start =
		reading.local === undefined
			? reading.base
			: plus(reading.base, binary("*", reading.local, length))
	return run(keys, guarded(reading.checks, start, key.cells), length)
}

/** A closed read: C.at's payload field `field`, C.row's completions of a prefix, or a membership test at a full key. */
export type ClosedRead =
	| { readonly kind: "at"; readonly field: string }
	| { readonly kind: "row" }
	| { readonly kind: "has" }

/**
 * A closed read over its relation's installed constants, its arguments the codes of the key fields it fixes, in key
 * order, as SQL, and `type` the type its value is cast to: a closed id's code or a set's domain.
 *
 * - C.at(field, k…): the cell at k…'s index in the relation's string of cells; its payload code is NULLIF(cell, 0) - 1,
 *   so a key the relation holds no tuple at reads NULL, never a code; `field`'s coordinate of that code is a closed
 *   id's code, cast to `type`, or an open-typed value read through its dictionary at code + 1.
 * - C.row(k…): the completions of the prefix k… (completions), cast to `type`, the set over the last key field's
 *   roster, which pads the run, its roster's codes or a slot's owner's count, with 0s to the set's width, so its holes
 *   and padding are 0: a prefix the relation completes nowhere reads the empty set, and a NULL code in it NULL, which
 *   the set's domain admits as every domain does (sql/print.ts).
 * - has(k…): the one bit of the relation's key set at k…'s index, read as the integer 1 exactly where the relation holds
 *   a tuple there.
 *
 * The reads' arguments are counted against the key: a read of any other count is refused with what it needs.
 */
export const closedRead = (
	constant: ClosedConstant,
	relation: string,
	read: ClosedRead,
	args: ReadonlyArray<Expr>,
	type: TypeRef
): Result.Result<Expr, string> => {
	const fields = closedKeyFields(constant.key)
	if (read.kind === "row") {
		return args.length === fields.length - 1
			? Result.ok(cast(completions(constant.keys, constant.key, args), type))
			: Result.err(`${relation}.row over every key field of ${relation} but its last`)
	}
	if (!isNonEmpty(args) || args.length !== fields.length) {
		return Result.err(`${relation}.${read.kind} over every key field of ${relation}, in key order`)
	}
	const index = cellOfKey(constant.key, args)
	if (read.kind === "has") {
		return Result.ok(inSet(constant.keys, index))
	}
	const position = constant.payload.findIndex((p) => p.field === read.field)
	const payload = constant.payload[position]
	if (payload === undefined) {
		return Result.err(`${relation}.at of a payload field of ${relation}; ${read.field} is none`)
	}
	const digit = payloadDigit(
		constant.function,
		index,
		constant.width,
		constant.payload.map((p) => p.radix),
		position
	)
	return Result.ok(
		payload.dictionary === undefined
			? cast(digit, type)
			: { kind: "subscript", array: constantValue(payload.dictionary), index: plus(digit, int(1)) }
	)
}

/** The cells of `constant` from cell `start`, `length` of them, one bit each: substring(F(), start + 1, length). */
const run = (constant: ObjectName, start: Expr, length: Expr): Expr =>
	call("substring", [constantValue(constant), plus(start, int(1)), length])

/**
 * Cell `index` of the constant F, `width` bits: substring(F(), index * width + 1, width), positions counted from 1.
 * `index` is an integer: substring takes no bigint position. A range past the last cell reads the 0 bits that pad the
 * string to whole hex digits, or past either end the empty string, each of which reads as the integer 0, so an index
 * out of range reads as absent and no range check is needed.
 * With `width` the size of a prefix's completions, the same read is that prefix's set of completions.
 */
const cellAt = (constant: ObjectName, index: Expr, width: number): Expr =>
	call("substring", [constantValue(constant), plus(times(index, width), int(1)), int(width)])

/** A cell's value as an integer: 0 absent, 1 + c present with payload code c. */
const cellCode = (constant: ObjectName, index: Expr, width: number): Expr =>
	cast(cellAt(constant, index, width), types.integer)

/**
 * A set's member, a cell of one bit that reads as the integer 1: a code is live, or a tuple is in a set. A cell past the
 * last reads padding or nothing, 0 either way, so no range check is needed.
 */
export const inSet = (constant: ObjectName, index: Expr): Expr =>
	eq(cellCode(constant, index, 1), int(1))

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

/** A code's name, read from its roster's names constant: (names())[code + 1]::text, a hole the empty name. */
export const nameOf = (names: ObjectName, code: Expr): Expr =>
	cast({ kind: "subscript", array: constantValue(names), index: plus(code, int(1)) }, types.text)

/**
 * A closed relation's constant as the migration states it: `cells` cells of `width` bits, its literal `hex`, the host's
 * encoding of its cells (ir/cells.ts literalOf), with the count of rows it holds and its content's digest. The caller
 * checks the relation's key before it encodes (ir/cells.ts constantOf), and every reader computes the index from the
 * key's codes in SQL (cellOfKey), so each read checks the host's encoder against PostgreSQL's arithmetic.
 */
export const pack = (
	fn: ObjectName,
	cells: bigint,
	width: number,
	literal: { readonly hex: string; readonly rows: number; readonly digest: string }
): PackConstant => ({ kind: "packConstant", function: fn, cells, width, ...literal })
