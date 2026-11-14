import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option, Record as Rec } from "effect"
import { indices } from "#compiler/core/array.ts"
import type { FieldDesc, QueryDesc } from "#compiler/ir/desc.ts"
import {
	type QueryDesc as AuthoredQueryDesc,
	type BindingsDesc,
	decodedQuery,
	type AuthoredExprDesc as ExprDesc,
	type HeadTermDesc,
	type QueryStageDesc,
	type RuleDesc,
	type SourceDesc,
	type VarDesc
} from "#test/support/fixtures/ir/desc.ts"
import {
	closedName,
	type FieldName,
	fieldNames,
	type ParamsRead,
	type RelationName,
	relationNames,
	relationParam,
	subsetsOf
} from "#test/unit/analysis/small/universe.ts"

/** An attachment of a plan: a scan of a source, or the root's ordinal. */
export type Child =
	| {
			readonly kind: "scan"
			readonly name: string
			readonly source: RelationName | typeof closedName
			readonly links: number
	  }
	| { readonly kind: "ordinal"; readonly name: string; readonly source: RelationName }

/** What a match reads: a stored relation of the universe, the closed relation or the relation parameter. */
export type SourceName = RelationName | typeof closedName | typeof relationParam

/** What a plan starts from: a source, or the recursive closure of R imported as a query. */
type ScanName = SourceName | "reach" | typeof selectedS

/**
 * S's facts whose a is 1: the scan of S under the filter a = 1, which reads its fields from one fact a selection on a
 * holds of in one operator, where a scan and a filter would take two.
 */
const selectedS = "S where a = 1"

/** A column's type: an integer field's, a bigint (a count, a sum, a widened integer) or the closed roster's handle. */
type ColumnType = "int4" | "int8" | "handle"

export type Step =
	| { readonly op: "filter"; readonly column: number; readonly value: "literal" | "param" }
	| { readonly op: "project"; readonly keep: ReadonlyArray<number> }
	| {
			readonly op: "join"
			readonly source: SourceName
			readonly column: number
			readonly field: FieldName
			readonly other: "head" | "witness"
	  }
	| {
			readonly op: "negate"
			readonly source: SourceName
			readonly column: number
			readonly field: FieldName
	  }
	| { readonly op: "count"; readonly by: ReadonlyArray<number> }
	| { readonly op: "sum"; readonly by: ReadonlyArray<number>; readonly arg: number }
	| { readonly op: "compute"; readonly column: number; readonly fn: "widen" | "halve" }
	| { readonly op: "take" }
	| { readonly op: "union"; readonly relation: RelationName; readonly tagged: boolean }
	| { readonly op: "hunion"; readonly relation: RelationName }
	| {
			readonly op: "attach"
			readonly source: RelationName | typeof closedName
			readonly links: Arr.NonEmptyReadonlyArray<Link>
	  }
	| {
			readonly op: "ordinal"
			readonly source: RelationName
			readonly field: FieldName
			readonly inclusive: boolean
			readonly conjunct: boolean
	  }

/** A parent column an attached child's field is bound to. */
export interface Link {
	readonly column: number
	readonly field: FieldName
}

/** Which sources, scans and operators a space draws from. */
export interface Grammar {
	readonly name: "core" | "extended"
	readonly scans: Arr.NonEmptyReadonlyArray<ScanName>
	/** The sources a join, a negation or an attachment matches. */
	readonly sources: ReadonlyArray<SourceName>
	readonly extended: boolean
}

export const coreGrammar: Grammar = {
	name: "core",
	scans: [...relationNames, selectedS],
	sources: relationNames,
	extended: false
}

export const extendedGrammar: Grammar = {
	name: "extended",
	scans: ["R", "S", closedName, relationParam, "reach"],
	sources: ["R", "S", closedName, relationParam],
	extended: true
}

const integer: FieldDesc = { kind: "pg", type: "integer" }
const bigint: FieldDesc = { kind: "pg", type: "bigint" }

/** The head keys of a count, a sum and a union's tag. */
const countKey = "n"
const sumKey = "s"
const tagKey = "t"

/** A column of the rule's head: its key and, when it delivers a variable of the rule, that variable. */
interface Column {
	readonly key: string
	readonly term: HeadTermDesc
	readonly variable: string | undefined
	readonly type: ColumnType
}

