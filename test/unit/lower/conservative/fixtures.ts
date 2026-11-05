import { Array as Arr, Option, Order, pipe, Record as Rec, String as Str } from "effect"
import { makeIdSupply, ParamId } from "#compiler/core/ids.ts"
import { DagBuilder, type ReservedNode } from "#compiler/ir/builder.ts"
import { DecimalText } from "#compiler/ir/decimal.ts"
import {
	OpId,
	type ParamRole,
	type RangeOpId,
	type ScalarExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import { rewriteClaim } from "#compiler/ir/keys.ts"
import type { LogicalQuery, ParamDecl } from "#compiler/ir/products.ts"
import type {
	AggregateCallOver,
	AggregateSpecOver,
	CompletedOrder,
	Heading,
	HeadingColumn,
	MetaSpec,
	NodeSpec,
	RelNode,
	TakeBound,
	VarDecl
} from "#compiler/ir/rel.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { defined } from "#test/support/assert.ts"
import { closed, f, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { anyNumeric, plainType, scalarOf, wildcardText } from "#test/support/fixtures/ir/scalar.ts"
import { definedOf } from "#test/support/oracle/gen/ops.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { heading } from "#test/unit/ir/fixture.ts"
import { present } from "#test/unit/lower/support.ts"

/**
 * IR fixtures for the conservative lowering: a small ledger schema and a builder that states queries over it the way
 * the checker will (one MatchRegion per rule, a ProjectSet or Group for find, union arms, take, attach, recursion).
 *
 * Every query is built through DagBuilder, so it is validated before the lowering sees it. The relations and the
 * facts the pg tests load are shared, so a unit golden and the PostgreSQL run read the same IR.
 */

/**
 * The span endpoints and contract bases the fixture states, and its scalar types: each the one the registry builds
 * (fixtures/ir/scalar.ts), so every capability a lowering reads is production's.
 */
export const E = { int4: plainType("int4"), int8: plainType("int8") } as const

export const T = {
	uuid: scalarOf(f.uuid, {}),
	int2: plainType("int2"),
	int4: plainType("int4"),
	int8: plainType("int8"),
	numeric: anyNumeric,
	numeric10_2: scalarOf(f.numeric(10, 2), {}),
	float4: plainType("float4"),
	float8: plainType("float8"),
	/** money has no hash operator class. */
	money: plainType("money"),
	bool: plainType("bool"),
	text: wildcardText,
	code: scalarOf(f.regex("^[a-z]+$", "u"), {}),
	kind: scalarOf(f.closedId("Kind"), { Kind: ["Automatic", "Manual"] }),
	range8: scalarOf(f.span(f.bigint, undefined), {}),
	vector3: scalarOf({ kind: "vector", dimensions: 3 }, {}),
	cents: scalarOf(f.contract("Cents", f.bigint, undefined), {})
} as const

/** The ledger schema: stored relations by name, heading and primary key. */
export interface RelationSpec {
	readonly name: string
	readonly heading: Heading
	readonly primaryKey: ReadonlyArray<string>
}

export const Posting: RelationSpec = {
	name: "Posting",
	heading: heading(["id", T.uuid], ["account", T.uuid], ["amount", T.int8]),
	primaryKey: ["id"]
}

export const Account: RelationSpec = {
	name: "Account",
	heading: heading(["id", T.uuid], ["name", T.text]),
	primaryKey: ["id"]
}

export const Task: RelationSpec = {
	name: "Task",
	heading: heading(["id", T.uuid], ["account", T.uuid], ["kind", T.kind], ["amount", T.int8]),
	primaryKey: ["id"]
}

export const Edge: RelationSpec = {
	name: "Edge",
	heading: heading(["src", T.int4], ["dst", T.int4]),
	primaryKey: ["src", "dst"]
}

export const Reading: RelationSpec = {
	name: "Reading",
	heading: heading(
		["id", T.int4],
		["value", T.float8],
		["price", T.numeric],
		["paid", T.money],
		["ok", T.bool]
	),
	primaryKey: ["id"]
}
export const relations = [Posting, Account, Task, Edge, Reading] as const

/**
 * The ledger schema as the Description ownership installs: the relations above, field for field, and the roster Kind
 * their enum column is typed by. A test's evidence catalog comes from it (test/support/evidence.ts).
 */
export const ledgerSchema: SchemaDesc = {
	name: "Ledger",
	relations: [
		relation("Posting", { id: f.uuid, account: f.uuid, amount: f.bigint }, ["id"]),
		relation("Account", { id: f.uuid, name: f.wildcard }, ["id"]),
		relation("Task", { id: f.uuid, account: f.uuid, kind: f.closedId("Kind"), amount: f.bigint }, [
			"id"
		]),
		relation("Edge", { src: f.integer, dst: f.integer }, ["src", "dst"]),
		relation(
			"Reading",
			{
				id: f.integer,
				value: f.pg("double precision"),
				price: f.numeric(10, 2),
				paid: f.pg("money"),
				ok: f.boolean
			},
			["id"]
		),
		closed("Kind", ["Automatic", "Manual"])
	],
	statements: [],
	extends: undefined
}

export const uuidOf = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** One occurrence of a region: its source, its column-to-variable bindings, and its column constants ({} where none). */
export interface OccurrenceSpec {
	readonly source: RelNode
	readonly bind: Readonly<Record<string, string>>
	readonly constants: Readonly<Record<string, ScalarExpr>>
}

/**
 * What a region states beyond its occurrences: its heading (every variable in order of first binding, or the named
 * variables in order), a fresh node or the id reserved for it (a correlated source reads it before it is defined),
 * variables fixed per evaluation by an outer expression, and pairs of variables it equates.
 */
export interface RegionOptions {
	readonly heading:
		| { readonly kind: "bound" }
		| { readonly kind: "named"; readonly names: ReadonlyArray<string> }
	readonly id: { readonly kind: "fresh" } | { readonly kind: "reserved"; readonly id: ReservedNode }
	readonly correlated: ReadonlyArray<{
		readonly name: string
		readonly type: ScalarType
		readonly expr: ScalarExpr
	}>
	readonly equalities: ReadonlyArray<readonly [string, string]>
}

/**
 * A plain region: every bound variable in its heading, a fresh node, nothing correlated or equated. A region that
 * states more spreads this.
 */
export const plainRegion: RegionOptions = {
	heading: { kind: "bound" },
	id: { kind: "fresh" },
	correlated: [],
	equalities: []
}

/**
 * One aggregate of a group: its output, function, operator, argument columns and type, and for a count its condition
 * over the bound tuple.
 */
type AggregateBase = {
	readonly name: string
	readonly op: string
	readonly type: ScalarType
} & AggregateCallOver<string>
export type AggregateSpec = AggregateBase | (AggregateBase & { readonly filter: ScalarExpr })

/** Relational nodes. */
export class Q {
	readonly b = new DagBuilder(makeIdSupply())
	/**
	 * The parameters the query reads, declared as the checker declares them: a scalar at its type, a take bound as an
	 * integer, a relation at its heading.
	 */
	readonly #params = new Map<string, ParamDecl>()

	#declare(decl: ParamDecl): void {
		if (!this.#params.has(decl.name)) {
			this.#params.set(decl.name, decl)
		}
	}

	column(node: RelNode, name: string): HeadingColumn {
		return Option.getOrThrowWith(
			Arr.findFirst(node.heading, (h) => h.name === name),
			() => new Error(`no column ${name} on ${node.id}`)
		)
	}

	node(spec: NodeSpec): RelNode {
		return this.b.node(spec)
	}

	base(relation: RelationSpec, meta: MetaSpec): RelNode {
		return this.b.node({
			kind: "Base",
			relation: relation.name,
			occurrence: this.b.ids.occurrence(),
			primaryKey: nonEmptyList(relation.primaryKey, "a primary key"),
			keys: [],
			relationKind: "relation",
			heading: relation.heading,
			loc: undefined,
			meta
		})
	}

	/** Expressions. */
	col(node: RelNode, name: string): ScalarExpr {
		return this.b.expr({
			kind: "column",
			column: { node: node.id, name },
			args: [],
			type: this.column(node, name).type,
			nonNull: "storage"
		})
	}

	lit(value: TypedLiteral, type: ScalarType): ScalarExpr {
		return this.b.expr({
			kind: "literal",
			value,
			args: [],
			type,
			nonNull: "literal"
		})
	}

	int(value: number | bigint, type: ScalarType): ScalarExpr {
		return this.lit({ kind: "int", value: BigInt(value) }, type)
	}

	decimal(text: string, type: ScalarType): ScalarExpr {
		return this.lit({ kind: "numeric", value: defined(DecimalText.parse(text)) }, type)
	}

	param(name: string, type: ScalarType, role: ParamRole): ScalarExpr {
		this.#declare({ id: ParamId(name), name, kind: "scalar", type })
		return this.b.expr({
			kind: "param",
			param: ParamId(name),
			role,
			args: [],
			type,
			nonNull: "codec"
		})
	}

	/** An operator defined on every value, by its catalog identity's spelling, or a range operator. */
	op(op: string | RangeOpId, args: ReadonlyArray<ScalarExpr>, type: ScalarType): ScalarExpr {
		return this.b.expr({
			kind: "op",
			op: definedOf(typeof op === "string" ? OpId(op) : op),
			args,
			type,
			nonNull: "strict",
			volatility: "immutable"
		})
	}

	/** A rule's connected matches, a plain region (plainRegion). */
	region(occurrences: ReadonlyArray<OccurrenceSpec>): RelNode {
		return this.regionWith(occurrences, plainRegion)
	}

	/**
	 * A rule's connected matches: variables named by the binding values, typed by their first bound column, under the
	 * options' heading, node, correlated variables and equalities.
	 */
	regionWith(occurrences: ReadonlyArray<OccurrenceSpec>, options: RegionOptions): RelNode {
		/** Each variable once, by name: the declaration the region holds is the object every reference holds. */
		const vars = new Map<string, VarDecl>()
		const declare = (name: string, type: ScalarType): VarDecl => {
			const found = vars.get(name)
			if (found !== undefined) {
				return found
			}
			const v: VarDecl = { id: this.b.ids.var(), name, type }
			vars.set(name, v)
			return v
		}
		const occ = Arr.map(occurrences, (o) => ({
			id: this.b.ids.occurrence(),
			source: o.source,
			bindings: Arr.map(Rec.toEntries(o.bind), ([column, name]) => ({
				column,
				var: declare(name, this.column(o.source, column).type)
			})),
			constants: Arr.map(Rec.toEntries(o.constants), ([column, expr]) => ({ column, expr }))
		}))
		const correlated = Arr.map(options.correlated, (c) => ({
			var: declare(c.name, c.type),
			expr: c.expr
		}))
		const equalities = Arr.map(options.equalities, ([a, b]) => ({
			a: present(vars.get(a), `the variable ${a}`),
			b: present(vars.get(b), `the variable ${b}`)
		}))
		const names = options.heading.kind === "named" ? options.heading.names : [...vars.keys()]
		const spec: NodeSpec = {
			kind: "MatchRegion",
			loc: undefined,
			meta: conservativeMeta,
			scope: this.b.ids.scope(),
			vars: [...vars.values()],
			occurrences: occ,
			equalities,
			correlated,
			heading: Arr.map(names, (name) => {
				const v = vars.get(name)
				if (v === undefined) {
					throw new Error(`no variable ${name}`)
				}
				return { name, type: v.type }
			})
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

	/** find: each output a column name of the input or an expression with its type. */
	project(
		input: RelNode,
		out: ReadonlyArray<readonly [string, string | readonly [ScalarExpr, ScalarType]]>,
		meta: MetaSpec
	): RelNode {
		const items = Arr.map(out, ([name, e]) =>
			typeof e === "string"
				? { name, expr: this.col(input, e), type: this.column(input, e).type }
				: { name, expr: e[0], type: e[1] }
		)
		return this.b.node({
			kind: "ProjectSet",
			input,
			out: Arr.map(items, (i) => ({ name: i.name, expr: i.expr })),
			heading: Arr.map(items, (i) => ({ name: i.name, type: i.type })),
			loc: undefined,
			meta
		})
	}

	group(
		input: RelNode,
		bound: ReadonlyArray<string>,
		keys: ReadonlyArray<string>,
		aggs: ReadonlyArray<AggregateSpec>,
		meta: MetaSpec
	): RelNode {
		return this.b.node({
			kind: "Group",
			input,
			bound,
			keys,
			aggs: Arr.map(aggs, (a): AggregateSpecOver<ScalarExpr> => {
				const filter = "filter" in a ? a.filter : undefined
				switch (a.fn) {
					case "count":
						return { name: a.name, fn: a.fn, op: OpId(a.op), args: [], filter }
					case "sum":
					case "avg":
					case "min":
					case "max":
					case "boolAnd":
					case "boolOr":
						return {
							name: a.name,
							fn: a.fn,
							op: OpId(a.op),
							args: [this.col(input, a.args[0])],
							filter
						}
				}
			}),
			heading: [
				...Arr.map(
					Arr.map(keys, (k) => this.column(input, k)),
					(c) => ({ name: c.name, type: c.type })
				),
				...Arr.map(aggs, (a) => ({ name: a.name, type: a.type }))
			],
			loc: undefined,
			meta
		})
	}

	semi(left: RelNode, right: RelNode, on: ReadonlyArray<readonly [string, string]>): RelNode {
		return this.#join("SemiJoin", left, right, on)
	}

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

	union(arms: ReadonlyArray<RelNode>, discriminant: ReadonlyArray<string>): RelNode {
		const [head, ...more] = arms
		if (head === undefined) {
			throw new Error("a union of no arms")
		}
		const groups: Arr.NonEmptyArray<{ heading: Heading; arms: Arr.NonEmptyArray<RelNode> }> = [
			{ heading: head.heading, arms: [head] }
		]
		const same = (a: Heading, b: Heading) =>
			a.length === b.length && Arr.every(a, (c) => Arr.some(b, (d) => d.name === c.name))
		for (const arm of more) {
			const h = arm.heading
			const group = Arr.findFirst(groups, (g) => same(g.heading, h))
			if (Option.isNone(group)) {
				groups.push({ heading: h, arms: [arm] })
			} else {
				group.value.arms.push(arm)
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
			meta: conservativeMeta
		})
	}

	setOp(kind: "Intersect" | "Difference", left: RelNode, right: RelNode): RelNode {
		return this.b.node({
			kind,
			left,
			right,
			heading: left.heading,
			loc: undefined,
			meta: conservativeMeta
		})
	}

	take(
		input: RelNode,
		order: CompletedOrder,
		bound: TakeBound,
		correlation: ReadonlyArray<{ readonly column: string; readonly expr: ScalarExpr }>,
		meta: MetaSpec
	): RelNode {
		return this.b.node({
			kind: "Take",
			input,
			order,
			bound,
			correlation,
			heading: input.heading,
			loc: undefined,
			meta
		})
	}

	ordered(input: RelNode, order: CompletedOrder): RelNode {
		return this.b.node({
			kind: "OrderedResult",
			input,
			order,
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
		order: CompletedOrder | undefined
	): RelNode {
		const body = {
			kind: "Attach",
			parent,
			child,
			name,
			correlation: Arr.map(correlation, ([p, c]) => ({ parent: p, child: c })),
			heading: parent.heading
		} as const
		if (delivered !== "array") {
			if (order !== undefined) {
				throw new Error("fixture: an order only on a delivered array")
			}
			return this.b.node({
				...body,
				delivered,
				order: undefined,
				loc: undefined,
				meta: conservativeMeta
			})
		}
		return this.b.node({ ...body, delivered, order, loc: undefined, meta: conservativeMeta })
	}

	closed(name: string, h: Heading, rows: ReadonlyArray<ReadonlyArray<TypedLiteral>>): RelNode {
		return this.b.node({
			kind: "Closed",
			closed: name,
			rows,
			heading: h,
			loc: undefined,
			meta: conservativeMeta
		})
	}

	input(param: string, h: Heading): RelNode {
		this.#declare({ id: ParamId(param), name: param, kind: "relation", heading: h })
		return this.b.node({
			kind: "InputSet",
			input: { kind: "declared", param: ParamId(param) },
			heading: h,
			loc: undefined,
			meta: conservativeMeta
		})
	}

	/** The query rooted at `root`, built by the builder, so valid by construction. */
	build(root: RelNode): LogicalQuery {
		const params = Arr.sort(
			this.#params.values(),
			Order.mapInput(Order.String, (p: { readonly name: string }) => p.name)
		)
		return { dag: this.b.build(Arr.of(root)), params }
	}
}

export const keyed = (
	key: ReadonlyArray<string>,
	card: "many" | "atMostOne" | "one"
): MetaSpec => ({
	...conservativeMeta,
	logicalKeys: [rewriteClaim(key, [])],
	card
})

export const asc = (...columns: ReadonlyArray<string>): CompletedOrder => ({
	keys: Arr.map(columns, (column) => ({ column, dir: "asc" as const }))
})
