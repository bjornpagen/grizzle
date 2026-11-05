import { Refusal } from "#compiler/core/canonical.ts"
import { CompileError, type ProseTag, prose, resourceBound } from "#compiler/core/errors.ts"
import { type LawId, makeIdSupply } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type * as Result from "#compiler/core/result.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { CatalogOpId, ExprSpec, TypedLiteral, ScalarExpr } from "#compiler/ir/expr.ts"
import { headingColumns, type LawField, type TheoryRelation } from "#compiler/ir/law.ts"

import {
	type AggregateCallOver,
	conservativeMeta,
	type FoldInput,
	type HeadingColumn,
	type NodeSpec,
	type Occurrence,
	type RelNode,
	type VarDecl
} from "#compiler/ir/rel.ts"
import {
	baseOf,
	type NumericBound,
	numericMaxIntegerDigits,
	type ScalarType,
	type SpanCarrier,
	sameScalarType
} from "#compiler/ir/scalar.ts"
import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import {
	binaryCoercion,
	castOf,
	definedRangeOp,
	overloadOf
} from "#compiler/scalar/compute/registry.ts"
import {
	commonType,
	exactNumericBound,
	numericHull,
	type PlainCarrier,
	plainType,
	valueType
} from "#compiler/scalar/compute/types.ts"
import { numericValue } from "#compiler/scalar/registry.ts"

/** A refusal deep inside a construction is the kernel's Refusal, caught at the theory boundary (catchRefusal). */
const refusal = (tag: ProseTag, loc: SourceLoc, capability: string): Refusal =>
	new Refusal(CompileError.make(prose(tag, loc, capability)))

/** Throws the refusal: a function declaration, so control flow knows a call never returns. */
export function refuse(tag: ProseTag, loc: SourceLoc, capability: string): never {
	throw refusal(tag, loc, capability)
}

export const unwrapOr = <A>(result: Result.Result<A, CompileError>): A => {
	if (!result.ok) {
		throw new Refusal(result.error)
	}
	return result.value
}

const plainCarriers: ReadonlyArray<PlainCarrier> = [
	"int2",
	"int4",
	"int8",
	"float4",
	"float8",
	"money",
	"bool"
]

const boolType = plainType("bool")

type NativeName = Parameters<typeof overloadOf>[0]

/** A selector a scan fixes: the handle of the field it selects, and its literal at that field's type. */
export interface ScanSelector {
	readonly col: LawField
	readonly value: TypedLiteral
}

/**
 * A field of a self-join's relation as its two scans bind it: one column of its own name for both when the scans share
 * it, else one per scan, `#1` and `#2`. Each is of the field's type.
 */
export interface FieldPair {
	readonly left: HeadingColumn
	readonly right: HeadingColumn
}

/** A self-join (ViolationBuilder.selfJoin): its region, and each field's pair of columns there. */
export interface SelfJoin {
	readonly node: RelNode
	readonly pair: (field: LawField) => FieldPair
}

/**
 * A column two projections of a two-sided law both hold: its column in each, of the one type the projections cast their
 * fields to. `metColumn` is its one constructor, so both columns are of that type.
 */
export interface Met {
	readonly left: HeadingColumn
	readonly right: HeadingColumn
}

/** The met column of `type` under its name on each side. */
export const metColumn = (type: ScalarType, left: string, right: string): Met => ({
	left: { name: left, type },
	right: { name: right, type }
})

/** A column of a join's left projection: one a met column of the spec meets on, or one of its own. */
export type JoinColumn =
	| { readonly kind: "met"; readonly met: Met }
	| { readonly kind: "own"; readonly column: HeadingColumn }

/** A group's aggregate: its column, its call and its catalogue operator. */
interface GroupAggregate {
	readonly column: HeadingColumn
	readonly call: AggregateCallOver<ScalarExpr>
	readonly op: CatalogOpId
}

/**
 * The fold input of a scan of a relation's facts, every field bound (ViolationBuilder.scan), under any filters: each
 * scanned fact read once by its source's primary key, which the scan binds. Any other input is a defect of the
 * builder.
 */
