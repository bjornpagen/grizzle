import { floorPopulation, type Reached } from "@grizzle/testing/features"
import { array, element, type Gen, int, shuffled } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample, type Source } from "@grizzle/testing/source"
import { keep, type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { regex } from "arkregex"
import { Array as Arr, Option, pipe, Record as Rec, String as Str } from "effect"
import { requireGet } from "#compiler/analysis/logical/get.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileReason } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { type ClaimedKey, claimedColumns, claimedMembers } from "#compiler/ir/keys.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import type { Card } from "#compiler/ir/rel.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { TypeRefusal } from "#compiler/types/core/phantom.ts"
import {
	type AdmissionCell,
	admissionCells,
	admissionModule,
	admissionSize,
	combinatorCells
} from "#test/support/agreement/admission.ts"
import { groupFields, paramsType, recordType } from "#test/support/agreement/heading.ts"
import {
	Agree,
	Cents,
	Item,
	Note,
	Owned,
	Stray,
	Tag,
	Tone,
	Tones
} from "#test/support/agreement/schema.ts"
import { defined } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { admittedNames, refusedNames } from "#test/support/kernel/dict.ts"
import { argumentsOf } from "#test/support/list.ts"
import { messageOf } from "#test/support/message.ts"

/**
 * The type/engine agreement: queries drawn over the agreement schema (./schema.ts), each with the engine's verdict on
 * it, and the one TypeScript program that states every verdict as a type assertion, which the type tier checks
 * (test/types/evidence/agreement.test.ts). The engine is the oracle: a drawn query typechecks exactly when the engine
 * compiles it, db.get accepts exactly what the engine proves at most one row per binding, every key the types claim is
 * one the engine proves, its cardinality is the engine's, and the records the types infer, of a snapshot read and of
 * db.execute and db.get, are the engine's decoded heading (./heading.ts), as are its parameters.
 *
 * A query is drawn as data (QuerySpec) and read twice: rendered as TypeScript source for the program, and built through
 * the query builder's JavaScript view (queryOver, varsOver, computeCore) for the engine, which compiles it as the
 * runtime does (snapshot context, rows) and reads the root of its analyzed DAG: whether get may read it
 * (analysis/logical/get.ts requireGet), its cardinality and its minimal keys; each arm, built and compiled alone, gives
 * its heading group's decoded record. Both readings walk one spec construct by construct, so the program and the engine
 * see one query.
 *
 * Two populations share the generator. The clean one plants no fault: the floor's witnesses (floorPopulation), the
 * same in every run, which alone meet the required constructs, and the run's own stream (agreementCases samples it from
 * the run's seed), new every run. The faulted one (faultCases) plants one fault per case at a site the generator draws
 * (Fault): a scope's name drawn from the declared-name dictionary, or left out, or spelled through a `string`; a
 * binding of a name drawn from every relation's fields and a stranger; a match of Stray, which Agree does not hold; a
 * fold whose match keeps the keys it binds as drawn; a second arm of another heading whose fields are named as the
 * first's; a relation parameter of no field; and Owned matched unbound. The engine decides each: where it refuses, the
 * program states the refusal its reason is, at the fault's site (refusalOf), under the directive the type-test batch
 * disarms; where it admits, the program states every verdict as for a clean query. A name spelled through a `string`
 * is the one fault no engine sees, since every value a `string` holds at run time is a literal: the types refuse the
 * widening of every name the engine admits, so two scopes never share a type.
 *
 * Each case first draws a swarm over the constructs (@grizzle/testing/swarm), then its query construct by construct:
 * the swarm turns constructs off for a whole case and thins the rest, so the forms that crowd others out are left out
 * of some cases and the rest combine. Each constant's construct is drawn at a place every case visits, so a case whose
 * swarm keeps it holds it and the floor reaches it by construction: a constant of Tone through the rule's anchor
 * (Anchor), a handle discriminant before the union's own gates, a constant at Tones as the rule's last match. So is a
 * self-join whose get the engine proves (pinnedSelfJoin), drawn as a rule's second match: two scopes of one relation,
 * each with a key bound to values fixed per binding, in a query of no other arm, which reaches the pair a repeat and a
 * proved get make (agreementPairs) wherever the swarm keeps it.
 *
 * A constant stands in every term position: a JavaScript value (`literal`), Tone's handle (`handle`) at Item.tone in a
 * binding, a filter, first in a comparison, a head, a union's discriminant and a binding at Tones, the union source of
 * ./schema.ts, whose arm it selects, and a typed constant (`constant`), `Compute.literal(pg.integer, v)` where its
 * value never reaches the evidence (Compute operands, a conditional's branch) and `Compute.literal(Cents, v)` where it
 * stands for a value of Item.cost: its type keeps its descriptor's whole host type, the one approximation of a typed
 * constant's value, so the evidence never reads it.
 *
 * The clean program is emitted twice, in the drawn order and in a second drawn order, as two modules, and a third
 * asserts every query's head and keys equal across the two: TypeScript's evaluation of the evidence must not depend on
 * the order of unrelated statements. A fourth module is the admission agreement (./admission.ts), and a fifth the
 * faulted population.
 */

/** The constructs a drawn query may use, each a swarm feature. */
export const agreementFeatures = [
	"ownVar",
	"join",
	"foreignVar",
	"param",
	"literal",
	"omit",
	"computedBinding",
	"secondMatch",
	"thirdMatch",
	"repeat",
	"pinnedSelfJoin",
	"fixFilter",
	"computedFix",
	"varEquality",
	"rangeFilter",
	"computeFilter",
	"conjunction",
	"disjunction",
	"negation",
	"flaggedEither",
	"flaggedSpread",
	"headVar",
	"computedHead",
	"condHead",
	"literalHead",
	"paramHead",
	"constantBinding",
	"constantFirst",
	"constantFilter",
	"constantHead",
	"handleDiscriminant",
	"constantAtUnionSource",
	"relationParam",
	"boundImport",
	"aggregate",
	"groupTerm",
	"sum",
	"minMax",
	"mean",
	"union",
	"discriminant",
	"heterogeneous",
	"take",
	"namedTake"
] as const
export type AgreementFeature = (typeof agreementFeatures)[number]

/**
 * The faults a faulted case plants, one per case: a site whose drawn value the engine may refuse (or, for widenedName,
 * a spelling no engine sees).
 */
export const agreementFaults = [
	"scopeName",
	"unnamedScope",
	"widenedName",
	"stranger",
	"stray",
	"unkeyedFold",
	"unionTypes",
	"emptyRelation",
	"unboundImport"
] as const
export type Fault = (typeof agreementFaults)[number]

/** What a case plants: no fault, or one. */
type Planted = "clean" | Fault

/** What a drawn case reached: its constructs, and the engine's verdict on it. */
export type AgreementNote =
	| AgreementFeature
	| "get proved"
	| "get refused"
	| "a key below the heading"
	| "a variable two filters fix"
	| "a contract in the head"

/** What a faulted case reached: its fault, and whether its site's drawn value was refused or admitted. */
export type FaultNote = `${Fault} refused` | `${Fault} admitted`

/**
 * The pairs of notes one case must reach together: a self-join whose get the engine proves, which pinnedSelfJoin
 * draws by construction.
 */
export const agreementPairs: ReadonlyArray<readonly [AgreementNote, AgreementNote]> = [
	["repeat", "get proved"]
]

type Rel = "Item" | "Tag" | "Note"
/**
 * A source a rule mints variables over: a relation of Agree, the rule's relation parameter (Rows), the import Owned, or
 * Stray, which Agree does not hold.
 */
type Minted = Rel | "Rows" | "Owned" | "Stray"
/** What a match reads: a source of variables, or Tones, the union of Item's facts by tone (./schema.ts). */
type MatchSource = Minted | "Tones"
type Kind = "uuid" | "int" | "code" | "cents"

interface Field {
	readonly rel: Minted
	readonly name: string
	readonly kind: Kind
}

const fieldsOf: { readonly [S in Minted]: Arr.NonEmptyReadonlyArray<Field> } = {
	Item: [
		{ rel: "Item", name: "id", kind: "uuid" },
		{ rel: "Item", name: "owner", kind: "uuid" },
		{ rel: "Item", name: "n", kind: "int" },
		{ rel: "Item", name: "m", kind: "int" },
		{ rel: "Item", name: "tone", kind: "code" },
		{ rel: "Item", name: "cost", kind: "cents" }
	],
	Tag: [
		{ rel: "Tag", name: "item", kind: "uuid" },
		{ rel: "Tag", name: "label", kind: "int" },
		{ rel: "Tag", name: "w", kind: "int" }
	],
	Note: [
		{ rel: "Note", name: "item", kind: "uuid" },
		{ rel: "Note", name: "k", kind: "int" }
	],
	Rows: [
		{ rel: "Rows", name: "id", kind: "uuid" },
		{ rel: "Rows", name: "n", kind: "int" }
	],
	Owned: [
		{ rel: "Owned", name: "id", kind: "uuid" },
		{ rel: "Owned", name: "n", kind: "int" }
	],
	Stray: [
		{ rel: "Stray", name: "id", kind: "uuid" },
		{ rel: "Stray", name: "n", kind: "int" }
	]
}
const rels: Arr.NonEmptyReadonlyArray<Rel> = ["Item", "Tag", "Note"]
/**
 * Each source's keys, by their fields (./schema.ts): a relation parameter's rows are a set, and so are an import's,
 * each keyed by its whole heading.
 */
const keysOf: { readonly [S in Minted]: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>> } = {
	Item: [["id"], ["owner", "n"]],
	Tag: [["item", "label"]],
	Note: [["item"]],
	Rows: [["id", "n"]],
	Owned: [["id", "n"]],
	Stray: [["id"]]
}
const allFields: Arr.NonEmptyReadonlyArray<Field> = Arr.flatMap(rels, (rel) => fieldsOf[rel])
/** Item's field of each kind: the descriptor a parameter of that kind is declared at, wherever it stands. */
const itemField = (kind: Kind): Field =>
	Option.getOrThrowWith(
		Arr.findFirst(fieldsOf.Item, (f) => f.kind === kind),
		() => new Error(`Item has no ${kind} field`)
	)
/** The integer field a parameter compared with a constant is typed by, where the rule binds no variable. */
const integerField: Field = itemField("int")
/** Item.tone, the field a rule's first match binds when it draws a constant of Tone by construction (Anchor). */
const toneField: Field = itemField("code")

/** Owned through the query builder's JavaScript view, whose bind the engine reads a drawn binding through. */
const ownedImport: QueryValue = Owned

/** The relations a match reads, as values, and Item's field descriptors, which every parameter is declared at. */
const relations: { readonly [R in Rel | "Stray" | "Tones"]: unknown } = {
	Item,
	Tag,
	Note,
	Stray,
	Tones
}
const descriptors: Readonly<Record<string, unknown>> = Item.fields

/**
 * A variable v mints over a source's field, in the scope of the source's `copy`-th match in its rule: a self-join's two
 * matches mint in two scopes (scopeOf).
 */
interface Var {
	readonly field: Field
	readonly copy: number
}

type Term =
	| { readonly kind: "var"; readonly v: Var }
	| { readonly kind: "param"; readonly name: string; readonly at: Field }
	| { readonly kind: "literal"; readonly type: Exclude<Kind, "cents">; readonly value: number }
	| { readonly kind: "constant"; readonly of: "integer" | "cents"; readonly value: number }
	| { readonly kind: "handle"; readonly value: number }
	| {
			readonly kind: "arith"
			readonly op: "add" | "sub" | "mul"
			readonly a: Term
			readonly b: Term
	  }
	| { readonly kind: "neg"; readonly a: Term }
	| { readonly kind: "cond"; readonly p: Pred; readonly onTrue: Term; readonly onFalse: Term }

/** A rule's predicate (r.eq, r.and, ...) or Compute's (Compute.eq, Compute.and, ...). */
type Via = "rule" | "compute"

type Pred =
	| {
			readonly kind: "cmp"
			readonly op: "eq" | "ne" | "lt" | "ge"
			readonly a: Term
			readonly b: Term
			readonly via: Via
	  }
	| { readonly kind: "and" | "or"; readonly ps: readonly [Pred, Pred]; readonly via: Via }
	| { readonly kind: "not"; readonly rel: Rel; readonly field: string; readonly t: Term }

/** An aggregate a grouped head folds its matches by. */
type Fold = "sum" | "min" | "max" | "mean"

type HeadTerm =
	| { readonly kind: "term"; readonly t: Term }
	| { readonly kind: "literal"; readonly value: number | string }
	| { readonly kind: "count" }
	| { readonly kind: "fold"; readonly fold: Fold; readonly of: Term }

interface Match {
	readonly rel: MatchSource
	readonly copy: number
	readonly bindings: ReadonlyArray<readonly [string, Term]>
}

/** How a scope's name is written: a literal, left out of v, or spelled through a `string` (Fault). */
type Spelling =
	| { readonly kind: "literal"; readonly name: string }
	| { readonly kind: "omitted" }
	| { readonly kind: "widened" }

/**
 * A filter whose predicate turns on a boolean the program does not know: one of two predicates (`flag ? a : b`), or a
 * predicate a spread array of unknown length may hold (`...Arr.filter([p], () => flag)`). The engine reads the rule
 * under each value the flag may take (flagVariants), and the types must hold what holds under both.
 */
type Flagged =
	| { readonly kind: "either"; readonly ifTrue: Pred; readonly ifFalse: Pred }
	| { readonly kind: "spread"; readonly p: Pred }

/** A rule's relation parameter, which every match of Rows reads: its name and heading. */
interface RowsDecl {
	readonly name: string
	readonly heading: ReadonlyArray<Field>
}

/** Owned's parameter under one of its matches: bound to a term, or unbound where a case plants that fault. */
type OwnedBind = { readonly kind: "bound"; readonly owner: Term } | { readonly kind: "unbound" }

interface RuleSpec {
	readonly matches: Arr.NonEmptyReadonlyArray<Match>
	readonly filters: ReadonlyArray<Pred>
	/** A filter on a flag, where the rule states one. */
	readonly flagged: Flagged | undefined
	readonly head: Arr.NonEmptyReadonlyArray<readonly [string, HeadTerm]>
	/** The relation parameter the rule declares, where it declares one. */
	readonly rows: RowsDecl | undefined
	/** Owned's binding under each of its matches, by the match's copy. */
	readonly owned: ReadonlyArray<OwnedBind>
	/** A scope whose name is written otherwise than as its own literal (scopeOf), by its scope. */
	readonly spellings: ReadonlyArray<readonly [string, Spelling]>
}

/** One query: its arms (a union when two), the take that closes it, if any, and the fault it plants. */
interface QuerySpec {
	readonly arms: Arr.NonEmptyReadonlyArray<RuleSpec>
	readonly take: 1 | 2 | "k" | undefined
	readonly fault: Planted
}

/** A form a draw may take: the construct it uses, and the part it draws. */
type Form<A> = readonly [AgreementFeature, () => A]

/**
 * One query's drawing: the case's swarm, the fault it plants, the source its decisions come from, the constructs it
 * reached and its fresh names.
 */
class Drawing {
	readonly #source: Source
	readonly #swarm: Swarm<AgreementFeature>
	readonly fault: Planted
	#params = 0
	readonly reached = new Set<AgreementFeature>()

	constructor(source: Source, drawn: Swarm<AgreementFeature>, fault: Planted) {
		this.#source = source
		this.#swarm = drawn
		this.fault = fault
	}

	/** Whether `feature` appears at this place, as the swarm keeps it; noted when it does. */
	keep(feature: AgreementFeature): boolean {
		const kept = this.#source.draw(keep(this.#swarm, feature))
		if (kept) {
			this.reached.add(feature)
		}
		return kept
	}

	/** Notes a construct another construct's draw made, as the draw that kept it would. */
	note(feature: AgreementFeature): void {
		this.reached.add(feature)
	}

	/** One of `forms`, by the swarm's weights of their constructs, the first when every one is off; noted. */
	choose<A>(forms: Arr.NonEmptyReadonlyArray<Form<A>>): A {
		const feature = this.#source.draw(
			swarmChoice(
				this.#swarm,
				Arr.map(forms, ([f]) => f)
			)
		)
		this.reached.add(feature)
		const [, draw] = Option.getOrThrowWith(
			Arr.findFirst(forms, ([f]) => f === feature),
			() => new Error(`the swarm chose ${feature}, no form of the draw`)
		)
		return draw()
	}

	from<A>(options: Arr.NonEmptyReadonlyArray<A>): A {
		return this.#source.draw(element(options))
	}

	param(at: Field): Term {
		const name = `p${this.#params}`
		this.#params += 1
		return { kind: "param", name, at: at.rel === "Item" ? at : itemField(at.kind) }
	}
}

