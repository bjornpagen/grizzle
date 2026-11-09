import { Array as Arr, Option, Record as Rec, Result } from "effect"
import {
	atomOperands,
	literalAtom,
	literalNegated,
	rangeOperatorCodes
} from "#compiler/allen/atoms.ts"
import { allenFormula } from "#compiler/allen/lower.ts"
import { fullAllenMask } from "#compiler/allen/mask.ts"
import { indices } from "#compiler/core/array.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { makeIdSupply, ParamId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Engine from "#compiler/core/result.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import {
	type ExprSpec,
	type DefinedOp,
	type ScalarExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import { noExtension } from "#test/support/compute.ts"

import {
	type AggregateSpec,
	type CompletedOrder,
	conservativeMeta,
	type Heading,
	type HeadingColumn,
	headingOrder,
	type Occurrence,
	type RelNode,
	type ValidDag,
	type VarDecl
} from "#compiler/ir/rel.ts"
import {
	baseOf,
	rosterOf,
	type ScalarType,
	sameScalarType,
	spanCarrierOf
} from "#compiler/ir/scalar.ts"
import {
	type LowerEnv,
	lowerTerm,
	noClosedRelations,
	noParams
} from "#compiler/scalar/compute/lower.ts"
import { definedRangeOp } from "#compiler/scalar/compute/registry.ts"
import { widening } from "#compiler/scalar/compute/types.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { bareEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import { defined } from "#test/support/assert.ts"
import { foldInputOf } from "#test/support/fixtures/ir/fold.ts"
import { bool, compareParamType } from "#test/support/oracle/gen/domain.ts"
import type { GenFacts } from "#test/support/oracle/gen/facts.ts"
import {
	aggregateOpId,
	andOp,
	type CompareOp,
	compareOpId,
	notOp,
	orOp
} from "#test/support/oracle/gen/ops.ts"
import type { GenParam } from "#test/support/oracle/gen/query.ts"
import {
	closedHeading,
	type GenClosed,
	type GenRelation,
	type GenSchema,
	relationHeading
} from "#test/support/oracle/gen/schema.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import type { Answer, Nested } from "#test/support/oracle/public/answer.ts"
import { generatedSchemaName } from "#test/support/oracle/public/build.ts"
import {
	type AllenAtom,
	type ArgTerm,
	type ProgramCase,
	type Closure,
	type Column,
	type Comparison,
	type ComputedTerm,
	deliveredOrder,
	storedFactValues,
	type ProgramFact,
	type HeadItem,
	isAggregate,
	type MixedRoot,
	type Operand,
	type OrderKey,
	type Param,
	type ParentColumn,
	type Query,
	type ProgramRead,
	type RelationParam,
	type Root,
	type Rule,
	type ProgramSchema,
	type Source,
	type Stored,
	sourceFields,
	takeOrder,
	type Var
} from "#test/support/oracle/public/program.ts"
import { termDesc } from "#test/support/oracle/public/terms.ts"

import {
	type ExpectedStatement,
	expectedStatements
} from "#test/support/oracle/reference/deliver.ts"
import {
	columnIndex,
	Reference,
	type ReferenceObserver,
	sortRows,
	unobserved
} from "#test/support/oracle/reference/evaluate.ts"
import {
	asBigint,
	asDecimal,
	equal,
	literalOf,
	type Row,
	statedValue,
	type Value,
	valueAt
} from "#test/support/oracle/reference/values.ts"

/** The schema as the reference reads it. */
const referenceSchema = (s: ProgramSchema): GenSchema => ({
	name: generatedSchemaName,
	relations: Arr.map(s.relations, (r): GenRelation => ({
		name: r.name,
		columns: Arr.map(r.fields, (f) => ({ name: f.name, type: f.type })),
		primaryKey: Arr.map(r.primaryKey, (f) => f.name),
		keys: Arr.map(r.candidates, (k) => Arr.map(k, (f) => f.name)),
		mutable: false
	})),
	closed: [rosterRelation(s)],
	containments: []
})

/**
 * The case's roster as the IR reads it. A program's schema is installed through its first migration
 * (test/support/install-migrate.ts), so its codes are a fresh installation's: each handle's code its declared position.
 */
const rosterRelation = (s: ProgramSchema): GenClosed => ({
	name: s.roster.name,
	handles: s.roster.handles,
	codes: Arr.map(s.roster.handles, (handle) => ({ kind: "live", handle }) as const),
	payload: [],
	rows: Arr.map(s.roster.handles, (handle): ReadonlyArray<TypedLiteral> => [
		{ kind: "handle", handle }
	])
})

/** A node under construction and its heading. */
interface Built {
	readonly node: RelNode
	readonly heading: Heading
}

/** A rule's node, and the parent columns its correlation columns carry. */
interface BuiltRule extends Built {
	readonly correlation: ReadonlyArray<{ readonly parent: string; readonly child: string }>
}

/**
 * What an imported query's parameter stands for inside the importing rule: the column of the source an earlier match
 * of the importing rule binds the variable at, read per binding of that match, or a parameter of the importing read.
 */
type Substitute =
	| { readonly kind: "var"; readonly node: RelNode; readonly column: HeadingColumn }
	| { readonly kind: "param"; readonly param: Param }

type Substitution = ReadonlyMap<string, Substitute>

const noSubstitution: Substitution = new Map()

/**
 * Where a query is evaluated: on its own, a root's or an import's, or as an attachment's child, once per row of its
 * parent, whose take ranks only the rows correlated with that parent row.
 */
type Outer = { readonly kind: "own" } | { readonly kind: "attached"; readonly parent: Built }

const ownQuery: Outer = { kind: "own" }

const columnOf = (name: string, type: ScalarType): HeadingColumn => ({ name, type })

/** The name of a child's correlation column for its i-th parent binding: no head key is spelled so. */
const correlationColumn = (i: number): string => `\u0001parent${i}`

