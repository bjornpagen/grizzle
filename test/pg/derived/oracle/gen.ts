import { array, boolean, constant, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import { appendAll, indices } from "#compiler/core/array.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { login } from "#compiler/program/workload/login.ts"
import { closedId, contract, pg, uuid } from "#compiler/public/fields.ts"
import type {
	AnyRoster,
	AnyDerived,
	AnyLogin,
	AnyLoginRole,
	AnyRelation,
	AnySchema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { type QueryValue, queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { closed, materializedDerived, relation } from "#compiler/schema/relation.ts"
import { schema } from "#compiler/schema/schema.ts"
import { role } from "#compiler/schema/world.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { argumentsOf } from "#test/support/list.ts"
import type { StorageCarrier } from "#test/support/oracle/gen/domain.ts"
import { floatLiteralOf } from "#test/support/oracle/gen/domain.ts"
import {
	inputRespelling,
	type Restorage,
	restoredFacts,
	type StorageOrder,
	type StoredRelation
} from "#test/support/oracle/gen/restorage.ts"
import { elementAt, whereIndex } from "#test/support/oracle/pick.ts"

/** The choice-th item, modulo the items there are; a choice with nothing to choose from is a defect of the generator.
 *
 * Generated derived relations for the refresh oracle.
 *
 * A case is a base schema, one to three levels of derived relations over it, the base facts, and a sequence of steps.
 * Everything is a sketch of small numbers built through the builders (relation, closed, contract, schema,
 * schema.extend, derived, query, v, match, where, not, find, the five aggregates, Compute.cond, orderBy, take), so the
 * Descriptions under test are the ones the builder records. Each choice is reduced modulo what is in scope and a
 * choice with nothing to choose from degrades to a simpler valid form, so every sketch builds a schema the compiler
 * installs and shrinking keeps it installable:
 *
 * - a base of one to three relations over a palette of field types (uuid, integer, bigint, boolean, a bounded refined
 *   text, a Cents contract over bigint, the handle of a closed roster, numeric(6, 2) and double precision), each keyed
 *   by a nonempty prefix of its fields, plus the roster itself, matchable as a relation;
 * - levels of derived relations: level n's definitions read the base and every level below it, never their
 *   own level, and are declared in a record whose order is not their alphabetical order, so declared order and name
 *   order differ;
 * - each definition parameterless: one rule, a union of two rules of one heading, or an ordered bounded
 *   subset taken over every group, each rule of one to three matches, joins through shared variables, literal
 *   filters, a relational negation, and a plain head or an aggregate head of group variables beside count, sum, mean,
 *   min, max and a conditional count sum(cond(p, 1, 0));
 * - one case in sixteen planted: a level-2 definition aggregating a level-1 aggregate's computed numeric result
 *   with sum, mean, min and max, which the drawn population reaches about once in 250 cases per function.
 *
 * The kinds track what each derived column holds, so a higher level binds it to variables of the right kind:
 * count is bigint, sum and mean take the native result types, min and max keep their input's kind,
 * the contract included. An aggregate's computed numeric result ("num"), PostgreSQL's numeric of no typmod, carries the
 * bound its definition proves, a mean's at numeric's display scale, a B-tree datum of some 520 bytes, so a key over
 * several such columns outgrows a B-tree entry (UnrepresentableKey): it is never a group or plain head column, which a
 * key holds, and is read only as an aggregate's argument. Raw text comparison needs display-deterministic data:
 * every stored value of a kind has one spelling, numeric(6, 2) stores two decimals whatever the input, and the double
 * precision values are exact binary fractions, so sums do not depend on the order PostgreSQL meets them in. */
export const pick = <A>(items: ReadonlyArray<A>, choice: number): A => {
	const item = items[choice % items.length]
	if (item === undefined) {
		throw new Error(`no item to choose from for choice ${choice}`)
	}
	return item
}

/** The kinds a base field may have. */
const baseKinds = ["uuid", "int4", "int8", "bool", "text", "cents", "color", "dec", "f8"] as const
export type BaseKind = (typeof baseKinds)[number]
/** A derived column may also hold a computed numeric, a sum's or a mean's result. */
export type Kind = BaseKind | "num"

const ordered: ReadonlySet<Kind> = new Set(["uuid", "int4", "int8", "text", "cents", "dec", "f8"])
/** The kinds sum and mean take. */
const summedKinds = [
	"int4",
	"int8",
	"cents",
	"dec",
	"f8",
	"num"
] as const satisfies ReadonlyArray<Kind>
export type SummedKind = (typeof summedKinds)[number]
/** The kinds min and max take: PostgreSQL has no min or max over uuid or boolean; an enum's order is its roster's, left
 * out here. */
const extremalKinds = [
	"int4",
	"int8",
	"text",
	"cents",
	"dec",
	"f8",
	"num"
] as const satisfies ReadonlyArray<Kind>
export type ExtremalKind = (typeof extremalKinds)[number]
const isSummed = (k: Kind): k is SummedKind => Arr.some(summedKinds, (s) => s === k)
const isExtremal = (k: Kind): k is ExtremalKind => Arr.some(extremalKinds, (e) => e === k)

/** What a definition's aggregate head computes: a count, a conditional count, or sum, mean, min or max over a column
 * of a kind it takes. */
export type AggregateKey =
	| "count"
	| "sum(cond)"
	| `${"sum" | "mean"}(${SummedKind})`
	| `${"min" | "max"}(${ExtremalKind})`

/** Every aggregate key, the population's required reach. */
export const aggregateKeys: Arr.NonEmptyReadonlyArray<AggregateKey> = [
	"count",
	"sum(cond)",
	...Arr.flatMap(summedKinds, (k) => [`sum(${k})` as const, `mean(${k})` as const]),
	...Arr.flatMap(extremalKinds, (k) => [`min(${k})` as const, `max(${k})` as const])
]

/** Kinds a literal is written for: a numeric literal would need a Decimal carrier, so numerics are compared only
 * through variables. */
const literal: ReadonlySet<Kind> = new Set([
	"uuid",
	"int4",
	"int8",
	"bool",
	"text",
	"cents",
	"color",
	"f8"
])

/**
 * The native result kinds: a contract contributes its base type to sum and mean. The sum of an integer of any width
 * is an exact numeric (README: "the r.sum of an integer is an exact Decimal"), so only a float's sum is a float.
 */
const sumKind = (k: Kind): Kind => (k === "f8" ? "f8" : "num")
const meanKind = (k: Kind): Kind => (k === "f8" ? "f8" : "num")

/** An aggregate a definition's head computes, by what it reads: a count, a conditional count, or sum, mean, min or max
 * over a variable of a kind it takes. */
type Aggregate =
	| { readonly fn: "count" }
	| { readonly fn: "cond" }
	| { readonly fn: "sum" | "mean"; readonly of: SummedKind }
	| { readonly fn: "min" | "max"; readonly of: ExtremalKind }

/**
 * An aggregate's key and the kind of the column it computes, both read off the one aggregate, so no column's kind
 * strays from what computes it: a count is a bigint; a sum, its argument's sum kind (sumKind), the conditional count a
 * sum over an integer; a mean, its argument's mean kind; min and max, their argument's kind.
 */
const aggregated = (a: Aggregate): { readonly key: AggregateKey; readonly kind: Kind } => {
	switch (a.fn) {
		case "count":
			return { key: "count", kind: "int8" }
		case "cond":
			return { key: "sum(cond)", kind: sumKind("int4") }
		case "sum":
			return { key: `sum(${a.of})`, kind: sumKind(a.of) }
		case "mean":
			return { key: `mean(${a.of})`, kind: meanKind(a.of) }
		case "min":
		case "max":
			return { key: `${a.fn}(${a.of})`, kind: a.of }
	}
}

/** The column a definition's conditional count is, `sum(cond(flag, 1, 0))`. */
const condColumn = "p"

const Color = closed("Color", ["red", "green", "blue"], [])
const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
const Word = str.regex("^[a-z]{0,4}$")

const descriptor = (k: BaseKind): FieldBase => {
	switch (k) {
		case "uuid":
			return uuid
		case "int4":
			return pg.integer
		case "int8":
			return pg.bigint
		case "bool":
			return pg.boolean
		case "text":
			return Word
		case "cents":
			return Cents
		case "color":
			return closedId(Color)
		case "dec":
			return pg.numeric(6, 2)
		case "f8":
			return pg.float8
	}
}

const uuids = [
	"00000000-0000-4000-8000-000000000001",
	"00000000-0000-4000-8000-000000000002",
	"00000000-0000-4000-8000-00000000000a"
] as const
const words = ["", "ab", "zz"] as const
const colors = ["red", "green", "blue"] as const
const decimals = ["-1.50", "0.00", "2.25", "10.00"] as const
const doubles = [-1.5, 0, 0.25, 2] as const

/** The n-th stored value of a kind, in the one spelling the case uses. */
const storedValue = (k: BaseKind, n: number): unknown => {
	switch (k) {
		case "uuid":
			return uuids[n % uuids.length]
		case "int4":
			return (n % 5) - 2
		case "int8":
			return BigInt((n % 5) - 2)
		case "bool":
			return n % 2 === 0
		case "text":
			return words[n % words.length]
		case "cents":
			return BigInt(n % 4)
		case "color":
			return colors[n % colors.length]
		case "dec":
			return decimals[n % decimals.length]
		case "f8":
			return doubles[n % doubles.length]
	}
}

/** The n-th literal of a kind with literals: always a value of its field. A computed numeric, no field's, has none. */
const literalOf = (k: Kind, n: number): unknown => {
	if (k === "num") {
		throw new Error("no literal of a computed numeric")
	}
	return storedValue(k, n)
}

export interface FieldSketch {
	readonly kind: number
}

export interface RelationSketch {
	readonly fields: ReadonlyArray<FieldSketch>
	readonly key: number
}

export interface BindSketch {
	/** 0: existential, 1: a variable, 2: a literal. */
	readonly how: number
	/** Which variable of the field's kind to share, or a fresh one past the end. */
	readonly share: number
	readonly n: number
}

export interface MatchSketch {
	readonly source: number
	readonly binds: ReadonlyArray<BindSketch>
}

export interface PredSketch {
	readonly variable: number
	readonly op: number
	readonly n: number
}

export interface AggSketch {
	/** 0: sum, 1: mean, 2: min, 3: max. */
	readonly fn: number
	readonly variable: number
}

export interface RuleSketch {
	readonly matches: ReadonlyArray<MatchSketch>
	readonly preds: ReadonlyArray<PredSketch>
	/** A negation: -1 for none, otherwise a source, bound through one variable of a field's kind, never a computed numeric. */
	readonly not: number
	readonly head: ReadonlyArray<number>
	readonly aggregate: boolean
	readonly aggs: ReadonlyArray<AggSketch>
	readonly count: boolean
	readonly cond: boolean
}

export interface DefinitionSketch {
	readonly rule: RuleSketch
	/** 0, 1: one rule; 2: a union of two rules of one heading; 3: an ordered bounded subset. */
	readonly form: number
	readonly k: number
	readonly desc: boolean
}

export interface LevelSketch {
	readonly definitions: ReadonlyArray<DefinitionSketch>
	/** Which permutation of the names the declared order takes. */
	readonly naming: number
}

export interface FactSketch {
	readonly values: ReadonlyArray<number>
}

export interface StepSketch {
	/** 0, 1: a base change; 2: no change; 3: the same facts reloaded; 4: the same facts reloaded in another order. */
	readonly change: number
	readonly drops: ReadonlyArray<number>
	readonly adds: ReadonlyArray<ReadonlyArray<FactSketch>>
	/** Which derived relations the call names: a bit per relation in refresh order; nothing named means all. */
	readonly names: number
	/** How the call orders and repeats them. */
	readonly shuffle: number
	readonly repeat: boolean
}

export interface CaseSketch {
	readonly relations: ReadonlyArray<RelationSketch>
	readonly levels: ReadonlyArray<LevelSketch>
	readonly facts: ReadonlyArray<ReadonlyArray<FactSketch>>
	/** The first call names a downward-closed subset: a bit per relation in refresh order. */
	readonly first: number
	readonly steps: ReadonlyArray<StepSketch>
}

/** Mostly variables, so joins and heads have something to bind; literals sparingly, so definitions are rarely empty. */
/** Mostly variables (four in seven), existentials two in seven, literals one in seven. */
const bindGen: Gen<BindSketch> = (source) => ({
	how: source.draw(
		weighted([
			[2, constant(0)],
			[4, constant(1)],
			[1, constant(2)]
		])
	),
	share: source.draw(int(0, 2)),
	n: source.draw(int(0, 7))
})

const ruleGen: Gen<RuleSketch> = (source) => ({
	/** One to three matches, each binding up to four fields (a base relation's widest). */
	matches: source.draw(
		array(
			(match): MatchSketch => ({
				source: match.draw(int(0, 7)),
				binds: match.draw(array(bindGen, { min: 0, max: 4 }))
			}),
			{ min: 1, max: 3 }
		)
	),
	preds: source.draw(
		array(
			(pred): PredSketch => ({
				variable: pred.draw(int(0, 7)),
				op: pred.draw(int(0, 5)),
				n: pred.draw(int(0, 7))
			}),
			{ min: 0, max: 1 }
		)
	),
	not: source.draw(int(-4, 5)),
	head: source.draw(array(int(0, 7), { min: 0, max: 3 })),
	/** An aggregate two times in three. */
	aggregate: source.draw(
		weighted([
			[2, constant(true)],
			[1, constant(false)]
		])
	),
	aggs: source.draw(
		array((agg): AggSketch => ({ fn: agg.draw(int(0, 3)), variable: agg.draw(int(0, 7)) }), {
			min: 0,
			max: 3
		})
	),
	count: source.draw(boolean),
	cond: source.draw(boolean)
})

const definitionGen: Gen<DefinitionSketch> = (source) => ({
	rule: source.draw(ruleGen),
	form: source.draw(int(0, 3)),
	k: source.draw(int(1, 3)),
	desc: source.draw(boolean)
})

/** A value choice per field of the widest base relation, and up to eight facts for each of up to three base relations. */
const factGen: Gen<FactSketch> = (source) => ({
	values: source.draw(array(int(0, 7), { min: 4, max: 4 }))
})

const factsGen = array(array(factGen, { min: 0, max: 8 }), { min: 3, max: 3 })

const stepGen: Gen<StepSketch> = (source) => ({
	change: source.draw(int(0, 4)),
	drops: source.draw(array(int(0, 7), { min: 0, max: 3 })),
	adds: source.draw(array(array(factGen, { min: 0, max: 3 }), { min: 3, max: 3 })),
	names: source.draw(int(0, 255)),
	shuffle: source.draw(int(0, 719)),
	repeat: source.draw(boolean)
})

const drawnCaseSketchGen: Gen<CaseSketch> = (source) => ({
	relations: source.draw(
		array(
			(relation): RelationSketch => ({
				fields: relation.draw(
					array((field): FieldSketch => ({ kind: field.draw(int(0, baseKinds.length - 1)) }), {
						min: 1,
						max: 4
					})
				),
				key: relation.draw(int(0, 3))
			}),
			{ min: 1, max: 3 }
		)
	),
	/** One to three levels of one to three definitions each (the header's case). */
	levels: source.draw(
		array(
			(level): LevelSketch => ({
				definitions: level.draw(array(definitionGen, { min: 1, max: 3 })),
				naming: level.draw(int(0, 5))
			}),
			{ min: 1, max: 3 }
		)
	),
	facts: source.draw(factsGen),
	first: source.draw(int(0, 255)),
	steps: source.draw(array(stepGen, { min: 1, max: 4 }))
})

/** The planted population: a level-2 definition aggregating a level-1 aggregate's computed numeric result with
 * sum, mean, min and max, which the drawn population reaches about once in 250 cases per function. R0(f0 int8 key,
 * f1 numeric(6, 2)); L1a = R0 grouped by f0 with sum(f1), a "num" column; L2a = L1a with the four aggregates over it
 * (its sources: R0, the roster, L1a). */
const fresh: BindSketch = { how: 1, share: 99, n: 0 }
/** A one-rule aggregate definition over `source`, its head `head`, its aggregates `aggs`. */
const aggregateOver = (
	source: number,
	head: ReadonlyArray<number>,
	aggs: ReadonlyArray<AggSketch>
): DefinitionSketch => ({
	form: 0,
	k: 1,
	desc: false,
	rule: {
		matches: [{ source, binds: [fresh, fresh] }],
		preds: [],
		not: -1,
		head,
		aggregate: true,
		aggs,
		count: false,
		cond: false
	}
})

const plantedNumSketchGen: Gen<CaseSketch> = map(drawnCaseSketchGen, (s) => ({
	...s,
	relations: [
		{ fields: [{ kind: baseKinds.indexOf("int8") }, { kind: baseKinds.indexOf("dec") }], key: 0 }
	],
	levels: [
		{ naming: 0, definitions: [aggregateOver(0, [0], [{ fn: 0, variable: 1 }])] },
		{
			naming: 0,
			definitions: [
				aggregateOver(
					2,
					[],
					Arr.map([0, 1, 2, 3], (fn) => ({ fn, variable: 1 }))
				)
			]
		}
	]
}))

/**
 * A negation beside a conditional count, which the drawn population reaches about once a stream: R0(f0 bigint key,
 * f1 boolean); L1a = R0 ungrouped with its conditional count of f1, `p`, an exact numeric, and its count `n`, a bigint;
 * L2a = L1a's two columns, each a variable of its own, less the facts of R0 at its count (its sources: R0, the roster,
 * L1a). The negation's field, R0.f0, is a bigint, which only `n` may bind: a generator that typed `p` a bigint too
 * would bind it first.
 */
export const condNegationSketchGen: Gen<CaseSketch> = map(drawnCaseSketchGen, (s) => ({
	...s,
	relations: [
		{ fields: [{ kind: baseKinds.indexOf("int8") }, { kind: baseKinds.indexOf("bool") }], key: 0 }
	],
	levels: [
		{
			naming: 0,
			definitions: [
				{
					...aggregateOver(0, [], []),
					rule: { ...aggregateOver(0, [], []).rule, count: true, cond: true }
				}
			]
		},
		{
			naming: 0,
			definitions: [
				{
					form: 0,
					k: 1,
					desc: false,
					rule: {
						matches: [{ source: 2, binds: [fresh, fresh] }],
						preds: [],
						not: 0,
						head: [],
						aggregate: false,
						aggs: [],
						count: false,
						cond: false
					}
				}
			]
		}
	]
}))

/** One case in sixteen is planted: about 15 per stream of 250, each reaching all four keys. */
export const caseSketchGen: Gen<CaseSketch> = weighted([
	[15, drawnCaseSketchGen],
	[1, plantedNumSketchGen]
])

/** Every aggregate key in one case: the drawn population reaches each key over a base kind a few times a run, since a
 * definition draws few aggregates and each over a variable of any kind. R0(f0 integer key, f1 bigint, f2 Cents, f3
 * Word) and R1(f0 numeric(6, 2) key, f1 double precision, f2 boolean), four facts each; L1a reads R0 with sum and mean
 * over each field they take, and min and max over each; L1b reads R1 the same way, with a count and a conditional count
 * of its flag; L2a reads L1a's first computed numeric result, its sum of f1, with all four. The one step drops the
 * first fact of each relation and adds a fact to R0. */
const ungrouped = (
	source: number,
	aggs: ReadonlyArray<AggSketch>,
	counted: boolean
): DefinitionSketch => {
	const d = aggregateOver(source, [], aggs)
	return { ...d, rule: { ...d.rule, count: counted, cond: counted } }
}

/** Each of `fns` over each of the first `variables` variables a function takes. */
const eachOver = (fns: ReadonlyArray<number>, variables: number): ReadonlyArray<AggSketch> =>
	Arr.flatMap(fns, (fn) => Arr.map(indices(variables), (variable) => ({ fn, variable })))

const factRows = (rows: ReadonlyArray<ReadonlyArray<number>>): ReadonlyArray<FactSketch> =>
	Arr.map(rows, (values) => ({ values }))

/** The sources of level 2 are R0, R1, the roster, L1a and L1b; L1a's second summed variable is its sum of f1. */
export const plantedAggregates: CaseSketch = {
	relations: [
		{
			fields: Arr.map(["int4", "int8", "cents", "text"] as const, (k) => ({
				kind: baseKinds.indexOf(k)
			})),
			key: 0
		},
		{
			fields: Arr.map(["dec", "f8", "bool"] as const, (k) => ({ kind: baseKinds.indexOf(k) })),
			key: 0
		}
	],
	levels: [
		{
			naming: 0,
			definitions: [
				ungrouped(0, [...eachOver([0, 1], 3), ...eachOver([2, 3], 4)], false),
				ungrouped(1, eachOver([0, 1, 2, 3], 2), true)
			]
		},
		{
			naming: 0,
			definitions: [
				ungrouped(
					3,
					Arr.map([0, 1, 2, 3], (fn) => ({ fn, variable: 1 })),
					false
				)
			]
		}
	],
	facts: [
		factRows([
			[0, 0, 0, 0],
			[1, 2, 3, 1],
			[2, 4, 1, 2],
			[4, 3, 2, 1]
		]),
		factRows([
			[0, 0, 0, 0],
			[1, 2, 1, 0],
			[2, 3, 0, 0],
			[3, 1, 1, 0]
		]),
		[]
	],
	first: 0,
	steps: [
		{
			change: 0,
			drops: [0],
			adds: [factRows([[3, 1, 0, 2]]), [], []],
			names: 0,
			shuffle: 0,
			repeat: false
		}
	]
}

export interface GenColumn {
	readonly name: string
	readonly kind: Kind
}

/** A matchable source: a base relation, the roster, or a derived relation of a lower level. */
export interface GenSource {
	readonly name: string
	readonly columns: ReadonlyArray<GenColumn>
	readonly value: AnyRelation | AnyRoster | AnyDerived
}

/** A stored source: a base relation or the roster, which the root schema declares. */
interface GenStored extends GenSource {
	readonly value: AnyRelation | AnyRoster
}

export interface GenBase extends GenStored {
	readonly columns: ReadonlyArray<GenColumn & { readonly kind: BaseKind }>
	readonly key: ReadonlyArray<string>
	readonly value: AnyRelation
}

export interface GenDerived extends GenSource {
	readonly value: AnyDerived
	readonly level: number
	/** Its position in its level's relations record: declared order. */
	readonly declared: number
	/** The form its definition took, which a case notes (`DerivedFeature`). */
	readonly form: "rule" | "union" | "take"
	readonly aggregates: ReadonlyArray<AggregateKey>
	readonly negation: boolean
	/** Whether a rule of its definition negates beside a variable a source's conditional count binds (BuiltRule). */
	readonly negationOverCond: boolean
	readonly reads: ReadonlyArray<string>
}

/** Derived relations in refresh order: by level, then in declared order. */
const refreshed: Order.Order<GenDerived> = Order.combine(
	Order.mapInput(Order.Number, (d: GenDerived) => d.level),
	Order.mapInput(Order.Number, (d: GenDerived) => d.declared)
)

export interface GenSchema {
	readonly base: ReadonlyArray<GenBase>
	readonly derived: ReadonlyArray<GenDerived>
	/** The top-level schema: the last extension. */
	readonly value: AnySchema
	/** Every derived relation in refresh order: level, then declared order. */
	readonly refreshOrder: ReadonlyArray<string>
	/** The world a case refreshes in: the role `refresher` holding every relation whole and refreshing every derived
	 * one, reached through its login `server`, which the installation's logins hold. */
	readonly refresher: AnyLoginRole
	readonly server: AnyLogin
}

/** The names of level n, in declared order, chosen so declared order is often not alphabetical order. */
const levelNames = (level: number, count: number, naming: number): ReadonlyArray<string> => {
	const letters = ["a", "b", "c"].slice(0, count)
	const permutations: Array<Array<string>> = []
	const permute = (rest: ReadonlyArray<string>, acc: ReadonlyArray<string>) => {
		if (rest.length === 0) {
			permutations.push([...acc])
		}
		for (const [i, x] of rest.entries()) {
			permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, x])
		}
	}
	permute(letters, [])
	return Arr.map(pick(permutations, naming), (l) => `L${level}${l}`)
}

interface Variable {
	readonly kind: Kind
	readonly term: unknown
}

const compareOps = ["eq", "ne", "lt", "le", "gt", "ge"] as const

interface BuiltRule {
	readonly finished: FinishedValue
	readonly columns: ReadonlyArray<GenColumn>
	readonly aggregates: ReadonlyArray<AggregateKey>
	readonly negation: boolean
	/** Whether the rule negates beside a variable a source's conditional count binds, a numeric that no negated field
	 * of another kind takes. */
	readonly negationOverCond: boolean
	readonly reads: ReadonlyArray<string>
}

/** One rule over `sources`, run inside its callback. `plain` forces a plain head of at least one column.
 *
 * The a.variable-th variable of a kind fn takes, modulo those there are; none, and the aggregate is left out.
 *
 * A one-fact definition is keyed by its first representable column, which its first column always is: every kind's
 * datum fits a B-tree entry alone, a computed numeric's at its proved bound among them. */
const runRule = (
	sources: ReadonlyArray<GenSource>,
	sketch: RuleSketch,
	r: RuleValue,
	plain: boolean,
	shift: number
): BuiltRule => {
	/**
	 * The rule's matches, each column bound as its sketch draws it: left unbound, a literal, a shared or a fresh
	 * variable. A rule that folds binds every column of every match (`whole`), a key of each source among them, since a
	 * fold reads each fact it matches once, by its key, and one over a projection is refused (FoldOverProjection).
	 */
	const bound = (whole: boolean) => {
		const vars: Array<Variable> = []
		const reads = new Set<string>()
		let cond = false
		let rule = r
		for (const [mi, m] of sketch.matches.entries()) {
			const source = pick(sources, m.source)
			reads.add(source.name)
			const minted = v(source.value, `match${mi}`)
			const bindings: Record<string, unknown> = {}
			for (const [i, c] of source.columns.entries()) {
				/** The first column of the first match is always a variable, so every rule has one to find. */
				const drawn = (mi === 0 && i === 0 ? undefined : m.binds[i]) ?? { how: 1, share: 99, n: 0 }
				const b = whole && drawn.how === 0 ? { ...drawn, how: 3 } : drawn
				if (b.how === 0) {
					continue
				}
				if (b.how === 2 && literal.has(c.kind)) {
					bindings[c.name] = literalOf(c.kind, b.n + shift)
					continue
				}
				const same = Arr.filter(vars, (x) => x.kind === c.kind)
				const shared = b.how === 1 ? same[b.share] : undefined
				cond = cond || c.name === condColumn
				if (shared !== undefined) {
					bindings[c.name] = shared.term
				} else {
					bindings[c.name] = minted[c.name]
					vars.push({ kind: c.kind, term: minted[c.name] })
				}
			}
			if (Rec.keys(bindings).length === 0) {
				const c = pick(source.columns, 0)
				cond = cond || c.name === condColumn
				bindings[c.name] = minted[c.name]
				vars.push({ kind: c.kind, term: minted[c.name] })
			}
			rule = rule.match(source.value, bindings)
		}
		return { vars, reads, rule, cond }
	}
	/** Whether the rule folds: drawn so, or a plain rule with no variable a head may find, which counts instead. */
	const folds = (vars: ReadonlyArray<Variable>): boolean =>
		(!plain && sketch.aggregate) || !Arr.some(vars, (x) => x.kind !== "num")
	const drawnMatches = bound(false)
	const matched = folds(drawnMatches.vars) ? bound(true) : drawnMatches
	const { vars, reads } = matched
	let rule = matched.rule
	const predicates: Array<unknown> = []
	for (const p of sketch.preds) {
		const x = pick(vars, p.variable)
		if (!literal.has(x.kind)) {
			continue
		}
		const op = ordered.has(x.kind) ? pick(compareOps, p.op) : pick(compareOps, p.op % 2)
		predicates.push(r[op](x.term, literalOf(x.kind, p.n + shift)))
	}
	let negation = false
	if (sketch.not >= 0) {
		const source = pick(sources, sketch.not)
		const target = Arr.findFirst(
			source.columns,
			(c) => c.kind !== "num" && Arr.some(vars, (x) => x.kind === c.kind)
		)
		const x = Option.flatMap(target, (t) => Arr.findFirst(vars, (y) => y.kind === t.kind))
		if (Option.isSome(target) && Option.isSome(x)) {
			predicates.push(r.not(source.value, { [target.value.name]: x.value.term }))
			reads.add(source.name)
			negation = true
		}
	}
	if (predicates.length > 0) {
		rule = rule.where(...argumentsOf(predicates))
	}
	/** Group and plain head columns: never a computed numeric, several of which outgrow a key's B-tree entry. */
	const headable = Arr.filter(vars, (x) => x.kind !== "num")
	const chosen: Array<Variable> = []
	for (const h of sketch.head) {
		const x = headable[h % Math.max(headable.length, 1)]
		if (x !== undefined && !chosen.includes(x)) {
			chosen.push(x)
		}
	}
	const aggregate = (!plain && sketch.aggregate) || headable.length === 0
	if (!aggregate && chosen.length === 0 && headable[0] !== undefined) {
		chosen.push(headable[0])
	}
	const head: Record<string, unknown> = {}
	const columns: Array<GenColumn> = []
	const aggregates: Array<AggregateKey> = []
	/** An aggregate column of the head: its term, and its kind and key, both its aggregate's (`aggregated`). */
	const add = (name: string, term: unknown, a: Aggregate): void => {
		const { key, kind } = aggregated(a)
		head[name] = term
		columns.push({ name, kind })
		aggregates.push(key)
	}
	for (const [i, x] of chosen.entries()) {
		head[`c${i}`] = x.term
		columns.push({ name: `c${i}`, kind: x.kind })
	}
	/** A plain head with nothing to find falls back to a count alone: an aggregate column of a union or a take would be
	 * part of its whole-heading key, and a few computed numerics there outgrow its B-tree entry (UnrepresentableKey). */
	const countOnly = plain && headable.length === 0
	if (aggregate) {
		for (const [i, a] of (countOnly ? [] : sketch.aggs).entries()) {
			const fn = pick(["sum", "mean", "min", "max"] as const, a.fn)
			if (fn === "sum" || fn === "mean") {
				const takes = Arr.flatMap(vars, (x): ReadonlyArray<{ term: unknown; of: SummedKind }> =>
					isSummed(x.kind) ? [{ term: x.term, of: x.kind }] : []
				)
				const x = takes[a.variable % Math.max(takes.length, 1)]
				if (x === undefined) {
					continue
				}
				add(`a${i}`, r[fn](x.term), { fn, of: x.of })
				continue
			}
			const takes = Arr.flatMap(vars, (x): ReadonlyArray<{ term: unknown; of: ExtremalKind }> =>
				isExtremal(x.kind) ? [{ term: x.term, of: x.kind }] : []
			)
			const x = takes[a.variable % Math.max(takes.length, 1)]
			if (x === undefined) {
				continue
			}
			add(`a${i}`, r[fn](x.term), { fn, of: x.of })
		}
		const flag = Arr.findFirst(vars, (x) => x.kind === "bool")
		if (sketch.cond && Option.isSome(flag) && !countOnly) {
			add(
				condColumn,
				r.sum(computeCore.cond(flag.value.term, computeCore.literal(pg.integer, 1), 0)),
				{ fn: "cond" }
			)
		}
		if (sketch.count || aggregates.length === 0) {
			add("n", r.count(), { fn: "count" })
		}
	}
	return {
		finished: rule.find(head),
		columns,
		aggregates,
		negation,
		negationOverCond: negation && matched.cond,
		reads: Arr.sort([...reads], Order.String)
	}
}

/** The definition a sketch builds over `over` (the schema of the level below), reading `sources`. */
const buildDefinition = (
	over: AnySchema,
	sources: ReadonlyArray<GenSource>,
	sketch: DefinitionSketch
): {
	readonly query: QueryValue
	readonly columns: ReadonlyArray<GenColumn>
	readonly form: GenDerived["form"]
	readonly aggregates: ReadonlyArray<AggregateKey>
	readonly negation: boolean
	readonly negationOverCond: boolean
	readonly reads: ReadonlyArray<string>
} => {
	/** The arms the rule callbacks built, in order. */
	const arms: Array<BuiltRule> = []
	const form = sketch.form === 2 ? "union" : sketch.form === 3 ? "take" : "rule"
	const plain = form !== "rule"
	const arm = (shift: number) => (r: RuleValue) => {
		const built = runRule(sources, sketch.rule, r, plain, shift)
		arms.push(built)
		return built.finished
	}
	let q: QueryValue = query(over).rule(arm(0))
	if (form === "union") {
		q = q.rule(arm(1))
	}
	const [built, second] = arms
	if (built === undefined) {
		throw new Error("the rule callback did not run")
	}
	if (form === "take") {
		const by = pick(built.columns, 0)
		q = q.orderBy([by.name, sketch.desc ? "desc" : "asc"]).take(sketch.k)
	}
	const reads = new Set([...built.reads, ...(second?.reads ?? [])])
	return {
		query: q,
		columns: built.columns,
		form,
		aggregates: built.aggregates,
		negation: built.negation || second?.negation === true,
		negationOverCond: built.negationOverCond || second?.negationOverCond === true,
		reads: Arr.sort([...reads], Order.String)
	}
}

export interface BuildOptions {
	/** The declared schema name; the installed name when the case is rebuilt to open a Db. */
	readonly name: string
}

export const buildSchema = (sketch: CaseSketch, options: BuildOptions): GenSchema => {
	const base: Array<GenBase> = Arr.map(sketch.relations, (r, i) => {
		const columns = Arr.map(r.fields, (f, j) => ({
			name: `f${j}`,
			kind: pick(baseKinds, f.kind)
		}))
		const key = Arr.map(columns.slice(0, 1 + (r.key % columns.length)), (c) => c.name)
		const value = relation(
			`R${i}`,
			Rec.fromEntries(Arr.map(columns, (c) => [c.name, descriptor(c.kind)])),
			key,
			[]
		)
		return { name: `R${i}`, columns, key, value }
	})
	/** The roster is matchable as a relation of its handles. */
	const roster: GenStored = {
		name: "Color",
		columns: [{ name: "id", kind: "color" }],
		value: Color
	}
	const stored: ReadonlyArray<GenStored> = [...base, roster]
	let current: AnySchema = schema(
		options.name,
		Rec.values(Rec.fromEntries(Arr.map(stored, (s) => [s.name, s.value]))),
		[],
		[]
	)
	const derivedRelations: Array<GenDerived> = []
	for (const [li, level] of sketch.levels.entries()) {
		const names = levelNames(li + 1, level.definitions.length, level.naming)
		const sources: ReadonlyArray<GenSource> = [...stored, ...derivedRelations]
		const declared: Array<GenDerived> = Arr.map(level.definitions, (d, di) => {
			const built = buildDefinition(current, sources, d)
			const name = pick(names, di)
			return {
				name,
				level: li + 1,
				declared: di,
				columns: built.columns,
				value: materializedDerived(name, built.query, []),
				form: built.form,
				aggregates: built.aggregates,
				negation: built.negation,
				negationOverCond: built.negationOverCond,
				reads: built.reads
			}
		})
		appendAll(derivedRelations, declared)
		current = schema.extend(
			current,
			`${options.name}_${li + 1}`,
			Rec.values(Rec.fromEntries(Arr.map(declared, (d) => [d.name, d.value]))),
			[],
			[]
		)
	}
	const refreshOrder = Arr.map(Arr.sort(derivedRelations, refreshed), (d) => d.name)
	const whole: Readonly<Record<string, AnyRelation | AnyRoster | AnyDerived>> = Rec.fromEntries([
		...Arr.map(stored, (st) => [st.name, st.value] as const),
		...Arr.map(derivedRelations, (d) => [d.name, d.value] as const)
	])
	const refresher = role(current, "refresher", whole, {
		refresh: Arr.map(derivedRelations, (d) => d.name)
	})
	const server = login(current, "server", [refresher])
	return {
		base,
		derived: derivedRelations,
		value: current,
		refreshOrder,
		refresher: server.roles.refresher,
		server
	}
}

export type FactRecord = Readonly<Record<string, unknown>>
export type FactsByRelation = Readonly<Record<string, ReadonlyArray<FactRecord>>>

const factOf = (r: GenBase, f: FactSketch): FactRecord =>
	Rec.fromEntries(
		Arr.map(r.columns, (c, i) => [c.name, storedValue(c.kind, f.values[i % f.values.length] ?? 0)])
	)

const keyText = (r: GenBase, fact: FactRecord): string =>
	Arr.join(
		Arr.map(r.key, (k) => String(fact[k])),
		"\u0000"
	)

/** A set of facts at distinct keys: a later fact at a key replaces an earlier one, as a put would. */
const keyed = (r: GenBase, facts: ReadonlyArray<FactRecord>): ReadonlyArray<FactRecord> => {
	const out = new Map<string, FactRecord>()
	for (const fact of facts) {
		out.set(keyText(r, fact), fact)
	}
	return [...out.values()]
}

export const initialFacts = (s: GenSchema, sketch: CaseSketch): FactsByRelation =>
	Rec.fromEntries(
		Arr.map(
			s.base,
			(r, i) =>
				[
					r.name,
					keyed(
						r,
						Arr.map(sketch.facts[i] ?? [], (f) => factOf(r, f))
					)
				] as const
		)
	)

/** The carrier each base kind is stored at, whose twin spellings a stored value of the kind may be written in. */
const baseCarriers: { readonly [K in BaseKind]: StorageCarrier } = {
	uuid: "uuid",
	int4: "int4",
	int8: "int8",
	bool: "bool",
	text: "text",
	cents: "int8",
	color: "code",
	dec: "numeric",
	f8: "float8"
}

/** A stored value of a base kind (storedValue) as the IR's literal: a value of another host type is a defect. */
const literalOfBase = (k: BaseKind, value: unknown): TypedLiteral => {
	const wrong = (): never => {
		throw new TypeError(`a ${k} value of another host type: ${String(value)}`)
	}
	switch (k) {
		case "uuid":
			return typeof value === "string" ? { kind: "uuid", value } : wrong()
		case "int4":
			return typeof value === "number" && Number.isSafeInteger(value)
				? { kind: "int", value: BigInt(value) }
				: wrong()
		case "int8":
		case "cents":
			return typeof value === "bigint" ? { kind: "int", value } : wrong()
		case "bool":
			return typeof value === "boolean" ? { kind: "bool", value } : wrong()
		case "text":
			return typeof value === "string" ? { kind: "text", value } : wrong()
		case "color":
			return typeof value === "string" ? { kind: "handle", handle: value } : wrong()
		case "dec":
			return typeof value === "string" ? { kind: "numeric", value: Decimal.of(value) } : wrong()
		case "f8":
			return typeof value === "number" ? floatLiteralOf(value) : wrong()
	}
}

/**
 * The order a second reading stores the base facts in: the first reading's. The oracle reads every view's tuples, and
 * which tuple a refresh writes a row to follows the order it meets the base rows in.
 */
const tuplesObserved: StorageOrder = { kind: "kept", observed: "tuple ids" }

/**
 * The facts stored otherwise for a second reading (gen/restorage.ts restoredFacts), in the order they are stored
 * (tuplesObserved): one value whose carrier has twin spellings in its first twin, which the loader writes as that
 * text. Every value is unchanged, so every view holds the same values over them.
 */
export const restoredDerivedFacts = (
	s: GenSchema,
	facts: FactsByRelation,
	r: Restorage
): { readonly facts: FactsByRelation; readonly respelled: boolean } => {
	const restored = restoredFacts(
		Arr.map(s.base, (base): StoredRelation<unknown> => ({
			name: base.name,
			columns: Arr.map(base.columns, (c) =>
				inputRespelling(baseCarriers[c.kind], (v) => literalOfBase(c.kind, v))
			),
			rows: Arr.map(facts[base.name] ?? [], (fact) => Arr.map(base.columns, (c) => fact[c.name]))
		})),
		tuplesObserved,
		r
	)
	return {
		facts: Rec.fromEntries(
			Arr.map(
				Arr.zip(s.base, restored.relations),
				([base, stored]) =>
					[
						base.name,
						Arr.map(stored.rows, (row) =>
							Rec.fromEntries(
								Arr.map(
									base.columns,
									(c, j) => [c.name, elementAt(row, j, "a restored fact")] as const
								)
							)
						)
					] as const
			)
		),
		respelled: restored.respelled
	}
}

/** The facts after a base change: some dropped, some added at new or existing keys. */
export const changedFacts = (
	s: GenSchema,
	facts: FactsByRelation,
	step: StepSketch
): FactsByRelation =>
	Rec.fromEntries(
		Arr.map(s.base, (r, i) => {
			const now = facts[r.name] ?? []
			const dropped = new Set(Arr.map(step.drops, (d) => (now.length === 0 ? -1 : d % now.length)))
			const kept = whereIndex(now, (j) => !dropped.has(j))
			return [
				r.name,
				keyed(r, [...kept, ...Arr.map(step.adds[i] ?? [], (f) => factOf(r, f))])
			] as const
		})
	)

/** The relations a call names (a nonempty subset of `order` picked by `bits`, all when it picks none), in an order
 * picked by `shuffle`, with the first one repeated when `repeat` (a relation named twice is refreshed once). */
export const namedIn = (
	order: ReadonlyArray<string>,
	bits: number,
	shuffle: number,
	repeat: boolean
): ReadonlyArray<string> => {
	const picked = whereIndex(order, (i) => (bits >> i) % 2 === 1)
	const chosen = picked.length === 0 ? [...order] : picked
	const out: Array<string> = []
	let seed = shuffle
	const pool = [...chosen]
	while (pool.length > 0) {
		const at = seed % pool.length
		seed = Math.floor(seed / pool.length) + 7
		appendAll(out, pool.splice(at, 1))
	}
	const [first] = out
	return repeat && first !== undefined ? [...out, first] : out
}

/** The smallest set containing `named` and every derived relation a member reads, directly or through another. */
export const downwardClosed = (
	s: GenSchema,
	named: ReadonlyArray<string>
): ReadonlyArray<string> => {
	const byName = new Map(Arr.map(s.derived, (d) => [d.name, d]))
	const out = new Set<string>()
	const visit = (name: string) => {
		if (out.has(name)) {
			return
		}
		out.add(name)
		for (const read of byName.get(name)?.reads ?? []) {
			if (byName.has(read)) {
				visit(read)
			}
		}
	}
	for (const n of named) {
		visit(n)
	}
	return Arr.filter(s.refreshOrder, (n) => out.has(n))
}