const sameVar = (a: Var, b: Var): boolean =>
	a.field.rel === b.field.rel && a.field.name === b.field.name && a.copy === b.copy

const varTerm = (v: Var): Term => ({ kind: "var", v })

/** A value of a field's type written in the program: a JavaScript value, or a contract's typed constant. */
const literalOf = (d: Drawing, kind: Kind): Term =>
	kind === "cents"
		? { kind: "constant", of: "cents", value: d.from([0, 1, 2, 3]) }
		: { kind: "literal", type: kind, value: d.from([0, 1, 2, 3]) }

/** Tone's members, which a handle and a JavaScript value of Item.tone name by index. */
const tones = Tone.handles

const toneOf = (value: number): (typeof tones)[number] => Arr.getUnsafe(tones, value % tones.length)

const handleOf = (d: Drawing): Term => ({ kind: "handle", value: d.from([0, 1, 2]) })

/** A value a field's binding fixes per binding: a parameter or a literal of the field's type. */
const boundInputs = (d: Drawing, at: Field): Arr.NonEmptyReadonlyArray<Form<Term>> => [
	["param", () => d.param(at)],
	["literal", () => literalOf(d, at.kind)]
]

/** A value fixed per binding: a parameter or a literal, or Compute over a constant and a parameter. */
const inputOf = (d: Drawing, at: Field): Term => {
	const plain = boundInputs(d, at)
	switch (at.kind) {
		case "int":
			return d.choose([
				...plain,
				[
					"computedFix",
					() => ({
						kind: "arith",
						op: d.from(["add", "mul"] as const),
						a: { kind: "constant", of: "integer", value: d.from([1, 2]) },
						b: d.param(at)
					})
				]
			])
		case "code":
			return d.choose([...plain, ["constantFilter", () => handleOf(d)]])
		case "uuid":
		case "cents":
			return d.choose(plain)
	}
}

/**
 * A Compute term over the bound integer variables: arithmetic with a literal, a parameter or a variable, or a negation.
 */
const computedOver = (d: Drawing, ints: Arr.NonEmptyReadonlyArray<Var>): Term => {
	const a = varTerm(d.from(ints))
	switch (d.from(["literal", "param", "var", "neg"] as const)) {
		case "literal":
			return {
				kind: "arith",
				op: d.from(["add", "sub", "mul"] as const),
				a,
				b: literalOf(d, "int")
			}
		case "param":
			return {
				kind: "arith",
				op: d.from(["add", "sub", "mul"] as const),
				a,
				b: d.param(d.from(ints).field)
			}
		case "var":
			return { kind: "arith", op: d.from(["add", "mul"] as const), a, b: varTerm(d.from(ints)) }
		case "neg":
			return { kind: "neg", a }
	}
}

const viaOf = (d: Drawing): Via => (d.keep("computeFilter") ? "compute" : "rule")

/**
 * A comparison of a bound variable with a value fixed per binding or a literal bound, or of inputs when none is bound.
 */
const comparisonOver = (d: Drawing, bound: ReadonlyArray<Var>): Pred => {
	const via = viaOf(d)
	if (!Arr.isReadonlyArrayNonEmpty(bound)) {
		return {
			kind: "cmp",
			op: "ge",
			a: { kind: "constant", of: "integer", value: 1 },
			b: d.param(integerField),
			via
		}
	}
	const v = d.from(bound)
	if (v.field.kind === "code" && d.keep("constantFirst")) {
		return { kind: "cmp", op: d.from(["eq", "ne"] as const), a: handleOf(d), b: varTerm(v), via }
	}
	return v.field.kind === "int" && d.from([0, 1]) === 0
		? { kind: "cmp", op: d.from(["lt", "ge"] as const), a: varTerm(v), b: literalOf(d, "int"), via }
		: { kind: "cmp", op: d.from(["eq", "ne"] as const), a: varTerm(v), b: inputOf(d, v.field), via }
}

/**
 * The forms a field's binding may take: its own variable, a join, a foreign variable, an input, a computation, none.
 */
const bindingForms = (
	d: Drawing,
	field: Field,
	own: Var,
	bound: ReadonlyArray<Var>
): Arr.NonEmptyReadonlyArray<Form<Term | undefined>> => {
	const joins = Arr.filter(bound, (b) => b.field.kind === field.kind && !sameVar(b, own))
	const foreign = Arr.filter(
		allFields,
		(f) => f.kind === field.kind && !(f.rel === field.rel && f.name === field.name)
	)
	const ints = Arr.filter(bound, (b) => b.field.kind === "int")
	return [
		["ownVar", () => varTerm(own)],
		...(Arr.isReadonlyArrayNonEmpty(joins)
			? [["join", () => varTerm(d.from(joins))] as const]
			: []),
		...(Arr.isReadonlyArrayNonEmpty(foreign)
			? [["foreignVar", () => varTerm({ field: d.from(foreign), copy: 0 })] as const]
			: []),
		["param", () => d.param(field)],
		["literal", () => literalOf(d, field.kind)],
		...(field.kind === "code" ? [["constantBinding", () => handleOf(d)] as const] : []),
		["omit", () => undefined],
		...(field.kind === "int" && Arr.isReadonlyArrayNonEmpty(ints)
			? [
					[
						"computedBinding",
						(): Term => ({
							kind: "arith",
							op: d.from(["add", "mul"] as const),
							a: varTerm(d.from(ints)),
							b: literalOf(d, "int")
						})
					] as const
				]
			: [])
	]
}

/** A match's bindings, and the variables bound once they are. */
interface Bound {
	readonly bindings: ReadonlyArray<readonly [string, Term]>
	readonly bound: ReadonlyArray<Var>
}

/**
 * A rule's constant of Tone drawn by construction: its first match is Item, whose tone it binds to a handle
 * (constantBinding), or to tone's variable, which a filter compares with a handle second (constantFilter) or first
 * (constantFirst). Each is otherwise drawn only where Item.tone's variable happens to be bound, which few cases do.
 */
type Anchor =
	| { readonly kind: "binding"; readonly handle: Term }
	| { readonly kind: "variable"; readonly filter: boolean; readonly first: boolean }

const anchorOf = (d: Drawing): Anchor | undefined => {
	if (d.keep("constantBinding")) {
		return { kind: "binding", handle: handleOf(d) }
	}
	const filter = d.keep("constantFilter")
	const first = d.keep("constantFirst")
	return filter || first ? { kind: "variable", filter, first } : undefined
}

/** The filters an anchor's variable is compared with a handle in. */
const anchorFilters = (d: Drawing, anchor: Anchor | undefined): ReadonlyArray<Pred> => {
	if (anchor === undefined || anchor.kind === "binding") {
		return []
	}
	const tone = varTerm({ field: toneField, copy: 0 })
	const compared = (a: Term, b: Term): Pred => ({
		kind: "cmp",
		op: d.from(["eq", "ne"] as const),
		a,
		b,
		via: viaOf(d)
	})
	return [
		...(anchor.filter ? [compared(tone, handleOf(d))] : []),
		...(anchor.first ? [compared(handleOf(d), tone)] : [])
	]
}