const scannedFacts = (input: RelNode, columns: ReadonlyArray<string>): FoldInput => {
	const region = input.kind === "Filter" ? input.input : input
	if (region.kind !== "MatchRegion") {
		throw defect(`a violation fold over a scan of facts, not over ${region.kind}`)
	}
	return {
		columns,
		keyed: region.occurrences.map((o) => {
			const key =
				o.source.kind === "Base" ? o.source.primaryKey : o.source.heading.map((c) => c.name)
			if (!key.every((f) => o.bindings.some((b) => b.column === f))) {
				throw defect(`a violation fold whose scan binds its facts' key (${key.join(", ")})`)
			}
			return { occurrence: o.id, key }
		})
	}
}

/**
 * The relational IR the theory's violation queries are written in.
 *
 * Every law is one Forbid node over a violation query that must be empty (rel.ts). This builder writes those queries
 * over the owned schema's relations: one Base or Closed source per scan, one MatchRegion per rule, typed literals and
 * native operators resolved through the Compute catalogue (scalar/compute/registry.ts), so a violation query never
 * invents an OpId and is validated by DagBuilder.build like any other DAG. Two operand columns of compatible but not
 * identical types (a numeric typmod, a regex refinement, a serial declaration, a contract) meet as the common value
 * type through an unchecked, identity-preserving cast, because the compiler never adds a cast that could
 * change a value and two incompatible fields never meet at all (theory/classes.ts).
 *
 * A column is read by its handle, never found by name: a field a scan binds under its own name is its own handle, and
 * every other column is one the op that built its node hands back or one its caller's spec states. Two scans meet only
 * through a self-join, on one field's variable, or a join of two projections built from one met-column spec, so the
 * columns they meet on are of one type by construction.
 */
export class ViolationBuilder {
	readonly b = new DagBuilder(makeIdSupply())
	readonly loc: SourceLoc

	constructor(loc: SourceLoc) {
		this.loc = loc
	}

	expr(spec: ExprSpec): ScalarExpr {
		return this.b.expr(spec)
	}

	/** The column `column` of `node`, a handle of it the caller holds, read at its own type. */
	col(node: RelNode, column: HeadingColumn): ScalarExpr {
		return this.expr({
			kind: "column",
			column: { node: node.id, name: column.name },
			args: [],
			type: column.type,
			nonNull: "storage"
		})
	}

	/** The typed literal of `value` at `type`; a value that is not one is MalformedDescription. */
	literal(value: LiteralDesc, type: ScalarType, what: string): ScalarExpr {
		const typed = irLiteral(value, type)
		if (!typed.ok) {
			return refuse("MalformedDescription", this.loc, `${what}: ${typed.error}`)
		}
		return this.typed(typed.value.literal, type)
	}

	/** A literal already typed at `type`. */
	typed(literal: TypedLiteral, type: ScalarType): ScalarExpr {
		return this.expr({ kind: "literal", value: literal, args: [], type, nonNull: "literal" })
	}

	bool(value: boolean): ScalarExpr {
		return this.literal(value, boolType, "a boolean literal")
	}

	/** One native operator or function over its operands' carriers. */
	op(fn: NativeName, args: NonEmptyReadonlyArray<ScalarExpr>): ScalarExpr {
		const types = args.map((a) => a.type)
		const carriers =
			fn === "and" || fn === "or" || fn === "not"
				? ["bool" as const]
				: types.map((t) => baseOf(t).carrier)
		const native = overloadOf(fn, carriers)
		if (native === undefined) {
			return refuse(
				"UnsupportedOperation",
				this.loc,
				`a native ${fn} over ${carriers.join(", ")} (the Compute catalogue)`
			)
		}
		if (native.partial || native.totality.kind === "exact") {
			return refuse(
				"UnsupportedOperation",
				this.loc,
				`a native ${fn} over ${carriers.join(", ")} defined on every value at its own type: a law's violation query computes only comparisons, connectives and numeric differences`
			)
		}
		const plain = plainCarriers.find((c) => c === native.result)
		const result: ScalarType =
			native.result === "numeric"
				? this.numericDifference(fn, types)
				: plain === undefined
					? args[0].type
					: plainType(plain)
		return this.expr({
			kind: "op",
			op: native.id,
			args,
			type: result,
			nonNull: "strict",
			volatility: native.volatility
		})
	}

