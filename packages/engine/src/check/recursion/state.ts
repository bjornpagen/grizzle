import type { CheckServices } from "#compiler/check/context.ts"
import { failRecursion } from "#compiler/check/fail.ts"
import type { ResolvedRecursive } from "#compiler/check/params.ts"
import { guarantees } from "#compiler/check/refinement/index.ts"
import { entries } from "#compiler/check/scan.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import type { InexactConversion, RecursionArm } from "#compiler/core/causes.ts"
import { CompileError } from "#compiler/core/errors.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { Heading, RelNode } from "#compiler/ir/rel.ts"
import {
	contractOf,
	numericTypmodOf,
	type ScalarType,
	sameScalarType,
	typeLabel
} from "#compiler/ir/scalar.ts"
import { exactOf, finiteEnds, insideRange } from "#compiler/scalar/compute/bounds.ts"
import { boundsOfType } from "#compiler/scalar/compute/lower.ts"
import { binaryCoercion, castOf } from "#compiler/scalar/compute/registry.ts"
import { compatible, isInteger, withoutSerial } from "#compiler/scalar/compute/types.ts"

/**
 * The recursive state heading: the declared row, its hashing capability, and the exact conversions an arm's columns
 * take to it.
 *
 * The explicit `row` is the state signature. It fixes each column's PostgreSQL type, precision and scale, refinement
 * and codec across feedback, so an arm never widens a recursive column silently and the recursion never rests on
 * PostgreSQL's choice of a seed literal's type. An arm's column converts to its declared column when the
 * two have one identity (carrier, contract, closed roster, vector dimensions: compatible) and the conversion
 * is exact:
 *
 * - the same type, which needs no conversion;
 * - a numeric typmod the declared column does not have, dropped: equality on numeric ignores the scale it displays;
 * - a text refinement the declared column does not have, dropped: every value of a narrower pattern is a text value.
 *
 * A conversion that can round or fail is not exact: another numeric typmod (a typmod cast rounds), or a declared text
 * refinement the arm does not already carry (a checked narrowing): the arm's pattern is the declared one when the two
 * recognize one language (refinement/index.ts guarantees), however each is spelled. Those, and every change of
 * identity (an integer arm for a bigint column, say), are MalformedDescription naming the column, so the author casts
 * with Compute.cast where the conversion is intended. An exact conversion becomes a projection over the arm that casts
 * the column, so base, step and feedback all carry the declared type; the lowering then casts each column to its base
 * representation.
 *
 * Every state column needs the hashing capability, because PostgreSQL deduplicates a recursive UNION only by hashing
 * and refuses an unhashable column with 0A000: a money or vector column is UnsupportedOperation (unhashableState) at
 * admission.
 *
 * The declared row in canonical code-unit order, each column at its value type (a serial declaration dropped).
 */
export const declaredRow = (
	def: ResolvedRecursive,
	at: SourceLoc,
	cx: CheckServices
): ReadonlyMap<string, ScalarType> => {
	const row = new Map<string, ScalarType>()
	for (const [name, desc] of entries(def.row)) {
		const loc = childLoc(childLoc(at, "row"), name)
		const type = withoutSerial(cx.fieldType(desc, loc))
		requireHashing(def.name, name, type, loc)
		row.set(name, type)
	}
	return row
}

export const requireHashing = (
	recursion: string,
	column: string,
	type: ScalarType,
	loc: SourceLoc
): void => {
	if (!type.caps.includes("hashing")) {
		failRecursion(loc, {
			kind: "unhashableState",
			recursion,
			column,
			type: typeLabel(type)
		})
	}
}

/**
 * How an arm's column of type `arm` reaches a declared column of type `declared`: unchanged, by an exact cast, or
 * refused with the reason.
 */
type Conversion =
	| { readonly kind: "same" }
	| { readonly kind: "cast" }
	| { readonly kind: "narrow" }
	| { readonly kind: "refused"; readonly conversion: InexactConversion }

/**
 * One identity and typmod: what the arm's values may still lack is the declared text refinement.
 */
const conversion = (arm: ScalarType, declared: ScalarType): Conversion => {
	const a = withoutSerial(arm)
	const d = withoutSerial(declared)
	if (sameScalarType(a, d)) {
		return { kind: "same" }
	}
	if (a.carrier === "exactInteger" && contractOf(d) === undefined && isInteger(d)) {
		return { kind: "narrow" }
	}
	if (!compatible(a, d)) {
		return { kind: "refused", conversion: "anotherType" }
	}
	const dt = numericTypmodOf(d)
	const at = numericTypmodOf(a)
	if (dt !== undefined && (at?.precision !== dt.precision || at.scale !== dt.scale)) {
		return { kind: "refused", conversion: "anotherTypmod" }
	}
	if (!guarantees(a, d)) {
		return { kind: "refused", conversion: "unprovedRefinement" }
	}
	return { kind: "cast" }
}