const completed = (order: ReadonlyArray<OrderKey>): CompletedOrder => ({
	keys: Arr.map(order, (k) => ({ column: k.column.name, dir: k.dir }))
})

const refusal = (loc: SourceLoc, capability: string): CompileError =>
	malformedDescription(loc, capability)

const elementAt = <A>(items: ReadonlyArray<A>, i: number): A => {
	const item = items[i]
	if (item === undefined) {
		throw new Error(`no element ${i}`)
	}
	return item
}

const declColumn = (d: VarDecl): HeadingColumn => columnOf(d.name, d.type)

class Translation {
	readonly b = new DagBuilder(makeIdSupply())
	readonly #schema: ProgramSchema
	#closures = 0

	constructor(schema: ProgramSchema) {
		this.#schema = schema
	}

	columnSpec(node: RelNode, c: HeadingColumn): ExprSpec {
		return {
			kind: "column",
			column: { node: node.id, name: c.name },
			args: [],
			type: c.type,
			nonNull: "storage"
		}
	}

	col(node: RelNode, c: HeadingColumn): ScalarExpr {
		return this.b.expr(this.columnSpec(node, c))
	}

	literal(value: TypedLiteral, type: ScalarType): ScalarExpr {
		return this.b.expr({
			kind: "literal",
			value,
			args: [],
			type,
			nonNull: "literal"
		})
	}

	/**
	 * A parameter is bound as its compared type's base, never a refined domain, whatever its declaration: a field
	 * declaration adopts the field's contract or typmod in the program, not at the placeholder.
	 */
	param(p: Param): ScalarExpr {
		return this.b.expr({
			kind: "param",
			param: ParamId(p.name),
			role: "compare",
			args: [],
			type: compareParamType(p.type),
			nonNull: "codec"
		})
	}

	/** A strict, immutable Boolean operation defined on every value. */
	predicate(op: DefinedOp, args: ReadonlyArray<ScalarExpr>): ScalarExpr {
		return this.b.expr({
			kind: "op",
			op,
			args,
			type: bool,
			nonNull: "strict",
			volatility: "immutable"
		})
	}

	compare(op: CompareOp, type: ScalarType, left: ScalarExpr, right: ScalarExpr): ScalarExpr {
		return this.predicate(compareOpId(type, op), [left, right])
	}

	/** One expression of several: itself alone, or their `and` or `or`. */
	connective(op: DefinedOp, args: ReadonlyArray<ScalarExpr>): ScalarExpr {
		const [only, ...more] = args
		return only !== undefined && more.length === 0 ? only : this.predicate(op, args)
	}

	/**
	 * r.allen(left, mask, right): the mask's formula, each literal its atom's range operator over [left, right] (swapped
	 * when the atom reads B first), negated by not, each conjunction an and and the formula an or; the full mask true.
	 */
	allen(atom: AllenAtom, left: ScalarExpr, right: ScalarExpr): ScalarExpr {
		if (atom.mask === fullAllenMask) {
			return this.literal({ kind: "bool", value: true }, bool)
		}
		const carrier = defined(spanCarrierOf(atom.left.field.type), "an Allen operand's span carrier")
		const disjuncts = Arr.map(allenFormula(atom.mask), (conjunction) =>
			this.connective(
				andOp,
				Arr.map(conjunction, (literal) => {
					const a = literalAtom(literal)
					const positive = this.predicate(
						definedRangeOp(rangeOperatorCodes[a.op], carrier),
						atomOperands(a, left, right)
					)
					return literalNegated(literal) ? this.predicate(notOp, [positive]) : positive
				})
			)
		)
		return this.connective(orOp, disjuncts)
	}

	/**
	 * A Compute term lowered by src's Compute typing over `input`'s heading, whose columns are the term's variables, typed
	 * as the builder types it (its nominal type): a Compute.base or a widening cast emits no node of its own, so where the
	 * node it reads still carries the contract or typmod the term drops, the column casts it.
	 */
	computed(
		input: Built,
		t: ComputedTerm,
		name: (v: Var) => string
	): { readonly expr: ScalarExpr; readonly type: ScalarType } {
		const env: LowerEnv = {
			mode: "query",
			loc: SourceLoc("a computed head key", []),
			closed: noClosedRelations("a generated term reads no closed relation"),
			emit: (spec) => this.b.expr(spec),
			leaf: (desc, loc) => {
				const c =
					desc.kind === "var"
						? Option.getOrUndefined(Arr.findFirst(input.heading, (h) => h.name === desc.var))
						: undefined
				if (c === undefined) {
					return Engine.err(refusal(loc, "a column of the term's input"))
				}
				return Engine.ok(this.columnSpec(input.node, c))
			},
			params: noParams,
			fieldType: (desc, loc) => scalarTypeOf(desc, bareEnv, loc),
			patterns: new CompilePatterns(),
			patternLanguage: textLookup,
			extension: noExtension
		}
		const lowered = lowerTerm(termDesc(t, name), env)
		if (!lowered.ok) {
			throw new Error(`a computed head key Compute refuses: ${lowered.error.message}`)
		}
		const term = lowered.value
		if (sameScalarType(term.expr.type, term.nominal)) {
			return { expr: term.expr, type: term.nominal }
		}
		const expr = this.b.expr({
			kind: "cast",
			cast: defined(
				widening(term.expr.type, term.nominal),
				"a computed head key's widening into its nominal type"
			),
			args: [term.expr],
			type: term.nominal,
			nonNull: "strict",
			volatility: "immutable"
		})
		return { expr, type: term.nominal }
	}

