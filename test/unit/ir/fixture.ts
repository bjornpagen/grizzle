import { Array as Arr, Record as Rec } from "effect"
import { type IdSupply, ParamId } from "#compiler/core/ids.ts"
import type * as Result from "#compiler/core/result.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { MoneyText, VectorText } from "#compiler/ir/carriers.ts"
import { canonicalZero } from "#compiler/ir/carriers.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { DecimalText } from "#compiler/ir/decimal.ts"
import type { ExprSpec, ScalarExpr } from "#compiler/ir/expr.ts"
import { type TypedLiteral, OpId, type ParamRole } from "#compiler/ir/expr.ts"
import { rewriteClaim } from "#compiler/ir/keys.ts"
import {
	conservativeMeta,
	type Heading,
	type HeadingColumn,
	type RelNode,
	type ValidDag,
	type VarDecl
} from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { castOf } from "#compiler/scalar/compute/registry.ts"
import { defined, succeeded } from "#test/support/assert.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { anyNumeric, plainType, scalarOf, wildcardText } from "#test/support/fixtures/ir/scalar.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { castOpOf, definedOpOf } from "#test/support/oracle/gen/ops.ts"

/**
 * Shared IR fixtures: scalar types, expression helpers, and one valid DAG containing every RelNode
 * kind: every RelNode kind constructs, round-trips through canonical JSON, and prints.
 */
export const fail = <A, E>(result: Result.Result<A, E>): E => {
	if (result.ok) {
		throw new Error("expected a failure, got success")
	}
	return result.error
}

/**
 * The scalar types the fixtures read, each the one the registry builds (fixtures/ir/scalar.ts), so every capability a
 * fixture meets is production's.
 */
export const scalarTypes = {
	uuid: scalarOf(f.uuid, {}),
	int4: plainType("int4"),
	int8: plainType("int8"),
	numeric: anyNumeric,
	float8: plainType("float8"),
	money: plainType("money"),
	bool: plainType("bool"),
	text: wildcardText,
	kind: scalarOf(f.closedId("Kind"), { Kind: ["Automatic", "Manual"] }),
	range8: scalarOf(f.span(f.bigint, undefined), {}),
	vector3: scalarOf({ kind: "vector", dimensions: 3 }, {}),
	cents: scalarOf(f.contract("Cents", f.bigint, undefined), {})
} as const satisfies Readonly<Record<string, ScalarType>>

const column = (name: string, type: ScalarType): HeadingColumn => ({ name, type })
export const heading = (...columns: ReadonlyArray<readonly [string, ScalarType]>): Heading =>
	Arr.map(columns, ([name, type]) => column(name, type))

/** Expression helpers over a builder. */
export class Exprs {
	readonly b: DagBuilder
	constructor(b: DagBuilder) {
		this.b = b
	}
	col(node: RelNode, name: string, type: ScalarType) {
		return this.b.expr({
			kind: "column",
			column: { node: node.id, name },
			args: [],
			type,
			nonNull: "storage"
		})
	}
	lit(value: TypedLiteral, type: ScalarType) {
		return this.b.expr({
			kind: "literal",
			value,
			args: [],
			type,
			nonNull: "literal"
		})
	}
	param(name: string, type: ScalarType, role: ParamRole) {
		return this.b.expr({
			kind: "param",
			param: ParamId(name),
			role,
			args: [],
			type,
			nonNull: "codec"
		})
	}
	op(op: string, args: ReadonlyArray<ScalarExpr>, type: ScalarType) {
		return this.b.expr({
			kind: "op",
			op: definedOpOf(op),
			args,
			type,
			nonNull: "strict",
			volatility: "immutable"
		})
	}
	spec(spec: ExprSpec) {
		return this.b.expr(spec)
	}
}