/** What an anchor binds Item.tone to, where it binds it. */
const anchored = (anchor: Anchor | undefined, field: Field, own: Var): Term | undefined =>
	anchor === undefined || field.rel !== toneField.rel || field.name !== toneField.name
		? undefined
		: anchor.kind === "binding"
			? anchor.handle
			: varTerm(own)

/**
 * A match's bindings, field by field, each drawn over the variables bound before it, a join among them; a field the
 * anchor binds is bound as it says, and a field of `inputs` to a value fixed per binding.
 */
const bindingsOf = (
	d: Drawing,
	fields: ReadonlyArray<Field>,
	copy: number,
	before: ReadonlyArray<Var>,
	anchor: Anchor | undefined,
	inputs: ReadonlyArray<string>
): Bound =>
	Arr.reduce(fields, { bindings: [], bound: before }, (drawn: Bound, field): Bound => {
		const own: Var = { field, copy }
		const term = Arr.contains(inputs, field.name)
			? d.choose(boundInputs(d, field))
			: (anchored(anchor, field, own) ?? d.choose(bindingForms(d, field, own, drawn.bound)))
		return term === undefined
			? drawn
			: {
					bindings: [...drawn.bindings, [field.name, term] as const],
					bound: withVariable(drawn.bound, term)
				}
	})

const withVariable = (bound: ReadonlyArray<Var>, term: Term): ReadonlyArray<Var> =>
	term.kind === "var" && !Arr.some(bound, (b) => sameVar(b, term.v)) ? [...bound, term.v] : bound

/** A rule's matches, and the variables they bind. */
interface Matched {
	readonly matches: Arr.NonEmptyReadonlyArray<Match>
	readonly bound: ReadonlyArray<Var>
}

/** The copy the next match of `source` mints its scope in, after `matches`. */
const nextCopy = (matches: ReadonlyArray<Match>, source: MatchSource): number =>
	Arr.filter(matches, (m) => m.rel === source).length

/**
 * One to three matches, each of a drawn relation, the first Item when an anchor draws a constant of Tone (Anchor): a
 * relation already matched again only where the swarm keeps the repeat.
 */
const drawnMatches = (d: Drawing, anchor: Anchor | undefined, second: boolean): Matched => {
	const count = second ? (d.keep("thirdMatch") ? 3 : 2) : 1
	const matched: Array<Rel> = []
	let bound: ReadonlyArray<Var> = []
	const matches: Array<Match> = []
	for (let i = 0; i < count; i++) {
		const drawn = i === 0 && anchor !== undefined ? "Item" : d.from(rels)
		const unmatched = Arr.filter(rels, (rel) => !Arr.contains(matched, rel))
		const rel =
			Arr.contains(matched, drawn) && Arr.isReadonlyArrayNonEmpty(unmatched) && !d.keep("repeat")
				? d.from(unmatched)
				: drawn
		const copy = Arr.filter(matched, (m) => m === rel).length
		matched.push(rel)
		const bindings = bindingsOf(d, fieldsOf[rel], copy, bound, i === 0 ? anchor : undefined, [])
		bound = bindings.bound
		matches.push({ rel, copy, bindings: bindings.bindings })
	}
	return { matches: [defined(matches[0], "the first match"), ...matches.slice(1)], bound }
}

/**
 * A self-join whose get the engine proves, drawn by construction (pinnedSelfJoin): two matches of one relation, Item
 * when an anchor draws a constant of Tone, each scope binding one of the relation's keys to values fixed per binding,
 * so both facts are pinned and so is every variable the rule binds. Its other fields are drawn as any match's.
 */
const pinnedMatches = (d: Drawing, anchor: Anchor | undefined): Matched => {
	d.note("repeat")
	const rel = anchor === undefined ? d.from(rels) : "Item"
	const first = bindingsOf(d, fieldsOf[rel], 0, [], anchor, d.from(keysOf[rel]))
	const second = bindingsOf(d, fieldsOf[rel], 1, first.bound, undefined, d.from(keysOf[rel]))
	return {
		matches: [
			{ rel, copy: 0, bindings: first.bindings },
			{ rel, copy: 1, bindings: second.bindings }
		],
		bound: second.bound
	}
}

/**
 * The further sources a rule may match after its drawn matches: the relation parameter it declares, Owned bound to a
 * uuid input or variable, and Stray, each with its fields bound as any match's; a faulted case's own source among them,
 * so its fault stands at a match of the rule (Fault). A relation parameter of no field is declared, and matched by no
 * match, where the case plants that fault.
 */
interface Further {
	readonly matches: ReadonlyArray<Match>
	readonly bound: ReadonlyArray<Var>
	readonly rows: RowsDecl | undefined
	readonly owned: ReadonlyArray<OwnedBind>
}

const furtherMatches = (
	d: Drawing,
	before: ReadonlyArray<Match>,
	bound: ReadonlyArray<Var>,
	rowsName: string
): Further => {
	const rows = d.fault === "emptyRelation" ? false : d.keep("relationParam")
	const owned = d.fault === "unboundImport" || d.keep("boundImport")
	const stray = d.fault === "stray"
	const sources: ReadonlyArray<MatchSource> = [
		...(rows || d.fault === "emptyRelation" ? ["Rows" as const] : []),
		...(owned ? ["Owned" as const] : []),
		...(stray ? ["Stray" as const] : [])
	]
	const start: Further = {
		matches: [],
		bound,
		rows:
			d.fault === "emptyRelation"
				? { name: rowsName, heading: [] }
				: rows
					? { name: rowsName, heading: fieldsOf.Rows }
					: undefined,
		owned: []
	}
	return Arr.reduce(sources, start, (drawn: Further, source): Further => {
		const binds: ReadonlyArray<OwnedBind> =
			source === "Owned"
				? [
						...drawn.owned,
						d.fault === "unboundImport"
							? { kind: "unbound" }
							: { kind: "bound", owner: ownerOf(d, drawn.bound) }
					]
				: drawn.owned
		const minted: Minted = source === "Tones" ? "Item" : source
		const copy = nextCopy([...before, ...drawn.matches], source)
		const fields =
			source === "Rows" && drawn.rows !== undefined ? drawn.rows.heading : fieldsOf[minted]
		const bindings = bindingsOf(d, fields, copy, drawn.bound, undefined, [])
		return {
			matches: [...drawn.matches, { rel: source, copy, bindings: bindings.bindings }],
			bound: bindings.bound,
			rows: drawn.rows,
			owned: binds
		}
	})
}

/**
 * Owned's owner: a uuid variable of the rule bound before it, or a value fixed per binding; never a variable of Owned's
 * own, whose source is the binding itself.
 */
const ownerOf = (d: Drawing, bound: ReadonlyArray<Var>): Term => {
	const uuids = Arr.filter(bound, (b) => b.field.kind === "uuid" && b.field.rel !== "Owned")
	return Arr.isReadonlyArrayNonEmpty(uuids) && d.from([0, 1]) === 0
		? varTerm(d.from(uuids))
		: d.choose(boundInputs(d, itemField("uuid")))
}

/** A drawn rule, and whether it is a pinned self-join, which no union's arm is. */
interface DrawnRule {
	readonly rule: RuleSpec
	readonly pinned: boolean
}

/**
 * A rule: its matches, its filters and its head, over the variables its matches bind, its head fields named by
 * `prefix`. A second match may be a pinned self-join's (pinnedMatches), the rule's matches alone; any other rule's are
 * drawn, then its further matches (furtherMatches), and its last, under constantAtUnionSource, is Tones with a constant
 * bound at tone, a handle or its member's JavaScript value, which selects the arm holding it. A faulted case plants its
 * fault here, but for unionTypes, which its query plants.
 */
const drawRule = (d: Drawing, prefix: "h" | "g", rowsName: string): DrawnRule => {
	const anchor = anchorOf(d)
	const second = d.keep("secondMatch")
	const pinned = second && d.keep("pinnedSelfJoin")
	const drawn = pinned ? pinnedMatches(d, anchor) : drawnMatches(d, anchor, second)
	const further = pinned
		? { matches: [], bound: drawn.bound, rows: undefined, owned: [] }
		: furtherMatches(d, drawn.matches, drawn.bound, rowsName)
	const atUnion: ReadonlyArray<Match> =
		!pinned && d.keep("constantAtUnionSource")
			? [{ rel: "Tones", copy: 0, bindings: [["tone", tonesConstant(d)]] }]
			: []
	const filters = [...anchorFilters(d, anchor), ...filtersOver(d, further.bound)]
	const flagged = flaggedOver(d, further.bound)
	const head = headOver(d, further.bound, prefix)
	const all = [...drawn.matches, ...further.matches, ...atUnion]
	const folded = Arr.some(head, ([, h]) => h.kind === "count" || h.kind === "fold")
	const matches: Arr.NonEmptyReadonlyArray<Match> = Arr.appendAll(
		drawn.matches,
		Arr.appendAll(further.matches, atUnion)
	)
	const keyed: Arr.NonEmptyReadonlyArray<Match> =
		folded && d.fault !== "unkeyedFold" ? Arr.map(matches, keyedMatch) : matches
	const stranger = d.fault === "stranger" ? strangerOf(d, keyed) : keyed
	const rule: RuleSpec = {
		matches: stranger,
		filters,
		flagged,
		head,
		rows: further.rows,
		owned: further.owned,
		spellings: []
	}
	return {
		rule: d.fault === "clean" || all.length === 0 ? rule : spelled(d, rule),
		pinned
	}
}

/** The names a stranger binding is drawn from: every relation's fields, and one no source has. */
const strangerNames: Arr.NonEmptyReadonlyArray<string> = [
	...Arr.dedupe(Arr.map(allFields, (f) => f.name)),
	"nope"
]

/**
 * A rule's matches with one binding more, at a match other than Tones: a name drawn among every relation's fields and a
 * stranger's, bound where it names a field of the source to that field's own variable, and otherwise to a literal. The
 * engine decides whether the source has the field.
 */
const strangerOf = (
	d: Drawing,
	matches: Arr.NonEmptyReadonlyArray<Match>
): Arr.NonEmptyReadonlyArray<Match> => {
	const at = d.from(Arr.map(matches, (_m, i) => i))
	return Arr.map(matches, (m, i) => {
		if (i !== at || m.rel === "Tones") {
			return m
		}
		const named = Arr.map(m.bindings, ([f]) => f)
		const free = Arr.filter(strangerNames, (n) => !Arr.contains(named, n))
		if (!Arr.isReadonlyArrayNonEmpty(free)) {
			return m
		}
		const name = d.from(free)
		const field = Arr.findFirst(fieldsOf[m.rel], (f) => f.name === name)
		const term: Term = Option.isSome(field)
			? varTerm({ field: field.value, copy: m.copy })
			: { kind: "literal", type: "int", value: 0 }
		return { ...m, bindings: [...m.bindings, [name, term] as const] }
	})
}

/**
 * The scope names a scope's name is drawn from where a case plants scopeName: the declared-name dictionary's admitted
 * names and its refused ones, each half the draws, so the few refused spellings are drawn as often as the many admitted.
 */
const scopeNames: readonly [ReadonlyArray<string>, ReadonlyArray<string>] = [
	["peer", ...Arr.map(admittedNames, (n) => n.declared)],
	Arr.map(refusedNames, (n) => n.declared)
]

/**
 * A rule whose one scope, drawn among the scopes its terms read, is written as the case's scope fault says: a name of
 * the dictionary, other than any scope of the rule, under scopeName; no name under unnamedScope; its own name spelled
 * through a `string` under widenedName. A rule that reads no variable is left as it is.
 */