/** A rule still open to rule steps. */
interface OpenRule {
	readonly kind: "open"
	readonly vars: ReadonlyArray<VarDesc>
	readonly matches: RuleDesc["matches"]
	readonly where: ReadonlyArray<ExprDesc>
	readonly head: ReadonlyArray<Column>
}

/** A column of a sealed query's heading. */
interface SealedColumn {
	readonly key: string
	readonly type: ColumnType
}

/** A query sealed by a step: only take, attach and ordinal wrap it now. */
interface Sealed {
	readonly kind: "sealed"
	readonly stage: QueryStageDesc
	readonly head: ReadonlyArray<SealedColumn>
}

/**
 * A read of the root that the universe varies: a stored relation or the relation parameter. C's facts are the same in
 * every database, so reading it twice binds nothing the universe leaves out.
 */
type VariedRead = RelationName | typeof relationParam

/** What the scan and the steps so far resolve to, with what the suite reads of them. */
export interface Plan {
	readonly scan: ScanName
	readonly steps: ReadonlyArray<Step>
	readonly state: OpenRule | Sealed
	/**
	 * Every varied source the root's rows read, once per match, negation or union arm; an attachment's child is not
	 * the root's. The closure reads R in its base and again in its step.
	 */
	readonly reads: ReadonlyArray<VariedRead>
	/**
	 * The attachments, by name: a scan of the source each matches, its fields bound to parent columns, or the ordinal of
	 * the root's own fact, a count of the facts of the root's scan in its group at or before it.
	 */
	readonly children: ReadonlyArray<Child>
	readonly params: ParamsRead
	readonly union: boolean
	/** A union of arms of different headings, whose order may not complete. */
	readonly heterogeneous: boolean
	/**
	 * A computed column that maps the universe's two values to one (halve): a function of a key that the universe
	 * makes constant, which no analysis can be asked to see.
	 */
	readonly collapsed: boolean
}

const variable = (id: string): ExprDesc => ({ kind: "var", var: id })

interface SourceField {
	readonly field: string
	readonly type: "int4" | "handle"
}

const intFields: ReadonlyArray<SourceField> = Arr.map(fieldNames, (field) => ({
	field,
	type: "int4"
}))

/** Every field of a source, in its heading's order. */
const fieldsOf = (source: SourceName): ReadonlyArray<SourceField> => {
	switch (source) {
		case "R":
		case "S":
			return intFields
		case "C":
			return [{ field: "id", type: "handle" }, ...intFields]
		case "P":
			return [{ field: "a", type: "int4" }]
	}
}

/** The integer fields of a source. */
const integerFields = (source: SourceName): ReadonlyArray<FieldName> =>
	Arr.filter(fieldNames, (f) =>
		Arr.some(fieldsOf(source), (s) => s.field === f && s.type === "int4")
	)

/** The other integer field of a source, if it has two. */
const otherField = (source: SourceName, field: FieldName): Option.Option<FieldName> =>
	Arr.findFirst(integerFields(source), (f) => f !== field)

const sourceDesc = (source: SourceName): SourceDesc =>
	source === relationParam
		? { kind: "param", name: relationParam, heading: { a: integer } }
		: { kind: "relation", name: source }

/** A variable a match of `source` binds to `field`: a stored or closed field is its origin; a parameter's is none. */
const fieldVar = (source: SourceName, field: string, id: string): VarDesc =>
	source === relationParam ? { id, origin: undefined } : { id, origin: { relation: source, field } }

/**
 * Whether every match of a rule binds every field of its source: a stored or closed relation, the parameter, or the
 * imported closure, by its whole heading. A fold reads each fact it matches once, by a key (FoldOverProjection
 * otherwise), and the whole heading holds a key of every source under every variant, so a count or a sum is offered
 * over such a rule alone: a fold over a projection is no plan.
 */
const wholeMatches = (matches: RuleDesc["matches"]): boolean =>
	Arr.every(matches, (m) => {
		const bound = Rec.keys(m.bindings)
		switch (m.source.kind) {
			case "relation":
			case "param": {
				const name = m.source.name
				const source = Arr.findFirst(
					[...relationNames, closedName, relationParam] as const,
					(n) => n === name
				)
				return (
					Option.isSome(source) && Arr.every(fieldsOf(source.value), (f) => bound.includes(f.field))
				)
			}
			case "query":
				return Arr.every(["a", "b"], (f) => bound.includes(f))
			case "context":
			case "delta":
			case "interior":
			case "paramOf":
			case "row":
			case "self":
				return false
		}
	})