/**
 * An exact integer an arm computes for an integer state column, narrowed into it with the proof the recursion's
 * bounded counter gives (lower/shapes/recursion/bound.ts counterInterval): every value its step computes, the one
 * past its bound included, which PostgreSQL may compute before the step's filter, lies in the column's range. Without
 * one it is PartialOperation, naming the guard to write.
 */
const counterNarrowing = (
	cx: CheckServices,
	read: ScalarExpr,
	target: Heading[number],
	counters: ReadonlyMap<string, readonly [bigint, bigint]>,
	loc: SourceLoc
): ScalarExpr => {
	const carrier = withoutSerial(target.type).carrier
	const op = castOf("exactInteger", carrier)
	const interval = counters.get(target.name)
	const range = boundsOfType(target.type)
	const ends = range === undefined ? undefined : finiteEnds(range)
	const fits =
		interval !== undefined &&
		ends !== undefined &&
		insideRange(exactOf(interval[0], 0), exactOf(interval[1], 0), ends[0], ends[1])
	if (op === undefined || !op.partial || interval === undefined || !fits) {
		throw new Refusal(
			CompileError.make({
				_tag: "PartialOperation",
				at: loc,
				operation: `the recursion's ${target.name}, narrowed into ${typeLabel(target.type)}`,
				precondition: "fits",
				operand: target.name,
				guard: `Compute.when(Compute.within(${target.name}, <low>, <high>), (${target.name}) => Compute.cast(<the step>, <the state field>), <your value>), or a counter bound by a literal the step's filter compares it with`
			})
		)
	}
	return cx.builder.expr({
		kind: "cast",
		cast: op.id,
		args: [read],
		type: target.type,
		nonNull: "strict",
		volatility: op.volatility,
		proof: {
			precondition: { kind: "fits" },
			premises: [
				{
					kind: "interval",
					operand: 0,
					low: exactOf(interval[0], 0),
					high: exactOf(interval[1], 0)
				}
			]
		}
	})
}

/**
 * A node over `arms` delivering exactly `state`: unchanged when every column already has its state type, otherwise a
 * projection casting the columns that convert exactly. `loc` names the arm, or the arms when they are several.
 */
export const conform = (
	cx: CheckServices,
	recursion: string,
	node: RelNode,
	state: Heading,
	side: RecursionArm,
	loc: SourceLoc,
	counters: ReadonlyMap<string, readonly [bigint, bigint]>
): RelNode => {
	const heading = node.heading
	const stateHeading = (): never =>
		failRecursion(loc, {
			kind: "stateHeading",
			recursion,
			arm: side,
			state: state.map((c) => c.name),
			heading: heading.map((c) => c.name)
		})
	if (heading.length !== state.length) {
		stateHeading()
	}
	/** Each state column with the arm's column of its name. */
	const columns = state.map((target) => ({
		target,
		column: heading.find((c) => c.name === target.name) ?? stateHeading()
	}))
	let changed = false
	for (const { target, column } of columns) {
		const c = conversion(column.type, target.type)
		if (c.kind === "refused") {
			failRecursion(loc, {
				kind: "inexactConversion",
				recursion,
				arm: side,
				column: target.name,
				delivered: typeLabel(column.type),
				declared: typeLabel(withoutSerial(target.type)),
				conversion: c.conversion
			})
		}
		if (c.kind === "cast" || c.kind === "narrow") {
			changed = true
		}
	}
	if (!changed) {
		return node
	}
	const out = columns.map(({ target, column }) => {
		const read = cx.builder.expr({
			kind: "column",
			column: { node: node.id, name: column.name },
			args: [],
			type: column.type,
			nonNull: "storage"
		})
		if (sameScalarType(withoutSerial(column.type), target.type)) {
			return { name: target.name, expr: read }
		}
		if (column.type.carrier !== "exactInteger") {
			return {
				name: target.name,
				expr: cx.builder.expr({
					kind: "cast",
					cast: binaryCoercion,
					args: [read],
					type: target.type,
					nonNull: "strict",
					volatility: "immutable"
				})
			}
		}
		return { name: target.name, expr: counterNarrowing(cx, read, target, counters, loc) }
	})
	return cx.node({ kind: "ProjectSet", input: node, out, heading: state }, loc)
}