	stored(source: Stored): Built {
		const relation: GenRelation = {
			name: source.name,
			columns: Arr.map(source.fields, (f) => ({ name: f.name, type: f.type })),
			primaryKey: Arr.map(source.primaryKey, (f) => f.name),
			keys: Arr.map(source.candidates, (k) => Arr.map(k, (f) => f.name)),
			mutable: false
		}
		const heading = relationHeading(relation)
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "Base",
			relation: source.name,
			occurrence: this.b.ids.occurrence(),
			primaryKey: nonEmptyList(relation.primaryKey, "a primary key"),
			keys: Arr.map(relation.keys, (k) => nonEmptyList(k, "a candidate key")),
			relationKind: "relation",
			heading
		})
		return { node: id, heading }
	}

	/** A relation parameter's input set, under its relation's fields. */
	inputSet(param: RelationParam): Built {
		const heading = Arr.map(param.relation.fields, (f) => columnOf(f.name, f.type))
		return {
			node: this.b.node({
				loc: undefined,
				meta: conservativeMeta,
				kind: "InputSet",
				input: { kind: "declared", param: ParamId(param.name) },
				heading
			}),
			heading
		}
	}

	/**
	 * The closure of an edge relation's from-to pairs where from < to: a region over the relation binding the two
	 * fields, filtered and projected to src and dst, and a recursion whose step joins a path with an edge.
	 */
	closure(c: Closure): Built {
		const type = c.from.type
		const a: VarDecl = { id: this.b.ids.var(), name: "a", type }
		const b: VarDecl = { id: this.b.ids.var(), name: "b", type }
		const edge = this.region(
			[
				{
					source: c.edge,
					node: this.stored(c.edge),
					bound: new Map([
						[c.from.name, a],
						[c.to.name, b]
					])
				}
			],
			[a, b],
			[]
		)
		const lt = this.compare(
			"lt",
			type,
			this.col(edge.node, columnOf("a", type)),
			this.col(edge.node, columnOf("b", type))
		)
		const filtered = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "Filter",
			input: edge.node,
			pred: lt,
			heading: edge.heading
		})
		const state: Heading = [columnOf("src", type), columnOf("dst", type)]
		const edges = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "ProjectSet",
			input: filtered,
			out: [
				{ name: "src", expr: this.col(filtered, columnOf("a", type)) },
				{ name: "dst", expr: this.col(filtered, columnOf("b", type)) }
			],
			heading: state
		})
		const rec = this.b.reserve()
		const self = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "SelfRef",
			recursive: rec,
			heading: state
		})
		const vSrc: VarDecl = { id: this.b.ids.var(), name: "src", type }
		const vMid: VarDecl = { id: this.b.ids.var(), name: "mid", type }
		const vDst: VarDecl = { id: this.b.ids.var(), name: "dst", type }
		const region = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "MatchRegion",
			scope: this.b.ids.scope(),
			vars: [vSrc, vMid, vDst],
			occurrences: [
				{
					id: this.b.ids.occurrence(),
					source: self,
					bindings: [
						{ column: "src", var: vSrc },
						{ column: "dst", var: vMid }
					],
					constants: []
				},
				{
					id: this.b.ids.occurrence(),
					source: edges,
					bindings: [
						{ column: "src", var: vMid },
						{ column: "dst", var: vDst }
					],
					constants: []
				}
			],
			equalities: [],
			correlated: [],
			heading: [columnOf("src", type), columnOf("mid", type), columnOf("dst", type)]
		})
		const step = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "ProjectSet",
			input: region,
			out: [
				{ name: "src", expr: this.col(region, columnOf("src", type)) },
				{ name: "dst", expr: this.col(region, columnOf("dst", type)) }
			],
			heading: state
		})
		const recursive = this.b.define(rec, {
			loc: undefined,
			meta: conservativeMeta,
			kind: "Recursive",
			name: `closure${++this.#closures}`,
			base: edges,
			step,
			self,
			/** Projection over a finite carrier: the state is a pair of edge endpoints. */
			termination: { kind: "finiteCarrier", stateEstimate: 4096n, premises: [] },
			origin: [],
			heading: state
		})
		return { node: recursive, heading: state }
	}

	/**
	 * A match's source node. An import's parameters bound to variables read the column of the earlier match binding
	 * each (`earlier`).
	 *
	 * An import reads its root's rows; its attachments deliver none.
	 */
	source(source: Source, earlier: (v: Var) => Substitute): Built {
		switch (source.kind) {
			case "stored":
				return this.stored(source)
			case "roster": {
				const closed = rosterRelation(this.#schema)
				const heading = closedHeading(closed)
				return {
					node: this.b.node({
						loc: undefined,
						meta: conservativeMeta,
						kind: "Closed",
						closed: closed.name,
						rows: closed.rows,
						heading
					}),
					heading
				}
			}
			case "import":
				return this.query(
					{ ...source.query, attachments: [] },
					ownQuery,
					new Map(
						Arr.map(source.binds, (bind): readonly [string, Substitute] => [
							bind.param.name,
							bind.to.kind === "var"
								? earlier(bind.to.var)
								: { kind: "param", param: bind.to.param }
						])
					)
				)
			case "interior":
				return this.rule(source.rule, noSubstitution)
			case "relation param":
				return this.inputSet(source.param)
			case "closure":
				return this.closure(source)
		}
	}

	/**
	 * A region over `matches`, binding every listed field to a variable; `correlated` fixes variables per binding of an
	 * enclosing region's earlier matches.
	 *
	 * A field no match binds is an existential witness.
	 */
	region(
		matches: ReadonlyArray<{
			readonly source: Source
			readonly node: Built
			readonly bound: ReadonlyMap<string, VarDecl>
		}>,
		decls: ReadonlyArray<VarDecl>,
		correlated: ReadonlyArray<{ readonly var: VarDecl; readonly expr: ScalarExpr }>
	): Built {
		const occurrences: Array<Occurrence> = []
		for (const m of matches) {
			const id = this.b.ids.occurrence()
			const bindings = Arr.flatMap(sourceFields(m.source), (field) => {
				const decl = m.bound.get(field.name)
				return decl === undefined ? [] : [{ column: field.name, var: decl }]
			})
			occurrences.push({ id, source: m.node.node, bindings, constants: [] })
		}
		const heading = Arr.map(decls, (d) => columnOf(d.name, d.type))
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "MatchRegion",
			scope: this.b.ids.scope(),
			vars: decls,
			occurrences,
			equalities: [],
			correlated,
			heading
		})
		return { node: id, heading }
	}

	rule(rule: Rule<ParentColumn>, substitution: Substitution): BuiltRule {
		const decls: Array<VarDecl> = []
		const declare = (name: string, type: ScalarType): VarDecl => {
			const decl: VarDecl = { id: this.b.ids.var(), name, type }
			decls.push(decl)
			return decl
		}
		const vars = new Map<number, VarDecl>()
		const fixed: Array<{ readonly decl: VarDecl; readonly operand: Operand<never> }> = []
		const parents: Array<{ readonly decl: VarDecl; readonly column: Column }> = []
		const correlated: Array<{ readonly var: VarDecl; readonly expr: ScalarExpr }> = []
		const matches: Array<{
			readonly source: Source
			readonly node: Built
			readonly bound: Map<string, VarDecl>
		}> = []
		/**
		 * The variable a binding binds: a rule variable's, declared at its first binding; or a fresh one fixed to a
		 * literal, a parameter or its substitute, or a parent's column.
		 */
		const declared = (b: Rule<ParentColumn>["matches"][number]["bindings"][number]): VarDecl => {
			const o = b.operand
			switch (o.kind) {
				case "var": {
					const known = vars.get(o.var.id)
					const decl = known ?? declare(`v${o.var.id}`, b.field.type)
					vars.set(o.var.id, decl)
					return decl
				}
				case "literal": {
					const decl = declare(`k${decls.length}`, b.field.type)
					fixed.push({ decl, operand: o })
					return decl
				}
				case "param": {
					const decl = declare(`k${decls.length}`, b.field.type)
					const substitute = substitution.get(o.param.name)
					if (substitute === undefined) {
						fixed.push({ decl, operand: o })
					} else if (substitute.kind === "param") {
						fixed.push({ decl, operand: { kind: "param", param: substitute.param } })
					} else {
						correlated.push({ var: decl, expr: this.col(substitute.node, substitute.column) })
					}
					return decl
				}
				case "parent": {
					const decl = declare(`k${decls.length}`, b.field.type)
					parents.push({ decl, column: o.column })
					return decl
				}
			}
		}
		/**
		 * The column of the source of the earliest earlier match binding `v`, which an import's parameter bound to `v`
		 * reads per binding of that match.
		 */
		const earlier = (v: Var): Substitute => {
			for (const [j, m] of matches.entries()) {
				const binding = Arr.findFirst(
					elementAt(rule.matches, j).bindings,
					(b) => b.operand.kind === "var" && b.operand.var.id === v.id
				)
				if (Option.isSome(binding)) {
					return {
						kind: "var",
						node: m.node.node,
						column: columnOf(binding.value.field.name, binding.value.field.type)
					}
				}
			}
			throw new Error(`an import binds the variable ${v.id}, which no earlier match binds`)
		}
		for (const m of rule.matches) {
			const node = this.source(m.source, earlier)
			const bound = new Map<string, VarDecl>()
			for (const b of m.bindings) {
				bound.set(b.field.name, declared(b))
			}
			matches.push({ source: m.source, node, bound })
		}
		const region = this.region(matches, decls, correlated)
		const declOf = (id: number): VarDecl => {
			const decl = vars.get(id)
			if (decl === undefined) {
				throw new Error(`the variable ${id} is used before a match binds it`)
			}
			return decl
		}
		const nameOf = (v: Var): string => declOf(v.id).name
		const operand = (o: Operand<never>, type: ScalarType): ScalarExpr => {
			switch (o.kind) {
				case "var":
					return this.col(region.node, declOf(o.var.id))
				case "literal":
					return this.literal(o.literal, type)
				case "param":
					return this.param(o.param)
			}
		}
		const left = (v: Var): ScalarExpr => this.col(region.node, declOf(v.id))
		const comparison = (c: Comparison): ScalarExpr => {
			const type = declOf(c.left.id).type
			return this.compare(c.op, type, left(c.left), operand(c.right, type))
		}
		const conjuncts = [
			...Arr.map(fixed, (f) =>
				this.compare(
					"eq",
					f.decl.type,
					this.col(region.node, f.decl),
					operand(f.operand, f.decl.type)
				)
			),
			...Arr.map(rule.where, comparison),
			...Arr.flatMap(rule.between, (b) => {
				const type = declOf(b.left.id).type
				return [
					this.compare("ge", type, left(b.left), operand(b.low, type)),
					this.compare("le", type, left(b.left), operand(b.high, type))
				]
			}),
			...Arr.map(rule.inSets, (s) => {
				const type = declOf(s.left.id).type
				return Arr.isReadonlyArrayNonEmpty(s.values)
					? this.connective(
							orOp,
							Arr.map(s.values, (value) =>
								this.compare("eq", type, left(s.left), this.literal(value, type))
							)
						)
					: this.literal({ kind: "bool", value: false }, bool)
			}),
			...Arr.map(rule.allens, (a) => this.allen(a, left(a.left), left(a.right))),
			...Arr.map(rule.pointIns, (p) =>
				this.predicate(
					definedRangeOp(
						"range_contains_elem",
						defined(spanCarrierOf(declOf(p.span.id).type), "a pointIn span's carrier")
					),
					[left(p.span), left(p.point)]
				)
			),
			...Arr.map(rule.connectives, (j) => {
				const args = Arr.map(j.args, comparison)
				return Arr.isReadonlyArrayNonEmpty(args)
					? this.connective(j.kind === "and" ? andOp : orOp, args)
					: this.literal({ kind: "bool", value: j.kind === "and" }, bool)
			})
		]
		let current: Built = region
		if (conjuncts.length > 0) {
			current = {
				node: this.b.node({
					loc: undefined,
					meta: conservativeMeta,
					kind: "Filter",
					input: region.node,
					pred: this.connective(andOp, conjuncts),
					heading: region.heading
				}),
				heading: region.heading
			}
		}
		for (const n of rule.negations) {
			const negated: Array<VarDecl> = []
			const bound = new Map<string, VarDecl>()
			for (const b of n.bindings) {
				const decl: VarDecl = {
					id: this.b.ids.var(),
					name: `n${negated.length}`,
					type: b.field.type
				}
				negated.push(decl)
				bound.set(b.field.name, decl)
			}
			const right = this.region(
				[{ source: n.source, node: this.stored(n.source), bound }],
				negated,
				[]
			)
			const on = Arr.map(n.bindings, (b, i) => ({ left: declOf(b.var.id).name, right: `n${i}` }))
			current = {
				node: this.b.node({
					loc: undefined,
					meta: conservativeMeta,
					kind: "AntiJoin",
					left: current.node,
					right: right.node,
					on,
					heading: current.heading
				}),
				heading: current.heading
			}
		}
		const correlation = Arr.map(parents, (p, i) => ({
			parent: p.column.name,
			child: correlationColumn(i)
		}))
		const carried = Arr.map(parents, (p, i) => ({ name: correlationColumn(i), decl: p.decl }))
		/** A projection of `input`, each item a name, its type and its expression. */
		const project = (
			input: Built,
			items: ReadonlyArray<{
				readonly name: string
				readonly type: ScalarType
				readonly expr: ScalarExpr
			}>
		): Built => {
			const heading = Arr.map(items, (it) => columnOf(it.name, it.type))
			const out = Arr.map(items, (it) => ({ name: it.name, expr: it.expr }))
			return {
				node: this.b.node({
					loc: undefined,
					meta: conservativeMeta,
					kind: "ProjectSet",
					input: input.node,
					out,
					heading
				}),
				heading
			}
		}
		const columnItem = (input: Built, name: string, c: HeadingColumn) => ({
			name,
			type: c.type,
			expr: this.col(input.node, c)
		})
		const carriedItems = (input: Built) =>
			Arr.map(carried, (c) => columnItem(input, c.name, declColumn(c.decl)))
		if (!isAggregate(rule)) {
			/** A literal head key is a constant column of the arm's projection. */
			const plainItem = (
				h: HeadItem
			): { readonly name: string; readonly type: ScalarType; readonly expr: ScalarExpr } => {
				switch (h.kind) {
					case "var":
						return columnItem(current, h.name, declColumn(declOf(h.var.id)))
					case "computed": {
						const term = this.computed(current, h.term, nameOf)
						return { name: h.name, type: term.type, expr: term.expr }
					}
					case "literal":
						return { name: h.name, type: h.type, expr: this.literal(h.literal, h.type) }
					case "count":
					case "fold":
						throw new Error(`the head key ${h.name} is an aggregate`)
				}
			}
			return {
				...project(current, [...Arr.map(rule.head, plainItem), ...carriedItems(current)]),
				correlation
			}
		}
		/**
		 * The group's input: every variable, then each computed key and each padding an aggregate folds as a column of
		 * its own.
		 */
		const keyed = Arr.flatMap(rule.head, (h, i) =>
			h.kind === "computed" ? [{ item: h, column: `c${i}` }] : []
		)
		const paddings = Arr.flatMap(rule.head, (h, i) =>
			h.kind === "fold" && h.arg.kind === "padded"
				? [{ item: h, padding: h.arg.padding, column: `f${i}` }]
				: []
		)
		const grouped: Built =
			keyed.length === 0 && paddings.length === 0
				? current
				: project(current, [
						...Arr.map(decls, (d) => columnItem(current, d.name, declColumn(d))),
						...Arr.map(keyed, (k) => {
							const term = this.computed(current, k.item.term, nameOf)
							return { name: k.column, type: term.type, expr: term.expr }
						}),
						...Arr.map(paddings, (p) => {
							const term = this.computed(current, { kind: "padded", padding: p.padding }, nameOf)
							return { name: p.column, type: term.type, expr: term.expr }
						})
					])
		/** The column of the group's input an aggregate folds: its variable's, or its padding's. */
		const foldedColumn = (h: HeadItem, arg: ArgTerm): HeadingColumn =>
			arg.kind === "var"
				? declColumn(declOf(arg.var.id))
				: Option.getOrThrowWith(
						Option.flatMap(
							Arr.findFirst(paddings, (p) => p.item === h),
							(p) => Arr.findFirst(grouped.heading, (c) => c.name === p.column)
						),
						() => new Error(`no group column of the padding ${h.name} folds`)
					)
		const computedColumn = (h: HeadItem): HeadingColumn =>
			Option.getOrThrowWith(
				Option.flatMap(
					Arr.findFirst(keyed, (x) => x.item === h),
					(k) => Arr.findFirst(grouped.heading, (x) => x.name === k.column)
				),
				() => new Error(`no group column of the computed key ${h.name}`)
			)
		/** The group key a head item is: its variable's or its computed column, or none for an aggregate. */
		const keyOf = (h: HeadItem): ReadonlyArray<HeadingColumn> => {
			switch (h.kind) {
				case "var":
					return [declColumn(declOf(h.var.id))]
				case "computed":
					return [computedColumn(h)]
				case "count":
				case "fold":
					return []
				case "literal":
					throw new Error(
						`the head key ${h.name} is a literal beside an aggregate, which the program never states`
					)
			}
		}
		const keys: ReadonlyArray<HeadingColumn> = [
			...Arr.flatMap(rule.head, keyOf),
			...Arr.map(carried, (c) => declColumn(c.decl))
		]
		const aggs: Array<AggregateSpec> = []
		const aggColumns = new Map<HeadItem, HeadingColumn>()
		for (const h of rule.head) {
			if (h.kind !== "count" && h.kind !== "fold") {
				continue
			}
			const name = `a${aggs.length}`
			if (h.kind === "count") {
				aggs.push({
					name,
					fn: "count",
					op: aggregateOpId("count", undefined),
					args: [],
					filter: undefined
				})
			} else {
				const fn = h.fn === "mean" ? "avg" : h.fn
				const arg = foldedColumn(h, h.arg)
				aggs.push({
					name,
					fn,
					op: aggregateOpId(fn, arg.type),
					args: [this.col(grouped.node, arg)],
					filter: undefined
				})
			}
			aggColumns.set(h, columnOf(name, h.type))
		}
		const groupHeading = [...keys, ...aggColumns.values()]
		const group: Built = {
			node: this.b.node({
				loc: undefined,
				meta: conservativeMeta,
				kind: "Group",
				input: grouped.node,
				bound: foldInputOf(
					grouped.node,
					Arr.map(grouped.heading, (c) => c.name)
				),
				keys: Arr.map(keys, (c) => c.name),
				aggs,
				heading: groupHeading
			}),
			heading: groupHeading
		}
		const groupItem = (
			h: HeadItem
		): { readonly name: string; readonly type: ScalarType; readonly expr: ScalarExpr } => {
			switch (h.kind) {
				case "var":
					return columnItem(group, h.name, declColumn(declOf(h.var.id)))
				case "computed":
					return columnItem(group, h.name, computedColumn(h))
				case "count":
				case "fold": {
					const c = aggColumns.get(h)
					if (c === undefined) {
						throw new Error(`no aggregate column of ${h.name}`)
					}
					return columnItem(group, h.name, c)
				}
				case "literal":
					throw new Error(
						`the head key ${h.name} is a literal beside an aggregate, which the program never states`
					)
			}
		}
		return {
			...project(group, [...Arr.map(rule.head, groupItem), ...carriedItems(group)]),
			correlation
		}
	}

	/**
	 * A query's node: its arms' union, its take, then its attachments; a name is no node. An attached child's take ranks
	 * each parent row's children apart: its correlation fixes each correlation column to its parent column's value.
	 */
	query(q: Query<ParentColumn>, outer: Outer, substitution: Substitution): BuiltRule {
		const arms = Arr.map(q.arms, (arm) => this.rule(arm, substitution))
		const [first, ...rest] = arms
		let current: Built =
			rest.length === 0
				? first
				: {
						node: this.b.node({
							loc: undefined,
							meta: conservativeMeta,
							kind: "Union",
							groups: [
								{ heading: first.heading, arms: [first.node, ...Arr.map(rest, (a) => a.node)] }
							],
							discriminant: [],
							heading: first.heading
						}),
						heading: first.heading
					}
		if (q.bound.kind === "take") {
			current = {
				node: this.b.node({
					loc: undefined,
					meta: conservativeMeta,
					kind: "Take",
					input: current.node,
					order: completed(takeOrder(q.heading, q.bound)),
					bound: { kind: "literal", k: BigInt(q.bound.k) },
					correlation:
						outer.kind === "own"
							? []
							: Arr.map(first.correlation, (c) => ({
									column: c.child,
									expr: this.col(
										outer.parent.node,
										defined(
											Option.getOrUndefined(
												Arr.findFirst(outer.parent.heading, (h) => h.name === c.parent)
											),
											`the parent column ${c.parent}`
										)
									)
								})),
					heading: current.heading
				}),
				heading: current.heading
			}
		}
		for (const a of q.attachments) {
			const child = this.query(a.child, { kind: "attached", parent: current }, noSubstitution)
			current = {
				node: this.b.node({
					loc: undefined,
					meta: conservativeMeta,
					kind: "Attach",
					parent: current.node,
					child: child.node,
					name: a.name,
					correlation: child.correlation,
					judged: "array",
					delivered: "array",
					heading: current.heading,
					order: headingOrder(child.node.heading)
				}),
				heading: current.heading
			}
		}
		return { ...current, correlation: first.correlation }
	}

	/**
	 * A mixed root's node: a union of its heading groups, each group's arms in the order the query states them, the
	 * node's heading the columns every group holds in the first group's order, told apart by its discriminant.
	 */
	mixed(root: MixedRoot): RelNode {
		const arms = Arr.map(root.arms, (arm) => ({
			group: arm.group,
			built: this.rule(arm.rule, noSubstitution)
		}))
		const groups = Arr.map(indices(root.groups.length), (g) => {
			const [first, ...rest] = Arr.filter(arms, (a) => a.group === g)
			if (first === undefined) {
				throw new Error(`the heading group ${g} of a mixed root has no arm`)
			}
			const ids: Arr.NonEmptyReadonlyArray<RelNode> = [
				first.built.node,
				...Arr.map(rest, (a) => a.built.node)
			]
			return { heading: first.built.heading, arms: ids }
		})
		const [firstGroup, ...moreGroups] = groups
		if (firstGroup === undefined) {
			throw new Error("a mixed root of no group")
		}
		const heading = Arr.filter(firstGroup.heading, (c) =>
			Arr.every(groups, (g) => Arr.some(g.heading, (d) => d.name === c.name))
		)
		return this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "Union",
			groups: [firstGroup, ...moreGroups],
			discriminant: root.discriminant,
			heading
		})
	}

	root(root: Root): RelNode {
		const body = this.query(root, ownQuery, noSubstitution)
		if (root.delivery.kind === "set") {
			return body.node
		}
		return this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "OrderedResult",
			input: body.node,
			order: completed(root.delivery.order),
			heading: body.heading
		})
	}
}