const variedRead = (source: SourceName): ReadonlyArray<VariedRead> =>
	source === "R" || source === "S" || source === relationParam ? [source] : []

/** The recursive closure of R: a base arm reading R's facts as edges and a step extending a path by one edge. */
const reachQuery: AuthoredQueryDesc = {
	stage: {
		kind: "recursive",
		recursive: {
			name: "reach",
			row: { a: integer, b: integer },
			base: [
				{
					vars: [fieldVar("R", "a", "x"), fieldVar("R", "b", "y")],
					matches: [{ source: sourceDesc("R"), bindings: { a: variable("x"), b: variable("y") } }],
					where: [],
					head: { a: variable("x"), b: variable("y") },
					interiors: [],
					attach: []
				}
			],
			rec: [
				{
					vars: [
						{ id: "x", origin: undefined },
						{ id: "m", origin: undefined },
						fieldVar("R", "b", "y")
					],
					matches: [
						{ source: { kind: "self" }, bindings: { a: variable("x"), b: variable("m") } },
						{ source: sourceDesc("R"), bindings: { a: variable("m"), b: variable("y") } }
					],
					where: [],
					head: { a: variable("x"), b: variable("y") },
					interiors: [],
					attach: []
				}
			]
		}
	}
}

/** The rule of an open state, its head extended by `extraHead`. */
const ruleOf = (r: OpenRule, extraHead: Readonly<Record<string, HeadTermDesc>>): RuleDesc => ({
	vars: r.vars,
	matches: r.matches,
	where: r.where,
	head: { ...Rec.fromEntries(Arr.map(r.head, (c) => [c.key, c.term])), ...extraHead },
	interiors: [],
	attach: []
})

const columnsOf = (state: OpenRule | Sealed): ReadonlyArray<SealedColumn> =>
	state.kind === "open" ? Arr.map(state.head, (c) => ({ key: c.key, type: c.type })) : state.head

const keysOf = (state: OpenRule | Sealed): ReadonlyArray<string> =>
	Arr.map(columnsOf(state), (c) => c.key)

const stageOf = (state: OpenRule | Sealed): QueryStageDesc =>
	state.kind === "open" ? { kind: "rules", arms: [ruleOf(state, {})] } : state.stage

/** The query a plan resolves to. */
export const descOf = (plan: Plan): QueryDesc => decodedQuery(stageOf(plan.state))

const noParams: ParamsRead = { scalar: false, relation: false }

/** The scan of a source or of the closure: every field a fresh variable `<field>0`, all in the head. */
const scan = (name: ScanName): Plan => {
	const base = {
		scan: name,
		steps: [],
		children: [],
		union: false,
		heterogeneous: false,
		collapsed: false
	}
	if (name === "reach") {
		const vars: ReadonlyArray<VarDesc> = Arr.map(fieldNames, (field) => ({
			id: `${field}0`,
			origin: undefined
		}))
		return {
			...base,
			state: {
				kind: "open",
				vars,
				matches: [
					{
						source: { kind: "query", query: reachQuery, bind: {} },
						bindings: Rec.fromEntries(
							Arr.map(fieldNames, (field) => [field, variable(`${field}0`)])
						)
					}
				],
				where: [],
				head: Arr.map(vars, (v) => ({
					key: v.id,
					term: variable(v.id),
					variable: v.id,
					type: "int4"
				}))
			},
			reads: ["R", "R"],
			params: noParams
		}
	}
	const source = name === selectedS ? "S" : name
	const fields = fieldsOf(source)
	const bindings: BindingsDesc = Rec.fromEntries(
		Arr.map(fields, (f) => [f.field, variable(`${f.field}0`)])
	)
	return {
		...base,
		state: {
			kind: "open",
			vars: Arr.map(fields, (f) => fieldVar(source, f.field, `${f.field}0`)),
			matches: [{ source: sourceDesc(source), bindings }],
			where:
				name === selectedS
					? [
							{
								kind: "compare",
								op: "eq",
								left: variable("a0"),
								right: { kind: "literal", value: 1, type: integer }
							}
						]
					: [],
			head: Arr.map(fields, (f) => ({
				key: `${f.field}0`,
				term: variable(`${f.field}0`),
				variable: `${f.field}0`,
				type: f.type
			}))
		},
		reads: variedRead(source),
		params: { scalar: false, relation: source === relationParam }
	}
}

