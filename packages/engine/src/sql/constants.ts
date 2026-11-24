import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type {
	Expr,
	ObjectName,
	PackConstant,
	PackLayout,
	QualifiedFunctionRef,
	TypeRef
} from "#compiler/sql/ast.ts"
import { and, binary, call, cast, eq, lit, lt, qualifiedCall, types } from "#compiler/sql/build.ts"

/**
 * The builders of the installation's constants, over sql/ast.ts Expr and its statements, which sql/print.ts prints. A
 * closed relation, and every closed side a law or query reads, compiles to two parallel sorted arrays (ir/cells.ts
 * Constant), each the body of an IMMUTABLE SQL function named by its contents, so a changed relation is a new function
 * and never a function replaced in place: its cells, the sentinel -1 then the index K of every row, ascending, K the
 * index its key gives its codes (ClosedKey), their row-major mixed radix over a product of closed ids, or over a
 * dependent sum its owner's base plus its block's mixed radix at the owner's own counts; and, where its payload space
 * holds more than one code, its payloads, every row's payload code in the same order.
 *
 * This module builds what reads and installs those arrays: a read finds the greatest index at or below K by
 * width_bucket, PostgreSQL's binary search over a sorted array, O(log n) in the relation's rows, the key is held exactly
 * where that index is K, and its payload is the payloads' element at the same position; and the migration statements
 * that state a relation's arrays as their literals. Every index and payload code is bigint arithmetic, so the one bound
 * on either is bigint's own.
 */

/** A key coordinate a closed read addresses by a closed id's code: its field, and its radix, the size of its roster's
 * code space, holes included. */
export interface ClosedCoordinate {
	readonly field: string
	readonly radix: number
}

/**
 * A constant's payloads as its readers address them: none to read where its payload space holds one code, every held
 * cell's payload being code 0 (`one`), or the function of its payload codes, parallel to its cells (`codes`).
 */
export type Payloads<F = ObjectName> =
	| { readonly kind: "one" }
	| { readonly kind: "codes"; readonly function: F }

/**
 * A constant's installed functions: its cells', every held index ascending after the sentinel, and its payloads'
 * (Payloads). F is how each function is named (ClosedConstant).
 */
export interface ConstantFunctions<F = ObjectName> {
	readonly cells: F
	readonly payloads: Payloads<F>
}

/**
 * A function of a dependent key's owner, installed as a closed relation over the owner prefix (ConstantFunctions): the
 * owner's value, a block's first cell or one count, is its payload at the owner's index, for every owner of the
 * prefix's product, so it never reads absent at a code its domain admits.
 */
type OwnerFunction<F = ObjectName> = ConstantFunctions<F>

/**
 * How a closed relation's key indexes its cells:
 *
 * - a product of closed ids, in mixed radix, row-major in key order;
 * - a dependent sum over the owner prefix `owner`: the owner's index is the mixed radix of the prefix's codes, its
 *   block the mixed radix of the block's coordinates at the radices the owner gives them, a closed id's size or, for a
 *   slot, the owner's count `count` (`counts[count]`), and the cell the owner's base (`bases`) plus that. A slot code
 *   at or past its owner's count reads the cell `cells`, past the key space, so it reads absent instead of aliasing the
 *   owner's next slot or the next owner's block.
 */
export type ClosedKey<F = ObjectName> =
	| { readonly kind: "product"; readonly coordinates: NonEmptyReadonlyArray<ClosedCoordinate> }
	| {
			readonly kind: "dependent"
			readonly owner: NonEmptyReadonlyArray<ClosedCoordinate>
			readonly block: NonEmptyReadonlyArray<
				| { readonly kind: "codes"; readonly field: string; readonly radix: number }
				| { readonly kind: "slots"; readonly field: string; readonly count: number }
			>
			readonly bases: OwnerFunction<F>
			readonly counts: NonEmptyReadonlyArray<OwnerFunction<F>>
			readonly cells: bigint
	  }

/**
 * A closed relation as its installed constants hold it, what a closed law's CHECK and a closed read read: its constant's
 * functions (ConstantFunctions), its cells at the index its key gives its key fields' codes (ClosedKey); its payload
 * fields in declared order, each with its radix and, for an open-typed field, the function of its dictionary, the
 * field's values in code order, none for a closed id, and for a str.pattern field the function of its ARE dictionary,
 * each value's ARE in that order; and every function a read of it calls, which each role that reads it is granted
 * EXECUTE on.
 *
 * F is how each function is named: by its ObjectName in the installation's schema, as a read calls it, or by its
 * identifier alone, as the snapshot records it (physical/ddl/constants.ts NamedClosed), every constant's name being its
 * content's digest whatever schema holds it.
 */
