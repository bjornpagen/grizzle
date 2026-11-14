import { Array as Arr, Option, Record as Rec } from "effect"
import type { Direction } from "#compiler/core/order.ts"
import { isRecord } from "#compiler/core/record.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { date, closedId, contract, pg, span, uuid, Vector } from "#compiler/public/fields.ts"
import {
	closed,
	key,
	login,
	on,
	type Relation,
	relation,
	role,
	type Statement,
	schema,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { arm } from "#compiler/query/build/attach.ts"
import {
	type OrderedValue,
	type QueryValue,
	queryOver,
	varsOver
} from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { type ChangeSetValue, changeSetOver } from "#compiler/write/changeset/value.ts"
import { argumentsOf, nonEmptyArgumentsOf } from "#test/support/list.ts"
import { numeric, vectorDimensions, wideNumericTypmod } from "#test/support/oracle/gen/domain.ts"
import type { CompareOp } from "#test/support/oracle/gen/ops.ts"
import {
	type ArgTerm,
	type Closure,
	type Comparison,
	type ComputedTerm,
	storedFactValues,
	type FieldKind,
	type HeadItem,
	type Imported,
	type MixedRoot,
	type Operand,
	type OrderKey,
	type Padding,
	type Param,
	type ParentColumn,
	type ProgramCase,
	type ProgramFact,
	type ProgramSchema,
	paddingBounds,
	powerBounds,
	type Query,
	type Root,
	type Rule,
	type Source,
	type StatedDelivery,
	type Stored,
	unguarded,
	type Var
} from "#test/support/oracle/public/program.ts"

/** The generated text field: at most two code points of any kind, a bounded key. */
const text = str.regex("^.{0,2}$", "su")

/** Unbounded text, no key. */
const prose = str.regex("^.*$", "su")

const rosterValue = (s: ProgramSchema) => closed(s.roster.name, s.roster.handles)
type RosterValue = ReturnType<typeof rosterValue>

/**
 * A generated relation value: its name, fields and key are known only at run time, so its type is the widest the
 * relation constructor gives.
 */
type RelationValue = Relation<
	string,
	Record<string, FieldBase>,
	readonly [string, ...Array<string>]
>

/** The contract a tick field declares: one value, so every relation's tick field is one domain. */
const tick = contract("Tick", pg.bigint)

const descriptor = (kind: FieldKind, roster: RosterValue): FieldBase => {
	switch (kind) {
		case "int2":
			return pg.smallint
		case "int4":
			return pg.integer
		case "int8":
			return pg.bigint
		case "numeric":
			return pg.numeric(wideNumericTypmod.precision, wideNumericTypmod.scale)
		case "fixed":
			return pg.numeric(5, 2)
		case "float4":
			return pg.real
		case "float8":
			return pg.float8
		case "money":
			return pg.money
		case "bool":
			return pg.boolean
		case "text":
			return text
		case "prose":
			return prose
		case "uuid":
			return uuid
		case "handle":
			return closedId(roster)
		case "span4":
			return span(pg.integer)
		case "span8":
			return span(pg.bigint)
		case "tick":
			return tick
		case "vector":
			return pg.vector(vectorDimensions)
	}
}

/**
 * The descriptor a parameter is declared with: its field's own (a contract's, a typmod's) for a field declaration, and
 * for a base declaration a generated descriptor of its type's carrier, the roster's for a handle, and unbounded text
 * for text. A base parameter's type is a compared column's base (compareParamType), and compatibility reads the carrier
 * and roster, never a text's refinement nor a numeric's typmod; a parameter is checked against its declared type at
 * bind, so a base declaration carries no refinement a compared value could violate.
 */
const paramDescriptor = (param: Param, roster: RosterValue): FieldBase => {
	if (param.declaration.kind === "field") {
		return descriptor(param.declaration.field.kind, roster)
	}
	const type = param.type
	switch (type.carrier) {
		case "int2":
			return pg.smallint
		case "int4":
			return pg.integer
		case "int8":
			return pg.bigint
		case "numeric":
			return pg.numeric(wideNumericTypmod.precision, wideNumericTypmod.scale)
		case "float4":
			return pg.real
		case "float8":
			return pg.float8
		case "money":
			return pg.money
		case "bool":
			return pg.boolean
		case "text":
			return prose
		case "uuid":
			return uuid
		case "date":
			return date
		case "code":
			return closedId(roster)
		case "bytes":
			throw new Error("a parameter of bytes, which no parameter is")
		case "bits":
			throw new Error("a parameter of a set, which no drawn field declares")
		case "range4":
			return span(pg.integer)
		case "range8":
			return span(pg.bigint)
		case "rangeDate":
			return span(date)
		case "vector":
			return pg.vector(vectorDimensions)
		case "exactInteger":
		case "exactMoney":
			throw new Error(
				`a parameter of the exact carrier ${type.carrier}, which no descriptor declares`
			)
	}
}

const schemaOf = (
	declared: string,
	relations: Readonly<Record<string, RosterValue | RelationValue>>,
	statements: ReadonlyArray<Statement>
) => schema(declared, Rec.values(relations), statements)
export type SchemaValue = ReturnType<typeof schemaOf>

/**
 * The world every case opens its Db as: the full role `app`, reading every relation and writing every stored one, in
 * its login `server`.
 */
const worldOf = (value: SchemaValue) => {
	const app = role(value, "app", wholeEntriesOf(value), { write: writableNamesOf(value) })
	return { app, server: login(value, "server", [app]) }
}
export type WorldValue = ReturnType<typeof worldOf>

/**
 * The schema name every generated program is built under: its production name "generated" is no reserved schema
 * (a schema named Public would share public with the extension schema, which the installer refuses).
 */
export const generatedSchemaName = "Generated"

/**
 * The schema's values, built once: the schema under generatedSchemaName, the same relation values under the name the pg
 * substrate allocated for an installation, and each source's value, which matches, negations, ChangeSet members and
 * keyed reads name.
 */
export interface BuiltSchema {
	readonly schema: SchemaValue
	readonly installedAs: (installed: string) => SchemaValue
	/**
	 * The world over the schema under its production name, which the installation carries, and over the installed one,
	 * which a Db opens.
	 */
	readonly world: WorldValue
	readonly worldAs: (installed: string) => WorldValue
	readonly roster: RosterValue
	/** A stored or roster source; a derived one is built in the rule that matches it. */
	readonly source: (source: Source) => RosterValue | RelationValue
	readonly relation: (relation: Stored) => RelationValue
	/** The Key value of a relation's candidate key. */
	readonly candidate: (relation: Stored, fields: Arr.NonEmptyReadonlyArray<string>) => Statement
}

const fieldNames = (
	fields: Arr.NonEmptyReadonlyArray<{ readonly name: string }>
): readonly [string, ...Array<string>] => [
	fields[0].name,
	...Arr.map(fields.slice(1), (f) => f.name)
]

export const buildSchema = (s: ProgramSchema): BuiltSchema => {
	const roster = rosterValue(s)
	const relations = new Map<string, RelationValue>()
	const candidates = new Map<string, Statement>()
	const statements: Array<Statement> = []
	for (const r of s.relations) {
		const fields: Record<string, FieldBase> = {}
		for (const f of r.fields) {
			fields[f.name] = descriptor(f.kind, roster)
		}
		const value = relation(r.name, fields, fieldNames(r.primaryKey))
		relations.set(r.name, value)
		for (const c of r.candidates) {
			const statement = key(on(value, ...nonEmptyArgumentsOf(fieldNames(c))))
			candidates.set(`${r.name}\u0000${Arr.join(fieldNames(c), "\u0000")}`, statement)
			statements.push(statement)
		}
	}
	const relationValue = (r: Stored): RelationValue => {
		const value = relations.get(r.name)
		if (value === undefined) {
			throw new Error(`no relation value ${r.name}`)
		}
		return value
	}
	const declared: Record<string, RosterValue | RelationValue> = { [s.roster.name]: roster }
	for (const r of s.relations) {
		declared[r.name] = relationValue(r)
	}
	const schemaValue = schemaOf(generatedSchemaName, declared, statements)
	return {
		schema: schemaValue,
		installedAs: (installed) => schemaOf(installed, declared, statements),
		world: worldOf(schemaValue),
		worldAs: (installed) => worldOf(schemaOf(installed, declared, statements)),
		roster,
		source: (source) => {
			switch (source.kind) {
				case "roster":
					return roster
				case "stored":
					return relationValue(source)
				case "import":
				case "interior":
				case "relation param":
				case "closure":
					throw new Error(`a ${source.kind} source is built in the rule that matches it`)
			}
		},
		relation: relationValue,
		candidate: (r, fields) => {
			const statement = candidates.get(`${r.name}\u0000${Arr.join(fields, "\u0000")}`)
			if (statement === undefined) {
				throw new Error(`no key(on(${r.name}, ${Arr.join(fields, ", ")}))`)
			}
			return statement
		}
	}
}

/**
 * The host value an application passes for a literal of `type`: an integer as a number, a bigint as a bigint, numeric
 * as a Decimal, a float as a number (NaN and the infinities included), money as a Money, a handle as its name, a set as
 * the Set of its handles.
 */
export const hostValue = (literal: TypedLiteral, type: ScalarType): unknown => {
	switch (literal.kind) {
		case "int":
			return type.carrier === "int8" ? literal.value : Number(literal.value)
		case "numeric":
		case "money":
			return literal.value
		case "vector":
			return Vector.fromValue(literal.value)
		case "float":
			return literal.value
		case "floatSpecial":
			return literal.value === "NaN"
				? Number.NaN
				: literal.value === "Infinity"
					? Number.POSITIVE_INFINITY
					: Number.NEGATIVE_INFINITY
		case "bool":
		case "text":
		case "uuid":
		case "date":
			return literal.value
		case "handle":
			return literal.handle
		case "handles":
			return new Set(literal.handles)
		case "span":
			return {
				start: type.carrier === "range8" ? literal.start : Number(literal.start),
				end: type.carrier === "range8" ? literal.end : Number(literal.end)
			}
	}
}

/** A fact as the row a ChangeSet insert or a relation parameter takes: each field's host value. */
export const factRecord = (
	stored: Stored,
	fact: ProgramFact
): Readonly<Record<string, unknown>> => {
	const row: Record<string, unknown> = {}
	for (const [i, f] of stored.fields.entries()) {
		const literal = fact[i]
		if (literal === undefined) {
			throw new Error(`a fact of ${stored.name} has no value for ${f.name}`)
		}
		row[f.name] = hostValue(literal, f.type)
	}
	return row
}

/**
 * A case's facts, by each relation that holds any: the relation and its facts as records, each value in its one form,
 * whatever spelling the fact drew, as a change member stores it.
 */
export const factRows = (
	c: ProgramCase
): ReadonlyArray<{
	readonly relation: Stored
	readonly rows: Arr.NonEmptyReadonlyArray<Readonly<Record<string, unknown>>>
}> =>
	Arr.flatMap(c.schema.relations, (r) => {
		const facts = c.facts.get(r.name) ?? []
		return Arr.isReadonlyArrayNonEmpty(facts)
			? [{ relation: r, rows: Arr.map(facts, (fact) => factRecord(r, storedFactValues(fact))) }]
			: []
	})

/**
 * The ChangeSet that stores a case's facts: one insert per relation that holds any (factRows), each an array member a
 * call supplies its rows to, or none when no relation does.
 */
export const factsChangeSet = (
	c: ProgramCase,
	built: BuiltSchema,
	value: SchemaValue
): Option.Option<ChangeSetValue> => {
	const holding = factRows(c)
	return Arr.isReadonlyArrayNonEmpty(holding)
		? Option.some(
				Arr.reduce(holding, changeSetOver.empty(value), (changes, { relation, rows }) =>
					changes.insert(built.relation(relation), rows)
				)
			)
		: Option.none()
}

/** The comparison `op` over two terms, through the rule builder's own member. */
const compare = (r: RuleValue, op: CompareOp, left: unknown, right: unknown): unknown => {
	switch (op) {
		case "eq":
			return r.eq(left, right)
		case "ne":
			return r.ne(left, right)
		case "lt":
			return r.lt(left, right)
		case "le":
			return r.le(left, right)
		case "gt":
			return r.gt(left, right)
		case "ge":
			return r.ge(left, right)
	}
}

/**
 * A padding through Compute's admission cores: Compute.when(Compute.within(v, low, high), (v) =>
 * Compute.numeric(Compute.cast(v, pg.numeric(1000, scale))), Compute.numeric(v)).
 */
const paddingTerm = (p: Padding, term: (v: Var) => unknown): unknown => {
	const type = p.arg.field.type
	const [low, high] = paddingBounds(type)
	return computeCore.when(
		computeCore.within(term(p.arg), hostValue(low, type), hostValue(high, type)),
		(v: unknown) => computeCore.numeric(computeCore.cast(v, pg.numeric(1000, p.scale))),
		computeCore.numeric(term(p.arg))
	)
}

/** What an aggregate or a reading reads: its variable's term, or the variable's padding. */
const argTermValue = (a: ArgTerm, term: (v: Var) => unknown): unknown =>
	a.kind === "var" ? term(a.var) : paddingTerm(a.padding, term)

/** The Compute term of a computed head key, through Compute's admission cores. */
const computedTerm = (r: RuleValue, t: ComputedTerm, term: (v: Var) => unknown): unknown => {
	switch (t.kind) {
		case "base":
			return computeCore.base(term(t.arg))
		case "cast numeric":
			return computeCore.numeric(term(t.arg))
		case "cond":
			return computeCore.cond(
				compare(r, t.op, term(t.arg), hostValue(t.than, t.arg.field.type)),
				term(t.arg),
				hostValue(t.otherwise, t.arg.field.type)
			)
		case "padded":
			return paddingTerm(t.padding, term)
		case "div":
			return computeCore.div(argTermValue(t.dividend, term), hostValue(t.divisor, numeric))
		case "sqrt":
			return computeCore.when(
				computeCore.nonnegative(argTermValue(t.radicand, term)),
				(a: unknown) => computeCore.sqrt(a),
				hostValue(unguarded, numeric)
			)
		case "power":
			return computeCore.when(
				computeCore.within(
					argTermValue(t.base, term),
					hostValue(powerBounds[0], numeric),
					hostValue(powerBounds[1], numeric)
				),
				(a: unknown) => computeCore.power(a, hostValue(t.exponent, numeric)),
				hostValue(unguarded, numeric)
			)
	}
}

/** The head term of one head key. */
const headTerm = (r: RuleValue, h: HeadItem, term: (v: Var) => unknown): unknown => {
	switch (h.kind) {
		case "var":
			return term(h.var)
		case "count":
			return r.count()
		case "computed":
			return computedTerm(r, h.term, term)
		case "literal":
			return hostValue(h.literal, h.type)
		case "fold":
			switch (h.fn) {
				case "sum":
					return r.sum(argTermValue(h.arg, term))
				case "mean":
					return r.mean(argTermValue(h.arg, term))
				case "min":
					return r.min(argTermValue(h.arg, term))
				case "max":
					return r.max(argTermValue(h.arg, term))
			}
	}
}

/**
 * The closure query(S).recursive(name, ...): its base arm each edge from a to b where a < b, and its recursive arm a
 * path from s to m extended by an edge from m to t where m < t.
 */
const closureQuery = (built: BuiltSchema, value: SchemaValue, closure: Closure): QueryValue => {
	const edge = built.relation(closure.edge)
	const from = closure.from.name
	const to = closure.to.name
	return queryOver(value).recursive(closure.name, {
		row: {
			src: descriptor(closure.from.kind, built.roster),
			dst: descriptor(closure.to.kind, built.roster)
		},
		base: [
			(r: RuleValue): FinishedValue => {
				const e = varsOver(edge, "edge")
				return r
					.match(edge, { [from]: e[from], [to]: e[to] })
					.where(r.lt(e[from], e[to]))
					.find({ src: e[from], dst: e[to] })
			}
		],
		rec: [
			(r: RuleValue, self: unknown): FinishedValue => {
				const path = varsOver(self, "self")
				const e = varsOver(edge, "edge")
				return r
					.match(self, { src: path["src"], dst: path["dst"] })
					.match(edge, { [from]: path["dst"], [to]: e[to] })
					.where(r.lt(path["dst"], e[to]))
					.find({ src: path["src"], dst: e[to] })
			}
		]
	})
}

/**
 * The callback of one rule: its matches, each over fresh variables in a scope of its own, `match<index>`, a variable's
 * term taken where it first occurs, a derived source built at the match that reads it; its comparisons, ranges, sets,
 * Allen atoms, point memberships, connectives and negations in one where; its head. `parent` holds the parent's head
 * terms, which an attachment's callback receives.
 */
const ruleCallback =
	(
		built: BuiltSchema,
		value: SchemaValue,
		rule: Rule<ParentColumn>,
		parent: Readonly<Record<string, unknown>>
	) =>
	(r: RuleValue): FinishedValue => {
		const terms = new Map<number, unknown>()
		const term = (v: Var): unknown => {
			if (!terms.has(v.id)) {
				throw new Error(`the variable ${v.id} is used before a match binds it`)
			}
			return terms.get(v.id)
		}
		const param = (p: Param): unknown => r.param(p.name, paramDescriptor(p, built.roster))
		const operand = (o: Operand<ParentColumn>, type: ScalarType): unknown => {
			switch (o.kind) {
				case "var":
					return term(o.var)
				case "literal":
					return hostValue(o.literal, type)
				case "param":
					return param(o.param)
				case "parent":
					if (!Rec.has(parent, o.column.name)) {
						throw new Error(`no parent term ${o.column.name}`)
					}
					return parent[o.column.name]
			}
		}
		/** An earlier read's query, its parameters bound to the variables or parameters its binds name. */
		const imported = (source: Imported): unknown => {
			const q = buildQuery(built, value, source.query, {})
			if (source.binds.length === 0) {
				return q
			}
			const bindings: Record<string, unknown> = {}
			for (const b of source.binds) {
				bindings[b.param.name] = b.to.kind === "var" ? term(b.to.var) : param(b.to.param)
			}
			return q.bind(bindings)
		}
		const sourceValue = (source: Source): unknown => {
			switch (source.kind) {
				case "stored":
				case "roster":
					return built.source(source)
				case "import":
					return imported(source)
				case "interior": {
					const stage = source.rule
					return r.interior((inner: RuleValue) => ruleCallback(built, value, stage, {})(inner))
				}
				case "relation param":
					return r.relation(source.param.name, built.relation(source.param.relation))
				case "closure":
					return closureQuery(built, value, source)
			}
		}
		let ruled = r
		for (const [index, m] of rule.matches.entries()) {
			const source = sourceValue(m.source)
			const vars = varsOver(source, `match${index}`)
			const bindings: Record<string, unknown> = {}
			for (const b of m.bindings) {
				if (b.operand.kind === "var" && !terms.has(b.operand.var.id)) {
					terms.set(b.operand.var.id, vars[b.field.name])
				}
				bindings[b.field.name] = operand(b.operand, b.field.type)
			}
			ruled = ruled.match(source, bindings)
		}
		const comparison = (c: Comparison): unknown =>
			compare(r, c.op, term(c.left), operand(c.right, c.left.field.type))
		const predicates = [
			...Arr.map(rule.where, comparison),
			...Arr.map(rule.between, (b) =>
				r.between(
					term(b.left),
					operand(b.low, b.left.field.type),
					operand(b.high, b.left.field.type)
				)
			),
			...Arr.map(rule.inSets, (s) =>
				r.inSet(
					term(s.left),
					Arr.map(s.values, (l) => hostValue(l, s.left.field.type))
				)
			),
			...Arr.map(rule.allens, (a) => r.allen(term(a.left), a.mask, term(a.right))),
			...Arr.map(rule.pointIns, (p) => r.pointIn(term(p.point), term(p.span))),
			...Arr.map(rule.connectives, (j) => {
				const args = argumentsOf(Arr.map(j.args, comparison))
				return j.kind === "and" ? r.and(...args) : r.or(...args)
			}),
			...Arr.map(rule.negations, (n) => {
				const bindings: Record<string, unknown> = {}
				for (const b of n.bindings) {
					bindings[b.field.name] = term(b.var)
				}
				return r.not(
					n.source.kind === "stored" ? built.relation(n.source) : imported(n.source),
					bindings
				)
			})
		]
		if (predicates.length > 0) {
			ruled = ruled.where(...argumentsOf(predicates))
		}
		const head: Record<string, unknown> = {}
		for (const h of rule.head) {
			head[h.name] = headTerm(r, h, term)
		}
		return ruled.find(head)
	}

/** attach's delivery argument for a stated delivery: its name, or the arm arm(field, handle) builds. */
const deliveryArg = (delivery: StatedDelivery): unknown =>
	delivery.kind === "arm" ? arm(delivery.field.name, delivery.handle) : delivery.kind

const orderArgs = (
	order: Arr.NonEmptyReadonlyArray<OrderKey>
): ReadonlyArray<readonly [string, Direction]> =>
	Arr.map(order, (k) => [k.column.name, k.dir] as const)

/**
 * A query as an application chains it: query(S).rule(...) per arm, then orderBy(...).take(k), then named(name), then
 * each attachment.
 */
const buildQuery = (
	built: BuiltSchema,
	value: SchemaValue,
	q: Query<ParentColumn>,
	parent: Readonly<Record<string, unknown>>
): QueryValue => {
	const [first, ...rest] = q.arms
	let query = queryOver(value).rule(ruleCallback(built, value, first, parent))
	for (const armRule of rest) {
		query = query.rule(ruleCallback(built, value, armRule, parent))
	}
	if (q.bound.kind === "take") {
		query = query.orderBy(...argumentsOf(orderArgs(q.bound.order))).take(q.bound.k)
	}
	if (q.stage.kind === "named") {
		query = query.named(q.stage.name)
	}
	for (const a of q.attachments) {
		query = query.attach(
			a.name,
			(p: unknown) => {
				if (!isRecord(p)) {
					throw new Error(`the attachment ${a.name} was given no record of parent terms`)
				}
				return buildQuery(built, value, a.child, p)
			},
			deliveryArg(a.delivery)
		)
	}
	return query
}

/**
 * A mixed root's query: its arms in order, each finding its own head, so the arms of each key set are one heading group.
 */
export const buildMixed = (built: BuiltSchema, value: SchemaValue, root: MixedRoot): QueryValue => {
	const [first, ...rest] = root.arms
	let query = queryOver(value).rule(ruleCallback(built, value, first.rule, {}))
	for (const armRule of rest) {
		query = query.rule(ruleCallback(built, value, armRule.rule, {}))
	}
	return query
}

/**
 * The first interpretation of a program: the calls an application makes to grizzle's public builders.
 *
 * The schema is built by relation, closed, key and schema, and its world by role and login, its facts by
 * ChangeSet.empty(S).insert(R, facts),
 * and each query by query(S).rule(...), v, match, where, not, find and the aggregates, then orderBy, take, named,
 * attach (in the delivery each attachment states, arm(field, handle) for an arm) and a final orderBy, exactly as an
 * application chains them. A rule's derived sources are built where the match that reads them is: an earlier read's
 * query and its Query.bind, r.interior, r.relation and query(S).recursive; its filters are r.eq ... r.ge, r.between,
 * r.inSet, r.allen, r.pointIn and r.not in one where; its Compute terms Compute.base, Compute.cast, Compute.cond,
 * Compute.div, and Compute.when over Compute.within or Compute.nonnegative guarding a typmod's cast, Compute.sqrt and
 * Compute.power; its aggregates r.count, r.sum, r.mean, r.min and r.max, over a variable or a padding of one. The
 * builders record Descriptions, and everything grizzle does with them (checking, lowering, running, decoding) is under
 * test. The shapes are known only at run time, so the builders are driven through their runtime as a JavaScript
 * caller drives them (queryOver, varsOver, changeSetOver, computeCore): the same values the typed facade returns,
 * whose signatures test/types holds.
 *
 * The root query, ordered when its delivery is.
 */
export const buildRoot = (
	built: BuiltSchema,
	value: SchemaValue,
	root: Root
): QueryValue | OrderedValue => {
	const query = buildQuery(built, value, root, {})
	return root.delivery.kind === "ordered"
		? query.orderBy(...argumentsOf(orderArgs(root.delivery.order)))
		: query
}