/** c <> 0: a conjunct beside the ordinal's comparison, unknown where c is read as the root's own value. */
const nonzero: ExprDesc = {
	kind: "compare",
	op: "ne",
	left: variable("c"),
	right: { kind: "literal", value: 0, type: integer }
}

/** The scan's own column of `field` among a head's keys, `<field>0`: where it stands, or none. */
const ownColumn = (keys: ReadonlyArray<string>, field: FieldName): Option.Option<number> =>
	Arr.findFirstIndex(keys, (key) => key === `${field}0`)

/** The index of the scan's own column of `field`, which the step's offer guaranteed to stand in the head. */
const columnOf = (keys: ReadonlyArray<string>, field: FieldName): number =>
	Option.getOrThrowWith(
		ownColumn(keys, field),
		() =>
			new Error(`the plan offered an ordinal over ${field}, whose own column is not in the head`)
	)

/** The key a step names, which the step's offer guaranteed to exist. */
const keyAt = (keys: ReadonlyArray<string>, i: number): string => {
	const key = keys[i]
	if (key === undefined) {
		throw new Error(`the plan offered column ${i} of a head of ${keys.length}`)
	}
	return key
}

/** The field a union arm binds its i-th head column to: a, then b; the offer admits heads of one or two columns. */
const fieldAt = (i: number): FieldName => {
	const field = fieldNames[i]
	if (field === undefined) {
		throw new Error(`the plan offered a union over a head of more than two columns`)
	}
	return field
}

/** The column a step names, which the step's offer guaranteed to exist and to deliver a variable where it must. */
const columnAt = (head: ReadonlyArray<Column>, i: number): Column => {
	const column = head[i]
	if (column === undefined) {
		throw new Error(`the plan offered column ${i} of a head of ${head.length}`)
	}
	return column
}

const variableAt = (head: ReadonlyArray<Column>, i: number): string => {
	const v = columnAt(head, i).variable
	if (v === undefined) {
		throw new Error(`the plan offered column ${i}, which delivers no variable`)
	}
	return v
}

const otherOf = (source: SourceName, field: FieldName): FieldName =>
	Option.getOrThrowWith(
		otherField(source, field),
		() => new Error(`the plan offered ${source}'s other field beside ${field}, which it lacks`)
	)