export interface ClosedConstant<F = ObjectName> {
	readonly constant: ConstantFunctions<F>
	readonly key: ClosedKey<F>
	readonly payload: ReadonlyArray<{
		readonly field: string
		readonly radix: number
		readonly dictionary: F | undefined
		/** A str.pattern field's ARE dictionary, each value's ARE in code order; none for any other field. */
		readonly are: F | undefined
	}>
	readonly functions: NonEmptyReadonlyArray<F>
}

/** An integer literal PostgreSQL types integer: a nonnegative one prints bare. */
const int = (value: number): Expr => lit.int(value, types.integer)

/** A bigint literal: a radix or a count of cells, which make every index's and payload code's arithmetic bigint. */
const big = (value: bigint | number): Expr => lit.int(value, types.bigint)

/** A constant's value: a call of its function with no arguments, F(). */
export const constantValue = (fn: ObjectName): Expr =>
	qualifiedCall(
		{ kind: "qualified", schema: fn.schema, name: fn.name, volatility: "IMMUTABLE" },
		[]
	)

const plus = (left: Expr, right: Expr): Expr => binary("+", left, right)

/** `e` times `factor`, in bigint: `e` itself for a factor of one. */
const times = (e: Expr, factor: number): Expr => (factor === 1 ? e : binary("*", e, big(factor)))

/** One coordinate of a tuple: its code, and the size of its code space, holes included. */
interface Coordinate {
	readonly digit: Expr
	readonly radix: number | Expr
}

/**
 * The row-major mixed-radix index of a tuple, ((k1 * r2 + k2) * r3 + k3) ...: Horner's rule over its coordinates in key
 * order, in bigint. The first coordinate's radix bounds the index and multiplies nothing. Every digit is below its
 * radix, which its field's type proves for a closed id and its read's range check for a slot, so no digit carries into
 * its neighbour and the index is in range.
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

/** A payload's mixed-radix code over its coordinates' codes, ((c1 * r2 + c2) * r3 + c3) ..., in bigint. */
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

/** An owner's value, its function's payload at the owner's index: it is never absent. */
const ownerValue = (f: OwnerFunction, owner: Expr): Expr => applied(f, owner)

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
			? big(c.radix)
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

/** `index` where every range check holds, and `cells`, the first cell past the key space, which reads absent, otherwise. */
const guarded = (checks: ReadonlyArray<Expr>, index: Expr, cells: bigint): Expr =>
	isNonEmpty(checks)
		? {
				kind: "case",
				operand: undefined,
				whens: [{ when: and(checks), result: index }],
				else: big(cells)
			}
		: index

/**
 * The cell of a full key's codes `digits`, one per key field in key order (closedKeyFields). Over a product, their
 * mixed radix; over a dependent sum, `CASE WHEN every slot code < its owner's count THEN base + block ELSE cells END`.
 * A slot code at or past its owner's count would carry into the owner's next slot or the next owner's block, so it
 * reads the first cell past the key space, which no entry holds: a set's membership is false there, an application
 * NULL. The block is computed only where its digits are in range, so its arithmetic never leaves the key space.
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
 * `value` unless a range check fails, where it is 0: a run's first cell and its count, so a prefix whose slot code is
 * past its owner's count reads the run of no cell, the empty set. A check is unknown only where a code it reads is NULL,
 * which makes the run's first cell NULL too, so the run reads NULL.
 */
const withinChecks = (checks: ReadonlyArray<Expr>, value: Expr): Expr =>
	isNonEmpty(checks)
		? {
				kind: "case",
				operand: undefined,
				whens: [{ when: { kind: "not", expr: and(checks) }, result: big(0) }],
				else: value
			}
		: value

/**
 * The completions of a key prefix in the closed relation whose cells' function is `cells`: the prefix's codes `prefix`,
 * every key field but the last, and the run of the last field's cells after it, as the set `row.empty` with one bit per
 * code of the last field set where the relation holds the completed key, which the library function `row.run` reads off
 * the cells (physical/ddl/library.ts closedRow). Over a product, the run of r cells from p * r, p the prefix's mixed
 * radix and r the last field's radix; over a dependent sum, its run at base + block * r, r a slot's count at the owner
 * or a closed id's size, and the run of no cell where a slot code of the prefix is past its owner's count
 * (withinChecks).
 */