	/**
	 * A range operator by its pg_operator.oprcode at the left span's carrier, the identity the span plug-ins lower: the
	 * carrier the caller resolved when it found the span.
	 */
	rangeOp(
		code: "range_overlaps" | "range_contains",
		carrier: SpanCarrier,
		left: ScalarExpr,
		right: ScalarExpr
	): ScalarExpr {
		return this.expr({
			kind: "op",
			op: definedRangeOp(code, carrier),
			args: [left, right],
			type: boolType,
			nonNull: "strict",
			volatility: "immutable"
		})
	}

	not(p: ScalarExpr): ScalarExpr {
		return this.op("not", [p])
	}

	/**
	 * A conjunction or disjunction of any number of predicates: the neutral literal for none, the predicate itself for
	 * one, and the native connective for two or more.
	 */
	connective(fn: "and" | "or", ps: ReadonlyArray<ScalarExpr>): ScalarExpr {
		const [only, ...more] = ps
		if (only === undefined) {
			return this.bool(fn === "and")
		}
		if (more.length === 0) {
			return only
		}
		return this.op(fn, [only, ...more])
	}

	/** An identity-preserving cast to `type` when the expression's type is not already it. */
	as(e: ScalarExpr, type: ScalarType): ScalarExpr {
		if (sameScalarType(e.type, type)) {
			return e
		}
		return this.expr({
			kind: "cast",
			cast: binaryCoercion,
			args: [e],
			type,
			nonNull: "strict",
			volatility: "immutable"
		})
	}

	/**
	 * The computed numeric a law's numeric sum or difference is: its operands' bounds' hull, one integer digit more,
	 * refused as ResourceBound past numeric's integer digits. A violation query computes no other numeric operation.
	 */
	numericDifference(fn: NativeName, types: ReadonlyArray<ScalarType>): ScalarType {
		if (fn !== "add" && fn !== "sub") {
			return refuse(
				"UnsupportedOperation",
				this.loc,
				`a native ${fn} over numeric: a law's violation query computes only numeric differences`
			)
		}
		const bounds = types.map((t) => this.numericBound(t))
		const hull = bounds.reduce(numericHull, { digits: 0, scale: 0 })
		const digits = hull.digits + 1
		if (digits > numericMaxIntegerDigits.value) {
			throw new Refusal(
				resourceBound(this.loc, {
					kind: "numericDigits",
					limit: numericMaxIntegerDigits.value,
					needed: digits
				})
			)
		}
		return numericValue({ digits, scale: hull.scale })
	}

	/** The bound of `t`'s values converted into numeric exactly, or the refusal of a type with none. */
	numericBound(t: ScalarType): NumericBound {
		return (
			exactNumericBound(t) ??
			refuse(
				"UnsupportedOperation",
				this.loc,
				`a numeric of an integer, money or numeric; a law compares no ${baseOf(t).carrier} in numeric`
			)
		)
	}

	/**
	 * The native cast to a plain carrier or to numeric, or the identity-preserving cast to the value type when the
	 * carrier is already that one: a widening, defined on every value, since a law compares in the wider carrier; a
	 * partial cast is refused, as it would need a proof no law states. A numeric is the computed numeric of the value's
	 * exact bound.
	 */
	toCarrier(e: ScalarExpr, target: PlainCarrier | "numeric"): ScalarExpr {
		const source = baseOf(e.type).carrier
		const type = target === "numeric" ? numericValue(this.numericBound(e.type)) : plainType(target)
		if (source === target) {
			return this.as(e, type)
		}
		const native = castOf(source, target)
		if (native === undefined || native.partial) {
			return refuse(
				"UnsupportedOperation",
				this.loc,
				`a native cast from ${source} to ${target} defined on every value`
			)
		}
		return this.expr({
			kind: "cast",
			cast: native.id,
			args: [this.as(e, valueType(e.type))],
			type,
			nonNull: "strict",
			volatility: native.volatility
		})
	}

	node(spec: NodeSpec): RelNode {
		return this.b.node(spec)
	}

	/** A fresh scan of a relation: a Base over its table, or the typed VALUES relation of a closed relation's facts. */
	source(r: TheoryRelation): RelNode {
		if (r.kind === "closed") {
			return this.node({
				kind: "Closed",
				closed: r.name,
				rows: r.rows,
				heading: headingColumns(r.fields),
				loc: undefined,
				meta: conservativeMeta
			})
		}
		return this.node({
			kind: "Base",
			relation: r.name,
			occurrence: this.b.ids.occurrence(),
			primaryKey: r.primaryKey,
			keys: r.keys,
			relationKind: "relation",
			heading: headingColumns(r.fields),
			loc: undefined,
			meta: conservativeMeta
		})
	}