/** The plan with one more step. */
const extend = (plan: Plan, step: Step): Plan => {
	const state = plan.state
	const next = (changes: Partial<Plan>): Plan => ({
		...plan,
		...changes,
		steps: [...plan.steps, step]
	})
	switch (step.op) {
		case "take":
			return next({
				state: {
					kind: "sealed",
					stage: {
						kind: "take",
						input: {
							kind: "order",
							input: stageOf(state),
							order: [{ column: keyAt(keysOf(state), 0), dir: "asc" }]
						},
						take: { kind: "literal", k: 1 }
					},
					head: columnsOf(state)
				}
			})
		case "attach": {
			const name = `child${plan.children.length}`
			const keys = keysOf(state)
			const parent = (link: Link): ExprDesc => ({
				kind: "parent",
				column: keyAt(keys, link.column)
			})
			const [first, ...more] = step.links
			const bound = Rec.fromEntries(
				Arr.map(step.links, (link) => [link.field, parent(link)] as const)
			)
			/** One field bound to the parent leaves the other the child's head; both bound deliver the first parent column. */
			const arm: RuleDesc = Arr.isReadonlyArrayNonEmpty(more)
				? {
						vars: [],
						matches: [{ source: sourceDesc(step.source), bindings: bound }],
						where: [],
						head: { c: parent(first) },
						interiors: [],
						attach: []
					}
				: {
						vars: [fieldVar(step.source, otherOf(step.source, first.field), "c")],
						matches: [
							{
								source: sourceDesc(step.source),
								bindings: { ...bound, [otherOf(step.source, first.field)]: variable("c") }
							}
						],
						where: [],
						head: { c: variable("c") },
						interiors: [],
						attach: []
					}
			return next({
				state: {
					kind: "sealed",
					stage: {
						kind: "attach",
						input: stageOf(state),
						attach: { name, child: { stage: { kind: "rules", arms: [arm] } } }
					},
					head: columnsOf(state)
				},
				children: [
					...plan.children,
					{ kind: "scan", name, source: step.source, links: step.links.length }
				]
			})
		}
		case "ordinal": {
			const name = `child${plan.children.length}`
			const source = step.source
			const keys = keysOf(state)
			const other = otherOf(source, step.field)
			const parent = (field: FieldName): ExprDesc => ({
				kind: "parent",
				column: keyAt(keys, columnOf(keys, field))
			})
			const arm: RuleDesc = {
				vars: [fieldVar(source, other, "c")],
				matches: [
					{
						source: sourceDesc(source),
						bindings: { [step.field]: parent(step.field), [other]: variable("c") }
					}
				],
				where: [
					{
						kind: "compare",
						op: step.inclusive ? "le" : "lt",
						left: variable("c"),
						right: parent(other)
					},
					...(step.conjunct ? [nonzero] : [])
				],
				head: { n: { kind: "aggregate", fn: "count" } },
				interiors: [],
				attach: []
			}
			return next({
				state: {
					kind: "sealed",
					stage: {
						kind: "attach",
						input: stageOf(state),
						attach: { name, child: { stage: { kind: "rules", arms: [arm] } } }
					},
					head: columnsOf(state)
				},
				children: [...plan.children, { kind: "ordinal", name, source }]
			})
		}
		case "compute":
		case "count":
		case "filter":
		case "hunion":
		case "join":
		case "negate":
		case "project":
		case "sum":
		case "union":
			break
	}
	if (state.kind === "sealed") {
		throw new Error(`the plan offered ${step.op} after the rule was sealed`)
	}
	switch (step.op) {
		case "filter":
			return next({
				state: {
					...state,
					where: [
						...state.where,
						{
							kind: "compare",
							op: "eq",
							left: variable(variableAt(state.head, step.column)),
							right:
								step.value === "literal"
									? { kind: "literal", value: 1, type: integer }
									: { kind: "param", name: "p", type: integer }
						}
					]
				},
				params: { ...plan.params, scalar: plan.params.scalar || step.value === "param" }
			})
		case "project":
			return next({ state: { ...state, head: Arr.map(step.keep, (i) => columnAt(state.head, i)) } })
		case "join": {
			const m = state.matches.length
			const other = step.other === "head" ? otherOf(step.source, step.field) : undefined
			const fresh = other === undefined ? undefined : fieldVar(step.source, other, `${other}${m}`)
			const bindings: BindingsDesc = {
				[step.field]: variable(variableAt(state.head, step.column)),
				...(other === undefined || fresh === undefined ? {} : { [other]: variable(fresh.id) })
			}
			return next({
				state: {
					...state,
					vars: fresh === undefined ? state.vars : [...state.vars, fresh],
					matches: [...state.matches, { source: sourceDesc(step.source), bindings }],
					head:
						fresh === undefined
							? state.head
							: [
									...state.head,
									{ key: fresh.id, term: variable(fresh.id), variable: fresh.id, type: "int4" }
								]
				},
				reads: [...plan.reads, ...variedRead(step.source)],
				params: { ...plan.params, relation: plan.params.relation || step.source === relationParam }
			})
		}
		case "negate":
			return next({
				state: {
					...state,
					where: [
						...state.where,
						{
							kind: "absent",
							source: sourceDesc(step.source),
							bindings: { [step.field]: variable(variableAt(state.head, step.column)) }
						}
					]
				},
				reads: [...plan.reads, ...variedRead(step.source)],
				params: { ...plan.params, relation: plan.params.relation || step.source === relationParam }
			})
		case "count":
		case "sum": {
			const by = Arr.map(step.by, (i) => columnAt(state.head, i))
			const key = step.op === "count" ? countKey : sumKey
			const term: HeadTermDesc =
				step.op === "count"
					? { kind: "aggregate", fn: "count" }
					: { kind: "aggregate", fn: "sum", arg: variable(variableAt(state.head, step.arg)) }
			return next({
				state: {
					kind: "sealed",
					stage: { kind: "rules", arms: [ruleOf({ ...state, head: by }, { [key]: term })] },
					head: [...Arr.map(by, (c) => ({ key: c.key, type: c.type })), { key, type: "int8" }]
				}
			})
		}
		case "compute": {
			const at = columnAt(state.head, step.column)
			const arg = variable(variableAt(state.head, step.column))
			const computed: Column =
				step.fn === "widen"
					? {
							key: `${at.key}w`,
							term: { kind: "cast", to: bigint, arg },
							variable: undefined,
							type: "int8"
						}
					: {
							key: `${at.key}h`,
							term: {
								kind: "compute",
								fn: "div",
								args: [arg, { kind: "literal", value: 2 }]
							},
							variable: undefined,
							type: "int4"
						}
			return next({
				state: {
					...state,
					head: Arr.map(state.head, (c, i) => (i === step.column ? computed : c))
				},
				collapsed: plan.collapsed || step.fn === "halve"
			})
		}
		case "union":
		case "hunion": {
			const tagged = step.op === "hunion" || step.tagged
			const tag = (value: number): Readonly<Record<string, HeadTermDesc>> =>
				tagged ? { [tagKey]: { kind: "literal", value, type: integer } } : {}
			/**
			 * The second arm binds each head column's field, a then b, to a variable `u<field>` delivered under the
			 * column's key. A heterogeneous arm delivers the first column alone beside a head of two, and a further
			 * column `x` beside a head of one.
			 */
			const [first] = state.head
			const columns: ReadonlyArray<{ readonly key: string; readonly field: FieldName }> =
				step.op === "union"
					? Arr.map(state.head, (c, i) => ({ key: c.key, field: fieldAt(i) }))
					: state.head.length === 2 && first !== undefined
						? [{ key: first.key, field: "a" }]
						: [
								{ key: columnAt(state.head, 0).key, field: "a" },
								{ key: "x", field: "b" }
							]
			const arm: RuleDesc = {
				vars: Arr.map(columns, (c) => fieldVar(step.relation, c.field, `u${c.field}`)),
				matches: [
					{
						source: sourceDesc(step.relation),
						bindings: Rec.fromEntries(Arr.map(columns, (c) => [c.field, variable(`u${c.field}`)]))
					}
				],
				where: [],
				head: {
					...Rec.fromEntries(Arr.map(columns, (c) => [c.key, variable(`u${c.field}`)])),
					...tag(1)
				},
				interiors: [],
				attach: []
			}
			/** A heterogeneous union delivers the columns both headings share: the first and the tag. */
			const shared: ReadonlyArray<SealedColumn> =
				step.op === "union"
					? columnsOf(state)
					: [{ key: columnAt(state.head, 0).key, type: "int4" }]
			return next({
				state: {
					kind: "sealed",
					/** The builder's rule calls on one query are one rules stage, its arms the union. */
					stage: { kind: "rules", arms: [ruleOf(state, tag(0)), arm] },
					head: [...shared, ...(tagged ? [{ key: tagKey, type: "int4" as const }] : [])]
				},
				reads: [...plan.reads, step.relation],
				union: true,
				heterogeneous: plan.heterogeneous || step.op === "hunion"
			})
		}
	}
}