const completions = (
	cells: ObjectName,
	row: Extract<ClosedRead, { readonly kind: "row" }>,
	key: ClosedKey,
	prefix: ReadonlyArray<Expr>
): Expr => {
	if (prefix.length !== closedKeyFields(key).length - 1) {
		throw defect("a closed row's prefix is every key field but the last")
	}
	const rowOf = (first: Expr, count: Expr): Expr =>
		qualifiedCall(row.run, [constantValue(cells), first, count, row.empty])
	if (key.kind === "product") {
		const last = defined(key.coordinates[prefix.length], "a prefix leaves one key field open")
		const coordinates = prefix.map((digit, i) => ({
			digit,
			radix: defined(key.coordinates[i], "a digit per prefix field").radix
		}))
		return rowOf(
			isNonEmpty(coordinates) ? times(mixedRadix(coordinates), last.radix) : big(0),
			big(last.radix)
		)
	}
	const reading = dependentReading(key, prefix)
	const length = defined(reading.next, "a prefix leaves its key's last block coordinate open")
	const start =
		reading.local === undefined
			? reading.base
			: plus(reading.base, binary("*", reading.local, length))
	return rowOf(withinChecks(reading.checks, start), withinChecks(reading.checks, length))
}

/**
 * A closed read: C.at's payload field `field`, a str.pattern field's ARE at a full key, which Text.matches reads
 * as its pattern, C.row's completions of a prefix, which the installation's library function `run` reads onto `empty`,
 * the empty set of the row's roster (physical/ddl/library.ts closedRow), or a membership test at a full key.
 */
export type ClosedRead =
	| { readonly kind: "at"; readonly field: string }
	| { readonly kind: "are"; readonly field: string }
	| { readonly kind: "row"; readonly run: QualifiedFunctionRef; readonly empty: Expr }
	| { readonly kind: "has" }

/**
 * A closed read over its relation's installed constants, its arguments the codes of the key fields it fixes, in key
 * order, as SQL, and `type` the type its value is cast to: a closed id's code or a set's domain.
 *
 * - C.at(field, k…): the payload code at k…'s index (applied), NULL where the relation holds no tuple at that key, never
 *   a code; `field`'s coordinate of that code is a closed id's code, cast to `type`, or an open-typed value read
 *   through its dictionary at code + 1.
 * - are(field, k…): a str.pattern field's code read as C.at reads it, through its ARE dictionary at code + 1: the
 *   pattern as the ARE `~` reads, translated where the constants were planned, so a match translates nothing as it runs.
 * - C.row(k…): the completions of the prefix k… (completions), set on the empty set at the set's width and cast to
 *   `type`, the set over the last key field's roster, so its holes and padding are 0: a prefix the relation completes
 *   nowhere reads the empty set, and a NULL code in it NULL, which the set's domain admits as every domain does
 *   (sql/print.ts).
 * - has(k…): whether the relation holds a tuple at k…'s index (held), false where it holds none and NULL where a code
 *   is NULL.
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
			? Result.ok(cast(completions(constant.constant.cells, read, constant.key, args), type))
			: Result.err(`${relation}.row over every key field of ${relation} but its last`)
	}
	if (!isNonEmpty(args) || args.length !== fields.length) {
		return Result.err(`${relation}.${read.kind} over every key field of ${relation}, in key order`)
	}
	const index = cellOfKey(constant.key, args)
	if (read.kind === "has") {
		return Result.ok(held(constant.constant.cells, index))
	}
	const position = constant.payload.findIndex((p) => p.field === read.field)
	const payload = constant.payload[position]
	if (payload === undefined) {
		return Result.err(`${relation}.at of a payload field of ${relation}; ${read.field} is none`)
	}
	const digit = payloadDigit(
		constant.constant,
		index,
		constant.payload.map((p) => p.radix),
		position
	)
	const dictionary = read.kind === "are" ? payload.are : payload.dictionary
	if (read.kind === "are" && dictionary === undefined) {
		return Result.err(
			`${relation}.at of a str.pattern field as a pattern; ${read.field} holds no patterns`
		)
	}
	return Result.ok(
		dictionary === undefined
			? cast(digit, type)
			: { kind: "subscript", array: constantValue(dictionary), index: plus(digit, int(1)) }
	)
}

/**
 * The position in the cells F of the greatest element at or below `index`: width_bucket(index, F()), PostgreSQL's
 * binary search over a sorted array, O(log n), the count of elements at or below it. The sentinel -1 is at or below every
 * index, so the position is at least 1, the sentinel's, where no held index is at or below `index`.
 */