const spelled = (d: Drawing, rule: RuleSpec): RuleSpec => {
	const scopes = Arr.dedupe(Arr.map(variablesOf(rule), scopeOf))
	if (!Arr.isReadonlyArrayNonEmpty(scopes)) {
		return rule
	}
	const scope = d.from(scopes)
	const spelling = (): Spelling | undefined => {
		switch (d.fault) {
			case "scopeName": {
				const free = Arr.filter(d.from(scopeNames), (n) => !Arr.contains(scopes, n))
				return Arr.isReadonlyArrayNonEmpty(free)
					? { kind: "literal", name: d.from(free) }
					: undefined
			}
			case "unnamedScope":
				return { kind: "omitted" }
			case "widenedName":
				return { kind: "widened" }
			case "clean":
			case "stranger":
			case "stray":
			case "unkeyedFold":
			case "unionTypes":
			case "emptyRelation":
			case "unboundImport":
				return undefined
		}
	}
	const drawn = spelling()
	return drawn === undefined ? rule : { ...rule, spellings: [[scope, drawn]] }
}

/** Each key of a match's source, by its fields: Tones, a union keyed by its heading, by id and tone. */
const sourceKeys = (source: MatchSource): Arr.NonEmptyReadonlyArray<ReadonlyArray<string>> =>
	source === "Tones" ? [["id", "tone"]] : keysOf[source]

/**
 * A match a fold reads, which binds every field of one key of its source (a fold reads each fact it matches once, by a
 * key): as drawn when it does, and otherwise with its source's first key's unbound fields bound to variables of its
 * own scope; Tones' id, a field of Item's facts, to the first Item match's.
 */
const keyedMatch = (m: Match): Match => {
	const named = new Set(Arr.map(m.bindings, ([f]) => f))
	const keys = sourceKeys(m.rel)
	if (Option.isSome(Arr.findFirst(keys, (k) => Arr.every(k, (f) => named.has(f))))) {
		return m
	}
	const fields = m.rel === "Tones" ? fieldsOf.Item : fieldsOf[m.rel]
	const [first] = keys
	const added = Arr.flatMap(first, (name: string): ReadonlyArray<readonly [string, Term]> => {
		const field = Arr.findFirst(fields, (f) => f.name === name)
		return named.has(name) || Option.isNone(field)
			? []
			: [[name, varTerm({ field: field.value, copy: m.copy })]]
	})
	return { ...m, bindings: Arr.appendAll(m.bindings, added) }
}

/** A constant some arm of Tones holds at tone: low or mid, as a handle or as the member's JavaScript value. */
const tonesConstant = (d: Drawing): Term => {
	const value = d.from([0, 1])
	return d.from([0, 1]) === 0 ? { kind: "handle", value } : { kind: "literal", type: "code", value }
}

/** The rule's filters: an equality with a value fixed per binding, between two variables, a range; joined or not. */
const filtersOver = (d: Drawing, bound: ReadonlyArray<Var>): ReadonlyArray<Pred> => {
	const simple: Array<Pred> = []
	if (Arr.isReadonlyArrayNonEmpty(bound) && d.keep("fixFilter")) {
		const v = d.from(bound)
		simple.push({ kind: "cmp", op: "eq", a: varTerm(v), b: inputOf(d, v.field), via: viaOf(d) })
	}
	const pairs = Arr.flatMap(bound, (a, i) =>
		Arr.flatMap(bound.slice(i + 1), (b) => (a.field.kind === b.field.kind ? [[a, b] as const] : []))
	)
	if (Arr.isReadonlyArrayNonEmpty(pairs) && d.keep("varEquality")) {
		const [a, b] = d.from(pairs)
		simple.push({ kind: "cmp", op: "eq", a: varTerm(a), b: varTerm(b), via: viaOf(d) })
	}
	const ints = Arr.filter(bound, (b) => b.field.kind === "int")
	if (Arr.isReadonlyArrayNonEmpty(ints) && d.keep("rangeFilter")) {
		simple.push({
			kind: "cmp",
			op: d.from(["lt", "ge"] as const),
			a: varTerm(d.from(ints)),
			b:
				d.from([0, 1]) === 0
					? literalOf(d, "int")
					: { kind: "constant", of: "integer", value: d.from([1, 2]) },
			via: viaOf(d)
		})
	}
	const negated = negationOver(d, bound)
	const [first, second, ...rest] = simple
	if (first === undefined || second === undefined) {
		return [...simple, ...negated]
	}
	if (d.keep("disjunction")) {
		return [{ kind: "or", ps: [first, second], via: viaOf(d) }, ...rest, ...negated]
	}
	if (d.keep("conjunction")) {
		return [{ kind: "and", ps: [first, second], via: viaOf(d) }, ...rest, ...negated]
	}
	return [...simple, ...negated]
}

/**
 * A filter on a flag over the bound variables: one of two comparisons, or one a spread array may hold, each an
 * equality with a value fixed per binding, which fixes its variable under the flag's one value alone.
 */
const flaggedOver = (d: Drawing, bound: ReadonlyArray<Var>): Flagged | undefined => {
	if (!Arr.isReadonlyArrayNonEmpty(bound)) {
		return undefined
	}
	const fixing = (): Pred => {
		const v = d.from(bound)
		return { kind: "cmp", op: "eq", a: varTerm(v), b: inputOf(d, v.field), via: viaOf(d) }
	}
	if (d.keep("flaggedEither")) {
		return { kind: "either", ifTrue: fixing(), ifFalse: fixing() }
	}
	return d.keep("flaggedSpread") ? { kind: "spread", p: fixing() } : undefined
}

/** A negation: no fact of a relation whose field holds a bound variable of its kind. */
const negationOver = (d: Drawing, bound: ReadonlyArray<Var>): ReadonlyArray<Pred> => {
	const pairs = Arr.flatMap(rels, (rel) =>
		Arr.flatMap(fieldsOf[rel], (f) =>
			Arr.flatMap(bound, (v) => (v.field.kind === f.kind ? [[rel, f.name, v] as const] : []))
		)
	)
	if (!Arr.isReadonlyArrayNonEmpty(pairs) || !d.keep("negation")) {
		return []
	}
	const [rel, field, v] = d.from(pairs)
	return [{ kind: "not", rel, field, t: varTerm(v) }]
}

/**
 * A conditional over a comparison, or a conjunction of two, whose branches are bound integers, constants or literals.
 */
const condOver = (d: Drawing, bound: ReadonlyArray<Var>, ints: ReadonlyArray<Var>): Term => {
	const first = comparisonOver(d, bound)
	const p: Pred = d.keep("conjunction")
		? { kind: "and", ps: [first, comparisonOver(d, bound)], via: viaOf(d) }
		: first
	const onTrue: Term =
		Arr.isReadonlyArrayNonEmpty(ints) && d.from([0, 1]) === 0
			? varTerm(d.from(ints))
			: { kind: "constant", of: "integer", value: 1 }
	const onFalse: Term =
		Arr.isReadonlyArrayNonEmpty(ints) && d.from([0, 1]) === 0
			? varTerm(d.from(ints))
			: literalOf(d, "int")
	return { kind: "cond", p, onTrue, onFalse }
}

/** Up to two distinct group terms over the bound variables. */
const groupsOver = (d: Drawing, bound: ReadonlyArray<Var>): ReadonlyArray<Var> => {
	if (!Arr.isReadonlyArrayNonEmpty(bound)) {
		return []
	}
	const groups: Array<Var> = []
	for (let i = 0; i < 2; i++) {
		const v = d.keep("groupTerm") ? d.from(bound) : undefined
		if (v !== undefined && !Arr.some(groups, (g) => sameVar(g, v))) {
			groups.push(v)
		}
	}
	return groups
}

/**
 * The folds a grouped head may hold beside its count: a sum, a least or greatest value, a mean, each over a bound
 * integer or Item.cost, a contract's, whose brand min and max keep.
 */
const foldsOver = (d: Drawing, bound: ReadonlyArray<Var>): ReadonlyArray<HeadTerm> => {
	const folded = Arr.filter(bound, (b) => b.field.kind === "int" || b.field.kind === "cents")
	if (!Arr.isReadonlyArrayNonEmpty(folded)) {
		return []
	}
	const of = (): Term => varTerm(d.from(folded))
	return [
		...(d.keep("sum") ? [{ kind: "fold", fold: "sum", of: of() } as const] : []),
		...(d.keep("minMax")
			? [{ kind: "fold", fold: d.from(["min", "max"] as const), of: of() } as const]
			: []),
		...(d.keep("mean") ? [{ kind: "fold", fold: "mean", of: of() } as const] : [])
	]
}

/**
 * The head: a grouped aggregate, or one to three fields of variables, computations, conditionals, literals and
 * parameters, each a parameter declared at a field's descriptor, which types it. Its fields are named by `prefix`.
 */
const headOver = (
	d: Drawing,
	bound: ReadonlyArray<Var>,
	prefix: "h" | "g"
): Arr.NonEmptyReadonlyArray<readonly [string, HeadTerm]> => {
	const ints = Arr.filter(bound, (b) => b.field.kind === "int")
	if (d.keep("aggregate")) {
		const groups = groupsOver(d, bound)
		const terms: Arr.NonEmptyReadonlyArray<HeadTerm> = [
			{ kind: "count" },
			...Arr.map(groups, (g): HeadTerm => ({ kind: "term", t: varTerm(g) })),
			...foldsOver(d, bound)
		]
		return Arr.map(terms, (t, i) => [`${prefix}${i}`, t] as const)
	}
	return Arr.map(Arr.range(0, d.from([0, 1, 2])), (i) => {
		const anywhere: ReadonlyArray<Form<HeadTerm>> = [
			["condHead", () => ({ kind: "term", t: condOver(d, bound, ints) })],
			["literalHead", () => ({ kind: "literal", value: d.from([0, 1, "a", "b"]) })],
			["constantHead", () => ({ kind: "term", t: handleOf(d) })],
			["paramHead", () => ({ kind: "term", t: d.param(d.from(fieldsOf.Item)) })]
		]
		const forms: Arr.NonEmptyReadonlyArray<Form<HeadTerm>> = Arr.isReadonlyArrayNonEmpty(bound)
			? [
					["headVar", () => ({ kind: "term", t: varTerm(d.from(bound)) })],
					...(Arr.isReadonlyArrayNonEmpty(ints)
						? [
								[
									"computedHead",
									(): HeadTerm => ({ kind: "term", t: computedOver(d, ints) })
								] as const
							]
						: []),
					...anywhere
				]
			: [["literalHead", () => ({ kind: "literal", value: d.from([0, 1, "a", "b"]) })], ...anywhere]
		return [`${prefix}${i}`, d.choose(forms)] as const
	})
}

/** A union's second arm: the first's, with its parameters renamed and, under a discriminant, each arm told apart. */
const secondArm = (arm: RuleSpec): RuleSpec => ({ ...arm, ...renamed(arm) })