/** The columns that deliver an integer variable: the ones a filter, a join, a negation or a sum reads. */
const integerVariables = (head: ReadonlyArray<Column>): ReadonlyArray<number> =>
	Arr.flatMap(head, (c, i) => (c.variable !== undefined && c.type === "int4" ? [i] : []))

/** Every step valid after a plan, in a fixed order. */
const stepsAfter = (plan: Plan, grammar: Grammar): ReadonlyArray<Step> => {
	const state = plan.state
	const columns = columnsOf(state)
	/** An attachment correlates an integer field of its child with an integer column of the parent. */
	const integerColumns = Arr.filter(indices(columns.length), (i) => columns[i]?.type === "int4")
	const attachable = Arr.flatMap(
		grammar.sources,
		(s): ReadonlyArray<RelationName | typeof closedName> =>
			s === "R" || s === "S" || s === "C" ? [s] : []
	)
	const keys = Arr.map(columns, (c) => c.key)
	/** The root's ordinal stands where the root scans a stored relation and its head holds both of its own columns. */
	const ordinals: ReadonlyArray<RelationName> =
		(plan.scan === "R" || plan.scan === "S") &&
		Arr.every(fieldNames, (field) => Option.isSome(ownColumn(keys, field)))
			? [plan.scan]
			: []
	const wrapping: ReadonlyArray<Step> = [
		...(columns.length > 0 && !plan.heterogeneous ? [{ op: "take" } as const] : []),
		...Arr.flatMap(attachable, (source) => [
			...Arr.flatMap(integerColumns, (column) =>
				Arr.map(integerFields(source), (field): Step => ({
					op: "attach",
					source,
					links: [{ column, field }]
				}))
			),
			...(integerFields(source).length === 2
				? Arr.flatMap(integerColumns, (first) =>
						Arr.flatMap(integerColumns, (second): ReadonlyArray<Step> =>
							first === second
								? []
								: [
										{
											op: "attach",
											source,
											links: [
												{ column: first, field: "a" },
												{ column: second, field: "b" }
											]
										}
									]
						)
					)
				: [])
		]),
		...Arr.flatMap(ordinals, (source) =>
			Arr.flatMap(fieldNames, (field) =>
				Arr.flatMap([true, false], (inclusive) =>
					Arr.map([false, true], (conjunct): Step => ({
						op: "ordinal",
						source,
						field,
						inclusive,
						conjunct
					}))
				)
			)
		)
	]
	if (state.kind === "sealed") {
		return wrapping
	}
	const vars = integerVariables(state.head)
	const proper = Arr.filter(
		subsetsOf(indices(state.head.length)),
		(keep) => keep.length < state.head.length
	)
	const allVariables = Arr.every(state.head, (c) => c.variable !== undefined)
	const plainHead =
		allVariables &&
		Arr.every(state.head, (c) => c.type === "int4") &&
		state.head.length > 0 &&
		state.head.length <= 2
	return [
		...Arr.flatMap(vars, (column) =>
			Arr.map(["literal", "param"] as const, (value): Step => ({ op: "filter", column, value }))
		),
		...Arr.map(proper, (keep): Step => ({ op: "project", keep })),
		...Arr.flatMap(grammar.sources, (source) =>
			Arr.flatMap(vars, (column) =>
				Arr.flatMap(integerFields(source), (field) =>
					Arr.map(
						Option.isNone(otherField(source, field))
							? (["witness"] as const)
							: (["head", "witness"] as const),
						(other): Step => ({ op: "join", source, column, field, other })
					)
				)
			)
		),
		...Arr.flatMap(grammar.sources, (source) =>
			Arr.flatMap(vars, (column) =>
				Arr.map(integerFields(source), (field): Step => ({ op: "negate", source, column, field }))
			)
		),
		...(allVariables && wholeMatches(state.matches)
			? Arr.map(proper, (by): Step => ({ op: "count", by }))
			: []),
		...(grammar.extended && allVariables && wholeMatches(state.matches)
			? Arr.flatMap(proper, (by) => Arr.map(vars, (arg): Step => ({ op: "sum", by, arg })))
			: []),
		...(grammar.extended
			? Arr.flatMap(vars, (column) =>
					Arr.map(["widen", "halve"] as const, (fn): Step => ({ op: "compute", column, fn }))
				)
			: []),
		...(plainHead
			? Arr.flatMap(relationNames, (relation) =>
					Arr.map([false, true], (tagged): Step => ({ op: "union", relation, tagged }))
				)
			: []),
		...(plainHead && grammar.extended
			? Arr.map(relationNames, (relation): Step => ({ op: "hunion", relation }))
			: []),
		...wrapping
	]
}