	/** A fresh variable of `column`'s name and type. */
	#var(column: HeadingColumn): VarDecl {
		return Object.freeze({ id: this.b.ids.var(), name: column.name, type: column.type })
	}

	/** The region of `vars`, its heading, over `occurrences`. */
	#region(vars: ReadonlyArray<VarDecl>, occurrences: ReadonlyArray<Occurrence>): RelNode {
		return this.node({
			kind: "MatchRegion",
			scope: this.b.ids.scope(),
			vars,
			occurrences,
			equalities: [],
			correlated: [],
			heading: vars.map((v) => ({ name: v.name, type: v.type })),
			loc: undefined,
			meta: conservativeMeta
		})
	}

	/**
	 * A scan of `r`: one region of one occurrence binding each of `fields`, once, to a variable of its name and type, and
	 * fixing each selector's field to its literal. Each field bound is its own handle of a column of the region.
	 */
	scan(
		r: TheoryRelation,
		fields: ReadonlyArray<LawField>,
		selection: ReadonlyArray<ScanSelector>
	): RelNode {
		const source = this.source(r)
		const id = this.b.ids.occurrence()
		const bindings = [...new Set(fields)].map((f) => ({ column: f.name, var: this.#var(f) }))
		const constants = selection.map((s) => ({
			column: s.col.name,
			expr: this.typed(s.value, s.col.type)
		}))
		return this.#region(
			bindings.map((b) => b.var),
			[{ id, source, bindings, constants }]
		)
	}

	/**
	 * The self-join of `r`: two scans binding every field of `r`, which share the one variable of each field of `shared`,
	 * its field's own column, and hold one variable per scan of every other. Every variable is of its field's type, so
	 * two scans meet only on columns of one type.
	 */
	selfJoin(r: TheoryRelation, shared: ReadonlySet<LawField>): SelfJoin {
		const pair = (f: LawField): FieldPair =>
			shared.has(f)
				? { left: f, right: f }
				: {
						left: { name: `${f.name}#1`, type: f.type },
						right: { name: `${f.name}#2`, type: f.type }
					}
		const left = this.source(r)
		const leftId = this.b.ids.occurrence()
		const firsts = r.fields.map((field) => ({ field, left: this.#var(pair(field).left) }))
		const right = this.source(r)
		const rightId = this.b.ids.occurrence()
		/** Each field's second variable: its first when the scans share it, else a fresh one of its own. */
		const bound = firsts.map((p) => {
			if (shared.has(p.field)) {
				return { ...p, right: p.left, fresh: [] }
			}
			const second = this.#var(pair(p.field).right)
			return { ...p, right: second, fresh: [second] }
		})
		const node = this.#region(
			[...firsts.map((p) => p.left), ...bound.flatMap((p) => p.fresh)],
			[
				{
					id: leftId,
					source: left,
					bindings: bound.map((p) => ({ column: p.field.name, var: p.left })),
					constants: []
				},
				{
					id: rightId,
					source: right,
					bindings: bound.map((p) => ({ column: p.field.name, var: p.right })),
					constants: []
				}
			]
		)
		return { node, pair }
	}

	/**
	 * The join of two projections built from one met-column spec: a region whose variables are `left`'s columns, in its
	 * order, each met column's binding its right column too, then `rightOwn`, the right projection's columns no met
	 * column holds. A met column's variable is of its one type, which both its columns are of.
	 */
	join(
		left: RelNode,
		columns: ReadonlyArray<JoinColumn>,
		right: RelNode,
		rightOwn: ReadonlyArray<HeadingColumn>
	): RelNode {
		const leftId = this.b.ids.occurrence()
		const bound = columns.map((c) => {
			const column = c.kind === "met" ? c.met.left : c.column
			const v = this.#var(column)
			return {
				left: { column: column.name, var: v },
				right: c.kind === "met" ? [{ column: c.met.right.name, var: v }] : []
			}
		})
		const rightId = this.b.ids.occurrence()
		const own = rightOwn.map((c) => ({ column: c.name, var: this.#var(c) }))
		return this.#region(
			[...bound.map((b) => b.left.var), ...own.map((b) => b.var)],
			[
				{ id: leftId, source: left, bindings: bound.map((b) => b.left), constants: [] },
				{
					id: rightId,
					source: right,
					bindings: [...bound.flatMap((b) => b.right), ...own],
					constants: []
				}
			]
		)
	}

	filter(input: RelNode, pred: ScalarExpr): RelNode {
		return this.node({
			kind: "Filter",
			input,
			pred,
			heading: input.heading,
			loc: undefined,
			meta: conservativeMeta
		})
	}

	/** find: each output a column of the input, or an expression with the type it computes. */
	project(input: RelNode, out: ReadonlyArray<readonly [string, ScalarExpr]>): RelNode {
		return this.node({
			kind: "ProjectSet",
			input,
			out: out.map(([name, expr]) => ({ name, expr })),
			heading: out.map(([name, expr]) => ({ name, type: expr.type })),
			loc: undefined,
			meta: conservativeMeta
		})
	}

	/**
	 * The aggregate of the complete bound tuple `bound`, grouped by `keys`, each a column of the input. The heading is the
	 * group keys then the aggregates, each its own column. The input is the facts of one relation (sideFacts): a scan
	 * binding every field, filtered or not, so the bound tuple holds each fact's primary key and the fold reads each fact
	 * once (FoldInput).
	 */
	group(
		input: RelNode,
		bound: ReadonlyArray<HeadingColumn>,
		keys: ReadonlyArray<HeadingColumn>,
		aggs: ReadonlyArray<GroupAggregate>
	): RelNode {
		return this.node({
			kind: "Group",
			input,
			bound: scannedFacts(
				input,
				bound.map((c) => c.name)
			),
			keys: keys.map((c) => c.name),
			aggs: aggs.map((a) => ({ name: a.column.name, op: a.op, filter: undefined, ...a.call })),
			heading: [
				...keys.map((c) => ({ name: c.name, type: c.type })),
				...aggs.map((a) => ({ name: a.column.name, type: a.column.type }))
			],
			loc: undefined,
			meta: conservativeMeta
		})
	}

	/**
	 * spanPack: the maximal covered segments of the input's `span` column per group of its `carried` columns, each
	 * segment its column `out` of the span's type.
	 */
	pack(
		input: RelNode,
		span: HeadingColumn,
		carried: ReadonlyArray<HeadingColumn>,
		out: string
	): { readonly node: RelNode; readonly out: HeadingColumn } {
		const segment = { name: out, type: span.type }
		const node = this.node({
			kind: "Produce",
			input,
			producer: "spanPack",
			args: [this.col(input, span)],
			carried: carried.map((c) => c.name),
			out,
			heading: [...carried.map((c) => ({ name: c.name, type: c.type })), segment],
			loc: undefined,
			meta: conservativeMeta
		})
		return { node, out: segment }
	}

	/** The left's rows with no right row agreeing with it on every met column of `on`. */
	anti(left: RelNode, right: RelNode, on: ReadonlyArray<Met>): RelNode {
		return this.node({
			kind: "AntiJoin",
			left,
			right,
			on: on.map((m) => ({ left: m.left.name, right: m.right.name })),
			heading: left.heading,
			loc: undefined,
			meta: conservativeMeta
		})
	}

	difference(left: RelNode, right: RelNode): RelNode {
		return this.node({
			kind: "Difference",
			left,
			right,
			heading: left.heading,
			loc: undefined,
			meta: conservativeMeta
		})
	}

	/** A union of arms of one heading: one heading group, no discriminant. */
	union(arms: NonEmptyReadonlyArray<RelNode>): RelNode {
		const [first, ...rest] = arms
		if (rest.length === 0) {
			return first
		}
		const heading = first.heading
		return this.node({
			kind: "Union",
			groups: [{ heading, arms }],
			discriminant: [],
			heading,
			loc: undefined,
			meta: conservativeMeta
		})
	}

	forbid(lawId: LawId, violation: RelNode): RelNode {
		return this.node({
			kind: "Forbid",
			lawId,
			violation,
			heading: violation.heading,
			loc: undefined,
			meta: conservativeMeta
		})
	}
}

/**
 * The type two compatible operand columns meet as: their common value type, the serial declaration and every
 * contract dropped, with a numeric typmod or a regex refinement widened when they differ.
 */
export const meetType = (a: ScalarType, b: ScalarType): ScalarType =>
	commonType(valueType(a), valueType(b))