const renamed = (
	arm: RuleSpec
): Pick<RuleSpec, "matches" | "filters" | "flagged" | "head" | "rows" | "owned"> => {
	const term = (t: Term): Term => {
		switch (t.kind) {
			case "param":
				return { ...t, name: `${t.name}b` }
			case "arith":
				return { ...t, a: term(t.a), b: term(t.b) }
			case "neg":
				return { ...t, a: term(t.a) }
			case "cond":
				return { ...t, p: pred(t.p), onTrue: term(t.onTrue), onFalse: term(t.onFalse) }
			case "var":
			case "literal":
			case "constant":
			case "handle":
				return t
		}
	}
	const pred = (p: Pred): Pred => {
		switch (p.kind) {
			case "cmp":
				return { ...p, a: term(p.a), b: term(p.b) }
			case "and":
			case "or":
				return { ...p, ps: [pred(p.ps[0]), pred(p.ps[1])] }
			case "not":
				return { ...p, t: term(p.t) }
		}
	}
	const head = (h: HeadTerm): HeadTerm => {
		switch (h.kind) {
			case "term":
				return { kind: "term", t: term(h.t) }
			case "fold":
				return { ...h, of: term(h.of) }
			case "literal":
			case "count":
				return h
		}
	}
	return {
		matches: Arr.map(arm.matches, (m) => ({
			...m,
			bindings: Arr.map(m.bindings, ([f, t]) => [f, term(t)] as const)
		})),
		filters: Arr.map(arm.filters, pred),
		flagged:
			arm.flagged === undefined
				? undefined
				: arm.flagged.kind === "either"
					? { kind: "either", ifTrue: pred(arm.flagged.ifTrue), ifFalse: pred(arm.flagged.ifFalse) }
					: { kind: "spread", p: pred(arm.flagged.p) },
		head: Arr.map(arm.head, ([n, h]) => [n, head(h)] as const),
		rows: arm.rows === undefined ? undefined : { ...arm.rows, name: `${arm.rows.name}b` },
		owned: Arr.map(arm.owned, (o) =>
			o.kind === "bound" ? { kind: "bound", owner: term(o.owner) } : o
		)
	}
}

const discriminated = (arm: RuleSpec, value: HeadTerm): RuleSpec => ({
	...arm,
	head: [...arm.head, ["d", value]]
})

/**
 * A union's two discriminants of Tone: the first arm's a handle, the second arm's a handle or its member's JavaScript
 * value, which the first arm's closed id types.
 */
const handleDiscriminants = (d: Drawing): readonly [HeadTerm, HeadTerm] => [
	{ kind: "term", t: { kind: "handle", value: 0 } },
	d.from([0, 1]) === 0
		? { kind: "term", t: { kind: "handle", value: 1 } }
		: { kind: "literal", value: toneOf(1) }
]

/** A union's two discriminants as JavaScript values. */
const literalDiscriminants: readonly [HeadTerm, HeadTerm] = [
	{ kind: "literal", value: "a" },
	{ kind: "literal", value: "b" }
]

/**
 * The query a drawing draws: a rule, a union of it with its renamed twin or with a rule of its own heading, and a take
 * that closes it. A handle discriminant is drawn first, so a case that keeps it is a discriminated union whatever the
 * union's own gates draw. A pinned self-join is no union's arm, so its get is proved whatever the rest of the case
 * draws. A union of two headings is discriminated, its second arm's fields named apart from the first's, but where the
 * case plants unionTypes, which names them as the first's. A faulted case's query is one rule, so its fault stands
 * once, but for unionTypes, whose fault is its second arm.
 */
const drawQuery = (d: Drawing): QuerySpec => {
	const { rule: first, pinned } = drawRule(d, "h", "rows")
	const plain = d.fault === "clean" && !pinned
	const handled = plain && d.keep("handleDiscriminant")
	if (handled) {
		d.note("union")
		d.note("discriminant")
	}
	const heterogeneous = d.fault === "unionTypes" || (plain && d.keep("heterogeneous"))
	const union = handled || heterogeneous || (plain && d.keep("union"))
	const tagged = handled
		? handleDiscriminants(d)
		: heterogeneous || (union && d.keep("discriminant"))
			? literalDiscriminants
			: undefined
	const second = (): RuleSpec =>
		heterogeneous
			? drawRule(d, d.fault === "unionTypes" ? "h" : "g", "rowsb").rule
			: secondArm(first)
	const arms: Arr.NonEmptyReadonlyArray<RuleSpec> = union
		? tagged !== undefined
			? [discriminated(first, tagged[0]), discriminated(second(), tagged[1])]
			: [first, second()]
		: [first]
	const take =
		!heterogeneous && d.keep("take")
			? d.keep("namedTake")
				? "k"
				: d.from([1, 2] as const)
			: undefined
	return { arms, take, fault: d.fault }
}

const uuidOf = (value: number): string =>
	`00000000-0000-4000-8000-${pipe(String(value), Str.padStart(12, "0"))}`

/** The words that name the second and third scope of one source in a rule. */
const ordinals = ["second", "third"] as const

/**
 * A variable's scope name, which the program also declares its variables under: its source's name in lower camel case
 * for the first match of it, prefixed by the ordinal of its match after that, as a reader would name two scopes of one
 * relation by role.
 */
const scopeOf = (v: Var): string =>
	v.copy === 0
		? Str.uncapitalize(v.field.rel)
		: `${defined(ordinals[v.copy - 1], "a third match at most")}${v.field.rel}`

/** The name a bound Owned of a scope is declared under. */
const boundName = (scope: string): string => `${scope}Source`

/** The name a rule's relation parameter is declared under. */
const rowsConst = "rowsParam"

/** The scope Owned's `copy`-th match mints its variables in. */
const ownedScope = (copy: number): string => scopeOf({ field: fieldsOf.Owned[0], copy })

/** A line of a rendered query, and whether it is the line its planted fault's diagnostic is on. */
interface Line {
	readonly text: string
	readonly fault: boolean
}

/** The source of one query, its lines marking the one its planted fault's diagnostic is on. */
class Rendering {
	readonly #fault: Planted

	constructor(fault: Planted) {
		this.#fault = fault
	}

	term(t: Term): string {
		switch (t.kind) {
			case "var":
				return `${scopeOf(t.v)}.${t.v.field.name}`
			case "param":
				return `r.param(${jsonText(t.name)}, Item.fields.${t.at.name})`
			case "literal":
				return t.type === "int"
					? String(t.value)
					: jsonText(t.type === "uuid" ? uuidOf(t.value) : toneOf(t.value))
			case "constant":
				if (t.of === "cents") {
					return `Compute.literal(Cents, ${t.value}n)`
				}
				return `Compute.literal(pg.integer, ${t.value})`
			case "handle":
				return `Tone.handle(${jsonText(toneOf(t.value))})`
			case "arith":
				return `Compute.${t.op}(${this.term(t.a)}, ${this.term(t.b)})`
			case "neg":
				return `Compute.neg(${this.term(t.a)})`
			case "cond":
				return `Compute.cond(${this.pred(t.p)}, ${this.term(t.onTrue)}, ${this.term(t.onFalse)})`
		}
	}

	pred(p: Pred): string {
		if (p.kind === "not") {
			return `r.not(${p.rel}, { ${p.field}: ${this.term(p.t)} })`
		}
		const callee = p.via === "rule" ? "r" : "Compute"
		return p.kind === "cmp"
			? `${callee}.${p.op}(${this.term(p.a)}, ${this.term(p.b)})`
			: `${callee}.${p.kind}(${this.pred(p.ps[0])}, ${this.pred(p.ps[1])})`
	}

	head(h: HeadTerm): string {
		switch (h.kind) {
			case "term":
				return this.term(h.t)
			case "literal":
				return jsonText(h.value)
			case "count":
				return "r.count()"
			case "fold":
				return `r.${h.fold}(${this.term(h.of)})`
		}
	}

	/** A scope's v call: over its source, named as its spelling says. */
	scope(v: Var, arm: RuleSpec): string {
		const scope = scopeOf(v)
		const spelling = Option.getOrElse(
			Option.map(
				Arr.findFirst(arm.spellings, ([s]) => s === scope),
				([, s]) => s
			),
			(): Spelling => ({ kind: "literal", name: scope })
		)
		const over = sourceText(v.field.rel, v.copy, arm)
		switch (spelling.kind) {
			case "literal":
				return `v(${over}, ${jsonText(spelling.name)})`
			case "omitted":
				return `v(${over})`
			case "widened":
				return `v(${over}, anyName)`
		}
	}