/**
 * Every plan of at most `operators` operators of a grammar, the fewest first: a scan, then at each step either the plan
 * as it stands or one more step valid after it, each plan by one path of decisions, and a plan no step may follow
 * ending there, so no case is discarded.
 *
 * The queries of the small-scope suite: every query of up to k operators of a grammar over the small universe, as data.
 *
 * Rule: a plan is a scan followed by steps, each one operator of the query language with a parameter domain small enough
 * to enumerate, resolved left to right into the QueryDesc the public builder records, which the checker then checks.
 * The core grammar reads R(a, b) and S(a, b) through the operators every key and cardinality claim turns on:
 *
 * - scan: one match binding every field to a fresh variable, every variable in the head;
 * - filter: a head variable equal to the literal 1 or to the parameter p;
 * - project: the head cut to a proper subset of its columns, the empty one included;
 * - join: a match of a source binding one of its fields to a head variable, its other field a fresh head variable or
 *   left unbound, an existential witness;
 * - negate: no fact of a source agrees with a head variable on one of its fields;
 * - count: the head grouped by a subset of its columns, with a count;
 * - take: the first row in the order of the head's first column, completed by the checker;
 * - union: a second arm scanning a relation into the same head, untagged or with a literal tag column telling the arms
 *   apart;
 * - attach: a child query matching a source whose field equals a parent column, or both of whose fields equal two
 *   parent columns;
 * - ordinal: of a root scanning R or S whose head holds both of the scan's own columns, the count of the scanned
 *   relation's facts in the root fact's group by one field whose other field is at or before the root fact's
 *   (inclusive) or before it (strict), beside a conjunct that it is not 0 or none: a group the root's own fact keeps
 *   nonempty exactly when inclusive with no further conjunct.
 *
 * The extended grammar adds the sources and operators the remaining claims turn on:
 *
 * - the closed relation C(id, a, b), whose facts are declared, and the relation parameter P(a), whose rows the caller
 *   supplies, as scans, joined, negated and (C) attached;
 * - reach, the transitive closure of R read as edges a → b, a recursive query imported as a scan;
 * - compute: a head variable replaced by its widening to bigint, an injective cast, or by its half, which is not
 *   injective;
 * - sum: the head grouped by a subset of its columns, with the sum of one of its integer variables;
 * - hunion: a second arm of another heading, the two told apart by a literal tag, a heterogeneous union.
 *
 * Filter, project, join, negate, count, sum, compute and the unions edit the rule, so they apply only before a step
 * seals it; take, attach and ordinal wrap the query and apply anywhere, take only where the order completes (not over
 * a union of different headings, whose common columns may hold no key). Each step offers exactly the parameters valid
 * where it stands, so every plan the space yields is one the checker admits. Every column carries its type, and a step
 * comparing or correlating columns offers only integer ones.
 */