/** The query's IR: a defect of the translation when it does not validate. */
const meaningOf = (
	c: ProgramCase,
	root: Root
): { readonly dag: ValidDag; readonly root: RelNode } => {
	const t = new Translation(c.schema)
	const node = t.root(root)
	return { dag: t.b.build([node]), root: node }
}

/** The case's facts as the reference takes them: each stored fact in the spelling that stored it. */
const factsOf = (c: ProgramCase): GenFacts => Rec.fromEntries(c.facts)

/**
 * A query read's parameters as the reference binds them: each scalar one's value, and each relation parameter's facts
 * under its relation's fields.
 */
const paramsOf = (
	read: Extract<ProgramRead, { readonly kind: "query" }>
): Readonly<Record<string, GenParam>> =>
	Rec.fromEntries([
		...Arr.map(read.params, (p): readonly [string, GenParam] => [
			p.name,
			{ kind: "scalar", type: p.type, value: p.value }
		]),
		...Arr.map(read.relations, (r): readonly [string, GenParam] => [
			r.name,
			{
				kind: "relation",
				heading: Arr.map(r.relation.fields, (f) => columnOf(f.name, f.type)),
				rows: r.rows
			}
		])
	])

/**
 * The expected delivery assembled from the reference's statements: each row's head values, and for each attachment the
 * child rows whose parent key equals the row's by native equality, the root's rows in the order they arrive in
 * (deliveredOrder).
 */