/** The every-kind fixture's nodes by name. */
export type EveryKindKey =
	| "Base"
	| "Closed"
	| "Context"
	| "InputSet"
	| "Delta"
	| "MatchRegion"
	| "Filter"
	| "ProjectSet"
	| "SemiJoin"
	| "AntiJoin"
	| "Union"
	| "Intersect"
	| "Difference"
	| "Take"
	| "Group"
	| "Base(Booking)"
	| "Produce"
	| "Base(Edge seed)"
	| "Base(Edge step)"
	| "SelfRef"
	| "MatchRegion(step)"
	| "Recursive"
	| "Base(Doc)"
	| "ProjectSet(scored)"
	| "ApproximateNearest"
	| "OrderedResult"
	| "Attach"
	| "Forbid"
	| "Window"
	| "Window(lead)"
	| "Window(presence)"
	| "OrderedSetAggregate"
	| "ProjectSet(arm Automatic)"
	| "ProjectSet(arm Manual)"
	| "Union(hetero)"
	| "ProjectSet(exprs)"

export interface EveryKind {
	readonly dag: ValidDag
	/** The fixture's nodes by name. */
	readonly nodes: { readonly [K in EveryKindKey]: RelNode }
}

/**
 * One DAG with every kind of node, each consistent with its inputs, from `supply` (a fresh makeIdSupply(), or one that
 * has already been advanced, so identifier spellings differ between otherwise equal builds.
 */