const positionOf = (cells: ObjectName, index: Expr): Expr =>
	call("width_bucket", [index, constantValue(cells)])

/**
 * Whether the cells F hold the index `index`: the greatest element at or below it is it, F()[width_bucket(index, F())]
 * = index. A cell past either end has no element equal to it, so it reads false, and no range check is needed; a NULL
 * index reads NULL.
 */
export const held = (cells: ObjectName, index: Expr): Expr =>
	eq({ kind: "subscript", array: constantValue(cells), index: positionOf(cells, index) }, index)

/**
 * The payload code a constant's payloads hold for the element of its cells at or below `index`: 0 where its payload
 * space holds one code, and otherwise the payloads' element one before the cells' position, the sentinel holding none.
 * Read only where the cells hold `index`.
 */
const payloadAt = (constant: ConstantFunctions, index: Expr): Expr =>
	constant.payloads.kind === "one"
		? big(0)
		: {
				kind: "subscript",
				array: constantValue(constant.payloads.function),
				index: binary("-", positionOf(constant.cells, index), int(1))
			}

/** A key and its payload code are in the relation: its cells hold the key's index, and its payloads that code there. */
export const pairIn = (constant: ConstantFunctions, index: Expr, payload: Expr): Expr =>
	constant.payloads.kind === "one"
		? held(constant.cells, index)
		: and([held(constant.cells, index), eq(payloadAt(constant, index), payload)])

/** Whether the cells F hold `index` as an integer: 1 where they do, 0 where they do not, NULL at a NULL index. */
const heldBit = (cells: ObjectName, index: Expr): Expr => cast(held(cells, index), types.integer)

/**
 * A function's application to a key, its payload code, NULL where its cells hold no entry at the key: where its payload
 * space holds one code, `NULLIF(held::integer, 0) - 1`, 0 or NULL; otherwise its payloads at the cell's place times
 * `held::integer`, the place before the cells' position where the key is held and place 0, before the array's first,
 * NULL, where it is not. No CASE is stated: an absent key is NULL, never a code, so a lookup fed by it reads NULL
 * instead of a neighbour's payload, and the IS TRUE of a check refuses it.
 */
export const applied = (constant: ConstantFunctions, index: Expr): Expr =>
	constant.payloads.kind === "one"
		? binary("-", { kind: "nullif", expr: heldBit(constant.cells, index), absent: int(0) }, int(1))
		: {
				kind: "subscript",
				array: constantValue(constant.payloads.function),
				index: binary(
					"*",
					binary("-", positionOf(constant.cells, index), int(1)),
					heldBit(constant.cells, index)
				)
			}

/**
 * Payload coordinate `position` of the cell at `index`, among a payload of the coordinates `radices`: the cell's payload
 * code c (applied), then c / (the product of the radices after `position`) % (its own radix), in bigint. The division
 * is skipped where no coordinate follows, and the modulo for the first coordinate, whose quotient is already below its
 * radix. An absent key is NULL, never a code.
 */
export const payloadDigit = (
	constant: ConstantFunctions,
	index: Expr,
	radices: ReadonlyArray<number>,
	position: number
): Expr => {
	const after = radices.slice(position + 1).reduce((product, radix) => product * BigInt(radix), 1n)
	const code = applied(constant, index)
	const shifted = after === 1n ? code : binary("/", code, big(after))
	return position === 0
		? shifted
		: binary("%", shifted, big(defined(radices[position], "a payload coordinate's radix")))
}

/** A code's name, read from its roster's names constant: (names())[code + 1]::text, a hole the empty name. */
export const nameOf = (names: ObjectName, code: Expr): Expr =>
	cast({ kind: "subscript", array: constantValue(names), index: plus(code, int(1)) }, types.text)

/**
 * One array of a closed relation's constant as the migration states it (sql/ast.ts PackConstant): its layout, its
 * literal `text`, the host's encoding (ir/cells.ts cellsLiteralOf, payloadsLiteralOf), with the count of rows it holds
 * and its content's digest. The caller checks the relation's key before it encodes (ir/cells.ts constantOf), and every
 * reader computes the index from the key's codes in SQL (cellOfKey), so each read checks the host's encoder against
 * PostgreSQL's arithmetic.
 */
export const pack = (
	fn: ObjectName,
	layout: PackLayout,
	literal: { readonly text: string; readonly rows: number; readonly digest: string }
): PackConstant => ({ kind: "packConstant", function: fn, layout, ...literal })