const assemble = (
	statements: ReadonlyMap<string, ExpectedStatement>,
	root: Root
): ReadonlyArray<Nested> => {
	const nested = (label: string, q: Query<ParentColumn>, heading: Heading, row: Row): Nested => ({
		values: Arr.map(q.heading, (c) => valueAt(row, columnIndex(heading, c.name, label))),
		attachments: Arr.map(q.attachments, (a) => {
			const childLabel = `${label}/${a.name}`
			const statement = statements.get(childLabel)
			if (statement === undefined) {
				throw new Error(`the reference delivered no statement ${childLabel}`)
			}
			/**
			 * The statement's heading is the parent key, of the width the reference delivers, then the child's heading or
			 * its private unit column.
			 */
			const keyWidth = statement.parentKeyWidth
			const key = statement.heading.slice(0, keyWidth)
			const childHeading = statement.heading.slice(keyWidth)
			const parentKey = Arr.map(key, (k) => valueAt(row, columnIndex(heading, k.name, label)))
			const children = Arr.map(
				Arr.filter(statement.rows, (r) =>
					Arr.every(key, (k, i) => equal(valueAt(r, i), elementAt(parentKey, i), k.type))
				),
				(r) => r.slice(keyWidth)
			)
			/** A child that ends in a take is delivered in the order it ranks by. */
			const delivered =
				a.child.bound.kind === "take"
					? sortRows(childHeading, children, completed(takeOrder(a.child.heading, a.child.bound)))
					: children
			return Arr.map(delivered, (r) => nested(childLabel, a.child, childHeading, r))
		})
	})
	const main = statements.get("main")
	if (main === undefined) {
		throw new Error("the reference delivered no main statement")
	}
	const rows = Option.match(deliveredOrder(root), {
		onNone: () => main.rows,
		onSome: (order) => sortRows(main.heading, main.rows, completed(order))
	})
	return Arr.map(rows, (row) => nested("main", root, main.heading, row))
}