export const everyKind = (supply: IdSupply): EveryKind => {
	const b = new DagBuilder(supply)
	const x = new Exprs(b)
	const taskHeading = heading(
		["id", scalarTypes.uuid],
		["account", scalarTypes.uuid],
		["kind", scalarTypes.kind],
		["amount", scalarTypes.int8]
	)

	const task = b.node({
		kind: "Base",
		relation: "Task",
		occurrence: b.ids.occurrence(),
		primaryKey: ["id"],
		keys: [["account", "id"]],
		relationKind: "relation",
		heading: taskHeading,
		loc: undefined,
		meta: conservativeMeta
	})
	const closed = b.node({
		kind: "Closed",
		closed: "Kind",
		rows: [[{ kind: "enum", handle: "Automatic" }], [{ kind: "enum", handle: "Manual" }]],
		heading: heading(["id", scalarTypes.kind]),
		loc: undefined,
		meta: conservativeMeta
	})
	/** The session's context: at most one fact, its claims read through its heading's types. */
	const context = b.node({
		kind: "Context",
		context: "Session",
		heading: heading(["sub", scalarTypes.uuid]),
		loc: undefined,
		meta: conservativeMeta
	})
	const inputIds = b.node({
		kind: "InputSet",
		input: { kind: "declared", param: ParamId("ids") },
		heading: heading(["id", scalarTypes.uuid]),
		loc: undefined,
		meta: conservativeMeta
	})
	const delta = b.node({
		kind: "Delta",
		relation: "Task",
		side: "added",
		keys: [["id"], ["account", "id"]],
		heading: taskHeading,
		loc: undefined,
		meta: conservativeMeta
	})

	const vId: VarDecl = { id: b.ids.var(), name: "id", type: scalarTypes.uuid }
	const vAccount: VarDecl = { id: b.ids.var(), name: "account", type: scalarTypes.uuid }
	const vKind: VarDecl = { id: b.ids.var(), name: "kind", type: scalarTypes.kind }
	const vAmount: VarDecl = { id: b.ids.var(), name: "amount", type: scalarTypes.int8 }
	const match = b.node({
		kind: "MatchRegion",
		scope: b.ids.scope(),
		vars: [vId, vAccount, vKind, vAmount],
		occurrences: [
			{
				id: b.ids.occurrence(),
				source: task,
				bindings: [
					{ column: "id", var: vId },
					{ column: "account", var: vAccount },
					{ column: "kind", var: vKind },
					{ column: "amount", var: vAmount }
				],
				constants: []
			},
			{
				id: b.ids.occurrence(),
				source: inputIds,
				bindings: [{ column: "id", var: vId }],
				constants: []
			}
		],
		equalities: [{ a: vId, b: vId }],
		correlated: [],
		heading: taskHeading,
		loc: undefined,
		meta: conservativeMeta
	})
	const positive = x.op(
		"int8gt",
		[x.col(match, "amount", scalarTypes.int8), x.lit({ kind: "int", value: 0n }, scalarTypes.int8)],
		scalarTypes.bool
	)
	const filter = b.node({
		kind: "Filter",
		input: match,
		pred: positive,
		heading: taskHeading,
		loc: undefined,
		meta: conservativeMeta
	})
	const accountAmount = heading(["account", scalarTypes.uuid], ["amount", scalarTypes.int8])
	const project = b.node({
		kind: "ProjectSet",
		input: filter,
		out: [
			{ name: "account", expr: x.col(filter, "account", scalarTypes.uuid) },
			{ name: "amount", expr: x.col(filter, "amount", scalarTypes.int8) }
		],
		heading: accountAmount,
		loc: undefined,
		meta: conservativeMeta
	})
	const semi = b.node({
		kind: "SemiJoin",
		left: project,
		right: inputIds,
		on: [{ left: "account", right: "id" }],
		heading: accountAmount,
		loc: undefined,
		meta: conservativeMeta
	})
	const anti = b.node({
		kind: "AntiJoin",
		left: project,
		right: delta,
		on: [{ left: "account", right: "account" }],
		heading: accountAmount,
		loc: undefined,
		meta: conservativeMeta
	})
	const union = b.node({
		kind: "Union",
		groups: [{ heading: accountAmount, arms: [semi, anti] }],
		discriminant: [],
		heading: accountAmount,
		loc: undefined,
		meta: conservativeMeta
	})
	const intersect = b.node({
		kind: "Intersect",
		left: semi,
		right: anti,
		heading: accountAmount,
		loc: undefined,
		meta: conservativeMeta
	})
	const difference = b.node({
		kind: "Difference",
		left: semi,
		right: anti,
		heading: accountAmount,
		loc: undefined,
		meta: conservativeMeta
	})
	const order = {
		keys: [
			{ column: "amount", dir: "desc" },
			{ column: "account", dir: "asc" }
		]
	} as const
	const take = b.node({
		kind: "Take",
		input: union,
		order,
		bound: { kind: "literal", k: 3n },
		correlation: [],
		heading: accountAmount,
		loc: undefined,
		meta: conservativeMeta
	})
	const totals = b.node({
		kind: "Group",
		input: match,
		bound: ["id", "account", "amount"],
		keys: ["account"],
		aggs: [
			{
				name: "total",
				fn: "sum",
				op: OpId("int8_sum"),
				args: [x.col(match, "amount", scalarTypes.int8)],
				filter: undefined
			},
			{ name: "n", fn: "count", op: OpId("count"), args: [], filter: undefined }
		],
		heading: heading(
			["account", scalarTypes.uuid],
			["total", scalarTypes.numeric],
			["n", scalarTypes.int8]
		),
		/**
		 * A group's keys are a key of it, so the attachment correlated on account meets at most one total per parent.
		 */
		meta: { ...conservativeMeta, logicalKeys: [rewriteClaim(["account"], [])] },
		loc: undefined
	})
	const booking = b.node({
		kind: "Base",
		relation: "Booking",
		occurrence: b.ids.occurrence(),
		primaryKey: ["id"],
		keys: [],
		relationKind: "relation",
		heading: heading(["id", scalarTypes.uuid], ["during", scalarTypes.range8]),
		loc: undefined,
		meta: conservativeMeta
	})
	const produce = b.node({
		kind: "Produce",
		input: booking,
		producer: "spanPack",
		args: [x.col(booking, "during", scalarTypes.range8)],
		carried: ["id"],
		out: "packed",
		heading: heading(["id", scalarTypes.uuid], ["packed", scalarTypes.range8]),
		loc: undefined,
		meta: conservativeMeta
	})

	const edgeHeading = heading(["a", scalarTypes.uuid], ["b", scalarTypes.uuid])
	const edgeBase = () =>
		b.node({
			kind: "Base",
			relation: "Edge",
			occurrence: b.ids.occurrence(),
			primaryKey: ["a", "b"],
			keys: [],
			relationKind: "relation",
			heading: edgeHeading,
			loc: undefined,
			meta: conservativeMeta
		})
	const edge = edgeBase()
	const edgeStep = edgeBase()
	const rec = b.reserve()
	const self = b.node({
		kind: "SelfRef",
		recursive: rec,
		heading: edgeHeading,
		loc: undefined,
		meta: conservativeMeta
	})
	const sa: VarDecl = { id: b.ids.var(), name: "a", type: scalarTypes.uuid }
	const sm: VarDecl = { id: b.ids.var(), name: "m", type: scalarTypes.uuid }
	const sb: VarDecl = { id: b.ids.var(), name: "b", type: scalarTypes.uuid }
	const step = b.node({
		kind: "MatchRegion",
		scope: b.ids.scope(),
		vars: [sa, sm, sb],
		occurrences: [
			{
				id: b.ids.occurrence(),
				source: self,
				bindings: [
					{ column: "a", var: sa },
					{ column: "b", var: sm }
				],
				constants: []
			},
			{
				id: b.ids.occurrence(),
				source: edgeStep,
				bindings: [
					{ column: "a", var: sm },
					{ column: "b", var: sb }
				],
				constants: []
			}
		],
		equalities: [],
		correlated: [],
		heading: edgeHeading,
		loc: undefined,
		meta: conservativeMeta
	})
	const recursive = b.define(rec, {
		kind: "Recursive",
		name: "reach",
		base: edge,
		step,
		self,
		termination: {
			kind: "finiteCarrier",
			stateEstimate: 1_000_000n,
			premises: [{ kind: "node", node: edge.id }]
		},
		/** The seed column a, carried unchanged through the step, is each traversal's origin. */
		origin: ["a"],
		heading: edgeHeading,
		loc: undefined,
		meta: conservativeMeta
	})

	const doc = b.node({
		kind: "Base",
		relation: "Doc",
		occurrence: b.ids.occurrence(),
		primaryKey: ["id"],
		keys: [],
		relationKind: "relation",
		heading: heading(["id", scalarTypes.uuid], ["embedding", scalarTypes.vector3]),
		loc: undefined,
		meta: conservativeMeta
	})
	const scored = b.node({
		kind: "ProjectSet",
		input: doc,
		out: [
			{ name: "id", expr: x.col(doc, "id", scalarTypes.uuid) },
			{
				name: "distance",
				expr: x.op(
					"vector:cosine_distance(vector,vector)",
					[
						x.col(doc, "embedding", scalarTypes.vector3),
						x.param("q", scalarTypes.vector3, "compare")
					],
					scalarTypes.float8
				)
			}
		],
		heading: heading(["id", scalarTypes.uuid], ["distance", scalarTypes.float8]),
		loc: undefined,
		meta: conservativeMeta
	})
	const nearest = b.node({
		kind: "ApproximateNearest",
		source: scored,
		score: "distance",
		take: 5n,
		params: [ParamId("q")],
		sealed: true,
		heading: heading(["id", scalarTypes.uuid], ["distance", scalarTypes.float8]),
		loc: undefined,
		meta: conservativeMeta
	})
	const ordered = b.node({
		kind: "OrderedResult",
		input: take,
		order,
		heading: accountAmount,
		loc: undefined,
		meta: conservativeMeta
	})
	const attach = b.node({
		kind: "Attach",
		parent: project,
		child: totals,
		name: "totals",
		correlation: [{ parent: "account", child: "account" }],
		delivered: "option",
		heading: accountAmount,
		order: undefined,
		loc: undefined,
		meta: conservativeMeta
	})
	const forbid = b.node({
		kind: "Forbid",
		lawId: wild.lawId("task_amount"),
		violation: filter,
		heading: taskHeading,
		loc: undefined,
		meta: conservativeMeta
	})
	const window = b.node({
		kind: "Window",
		input: project,
		partition: ["account"],
		order: { keys: [{ column: "amount", dir: "asc" }] },
		fn: "rowNumber",
		op: OpId("row_number"),
		args: [],
		out: "ordinal",
		rule: "R26" satisfies CertificateRule,
		heading: heading(
			["account", scalarTypes.uuid],
			["amount", scalarTypes.int8],
			["ordinal", scalarTypes.int8]
		),
		filter: undefined,
		frame: undefined,
		loc: undefined,
		meta: conservativeMeta
	})
	/** R27: LEAD(amount, 1, amount) and the presence count over ROWS BETWEEN 1 FOLLOWING AND 1 FOLLOWING. */
	const byAmount = { keys: [{ column: "amount", dir: "asc" }] } as const
	const lead = b.node({
		kind: "Window",
		input: project,
		partition: ["account"],
		order: byAmount,
		fn: "lead",
		op: OpId("lead"),
		args: [
			x.col(project, "amount", scalarTypes.int8),
			x.lit({ kind: "int", value: 1n }, scalarTypes.int4),
			x.col(project, "amount", scalarTypes.int8)
		],
		out: "next",
		rule: "R27" satisfies CertificateRule,
		heading: heading(
			["account", scalarTypes.uuid],
			["amount", scalarTypes.int8],
			["next", scalarTypes.int8]
		),
		filter: undefined,
		frame: undefined,
		loc: undefined,
		meta: conservativeMeta
	})
	const presence = b.node({
		kind: "Window",
		input: project,
		partition: ["account"],
		order: byAmount,
		fn: "count",
		op: OpId("count"),
		args: [],
		frame: { unit: "rows", start: { following: 1n }, end: { following: 1n } },
		out: "present",
		rule: "R27" satisfies CertificateRule,
		heading: heading(
			["account", scalarTypes.uuid],
			["amount", scalarTypes.int8],
			["present", scalarTypes.int8]
		),
		filter: undefined,
		loc: undefined,
		meta: conservativeMeta
	})
	const orderedSet = b.node({
		kind: "OrderedSetAggregate",
		input: project,
		keys: ["account"],
		fn: "percentileDisc",
		op: OpId("percentile_disc_multi"),
		order: { keys: [{ column: "amount", dir: "asc" }] },
		fractions: [
			x.lit({ kind: "float", value: canonicalZero(0.5) }, scalarTypes.float8),
			x.lit({ kind: "float", value: canonicalZero(0.75) }, scalarTypes.float8)
		],
		outs: ["median", "p75"],
		rule: "R29" satisfies CertificateRule,
		heading: heading(
			["account", scalarTypes.uuid],
			["median", scalarTypes.int8],
			["p75", scalarTypes.int8]
		),
		loc: undefined,
		meta: conservativeMeta
	})

	/** A heterogeneous union: two heading groups told apart by the literal discriminant `kind`. */
	const arm = (handle: "Automatic" | "Manual", withAmount: boolean) =>
		b.node({
			kind: "ProjectSet",
			input: project,
			out: [
				{ name: "kind", expr: x.lit({ kind: "enum", handle }, scalarTypes.kind) },
				{ name: "account", expr: x.col(project, "account", scalarTypes.uuid) },
				...(withAmount
					? [{ name: "amount", expr: x.col(project, "amount", scalarTypes.int8) }]
					: [])
			],
			heading: withAmount
				? heading(
						["kind", scalarTypes.kind],
						["account", scalarTypes.uuid],
						["amount", scalarTypes.int8]
					)
				: heading(["kind", scalarTypes.kind], ["account", scalarTypes.uuid]),
			loc: undefined,
			meta: conservativeMeta
		})
	const armA = arm("Automatic", true)
	const armM = arm("Manual", false)
	const hetero = b.node({
		kind: "Union",
		groups: [
			{
				heading: heading(
					["kind", scalarTypes.kind],
					["account", scalarTypes.uuid],
					["amount", scalarTypes.int8]
				),
				arms: [armA]
			},
			{ heading: heading(["kind", scalarTypes.kind], ["account", scalarTypes.uuid]), arms: [armM] }
		],
		discriminant: ["kind"],
		heading: heading(["kind", scalarTypes.kind], ["account", scalarTypes.uuid]),
		loc: undefined,
		meta: conservativeMeta
	})

	/**
	 * Casts, a narrowing that stands with its proof, a domain cast, a conditional, a numeric literal and the remaining
	 * literal kinds.
	 */
	const amount = x.col(match, "amount", scalarTypes.int8)
	const narrowing = castOf("int8", "int4")
	if (narrowing === undefined || !narrowing.partial) {
		throw new Error("the every-kind fixture narrows bigint into integer, a partial cast")
	}
	const exprs = b.node({
		kind: "ProjectSet",
		input: match,
		out: [
			{
				name: "asNumeric",
				expr: x.spec({
					kind: "cast",
					cast: castOpOf("int8", "numeric"),
					args: [amount],
					type: scalarTypes.numeric,
					nonNull: "strict",
					volatility: "immutable"
				})
			},
			{
				name: "narrowed",
				expr: x.spec({
					kind: "cast",
					cast: narrowing.id,
					args: [amount],
					type: scalarTypes.int4,
					nonNull: "strict",
					volatility: "immutable",
					proof: [
						{
							precondition: { kind: "fits" },
							premises: [
								{
									kind: "interval",
									operand: 0,
									low: { units: -100n, scale: 0 },
									high: { units: 100n, scale: 0 },
									nan: false
								}
							]
						}
					]
				})
			},
			{
				name: "cents",
				expr: x.spec({
					kind: "domainCast",
					args: [amount],
					type: scalarTypes.cents,
					nonNull: "strict",
					proof: [
						{
							precondition: { kind: "contract" },
							premises: [{ kind: "checked", operand: 0, by: "write" }]
						}
					]
				})
			},
			{
				name: "flag",
				expr: x.spec({
					kind: "cond",
					args: [
						positive,
						x.lit({ kind: "int", value: 1n }, scalarTypes.int4),
						x.lit({ kind: "int", value: 0n }, scalarTypes.int4)
					],
					type: scalarTypes.int4,
					nonNull: "cond"
				})
			},
			{
				name: "rate",
				expr: x.lit(
					{ kind: "numeric", value: defined(DecimalText.parse("0.0145")) },
					scalarTypes.numeric
				)
			},
			{ name: "label", expr: x.lit({ kind: "text", value: "~tilde" }, scalarTypes.text) },
			{ name: "nan", expr: x.lit({ kind: "floatSpecial", value: "NaN" }, scalarTypes.float8) },
			{ name: "window", expr: x.lit({ kind: "span", start: 1n, end: 10n }, scalarTypes.range8) },
			{
				name: "vec",
				expr: x.lit(
					{ kind: "vector", value: succeeded(VectorText.of(Float32Array.of(0.5, 0.25, 1))) },
					scalarTypes.vector3
				)
			},
			{
				name: "price",
				expr: x.lit({ kind: "money", value: defined(MoneyText.parse("1999")) }, scalarTypes.money)
			},
			{
				name: "who",
				expr: x.lit(
					{ kind: "uuid", value: "00000000-0000-0000-0000-000000000001" },
					scalarTypes.uuid
				)
			},
			{ name: "yes", expr: x.lit({ kind: "bool", value: true }, scalarTypes.bool) }
		],
		heading: heading(
			["asNumeric", scalarTypes.numeric],
			["narrowed", scalarTypes.int4],
			["cents", scalarTypes.cents],
			["flag", scalarTypes.int4],
			["rate", scalarTypes.numeric],
			["label", scalarTypes.text],
			["nan", scalarTypes.float8],
			["window", scalarTypes.range8],
			["vec", scalarTypes.vector3],
			["price", scalarTypes.money],
			["who", scalarTypes.uuid],
			["yes", scalarTypes.bool]
		),
		loc: undefined,
		meta: conservativeMeta
	})

	/** In allocation order, which is the order of the roots. */
	const nodes = {
		Base: task,
		Closed: closed,
		Context: context,
		InputSet: inputIds,
		Delta: delta,
		MatchRegion: match,
		Filter: filter,
		ProjectSet: project,
		SemiJoin: semi,
		AntiJoin: anti,
		Union: union,
		Intersect: intersect,
		Difference: difference,
		Take: take,
		Group: totals,
		"Base(Booking)": booking,
		Produce: produce,
		"Base(Edge seed)": edge,
		"Base(Edge step)": edgeStep,
		SelfRef: self,
		"MatchRegion(step)": step,
		Recursive: recursive,
		"Base(Doc)": doc,
		"ProjectSet(scored)": scored,
		ApproximateNearest: nearest,
		OrderedResult: ordered,
		Attach: attach,
		Forbid: forbid,
		Window: window,
		"Window(lead)": lead,
		"Window(presence)": presence,
		OrderedSetAggregate: orderedSet,
		"ProjectSet(arm Automatic)": armA,
		"ProjectSet(arm Manual)": armM,
		"Union(hetero)": hetero,
		"ProjectSet(exprs)": exprs
	}
	return { dag: b.build(Rec.values(nodes)), nodes }
}
