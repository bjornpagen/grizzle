/**
 * The IR builder the fixtures state their queries with.
 *
 * A fixture query is written as the checked relational IR the checker produces from the example's rule (one
 * MatchRegion per rule, a ProjectSet or Group for find, union arms grouped by heading, take, attach, recursion), so
 * the conservative lowering runs it without the query frontend. The builder takes every type from the fixture's
 * schema as ownership read it (test/support/evidence.ts ownedFixture): a stored relation's heading is its fields
 * resolved through scalarTypeOf and its keys are ownership's, a closed relation's is its handle and payload with its
 * declared facts as typed literal rows, and every operator is the Compute catalogue's native overload for its operands'
 * carriers (packages/engine/src/scalar/compute/registry.ts), so a fixture never invents an OpId. Every query is built through
 * DagBuilder, so it is validated before anything reads it.
 */
import { Array as Arr, Formatter, Option, Record as Rec } from "effect"
import {
	atomOperands,
	literalAtom,
	literalNegated,
	rangeOperatorCodes
} from "#compiler/allen/atoms.ts"
import { allenFormula } from "#compiler/allen/lower.ts"
import { AllenMask } from "#compiler/allen/mask.ts"
import { makeIdSupply, NodeId, ParamId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type * as Result from "#compiler/core/result.ts"
import { DagBuilder, type ReservedNode } from "#compiler/ir/builder.ts"
import { toCalendarDate } from "#compiler/ir/date.ts"
import { DecimalText, decimalPayload, isDecimalLike } from "#compiler/ir/decimal.ts"
import type { FieldDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import {
	type ExprSpec,
	OpId,
	type ParamRole,
	type ScalarExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import { type KeyProof, soleFactor } from "#compiler/ir/keys.ts"
import {
	type AggregateSpecOver,
	type CompletedOrder,
	conservativeMeta,
	type DeclaredKey,
	type Heading,
	type HeadingColumn,
	headingOrder,
	type KeySet,
	type MetaSpec,
	type NodeSpec,
	type RelNode,
	type TakeBound,
	type ValidDag,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { baseOf, Roster, type ScalarType, spanCarrierOf } from "#compiler/ir/scalar.ts"
import { type AggregateName, countOverload, unaryOverload } from "#compiler/scalar/aggregate.ts"
import {
	definedIdOf,
	definedRangeOp,
	type FixedFn,
	overloadOf
} from "#compiler/scalar/compute/registry.ts"
import {
	anyNumeric,
	exactType,
	familyDigits,
	plainType,
	wildcardText
} from "#compiler/scalar/compute/types.ts"
import { scalarTypeOf } from "#compiler/scalar/registry.ts"
import { defined } from "#test/support/assert.ts"
import type { OwnedFixture } from "#test/support/evidence.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { foldInputOf } from "#test/support/fixtures/ir/fold.ts"
import { isPlainCarrier } from "#test/support/fixtures/ir/scalar.ts"
import { castOpOf } from "#test/support/oracle/gen/ops.ts"

/** A built query: its validated DAG and the node whose result it delivers. */
export interface BuiltQuery {
	readonly dag: ValidDag
	readonly root: RelNode
}

const ok = <A, E>(result: Result.Result<A, E>): A => {
	if (!result.ok) {
		throw new Error(`fixture IR: ${Formatter.format(result.error)}`)
	}
	return result.value
}

/** A relation of the schema as the IR reads it. */
interface StoredRelation {
	readonly kind: "relation" | "derived"
	readonly name: string
	readonly heading: Heading
	readonly primaryKey: DeclaredKey
	readonly keys: ReadonlyArray<DeclaredKey>
}

/**
 * A roster, heading `id` and one row per handle, or a closed relation, heading its key fields then its payload in
 * declared order, as a Closed node reads it.
 */
interface ClosedRelation {
	readonly kind: "closed"
	readonly name: string
	readonly heading: Heading
	readonly rows: ReadonlyArray<ReadonlyArray<TypedLiteral>>
}

type SchemaRelation = StoredRelation | ClosedRelation

/**
 * A derived relation's inferred fields and inherited key, which field inference computes from the definition; a
 * fixture states them explicitly.
 */
interface DerivedShape {
	readonly fields: ReadonlyArray<readonly [string, ScalarType]>
	readonly key: DeclaredKey
}

/** A literal of the Description boundary as a typed IR literal of `type`. */
const literalOf = (value: LiteralDesc, type: ScalarType): TypedLiteral => {
	const base = baseOf(type)
	switch (base.carrier) {
		case "int2":
		case "int4":
		case "int8":
			if (typeof value === "bigint") {
				return { kind: "int", value }
			}
			if (typeof value === "number" && Number.isSafeInteger(value)) {
				return { kind: "int", value: BigInt(value) }
			}
			break
		case "numeric":
			if (typeof value === "bigint") {
				return { kind: "numeric", value: defined(DecimalText.parse(value.toString())) }
			}
			if (typeof value === "string") {
				return { kind: "numeric", value: defined(DecimalText.parse(value)) }
			}
			if (isDecimalLike(value)) {
				return { kind: "numeric", value: defined(DecimalText.parse(decimalPayload(value))) }
			}
			break
		case "bool":
			if (typeof value === "boolean") {
				return { kind: "bool", value }
			}
			break
		case "uuid":
			if (typeof value === "string") {
				return { kind: "uuid", value }
			}
			break
		case "text":
			if (typeof value === "string") {
				return { kind: "text", value }
			}
			break
		case "code":
			if (typeof value === "string") {
				return { kind: "handle", handle: value }
			}
			break
		case "bits":
			if (typeof value === "object" && "handles" in value) {
				return { kind: "handles", handles: value.handles }
			}
			break
		case "date": {
			/** A date's description is its ISO 8601 text, the one form of its day (ir/date.ts). */
			const day = toCalendarDate(value)
			if (day.ok) {
				return { kind: "date", value: day.value }
			}
			break
		}
		case "float4":
		case "float8":
		case "money":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "exactInteger":
		case "exactMoney":
		case "bytes":
			break
	}
	throw new Error(`fixture IR: no ${base.carrier} literal for ${typeof value}`)
}

/**
 * The relations of an owned fixture schema and its extension levels, typed: every relation, key and closed roster as
 * ownership read them, so a fixture ownership refuses never reaches a model.
 */
export class SchemaModel {
	readonly fixture: OwnedFixture
	readonly desc: SchemaDesc
	readonly relations: ReadonlyMap<string, SchemaRelation>
	readonly #rosters = new Map<string, Roster>()

	constructor(fixture: OwnedFixture, derived: Readonly<Record<string, DerivedShape>>) {
		this.fixture = fixture
		this.desc = fixture.desc
		const owned = Rec.values(fixture.owned.relations)
		for (const r of owned) {
			if (r.kind === "closed") {
				this.#rosters.set(r.name, new Roster(r.name, r.desc.handles))
			}
		}
		const relations = new Map<string, SchemaRelation>()
		for (const r of owned) {
			switch (r.kind) {
				case "relation":
					relations.set(r.name, {
						kind: "relation",
						name: r.name,
						heading: Arr.map(Rec.toEntries(r.desc.fields), ([name, d]) => ({
							name,
							type: this.fieldType(d.type, SourceLoc(`${r.name}.${name}`, []))
						})),
						primaryKey: Option.getOrThrowWith(
							Arr.findFirst(r.keys, (k) => k.primary),
							() => new Error(`fixture IR: no primary key of ${r.name}`)
						).fields,
						keys: Arr.map(
							Arr.filter(r.keys, (k) => !k.primary),
							(k) => k.fields
						)
					})
					break
				case "closed": {
					const heading: Heading = [
						{
							name: "id",
							type: this.fieldType(
								{ kind: "closedId", roster: r.name },
								SourceLoc(`${r.name}.id`, [])
							)
						}
					]
					relations.set(r.name, {
						kind: "closed",
						name: r.name,
						heading,
						rows: Arr.map(r.desc.handles, (handle) => [{ kind: "handle", handle }])
					})
					break
				}
				case "closedRelation": {
					const desc = r.desc
					const order = [
						...desc.key,
						...Arr.filter(Rec.keys(desc.fields), (name) => !desc.key.includes(name))
					]
					const heading: Heading = Arr.map(order, (name) => ({
						name,
						type: this.fieldType(
							defined(desc.fields[name], `${r.name}.${name}`),
							SourceLoc(`${r.name}.${name}`, [])
						)
					}))
					relations.set(r.name, {
						kind: "closed",
						name: r.name,
						heading,
						rows: Arr.map(desc.rows, (row, at) =>
							Arr.map(heading, (h) =>
								literalOf(defined(row[h.name], `${r.name} row ${at}.${h.name}`), h.type)
							)
						)
					})
					break
				}
				case "derived": {
					const shape = defined(derived[r.name], `the inferred shape of ${r.name}`)
					relations.set(r.name, {
						kind: "derived",
						name: r.name,
						heading: Arr.map(shape.fields, ([name, type]) => ({ name, type })),
						primaryKey: shape.key,
						keys: []
					})
					break
				}
			}
		}
		this.relations = relations
	}

	fieldType(desc: FieldDesc, loc: SourceLoc): ScalarType {
		return ok(
			scalarTypeOf(desc, { kind: "builder", roster: (name) => this.#rosters.get(name) }, loc)
		)
	}

	relation(name: string): SchemaRelation {
		const r = this.relations.get(name)
		if (r === undefined) {
			throw new Error(`fixture IR: no relation ${name}`)
		}
		return r
	}

	type(relation: string, field: string): ScalarType {
		return Option.getOrThrowWith(
			Arr.findFirst(this.relation(relation).heading, (h) => h.name === field),
			() => new Error(`fixture IR: no field ${relation}.${field}`)
		).type
	}
}

/**
 * The type a comparison parameter is bound as: the field's base, and plain text for a refined text. A parameter
 * compared with a refined field is never cast to the refinement's domain.
 */
const compareType = (t: ScalarType): ScalarType => {
	const base = baseOf(t)
	return base.carrier === "text" ? wildcardText : base
}

const fixtureError = (message: string): never => {
	throw new Error(message)
}

/**
 * One occurrence of a region: its source, its column-to-variable bindings, and its column constants, {} where it has
 * none.
 */
export interface OccurrenceSpec {
	readonly source: RelNode
	readonly bind: Readonly<Record<string, string>>
	readonly constants: Readonly<Record<string, ScalarExpr>>
}

/** An aggregate of a group: count(*) of the contributions, or a function of one argument. */
type AggregateSpec =
	| { readonly name: string; readonly agg: "count" }
	| {
			readonly name: string
			readonly agg: Exclude<AggregateName, "count">
			readonly arg: ScalarExpr
	  }

/** A region's heading, the node it defines, its correlated variables and its equalities. */
export interface RegionOptions {
	/** Every variable in order of first binding, or the named variables in order. */
	readonly heading:
		| { readonly kind: "bound" }
		| { readonly kind: "named"; readonly names: ReadonlyArray<string> }
	/** A fresh node, or the id reserved for it: a correlated source reads it before it is defined. */
	readonly id: { readonly kind: "fresh" } | { readonly kind: "reserved"; readonly id: ReservedNode }
	/** Variables fixed per evaluation by an outer expression. */
	readonly correlated: ReadonlyArray<{ readonly name: string; readonly expr: ScalarExpr }>
	/** Pairs of variables the region equates. */
	readonly equalities: ReadonlyArray<readonly [string, string]>
}

/**
 * The options of a plain region: every bound variable in its heading, a fresh node, nothing correlated or equated. A
 * region that states more spreads this.
 */
const plainRegion: RegionOptions = {
	heading: { kind: "bound" },
	id: { kind: "fresh" },
	correlated: [],
	equalities: []
}

/** The node a fixture's stated key names, which no fixture builds: a stated key has no node it was proved over. */
const statedNode = NodeId("stated")

/**
 * A key a fixture states of a node it builds, where a test hands a lowering the keys the logical analysis would prove:
 * a proof whose derivation is the statement alone, on no premise, over the node `stated`, which no key kernel reads.
 */
export const statedKey = (key: KeySet): KeyProof => ({
	node: statedNode,
	key,
	basis: { kind: "rows", implication: { node: statedNode, from: key, steps: [] } },
	members: [],
	factors: soleFactor(key),
	premises: [],
	context: "queryLocal"
})

export const asc = (...columns: ReadonlyArray<string>): CompletedOrder => ({
	keys: Arr.map(columns, (column) => ({ column, dir: "asc" as const }))
})

/** Whether two headings hold the same column names. */
const sameHeading = (a: Heading, b: Heading): boolean =>
	a.length === b.length && Arr.every(a, (c) => Arr.some(b, (d) => d.name === c.name))

export class Ir {
	readonly b = new DagBuilder(makeIdSupply())
	readonly model: SchemaModel

	constructor(model: SchemaModel) {
		this.model = model
	}

	column(node: RelNode, name: string): HeadingColumn {
		return Option.getOrThrowWith(
			Arr.findFirst(node.heading, (h) => h.name === name),
			() => new Error(`fixture IR: no column ${name} on ${node.id}`)
		)
	}

	#record(spec: ExprSpec): ScalarExpr {
		return this.b.expr(spec)
	}

	base(name: string): RelNode {
		const r = this.model.relation(name)
		if (r.kind === "closed") {
			return this.closed(name)
		}
		const base = {
			kind: "Base",
			relation: r.name,
			occurrence: this.b.ids.occurrence(),
			primaryKey: r.primaryKey,
			keys: r.keys,
			heading: r.heading,
			loc: undefined,
			meta: conservativeMeta
		} as const
		return this.b.node(
			r.kind === "derived"
				? { ...base, relationKind: "derived", view: [] }
				: { ...base, relationKind: "relation" }
		)
	}

	closed(name: string): RelNode {
		const r = this.model.relation(name)
		if (r.kind !== "closed") {
			throw new Error(`fixture IR: ${name} is not closed`)
		}
		return this.b.node({
			kind: "Closed",
			closed: r.name,
			rows: r.rows,
			heading: r.heading,
			loc: undefined,
			meta: conservativeMeta
		})
	}

	input(param: string, heading: ReadonlyArray<readonly [string, ScalarType]>): RelNode {
		return this.b.node({
			kind: "InputSet",
			input: { kind: "declared", param: ParamId(param) },
			heading: Arr.map(heading, ([name, type]) => ({ name, type })),
			loc: undefined,
			meta: conservativeMeta
		})
	}

	col(node: RelNode, name: string): ScalarExpr {
		return this.#record({
			kind: "column",
			column: { node: node.id, name },
			args: [],
			type: this.column(node, name).type,
			nonNull: "storage"
		})
	}

	/** A column of a node defined later under a reserved id: an outer variable a correlated source reads. */
	outerCol(node: NodeId, name: string, type: ScalarType): ScalarExpr {
		return this.#record({
			kind: "column",
			column: { node, name },
			args: [],
			type,
			nonNull: "storage"
		})
	}

	lit(value: LiteralDesc, type: ScalarType): ScalarExpr {
		return this.#record({
			kind: "literal",
			value: literalOf(value, type),
			args: [],
			type,
			nonNull: "literal"
		})
	}

	/** A literal compared with or written into a column of `type` takes the column's type. */
	litFor(node: RelNode, column: string, value: LiteralDesc): ScalarExpr {
		return this.lit(value, this.column(node, column).type)
	}

	param(name: string, type: ScalarType, role: ParamRole): ScalarExpr {
		return this.#record({
			kind: "param",
			param: ParamId(name),
			role,
			args: [],
			type: role === "compare" ? compareType(type) : type,
			nonNull: "codec"
		})
	}

	/**
	 * One native operator or function over its operands' carriers, defined on every value: an exact one types its result
	 * an exact integer or exact money of the operands' digits summed, a bound past its own (the checker's are tighter); a
	 * partial one needs its proof, which no fixture writes.
	 */
	op(fn: Exclude<FixedFn, "cast">, args: ReadonlyArray<ScalarExpr>): ScalarExpr {
		const types = Arr.map(args, (a) => a.type)
		const carriers =
			fn === "and" || fn === "or" ? ["bool" as const] : Arr.map(types, (t) => baseOf(t).carrier)
		const native = overloadOf(fn, carriers)
		if (native === undefined) {
			throw new Error(`fixture IR: no native ${fn}(${Arr.join(carriers, ", ")})`)
		}
		const id = definedIdOf(native)
		if (id === undefined) {
			throw new Error(
				`fixture IR: ${fn}(${Arr.join(carriers, ", ")}) is partial; a fixture writes no proof`
			)
		}
		const [first] = types
		const digits = Arr.reduce(types, 1, (sum, t) => sum + (familyDigits(baseOf(t)) ?? 0))
		const result: ScalarType =
			native.totality.kind === "exact"
				? exactType(native.totality.yields === "integer" ? "exactInteger" : "exactMoney", digits)
				: native.result === "numeric"
					? anyNumeric
					: isPlainCarrier(native.result)
						? plainType(native.result)
						: (first ?? fixtureError(`fixture IR: ${fn} has no operand to take its type from`))
		return this.#record({
			kind: "op",
			op: id,
			args,
			type: result,
			nonNull: "strict",
			volatility: native.volatility
		})
	}

	eq(a: ScalarExpr, b: ScalarExpr): ScalarExpr {
		return this.op("eq", [a, b])
	}

	/**
	 * r.allen(left, mask, right): the shipped table's minimal formula for the mask, each literal one range operator
	 * between the two spans, so no lower() or upper() appears. A range operator's identity
	 * is its pg_operator.oprcode with the range carrier, as the registry names the polymorphic range comparisons; the
	 * span plug-ins own its lowering.
	 */
	allen(left: ScalarExpr, mask: number, right: ScalarExpr): ScalarExpr {
		const carrier = defined(spanCarrierOf(left.type), "an Allen operand's span carrier")
		const disjuncts = Arr.map(allenFormula(AllenMask(mask)), (conjunction) => {
			const literals = Arr.map(conjunction, (literal) => {
				const atom = literalAtom(literal)
				const [l, r] = atomOperands(atom, left, right)
				const positive = this.#record({
					kind: "op",
					op: definedRangeOp(rangeOperatorCodes[atom.op], carrier),
					args: [l, r],
					type: plainType("bool"),
					nonNull: "strict",
					volatility: "immutable"
				})
				return literalNegated(literal) ? this.op("not", [positive]) : positive
			})
			const [only, ...others] = literals
			return only !== undefined && others.length === 0 ? only : this.op("and", literals)
		})
		if (disjuncts.length === 0) {
			throw new Error("fixture IR: the empty Allen mask holds for no pair")
		}
		const [only, ...others] = disjuncts
		return only !== undefined && others.length === 0 ? only : this.op("or", disjuncts)
	}

	/**
	 * A native cast to an unrefined type: Compute.cast to a base type, and Compute.base, which only drops the
	 * contract.
	 */
	cast(arg: ScalarExpr, type: ScalarType): ScalarExpr {
		return this.#record({
			kind: "cast",
			cast: castOpOf(baseOf(arg.type).carrier, baseOf(type).carrier),
			args: [arg],
			type,
			nonNull: "strict",
			volatility: "immutable"
		})
	}

	/**
	 * A value written into a contract or text refinement, which the write validates: the domain cast of a derived head
	 * or a written member, its proof the write's own check.
	 */
	domainCast(arg: ScalarExpr, type: ScalarType): ScalarExpr {
		return this.#record({
			kind: "domainCast",
			args: [arg],
			type,
			nonNull: "strict",
			proof: [
				{
					precondition: { kind: "contract" },
					premises: [{ kind: "checked", operand: 0, by: "write" }]
				}
			]
		})
	}

	cond(pred: ScalarExpr, onTrue: ScalarExpr, onFalse: ScalarExpr): ScalarExpr {
		return this.#record({
			kind: "cond",
			args: [pred, onTrue, onFalse],
			type: onTrue.type,
			nonNull: "cond"
		})
	}

	/**
	 * A rule's connected matches, a plain region (plainRegion); `meta` is what the fixture claims of it
	 * (conservativeMeta claims nothing).
	 */
	region(occurrences: ReadonlyArray<OccurrenceSpec>, meta: MetaSpec): RelNode {
		return this.regionWith(occurrences, meta, plainRegion)
	}

	/**
	 * A rule's connected matches: variables named by the binding values, typed by their first bound column, under the
	 * options' heading, node, correlated variables and equalities.
	 */
	regionWith(
		occurrences: ReadonlyArray<OccurrenceSpec>,
		meta: MetaSpec,
		options: RegionOptions
	): RelNode {
		const vars = new Map<string, VarDecl>()
		const declare = (name: string, column: HeadingColumn): VarDecl => {
			const known = vars.get(name)
			if (known !== undefined) {
				return known
			}
			const decl: VarDecl = Object.freeze({ id: this.b.ids.var(), name, type: column.type })
			vars.set(name, decl)
			return decl
		}
		const occ = Arr.map(occurrences, (o) => ({
			id: this.b.ids.occurrence(),
			source: o.source,
			bindings: Arr.map(Rec.toEntries(o.bind), ([column, name]) => ({
				column,
				var: declare(name, this.column(o.source, column))
			})),
			constants: Arr.map(Rec.toEntries(o.constants), ([column, expr]) => ({ column, expr }))
		}))
		const correlated = Arr.map(options.correlated, (c) => ({
			var: declare(c.name, { name: c.name, type: c.expr.type }),
			expr: c.expr
		}))
		const varOf = (name: string): VarDecl => {
			const v = vars.get(name)
			if (v === undefined) {
				throw new Error(`fixture IR: no variable ${name}`)
			}
			return v
		}
		const equalities = Arr.map(options.equalities, ([a, b]) => ({ a: varOf(a), b: varOf(b) }))
		const names = options.heading.kind === "named" ? options.heading.names : [...vars.keys()]
		const spec: NodeSpec = {
			kind: "MatchRegion",
			scope: this.b.ids.scope(),
			vars: [...vars.values()],
			occurrences: occ,
			equalities,
			correlated,
			heading: Arr.map(names, (name) => {
				const v = vars.get(name)
				if (v === undefined) {
					throw new Error(`fixture IR: no variable ${name}`)
				}
				return { name, type: v.type }
			}),
			loc: undefined,
			meta
		}
		return options.id.kind === "fresh" ? this.b.node(spec) : this.b.define(options.id.id, spec)
	}

	filter(input: RelNode, pred: ScalarExpr): RelNode {
		return this.b.node({
			kind: "Filter",
			input,
			pred,
			heading: input.heading,
			loc: undefined,
			meta: conservativeMeta
		})
	}

	/**
	 * find: each output a column of the input, or an expression with the type it computes; `meta` is what the fixture
	 * claims of it.
	 */
	project(
		input: RelNode,
		out: ReadonlyArray<readonly [string, string | ScalarExpr]>,
		meta: MetaSpec
	): RelNode {
		const items = Arr.map(out, ([name, e]) => {
			const expr = typeof e === "string" ? this.col(input, e) : e
			return { name, expr, type: expr.type }
		})
		return this.b.node({
			kind: "ProjectSet",
			input,
			out: Arr.map(items, (i) => ({ name: i.name, expr: i.expr })),
			heading: Arr.map(items, (i) => ({ name: i.name, type: i.type })),
			loc: undefined,
			meta
		})
	}

	/**
	 * The aggregate of the complete bound tuple `bound`, grouped by `keys`; `meta` is what the fixture claims of it.
	 */
	group(
		input: RelNode,
		bound: ReadonlyArray<string>,
		keys: ReadonlyArray<string>,
		aggs: ReadonlyArray<AggregateSpec>,
		meta: MetaSpec
	): RelNode {
		const resolved = Arr.map(aggs, (a) => {
			const at = SourceLoc(`aggregate ${a.name}`, [])
			if (a.agg === "count") {
				const overload = countOverload()
				const spec: AggregateSpecOver<ScalarExpr> = {
					name: a.name,
					fn: overload.fn,
					op: OpId(overload.op),
					args: [],
					filter: undefined
				}
				return { spec, type: overload.result }
			}
			const overload = ok(unaryOverload(a.agg, a.arg.type, at))
			const spec: AggregateSpecOver<ScalarExpr> = {
				name: a.name,
				fn: overload.fn,
				op: OpId(overload.op),
				args: [a.arg],
				filter: undefined
			}
			return { spec, type: overload.result }
		})
		return this.b.node({
			kind: "Group",
			input,
			bound: foldInputOf(input, bound),
			keys,
			aggs: Arr.map(resolved, (r) => r.spec),
			heading: [
				...Arr.map(keys, (k) => {
					const c = this.column(input, k)
					return { name: c.name, type: c.type }
				}),
				...Arr.map(resolved, (r) => ({ name: r.spec.name, type: r.type }))
			],
			loc: undefined,
			meta
		})
	}

	/** The left rows with a matching right row. */
	semi(left: RelNode, right: RelNode, on: ReadonlyArray<readonly [string, string]>): RelNode {
		return this.#join("SemiJoin", left, right, on)
	}

	/** The left rows with no matching right row. */
	anti(left: RelNode, right: RelNode, on: ReadonlyArray<readonly [string, string]>): RelNode {
		return this.#join("AntiJoin", left, right, on)
	}

	#join(
		kind: "SemiJoin" | "AntiJoin",
		left: RelNode,
		right: RelNode,
		on: ReadonlyArray<readonly [string, string]>
	): RelNode {
		return this.b.node({
			kind,
			left,
			right,
			on: Arr.map(on, ([l, r]) => ({ left: l, right: r })),
			heading: left.heading,
			loc: undefined,
			meta: conservativeMeta
		})
	}

	/**
	 * Rule arms: arms of one column set share a heading group; several groups need a literal discriminant, and the
	 * union's own heading is then the columns common to every group. `meta` is what the fixture claims of it.
	 */
	union(
		arms: ReadonlyArray<RelNode>,
		discriminant: ReadonlyArray<string>,
		meta: MetaSpec
	): RelNode {
		const [head, ...more] = arms
		if (head === undefined) {
			throw new Error("a union of no arms")
		}
		const groups: Arr.NonEmptyArray<{ heading: Heading; arms: Arr.NonEmptyArray<RelNode> }> = [
			{ heading: head.heading, arms: [head] }
		]
		for (const arm of more) {
			const h = arm.heading
			const group = Arr.findFirst(groups, (g) => sameHeading(g.heading, h))
			if (Option.isSome(group)) {
				group.value.arms.push(arm)
			} else {
				groups.push({ heading: h, arms: [arm] })
			}
		}
		const first = groups[0].heading
		const common = Arr.filter(first, (c) =>
			Arr.every(groups, (g) => Arr.some(g.heading, (d) => d.name === c.name))
		)
		return this.b.node({
			kind: "Union",
			groups,
			discriminant,
			heading: groups.length === 1 ? first : common,
			loc: undefined,
			meta
		})
	}

	/** The first rows of `input` in `completed` order, up to `bound`; `meta` is what the fixture claims of it. */
	take(input: RelNode, completed: CompletedOrder, bound: TakeBound, meta: MetaSpec): RelNode {
		return this.b.node({
			kind: "Take",
			input,
			order: completed,
			bound,
			correlation: [],
			heading: input.heading,
			loc: undefined,
			meta
		})
	}

	ordered(input: RelNode, completed: CompletedOrder): RelNode {
		return this.b.node({
			kind: "OrderedResult",
			input,
			order: completed,
			heading: input.heading,
			loc: undefined,
			meta: conservativeMeta
		})
	}

	attach(
		parent: RelNode,
		child: RelNode,
		name: string,
		correlation: ReadonlyArray<readonly [string, string]>,
		delivered: "array" | "option" | "one",
		/**
		 * A delivered array's order, or undefined for one that states none, which its child's whole heading completes
		 * (ir/rel.ts AttachDelivery); none other has one.
		 */
		completed: CompletedOrder | undefined
	): RelNode {
		const body = {
			kind: "Attach",
			parent,
			child,
			name,
			correlation: Arr.map(correlation, ([p, c]) => ({ parent: p, child: c })),
			judged: delivered,
			heading: parent.heading,
			loc: undefined,
			meta: conservativeMeta
		} as const
		if (delivered !== "array") {
			if (completed !== undefined) {
				throw new Error("fixture: an order only on a delivered array")
			}
			return this.b.node({ ...body, delivered, order: undefined })
		}
		return this.b.node({ ...body, delivered, order: completed ?? headingOrder(child.heading) })
	}

	/**
	 * A recursive relation over the state `row`: its base, and a step built over its feedback reference
	 * under set semantics. Projection over finite stored relations terminates.
	 */
	recursive(
		name: string,
		row: ReadonlyArray<readonly [string, ScalarType]>,
		base: RelNode,
		step: (self: RelNode) => RelNode
	): RelNode {
		const heading: Heading = Arr.map(row, ([n, type]) => ({ name: n, type }))
		const rec = this.b.reserve()
		const self = this.b.node({
			kind: "SelfRef",
			recursive: rec,
			heading,
			loc: undefined,
			meta: conservativeMeta
		})
		return this.b.define(rec, {
			kind: "Recursive",
			name,
			base,
			step: step(self),
			self,
			termination: { kind: "finiteCarrier", stateEstimate: 1_000_000n, premises: [] },
			origin: [],
			heading,
			loc: undefined,
			meta: conservativeMeta
		})
	}

	build(root: RelNode): BuiltQuery {
		return { dag: this.b.build([root]), root }
	}
}