/**
 * The second interpretation of a program: its meaning, translated to IR by this suite's own rules and evaluated by the
 * reference evaluator (test/support/oracle/reference), never through grizzle's checker.
 *
 * The translation states the language's definition in the reference's vocabulary:
 *
 * - a rule is a MatchRegion over one occurrence per match, every bound field a variable of the region: a variable of
 *   the program where the field binds one (a shared variable is a join), and otherwise a variable of its own that a
 *   filter fixes to the literal or parameter, or that the child's heading carries as a correlation column for the
 *   parent column it binds; a field left out is an existential witness;
 * - a match's source is a stored relation's or the roster's node, an imported query's own translation (each of its
 *   parameters bound to a variable of the importing rule is a correlated variable of its region, fixed per binding of
 *   the importing rule's earlier matches, and each bound to a parameter compared with that parameter), an interior's
 *   rule, a relation parameter's input set, or a closure's recursion over its edge relation;
 * - its comparisons are one filter, each the comparison operator of its operands' type (gen/ops.ts), a range its two
 *   bounds' comparisons, a set the disjunction of its values' equalities, an Allen atom the mask's formula of range
 *   operators (src's Allen table), a point membership the range's element containment, and each negation an anti-join
 *   with a region over the negated relation binding the same fields;
 * - a head of variables and Compute terms is a projection, each term lowered by src's Compute typing (as the
 *   reference shares src's Compute evaluator); a head with an aggregate is a group over every variable of the region,
 *   the distinct complete bindings, keyed by the head's variables, its Compute terms and, in a child, its correlation
 *   columns, so each parent folds its own children;
 * - arms of one heading are a union, `.orderBy(...).take(k)` a take over the total order it ranks by (takeOrder), a
 *   name nothing, an attachment an Attach node whose correlation pairs each parent column the child binds with the
 *   child's correlation column, and the final orderBy an ordered result.
 *
 * The reference then delivers per parent: the root's rows, and for each attachment, every distinct parent key with the
 * children correlated with it (reference/deliver.ts). This module assembles that delivery into nested rows
 * (answer.ts): each parent row gets the children whose parent key equals its own by native equality, so the expected
 * children of two parents whose keys are equal but spelled differently are the same children.
 *
 * The reference's answer to a query read over the IR given for it: its rows, ordered where the root is, assembled per
 * parent from the statements the reference delivers, its evaluation observed by `observer`. The IR is the program's
 * meaning (expectedQuery), or any other translation of the same read, such as the checker's.
 */