export const plansUpTo =
	(grammar: Grammar, operators: number): Gen<Plan> =>
	(source) => {
		let plan = scan(source.draw(element(grammar.scans)))
		for (let more = 1; more < operators; more += 1) {
			const steps = stepsAfter(plan, grammar)
			if (!Arr.isReadonlyArrayNonEmpty(steps)) {
				return plan
			}
			const next = source.draw(element<Step | "stop">(["stop", ...steps]))
			if (next === "stop") {
				return plan
			}
			plan = extend(plan, next)
		}
		return plan
	}

/** The plan in the builder's words, for a failure report. */
export const printPlan = (plan: Plan): string =>
	Arr.join([`scan ${plan.scan}`, ...Arr.map(plan.steps, (s) => Formatter.format(s))], " → ")

/** The features a plan names: its scan and each step's operator, with what distinguishes its forms. */
export type PlanFeature =
	| `scan ${ScanName}`
	| `filter ${Extract<Step, { readonly op: "filter" }>["value"]}`
	| `join ${SourceName} ${Extract<Step, { readonly op: "join" }>["other"]}`
	| `negate ${SourceName}`
	| `union ${"tagged" | "untagged"}`
	| `compute ${Extract<Step, { readonly op: "compute" }>["fn"]}`
	| `attach ${Extract<Step, { readonly op: "attach" }>["source"]}`
	| `attach ${Extract<Step, { readonly op: "attach" }>["source"]} by both fields`
	| `ordinal ${"inclusive" | "strict"}`
	| "ordinal beside a conjunct"
	| Exclude<Step["op"], "filter" | "join" | "negate" | "union" | "compute" | "attach" | "ordinal">

/** A step's feature: its operator, with what distinguishes its forms. */
const stepOp = (s: Step): PlanFeature => {
	switch (s.op) {
		case "filter":
			return `filter ${s.value}`
		case "join":
			return `join ${s.source} ${s.other}`
		case "negate":
			return `negate ${s.source}`
		case "union":
			return `union ${s.tagged ? "tagged" : "untagged"}`
		case "compute":
			return `compute ${s.fn}`
		case "attach":
			return s.links.length === 1 ? `attach ${s.source}` : `attach ${s.source} by both fields`
		case "ordinal":
			return `ordinal ${s.inclusive ? "inclusive" : "strict"}`
		case "count":
		case "hunion":
		case "project":
		case "sum":
		case "take":
			return s.op
	}
}

export const planOps = (plan: Plan): Arr.NonEmptyReadonlyArray<PlanFeature> => [
	`scan ${plan.scan}`,
	...Arr.map(plan.steps, stepOp),
	...Arr.flatMap(plan.steps, (s): ReadonlyArray<PlanFeature> =>
		s.op === "ordinal" && s.conjunct ? ["ordinal beside a conjunct"] : []
	)
]