	/** One arm's lines: its `.rule(` line, its declarations, its body, and its close. */
	rule(arm: RuleSpec, second: boolean): ReadonlyArray<Line> {
		const matches = Arr.map(arm.matches, (m) => {
			const bindings = Arr.map(m.bindings, ([f, t]) => `${f}: ${this.term(t)}`)
			const record = Arr.isReadonlyArrayNonEmpty(bindings)
				? `{ ${Arr.join(bindings, ", ")} }`
				: "{}"
			return `.match(${sourceText(m.rel, m.copy, arm)}, ${record})`
		})
		const flagged =
			arm.flagged === undefined
				? []
				: arm.flagged.kind === "either"
					? [`flag ? ${this.pred(arm.flagged.ifTrue)} : ${this.pred(arm.flagged.ifFalse)}`]
					: [`...Arr.filter([${this.pred(arm.flagged.p)}], () => flag)`]
		const predicates = [...Arr.map(arm.filters, (p) => this.pred(p)), ...flagged]
		const filters = Arr.isReadonlyArrayNonEmpty(predicates)
			? [`.where(${Arr.join(predicates, ", ")})`]
			: []
		const head = `.find({ ${Arr.join(
			Arr.map(arm.head, ([n, h]) => `${n}: ${this.head(h)}`),
			", "
		)} })`
		const body = `r${Arr.join([...matches, ...filters, head], "")}`
		const variables = variablesOf(arm)
		const rows: ReadonlyArray<Line> =
			arm.rows === undefined
				? []
				: [
						{
							text: `\t\tconst ${rowsConst} = r.relation(${jsonText(arm.rows.name)}, ${this.heading(arm.rows.heading)})`,
							fault: this.#fault === "emptyRelation"
						}
					]
		const declare = (vs: ReadonlyArray<Var>): ReadonlyArray<Line> =>
			Arr.map(scopesOf(vs), (v) => ({
				text: `\t\tconst ${scopeOf(v)} = ${this.scope(v, arm)}`,
				fault: Arr.some(arm.spellings, ([s]) => s === scopeOf(v))
			}))
		const owned: ReadonlyArray<Line> = Arr.flatMap(arm.owned, (bind, copy) =>
			bind.kind === "bound"
				? [
						{
							text: `\t\tconst ${boundName(ownedScope(copy))} = Owned.bind({ owner: ${this.term(bind.owner)} })`,
							fault: false
						}
					]
				: []
		)
		const returned: Line = {
			text: `\t\treturn ${body}`,
			fault: !second && returnFaults.has(this.#fault)
		}
		return [
			{ text: "\t.rule((r) => {", fault: second && this.#fault === "unionTypes" },
			...rows,
			...declare(Arr.filter(variables, (v) => v.field.rel !== "Owned")),
			...owned,
			...declare(Arr.filter(variables, (v) => v.field.rel === "Owned")),
			returned,
			{ text: "\t})", fault: false }
		]
	}

	/** A relation parameter's heading: its fields' descriptors, by name. */
	heading(fields: ReadonlyArray<Field>): string {
		const entries = Arr.map(fields, (f) => {
			switch (f.kind) {
				case "uuid":
					return `${f.name}: uuid`
				case "int":
					return `${f.name}: pg.integer`
				case "code":
				case "cents":
					return `${f.name}: Item.fields.${itemField(f.kind).name}`
			}
		})
		return Arr.isReadonlyArrayNonEmpty(entries) ? `{ ${Arr.join(entries, ", ")} }` : "{}"
	}

	query(spec: QuerySpec): Arr.NonEmptyReadonlyArray<Line> {
		const arms = Arr.flatMap(spec.arms, (arm, i) => this.rule(arm, i > 0))
		const take =
			spec.take === undefined
				? []
				: [
						{ text: `\t.orderBy([${jsonText(orderedBy(spec))}, "asc"])`, fault: false },
						{ text: `\t.take(${jsonText(spec.take)})`, fault: false }
					]
		return [{ text: "query(Agree)", fault: false }, ...arms, ...take]
	}
}

/**
 * What a match of `rel` reads in the program, its `copy`-th of it: a relation's name, the rule's declared relation
 * parameter, Owned's binding under that match, or Owned itself where that match leaves it unbound.
 */
const sourceText = (rel: MatchSource, copy: number, arm: RuleSpec): string => {
	switch (rel) {
		case "Rows":
			return rowsConst
		case "Owned": {
			const bind = arm.owned[copy]
			return bind === undefined || bind.kind === "unbound" ? "Owned" : boundName(ownedScope(copy))
		}
		case "Item":
		case "Tag":
		case "Note":
		case "Stray":
		case "Tones":
			return rel
	}
}

/** The faults whose diagnostic is on the first arm's return line: a binding's, a match's or a fold's. */
const returnFaults: ReadonlySet<Planted> = new Set<Planted>([
	"stranger",
	"stray",
	"unkeyedFold",
	"unboundImport"
])

/**
 * The field a take orders by: the first head field, which every arm of a union of one heading delivers, and whose
 * order the take completes by the rest of the heading, a key of each arm.
 */
const orderedBy = (spec: QuerySpec): string => spec.arms[0].head[0][0]

/** The variables of each scope, one per scope, in their order. */
const scopesOf = (vs: ReadonlyArray<Var>): ReadonlyArray<Var> => {
	const seen = new Map<string, Var>()
	for (const v of vs) {
		if (!seen.has(scopeOf(v))) {
			seen.set(scopeOf(v), v)
		}
	}
	return [...seen.values()]
}

/** Every variable an arm reads, in the order of first use, an Owned binding's owner first. */
const variablesOf = (arm: RuleSpec): ReadonlyArray<Var> => {
	const seen = new Map<string, Var>()
	const term = (t: Term): void => {
		switch (t.kind) {
			case "var": {
				const key = `${scopeOf(t.v)}.${t.v.field.name}`
				if (!seen.has(key)) {
					seen.set(key, t.v)
				}
				return
			}
			case "arith":
				term(t.a)
				term(t.b)
				return
			case "neg":
				term(t.a)
				return
			case "cond":
				pred(t.p)
				term(t.onTrue)
				term(t.onFalse)
				return
			case "param":
			case "literal":
			case "constant":
			case "handle":
				return
		}
	}
	const pred = (p: Pred): void => {
		switch (p.kind) {
			case "cmp":
				term(p.a)
				term(p.b)
				return
			case "and":
			case "or":
				pred(p.ps[0])
				pred(p.ps[1])
				return
			case "not":
				term(p.t)
				return
		}
	}
	for (const bind of arm.owned) {
		if (bind.kind === "bound") {
			term(bind.owner)
		}
	}
	for (const m of arm.matches) {
		for (const [, t] of m.bindings) {
			term(t)
		}
	}
	for (const p of [...arm.filters, ...flaggedPreds(arm.flagged)]) {
		pred(p)
	}
	for (const [, h] of arm.head) {
		if (h.kind === "term") {
			term(h.t)
		}
		if (h.kind === "fold") {
			term(h.of)
		}
	}
	return [...seen.values()]
}

/** The predicates a flagged filter may hold. */
const flaggedPreds = (flagged: Flagged | undefined): ReadonlyArray<Pred> =>
	flagged === undefined
		? []
		: flagged.kind === "either"
			? [flagged.ifTrue, flagged.ifFalse]
			: [flagged.p]

/**
 * A spec under each value its flags may take: the spec itself where no rule states a flagged filter, and otherwise
 * the spec with every flagged filter resolved as the flag's true, and as its false, each a plain filter or none.
 */
const flagVariants = (spec: QuerySpec): Arr.NonEmptyReadonlyArray<QuerySpec> => {
	const resolved = (flag: boolean): QuerySpec => ({
		...spec,
		arms: Arr.map(spec.arms, (arm) => {
			const f = arm.flagged
			const extra: ReadonlyArray<Pred> =
				f === undefined
					? []
					: f.kind === "either"
						? [flag ? f.ifTrue : f.ifFalse]
						: flag
							? [f.p]
							: []
			return { ...arm, filters: [...arm.filters, ...extra], flagged: undefined }
		})
	})
	return Arr.some(spec.arms, (arm) => arm.flagged !== undefined)
		? [resolved(true), resolved(false)]
		: [spec]
}

/** The rule a spec's arm states, built through the query builder's JavaScript view, as the engine compiles it. */
const builtArm =
	(arm: RuleSpec) =>
	(r: RuleValue): unknown => {
		const rows =
			arm.rows === undefined
				? undefined
				: r.relation(
						arm.rows.name,
						Rec.fromEntries(Arr.map(arm.rows.heading, (f) => [f.name, rowsDescriptor(f)] as const))
					)
		const minted = new Map<string, Readonly<Record<string, unknown>>>()
		const bound = new Map<number, unknown>()
		const sourceOf = (rel: MatchSource, copy: number): unknown => {
			switch (rel) {
				case "Rows":
					return rows
				case "Owned":
					return bound.get(copy) ?? ownedImport
				case "Item":
				case "Tag":
				case "Note":
				case "Stray":
				case "Tones":
					return relations[rel]
			}
		}
		const variable = (v: Var): unknown => {
			const scope = scopeOf(v)
			const spelling = Option.map(
				Arr.findFirst(arm.spellings, ([s]) => s === scope),
				([, s]) => s
			)
			const name =
				Option.isSome(spelling) && spelling.value.kind === "omitted"
					? undefined
					: scopeName(spelling, scope)
			const vars = minted.get(scope) ?? varsOver(sourceOf(v.field.rel, v.copy), name)
			minted.set(scope, vars)
			return vars[v.field.name]
		}
		const term = (t: Term): unknown => {
			switch (t.kind) {
				case "var":
					return variable(t.v)
				case "param":
					return r.param(t.name, descriptors[t.at.name])
				case "literal":
					return t.type === "int" ? t.value : t.type === "uuid" ? uuidOf(t.value) : toneOf(t.value)
				case "constant":
					return t.of === "cents"
						? computeCore.literal(Cents, BigInt(t.value))
						: computeCore.literal(pg.integer, t.value)
				case "handle":
					return Tone.handle(toneOf(t.value))
				case "arith": {
					const a = term(t.a)
					const b = term(t.b)
					return t.op === "add"
						? computeCore.add(a, b)
						: t.op === "sub"
							? computeCore.sub(a, b)
							: computeCore.mul(a, b)
				}
				case "neg":
					return computeCore.neg(term(t.a))
				case "cond":
					return computeCore.cond(pred(t.p), term(t.onTrue), term(t.onFalse))
			}
		}
		const pred = (p: Pred): unknown => {
			if (p.kind === "not") {
				return r.not(relations[p.rel], { [p.field]: term(p.t) })
			}
			if (p.kind !== "cmp") {
				const [x, y] = [pred(p.ps[0]), pred(p.ps[1])]
				return p.via === "rule"
					? p.kind === "and"
						? r.and(x, y)
						: r.or(x, y)
					: p.kind === "and"
						? computeCore.and(x, y)
						: computeCore.or(x, y)
			}
			const a = term(p.a)
			const b = term(p.b)
			const compare = p.via === "rule" ? r : computeCore
			switch (p.op) {
				case "eq":
					return compare.eq(a, b)
				case "ne":
					return compare.ne(a, b)
				case "lt":
					return compare.lt(a, b)
				case "ge":
					return compare.ge(a, b)
			}
		}
		const head = (h: HeadTerm): unknown => {
			switch (h.kind) {
				case "term":
					return term(h.t)
				case "literal":
					return h.value
				case "count":
					return r.count()
				case "fold":
					return r[h.fold](term(h.of))
			}
		}
		for (const [copy, bind] of arm.owned.entries()) {
			if (bind.kind === "bound") {
				bound.set(copy, ownedImport.bind({ owner: term(bind.owner) }))
			}
		}
		const matched = Arr.reduce(arm.matches, r, (rule, m) =>
			rule.match(
				sourceOf(m.rel, m.copy),
				Rec.fromEntries(Arr.map(m.bindings, ([f, t]) => [f, term(t)] as const))
			)
		)
		const filtered = Arr.isReadonlyArrayNonEmpty(arm.filters)
			? matched.where(...argumentsOf(Arr.map(arm.filters, pred)))
			: matched
		return filtered.find(Rec.fromEntries(Arr.map(arm.head, ([n, h]) => [n, head(h)] as const)))
	}

/** The name a scope's v call passes: its spelling's literal, or the scope's own name, the value a `string` holds. */
const scopeName = (spelling: Option.Option<Spelling>, scope: string): string =>
	Option.isSome(spelling) && spelling.value.kind === "literal" ? spelling.value.name : scope

/** A relation parameter field's descriptor: the one its heading states it at. */
const rowsDescriptor = (f: Field): unknown => {
	switch (f.kind) {
		case "uuid":
			return uuid
		case "int":
			return pg.integer
		case "code":
		case "cents":
			return descriptors[itemField(f.kind).name]
	}
}

/** The query a spec states, built through the query builder's JavaScript view, as the engine compiles it. */
const built = (spec: QuerySpec): unknown => {
	const [first, ...rest] = Arr.map(spec.arms, builtArm)
	const union = Arr.reduce(rest, queryOver(Agree).rule(first), (q, arm) => q.rule(arm))
	return spec.take === undefined ? union : union.orderBy([orderedBy(spec), "asc"]).take(spec.take)
}

/**
 * What the engine proves of a query's root: whether get may read it, its cardinality, and its minimal keys, each over
 * its classes of equal columns (ir/keys.ts keyClasses): one column of each class, together, are a key. Each class is in
 * name order, and a key's classes by their first names. And the query as the types see it: its records, the decoded
 * record of each heading group, and its parameters, as ./heading.ts writes them.
 */
interface Proved {
	readonly get: boolean
	readonly card: Card
	/** The keys of each reading of the query, one where it states no flagged filter, two where it does. */
	readonly keys: Arr.NonEmptyReadonlyArray<ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>>
	readonly head: string
	readonly params: string
}

/** What the program states of a query the types must refuse: its diagnostic, and the refusal or prose it names. */
interface Refused {
	readonly code: "TS2322" | "TS2345" | "TS2554"
	readonly claim:
		| { readonly kind: "refusal"; readonly refusal: TypeRefusal }
		| { readonly kind: "prose"; readonly reason: string }
}

/** The engine's verdict on a drawn query: what it proves of one it compiles, or the refusal its reason is. */
type Verdict =
	| { readonly kind: "admitted"; readonly proved: Proved }
	| { readonly kind: "refused"; readonly refused: Refused }

/**
 * A claimed key over its classes, each key column with the columns its members state equal to it, each class in name
 * order, the classes by their first names.
 */
const classesInNameOrder = (k: ClaimedKey): ReadonlyArray<ReadonlyArray<string>> => {
	const members = claimedMembers(k)
	return Arr.sort(
		Arr.map(claimedColumns(k), (column) =>
			Arr.sort(
				[column, ...Arr.flatMap(members, (m) => (m.of === column ? [m.column] : []))],
				Str.Order
			)
		),
		Arr.makeOrder(Str.Order)
	)
}

/** A refusal the types name, under its diagnostic. */
const named = (code: Refused["code"], refusal: TypeRefusal): Refused => ({
	code,
	claim: { kind: "refusal", refusal }
})

/**
 * The refusal the types state where the engine refuses a case's planted fault: the engine's reason must be the fault's
 * site's (its tag, and the builder call or field it names), and the refusal is the one the types name for that site.
 * A reason at no site of the case's fault is the generator's defect: undefined.
 */
const refusalOf = (fault: Planted, reason: CompileReason): Refused | undefined => {
	const label = "at" in reason && "label" in reason.at ? reason.at.label : ""
	const malformed = reason._tag === "MalformedDescription"
	switch (fault) {
		case "scopeName":
			return malformed && label === "v"
				? named("TS2345", "a declared name: ASCII letters, digits and underscores, a letter first")
				: undefined
		case "unnamedScope":
			return malformed && label === "v"
				? {
						code: "TS2554",
						claim: { kind: "prose", reason: "v takes the scope's name beside its source" }
					}
				: undefined
		case "stranger":
			return malformed && Str.startsWith("r.match(")(label)
				? named("TS2322", "not a field of the arms the bindings select")
				: undefined
		case "stray":
			return malformed && label === "r.match(Stray)"
				? named("TS2345", "the relation is not in this query's schema")
				: undefined
		case "unkeyedFold":
			return reason._tag === "FoldOverProjection"
				? named(
						"TS2322",
						"a fold reads each fact it matches once, by a key: bind a key of every source the rule matches, or match a query of the distinct values"
					)
				: undefined
		case "unionTypes":
			return malformed &&
				(Str.startsWith("union field ")(label) ||
					(label === "query.rule" && "path" in reason.at && reason.at.path[0] === "arms"))
				? named("TS2345", "a union's arms deliver each field at one type")
				: undefined
		case "emptyRelation":
			return malformed && Str.startsWith("r.relation(")(label)
				? named("TS2345", "a relation parameter has at least one field, as a relation does")
				: undefined
		case "unboundImport":
			return malformed && "path" in reason.at && reason.at.path[0] === "bindings"
				? named("TS2345", "bind the query's parameters before matching it: Q.bind({ ... })")
				: undefined
		case "clean":
		case "widenedName":
			return undefined
	}
}

/** The refusal of a scope's name spelled through a `string`, which no engine sees (see the header). */
const widened: Refused = named("TS2345", "one literal name")

/**
 * The records of each arm, as its decoded heading group, the union of them the query's records: one member per arm,
 * since each arm's records are a type of their own, however alike two arms' are.
 */
const headOf = (spec: QuerySpec): string =>
	Arr.join(
		Arr.map(spec.arms, (arm) => {
			const q: QueryValue = queryOver(Agree).rule(builtArm(arm))
			const template = compileTemplate(q, undefined, testCompile)
			if (!template.ok) {
				throw new Error(
					`the engine refuses an arm of a query it compiles: ${messageOf(template.error)}`
				)
			}
			const keys = defined(q.rows.headings[0], "an arm's one heading group")
			return recordType(groupFields(keys, q.heading, template.value.heading))
		}),
		" | "
	)

/** The cardinality both readings of a flagged rule hold: the one they share, else at most one where each is, else many. */
const meetCard = (cards: Arr.NonEmptyReadonlyArray<Card>): Card =>
	Arr.every(cards, (c) => c === cards[0])
		? cards[0]
		: Arr.every(cards, (c) => c !== "many")
			? "atMostOne"
			: "many"

const verdictOf = (spec: QuerySpec, source: string): Verdict => {
	const failed = (what: string): never => {
		throw new Error(
			`the engine refuses a drawn query at no site of its fault (${spec.fault}), a defect of the generator: ${what}\n${source}`
		)
	}
	const variants = flagVariants(spec)
	const compiled = Arr.map(variants, (variant) =>
		Result.flatMap(
			catchCompileError(() => built(variant)),
			(q) => compileTemplate(q, undefined, testCompile)
		)
	)
	const templates: Array<QueryTemplate> = []
	for (const template of compiled) {
		if (!template.ok) {
			const refused = refusalOf(spec.fault, template.error.reason)
			return refused === undefined
				? failed(messageOf(template.error))
				: { kind: "refused", refused }
		}
		templates.push(template.value)
	}
	const [first, ...rest] = templates
	if (first === undefined) {
		return failed("no reading of the query")
	}
	if (
		spec.fault === "widenedName" &&
		Arr.some(spec.arms, (arm) => Arr.isReadonlyArrayNonEmpty(arm.spellings))
	) {
		return { kind: "refused", refused: widened }
	}
	const all: Arr.NonEmptyReadonlyArray<QueryTemplate> = [first, ...rest]
	const roots = Arr.map(all, (t) => t.analyzed.roots[0])
	const params = Arr.reduce(
		Arr.flatMap(all, (t) => t.params),
		[],
		(kept: ReadonlyArray<ParamDecl>, p): ReadonlyArray<ParamDecl> =>
			Arr.some(kept, (k) => k.name === p.name) ? kept : [...kept, p]
	)
	return {
		kind: "admitted",
		proved: {
			get: Arr.every(roots, (root) => requireGet(root, SourceLoc("agreement", [])).ok),
			card: meetCard(Arr.map(roots, (root) => root.meta.card)),
			keys: Arr.map(roots, (root) => Arr.map(root.meta.logicalKeys, classesInNameOrder)),
			head: headOf(variants[0]),
			params: paramsType(params)
		}
	}
}

/**
 * One drawn query: its source's lines, the engine's verdict, which the program asserts of the types exactly, a
 * self-join's included, and what it reached.
 */
interface AgreementCase {
	readonly spec: QuerySpec
	readonly lines: Arr.NonEmptyReadonlyArray<Line>
	readonly source: string
	readonly verdict: Verdict
	readonly notes: ReadonlySet<AgreementNote | FaultNote>
}

/** A drawn query and the constructs its drawing reached. */
interface Drawn {
	readonly spec: QuerySpec
	readonly reached: ReadonlySet<AgreementFeature>
}

/** One query planting `fault`: the case's swarm over the constructs, then the query under it. */
const drawnGen =
	(fault: Planted): Gen<Drawn> =>
	(source) => {
		const d = new Drawing(source, source.draw(swarm(agreementFeatures)), fault)
		return { spec: drawQuery(d), reached: d.reached }
	}

const caseOf = ({ spec, reached }: Drawn): AgreementCase => {
	const rendering = new Rendering(spec.fault)
	const lines = rendering.query(spec)
	const source = Arr.join(
		Arr.map(lines, (l) => l.text),
		"\n"
	)
	const verdict = verdictOf(spec, source)
	const notes = new Set<AgreementNote | FaultNote>(reached)
	if (spec.fault !== "clean") {
		notes.add(verdict.kind === "refused" ? `${spec.fault} refused` : `${spec.fault} admitted`)
	}
	if (verdict.kind === "admitted") {
		const heading = Arr.length(spec.arms[0].head)
		notes.add(verdict.proved.get ? "get proved" : "get refused")
		if (Arr.some(verdict.proved.keys[0], (k) => k.length < heading)) {
			notes.add("a key below the heading")
		}
		if (Str.includes("Brand.Brand")(verdict.proved.head)) {
			notes.add("a contract in the head")
		}
	}
	if (Arr.some(spec.arms, fixedTwice)) {
		notes.add("a variable two filters fix")
	}
	return { spec, lines, source, verdict, notes }
}

/**
 * The variables a filter fixes: one an equality compares with a value fixed per binding, a parameter or a constant, and
 * each a conjunction's operands fix; a disjunction fixes none.
 */
const fixedBy = (p: Pred): ReadonlyArray<string> => {
	switch (p.kind) {
		case "cmp": {
			const fixedWith = (v: Term, other: Term): ReadonlyArray<string> =>
				v.kind === "var" &&
				(other.kind === "param" ||
					other.kind === "literal" ||
					other.kind === "constant" ||
					other.kind === "handle")
					? [`${scopeOf(v.v)}.${v.v.field.name}`]
					: []
			return p.op === "eq" ? [...fixedWith(p.a, p.b), ...fixedWith(p.b, p.a)] : []
		}
		case "and":
			return [...fixedBy(p.ps[0]), ...fixedBy(p.ps[1])]
		case "or":
		case "not":
			return []
	}
}

/** Whether two of a rule's filters fix one variable: to two values, which are one wherever the rule has a row. */
const fixedTwice = (arm: RuleSpec): boolean => {
	const fixed = Arr.flatMap(arm.filters, fixedBy)
	return new Set(fixed).size < fixed.length
}

/** A predicate with every conjunction's and disjunction's operands in the other order. */
const swapped = (p: Pred): Pred =>
	p.kind === "cmp" || p.kind === "not" ? p : { ...p, ps: [swapped(p.ps[1]), swapped(p.ps[0])] }

/** A query with each rule's filters, and every connective's operands, in the other order. */
const reordered = (spec: QuerySpec): QuerySpec => ({
	...spec,
	arms: Arr.map(spec.arms, (arm) => ({
		...arm,
		filters: Arr.reverse(Arr.map(arm.filters, swapped))
	}))
})

/** A verdict as text: whether get reads the query, and its keys as a set; a refusal as its claim. */
const verdictText = (v: Verdict): string => {
	switch (v.kind) {
		case "admitted":
			return `get ${v.proved.get ? "proved" : "refused"}, keys ${jsonText(
				Arr.map(v.proved.keys, (keys) =>
					Arr.sort(
						Arr.map(keys, (k) => jsonText(k)),
						Str.Order
					)
				)
			)}`
		case "refused":
			return `refused, ${v.refused.code} ${v.refused.claim.kind === "refusal" ? v.refused.claim.refusal : v.refused.claim.reason}`
	}
}

/** The queries the run's own stream draws. */
export const agreementCount = 240

/** The faulted queries the run's own stream draws, and the floor's witnesses of each fault. */
export const faultCount = 72

/** The label both clean populations are drawn under. */
const agreementLabel = "types/evidence agreement"

/** The label both faulted populations are drawn under. */
const faultLabel = "types/evidence agreement faults"

/** One case: a drawn query and what the engine says of it. */
const caseGen: Gen<AgreementCase> = (source) => caseOf(drawnGen("clean")(source))

/** One faulted case: a fault drawn among every fault, then a query planting it. */
const faultGen: Gen<AgreementCase> = (source) =>
	caseOf(drawnGen(source.draw(element(agreementFaults)))(source))

/** What a case reached: its notes, and each required pair of them it notes together (agreementPairs). */
const reachedBy = (c: AgreementCase): ReadonlyArray<Reached<AgreementNote | FaultNote>> => [
	...c.notes,
	...Arr.filter(agreementPairs, ([a, b]) => c.notes.has(a) && c.notes.has(b))
]

/**
 * The floor's witnesses: a quarter of the run's count, drawn under the label alone, the same in every run, and the only
 * cases whose constructs and verdicts meet the required situations (test/types/evidence/agreement.test.ts).
 */
export const agreementWitnesses = () =>
	floorPopulation(agreementLabel, caseGen, agreementCount / 4, reachedBy)

/** The faulted population's witnesses: as many as its run's stream draws, the same in every run. */
export const faultWitnesses = () => floorPopulation(faultLabel, faultGen, faultCount, reachedBy)

/**
 * Every case a population's program holds: the floor's witnesses, then the stream of its label under the run's seed
 * (`TEST_SEED`, or the seed the run drew), so every process of one run draws the same cases and every run new ones.
 */
const agreementCases = (seed: number): ReadonlyArray<AgreementCase> => [
	...agreementWitnesses().values,
	...sample(caseGen, rotatingSeed(seed, floorSeed(agreementLabel)), agreementCount)
]

const faultCases = (seed: number): ReadonlyArray<AgreementCase> => [
	...faultWitnesses().values,
	...sample(faultGen, rotatingSeed(seed, floorSeed(faultLabel)), faultCount)
]

/**
 * The run's cases whose verdict moves when each rule's filters are written in the other order (reordered): none, since
 * the order of a rule's filters is no part of what it means, so a value two filters fix a variable to is one value
 * whichever comes first. Each is its source with its two verdicts.
 */
export const reorderedVerdicts = (seed: number): ReadonlyArray<string> =>
	Arr.flatMap([...agreementCases(seed), ...faultCases(seed)], (c) => {
		const moved = verdictOf(reordered(c.spec), c.source)
		return verdictText(moved) === verdictText(c.verdict)
			? []
			: [`${c.source}\n  as written: ${verdictText(c.verdict)}\n  reordered: ${verdictText(moved)}`]
	})

/** The refusal db.get's type names for a query not proved at most one row per binding (adapter/types/db.ts). */
const getRefusal = "get needs a query proved at most one row per parameter binding"

/** The modules the program imports, each spelled as an import specifier relative to the program's directory. */
export interface AgreementEntries {
	readonly query: string
	readonly compute: string
	readonly fields: string
	readonly db: string
	readonly errors: string
	readonly phantom: string
	readonly declare: string
	readonly schema: string
}

/** The engine's keys as a type: each a tuple of its classes, each class the union of its columns' names. */
const keysType = (keys: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>): string =>
	Arr.isReadonlyArrayNonEmpty(keys)
		? Arr.join(
				Arr.map(
					keys,
					(k) =>
						`readonly [${Arr.join(
							Arr.map(k, (members) =>
								Arr.join(
									Arr.map(members, (c) => jsonText(c)),
									" | "
								)
							),
							", "
						)}]`
				),
				" | "
			)
		: "never"

/** The modules the program imports, spelled by `entry` relative to the program's directory (test/types/batch). */
export const agreementEntriesFrom = (entry: (path: string) => string): AgreementEntries => ({
	query: entry("packages/engine/src/public/query.ts"),
	compute: entry("packages/engine/src/public/compute.ts"),
	fields: entry("packages/engine/src/public/fields.ts"),
	db: entry("packages/grizzle/src/adapter/types/db.ts"),
	errors: entry("packages/grizzle/src/adapter/errors/execution.ts"),
	phantom: entry("packages/engine/src/types/core/phantom.ts"),
	declare: entry("packages/engine/src/public/schema.ts"),
	schema: entry("test/support/agreement/schema.ts")
})

/**
 * The program over the run's cases, as five modules:
 * - index.ts, every clean case's query in the drawn order, the get the types must accept or refuse (a refusal under its
 *   directive, which the type-test batch disarms), the assertion that every key the types claim lies over one the
 *   engine proves, and its records, parameters, cardinality and reads asserted the engine's;
 * - order.ts, the same in a second order drawn from the run's stream;
 * - invariance.ts, every query's head and keys asserted equal across the two;
 * - admission.ts, the admission agreement over every position and constant kind (./admission.ts), its constants drawn
 *   from the run's stream, and over every combinator on every shape of query;
 * - faults.ts, every faulted case: a refused one under the directive of its refusal, at its fault's site, an admitted
 *   one asserted as a clean one is.
 */
export const agreementModules = (
	entries: AgreementEntries,
	seed: number
): Arr.NonEmptyReadonlyArray<{ readonly file: string; readonly source: string }> => {
	const cases = agreementCases(seed)
	const indices = Arr.map(cases, (_c, i) => i)
	const order = defined(
		sample(
			shuffled(indices, { min: indices.length, max: indices.length }),
			rotatingSeed(seed, floorSeed(`${agreementLabel} order`)),
			1
		)[0],
		"the second order"
	)
	const picks = defined(
		sample(
			array(int(0, 5), { min: admissionSize, max: admissionSize }),
			rotatingSeed(seed, floorSeed(`${agreementLabel} admission`)),
			1
		)[0],
		"the admission matrix's picks"
	)
	const cells: ReadonlyArray<AdmissionCell> = admissionCells((cell) =>
		defined(picks[cell], "a pick per cell of the matrix")
	)
	const faulted = faultCases(seed)
	return [
		{ file: "index.ts", source: programOf(entries, cases, indices) },
		{ file: "order.ts", source: programOf(entries, cases, order) },
		{ file: "invariance.ts", source: invarianceOf(entries, cases) },
		{ file: "admission.ts", source: admissionModule(entries, cells, combinatorCells()) },
		{
			file: "faults.ts",
			source: programOf(
				entries,
				faulted,
				Arr.map(faulted, (_c, i) => i)
			)
		}
	]
}

/** Every query's head and keys equal in the two orders' modules. */
const invarianceOf = (entries: AgreementEntries, cases: ReadonlyArray<AgreementCase>): string =>
	Arr.join(
		[
			"// Generated by test/support/agreement/queries.ts: the evidence is the same whatever the statements' order.",
			`import type { EvidenceOfQuery, HeadOf } from ${jsonText(entries.query)}`,
			'import type * as A from "./index.ts"',
			'import type * as B from "./order.ts"',
			"type Equals<X, Y> = (<Z>() => Z extends X ? 1 : 2) extends <Z>() => Z extends Y ? 1 : 2 ? true : false",
			"type Expect<T extends true> = T",
			...Arr.map(
				cases,
				(_c, i) =>
					`export type o${i} = [Expect<Equals<HeadOf<typeof A.q${i}>, HeadOf<typeof B.q${i}>>>, Expect<Equals<EvidenceOfQuery<typeof A.q${i}>["keys"], EvidenceOfQuery<typeof B.q${i}>["keys"]>>]`
			),
			""
		],
		"\n"
	)

/** The statements of one case: its query, under its fault's directive where the engine refuses it, and its verdicts. */
const blockOf = (c: AgreementCase, i: number): ReadonlyArray<string> => {
	const [first, ...rest] = c.lines
	const lines = [{ text: `export const q${i} = ${first.text}`, fault: first.fault }, ...rest]
	switch (c.verdict.kind) {
		case "refused": {
			const { code, claim } = c.verdict.refused
			const directive =
				claim.kind === "refusal"
					? `// @ts-expect-error -- ${code} refusal: ${claim.refusal}`
					: `// @ts-expect-error -- ${code}: ${claim.reason}`
			const at = Arr.findFirstIndex(lines, (l) => l.fault)
			if (Option.isNone(at)) {
				throw new Error(`a refused case marks no line of its fault (${c.spec.fault})\n${c.source}`)
			}
			return [
				`/** The engine refuses the case's ${c.spec.fault}. */`,
				...Arr.flatMap(lines, (l, j) => (j === at.value ? [directive, l.text] : [l.text])),
				""
			]
		}
		case "admitted": {
			const { get, card, keys, head, params } = c.verdict.proved
			const keyed = Arr.map(keys, keysType)
			return [
				`/** The engine ${get ? "proves" : "refuses"} get; its card: ${card}; its keys: ${Arr.join(keyed, "; under the other flag, ")}. */`,
				...Arr.map(lines, (l) => l.text),
				`export const g${i} = (db: DbOf<typeof Reader, unknown>) => (args: GetArg<typeof q${i}>) =>`,
				...(get ? [] : [`\t// @ts-expect-error -- TS2345 refusal: ${getRefusal}`]),
				`\tdb.get(q${i}, args)`,
				`export const e${i} = (db: DbOf<typeof Reader, unknown>) => (args: GetArg<typeof q${i}>) =>`,
				`\tdb.execute(q${i}, args)`,
				...Arr.map(
					keyed,
					(k, j) => `export type k${i}_${j} = Expect<Equals<Unproved<typeof q${i}, ${k}>, never>>`
				),
				`export type h${i} = Expect<Equals<HeadOf<typeof q${i}>, ${head}>>`,
				params === "unknown"
					? `export type p${i} = Expect<Equals<keyof ParamsOf<typeof q${i}>, never>>`
					: `export type p${i} = Expect<Equals<Flat<ParamsOf<typeof q${i}>>, ${params}>>`,
				`export type c${i} = Expect<Equals<EvidenceOfQuery<typeof q${i}>["card"], ${jsonText(card)}>>`,
				`export type x${i} = Expect<Equals<ReturnType<ReturnType<typeof e${i}>>, Effect.Effect<QueryResult<${head}>, ReadError>>>`,
				...(get
					? [
							`export type y${i} = Expect<Equals<ReturnType<ReturnType<typeof g${i}>>, Effect.Effect<Option.Option<${head}>, ReadError>>>`
						]
					: []),
				""
			]
		}
	}
}

/** The identifiers a module's body names, which its imports are read off. */
const identifiers = (body: string): ReadonlySet<string> =>
	new Set(Str.split(body, regex("[^A-Za-z0-9_$]+")))

/** The helpers an assertion of a case's verdicts reads. */
const assertions: ReadonlyArray<string> = [
	"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
	"type Expect<T extends true> = T",
	"/** A map's entries as one record, however the types join the maps its arms and terms state. */",
	"type Flat<T> = { readonly [K in keyof T]: T[K] }",
	"/** The keys the types claim of a query: none when its evidence is unknown. */",
	'type TypeKeys<Q> = EvidenceOfQuery<Q>["keys"] extends infer K',
	"\t? unknown extends K",
	"\t\t? never",
	"\t\t: K extends ReadonlyArray<infer E>",
	"\t\t\t? E",
	"\t\t\t: never",
	"\t: never",
	"/** Whether a key over the fields F lies over one of the engine's keys E: F holds a column of each of its classes. */",
	"type Over<F, E> = E extends ReadonlyArray<unknown>",
	"\t? false extends { [I in keyof E]: [Extract<E[I], F>] extends [never] ? false : true }[number]",
	"\t\t? false",
	"\t\t: true",
	"\t: false",
	"/** The keys the types claim of Q that lie over none the engine proves. */",
	"type Unproved<Q, E> = UnprovedOf<TypeKeys<Q>, E>",
	"type UnprovedOf<K, E> = K extends ReadonlyArray<infer F> ? (true extends Over<F, E> ? never : K) : never"
]

/**
 * A module of the cases in `order`: their blocks, after the declarations they read, and the imports the module names;
 * a module states only what its blocks read, since an unused one is a diagnostic of its own.
 */
const programOf = (
	entries: AgreementEntries,
	cases: ReadonlyArray<AgreementCase>,
	order: ReadonlyArray<number>
): string => {
	const blocks = Arr.flatMap(order, (i) =>
		blockOf(defined(cases[i], "a case of the drawn order"), i)
	)
	const read = identifiers(Arr.join(blocks, "\n"))
	const body = Arr.join(
		[
			...(read.has("Reader")
				? [
						"/** The role every drawn get reads through: the whole schema. */",
						'const Reader = role(Agree, "reader", Agree.relations)'
					]
				: []),
			...(read.has("anyName")
				? [
						"/** A scope's name spelled through a string, which the types refuse. */",
						"declare const anyName: string"
					]
				: []),
			...(read.has("flag")
				? [
						"/** A boolean the program does not know, which a flagged filter turns on. */",
						"declare const flag: boolean"
					]
				: []),
			...(read.has("Unproved") ? assertions : []),
			"",
			...blocks
		],
		"\n"
	)
	const named = identifiers(body)
	const some = (
		names: ReadonlyArray<string>,
		from: string,
		kind: "import" | "import type"
	): ReadonlyArray<string> => {
		const used = Arr.filter(names, (n) => named.has(n))
		return Arr.isReadonlyArrayNonEmpty(used)
			? [`${kind} { ${Arr.join(used, ", ")} } from ${jsonText(from)}`]
			: []
	}
	return Arr.join(
		[
			"// Generated by test/support/agreement/queries.ts: the type/engine agreement program.",
			...(named.has("Arr") ? ['import { Array as Arr } from "effect"'] : []),
			...some(["Brand", "Effect", "Option", "Stream"], "effect", "import type"),
			...some(["Compute"], entries.compute, "import"),
			...some(["pg", "uuid"], entries.fields, "import"),
			...some(["Decimal", "Money", "Span", "Uuid", "Vector"], entries.fields, "import type"),
			...some(["query", "v"], entries.query, "import"),
			...some(["EvidenceOfQuery", "HeadOf", "ParamsOf", "ParamType"], entries.query, "import type"),
			...some(["DbOf", "GetArg", "QueryResult"], entries.db, "import type"),
			...some(["ReadError"], entries.errors, "import type"),
			...some(["Rostered"], entries.phantom, "import type"),
			...some(["role"], entries.declare, "import"),
			...some(
				["Agree", "Cents", "Item", "Note", "Owned", "Stray", "Tag", "Tone", "Tones"],
				entries.schema,
				"import"
			),
			"",
			body
		],
		"\n"
	)
}