export const expectedFrom = (
	c: ProgramCase,
	read: Extract<ProgramRead, { readonly kind: "query" }>,
	ir: { readonly dag: ValidDag; readonly root: RelNode },
	observer: ReferenceObserver
): Answer => {
	const reference = Reference.of(ir.dag, {
		schema: referenceSchema(c.schema),
		facts: factsOf(c),
		params: paramsOf(read),
		observer
	})
	const statements = new Map(
		Arr.map(expectedStatements(reference, ir.root), (s) => [s.label, s] as const)
	)
	return Result.succeed(assemble(statements, read.query))
}

/** The reference's answer to a query read: its rows, ordered where the root is, its evaluation observed by `observer`. */
export const expectedQuery = (
	c: ProgramCase,
	read: Extract<ProgramRead, { readonly kind: "query" }>,
	observer: ReferenceObserver
): Answer => expectedFrom(c, read, meaningOf(c, read.query), observer)

/** A mixed root's IR: a defect of the translation when it does not validate. */
const mixedMeaningOf = (
	c: ProgramCase,
	root: MixedRoot
): { readonly dag: ValidDag; readonly root: RelNode } => {
	const t = new Translation(c.schema)
	const node = t.mixed(root)
	return { dag: t.b.build([node]), root: node }
}

/**
 * The reference's answer to a mixed root over the IR given for it (its meaning, or the checker's translation), per
 * heading group: each group's rows, from the reference's statement of that group, in the group's heading order; its
 * evaluation observed by `observer`.
 */
export const expectedMixedFrom = (
	c: ProgramCase,
	root: MixedRoot,
	ir: { readonly dag: ValidDag; readonly root: RelNode },
	observer: ReferenceObserver
): ReadonlyArray<Answer> => {
	const reference = Reference.of(ir.dag, {
		schema: referenceSchema(c.schema),
		facts: factsOf(c),
		params: {},
		observer
	})
	const statements = new Map(
		Arr.map(expectedStatements(reference, ir.root), (s) => [s.label, s] as const)
	)
	return Arr.map(root.groups, (columns, g): Answer => {
		const label = `group ${g}`
		const statement = statements.get(label)
		if (statement === undefined) {
			throw new Error(`the reference delivered no statement ${label}`)
		}
		return Result.succeed(
			Arr.map(statement.rows, (row) => ({
				values: Arr.map(columns, (col) =>
					valueAt(row, columnIndex(statement.heading, col.name, label))
				),
				attachments: []
			}))
		)
	})
}

/** The reference's answer to a mixed root, per heading group, its evaluation observed by `observer`. */
export const expectedMixed = (
	c: ProgramCase,
	root: MixedRoot,
	observer: ReferenceObserver
): ReadonlyArray<Answer> => expectedMixedFrom(c, root, mixedMeaningOf(c, root), observer)

/**
 * A reference value as a text cell PostgreSQL's output function may write for it, for the carriers whose output text
 * is the host value's own: an integer's decimal digits (an exact integer's too), a numeric's one text (scalar/values/decimal.ts), a text or
 * uuid as it is, and a handle as its code's digits, its declared position, as a first migration numbers a roster. A planted mixed root's arms read fields and literals alone, so it holds no other carrier
 * and no declined term's value.
 */
const cellText = (v: Value, type: ScalarType): string => {
	const carrier = baseOf(type).carrier
	const value = statedValue(v)
	if (value === undefined) {
		throw new Error("a mixed root's cell holds a declined term's value its arms never compute")
	}
	switch (carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger":
			return asBigint(value).toString()
		case "numeric":
			return asDecimal(value).toString()
		case "text":
		case "uuid":
		case "date":
			if (typeof value !== "string") {
				throw new Error(`a ${carrier} value that is no string`)
			}
			return value
		case "code": {
			const code = typeof value === "string" ? rosterOf(type)?.handles.indexOf(value) : undefined
			if (code === undefined || code < 0) {
				throw new Error(`a closed id's value that is no live handle of its roster`)
			}
			return String(code)
		}
		case "bool":
		case "bytes":
		case "bits":
		case "float4":
		case "float8":
		case "money":
		case "exactMoney":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
			throw new Error(`a mixed root's cell of the ${carrier} carrier, which its arms never hold`)
	}
}

/**
 * The reference's rows of a mixed root as the text cells the database returns for them, per heading group, each row's
 * cells in its group's heading order (MixedRoot.groups): what a query value's row decoders read, without a database.
 */
export const referenceCells = (
	c: ProgramCase,
	root: MixedRoot
): ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>> =>
	Arr.map(expectedMixed(c, root, unobserved), (answer, g) => {
		const columns = root.groups[g]
		if (columns === undefined) {
			throw new Error(`no heading group ${g}`)
		}
		if (Result.isFailure(answer)) {
			throw new Error(`the reference refused heading group ${g}: ${answer.failure}`)
		}
		return Arr.map(answer.success, (row) =>
			Arr.map(columns, (col, i) => {
				const v = row.values[i]
				if (v === undefined) {
					throw new Error(`a row of heading group ${g} has no column ${col.name}`)
				}
				return cellText(v, col.type)
			})
		)
	})

/**
 * The reference's answer to a keyed read: the facts whose key fields equal the values by native equality, every field
 * as its column holds it.
 */
export const expectedKey = (
	c: ProgramCase,
	read: Extract<ProgramRead, { readonly kind: "key" }>
): Answer => {
	const fields = read.relation.fields
	const at = (fact: ProgramFact, field: (typeof fields)[number]) =>
		literalOf(elementAt(fact, fields.indexOf(field)), field.type)
	const rows = Arr.map(
		Arr.filter(Arr.map(c.facts.get(read.relation.name) ?? [], storedFactValues), (fact) =>
			Arr.every(read.key, (field, i) =>
				equal(at(fact, field), literalOf(elementAt(read.values, i), field.type), field.type)
			)
		),
		(fact): Nested => ({ values: Arr.map(fields, (f) => at(fact, f)), attachments: [] })
	)
	return Result.succeed(rows)
}

/** The reference's answer to a read of the closed roster by handle: the handle's fact, which every handle has. */
export const expectedHandle = (read: Extract<ProgramRead, { readonly kind: "handle" }>): Answer =>
	Result.succeed([{ values: [read.handle], attachments: [] }])
