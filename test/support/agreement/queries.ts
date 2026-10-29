import { element, type Gen } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample, type Source } from "@grizzle/testing/source"
import { keep, type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { Array as Arr, Option, pipe, Record as Rec, String as Str } from "effect"
import { requireGet } from "#compiler/analysis/logical/get.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type ClaimedKey, claimedClasses } from "#compiler/ir/keys.ts"
import { pg } from "#compiler/public/fields.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { Agree, Item, Note, Tag } from "#test/support/agreement/schema.ts"
import { defined } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { messageOf } from "#test/support/message.ts"

/**
 * The type/engine agreement: queries drawn over the agreement schema (./schema.ts), each with the engine's verdict on
 * it, and the one TypeScript program that states every verdict as a type assertion, which the type tier checks
 * (test/types/evidence/agreement.test.ts). TypeScript's evidence learns the engine's rule,
 * so db.get accepts exactly what the engine proves at most one row per binding, and every key the types claim is one
 * the engine proves.
 *
 * A query is drawn as data (QuerySpec) and read twice: rendered as TypeScript source for the program, and built through
 * the query builder's JavaScript view (queryOver, varsOver, computeCore) for the engine, which compiles it as the
 * runtime does (snapshot context, rows) and reads the root of its analyzed DAG: whether get may read it
 * (analysis/logical/get.ts requireGet) and its minimal keys. Both readings walk one spec construct by construct, so the
 * program and the engine see one query.
 *
 * The draws come from the run's own stream (agreementCases samples it from the run's seed): the program the type-test
 * batch checks and the cases the test reads are one population in every process of a run, and every run draws a new
 * one. Each case first draws a swarm over the constructs (@grizzle/testing/swarm), then its query construct by
 * construct: the swarm turns constructs off for a whole case and thins the rest, so the forms that crowd others out are
 * left out of some cases and the rest combine.
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
	"fixFilter",
	"computedFix",
	"varEquality",
	"rangeFilter",
	"computeFilter",
	"conjunction",
	"disjunction",
	"headVar",
	"computedHead",
	"condHead",
	"literalHead",
	"aggregate",
	"groupTerm",
	"sum",
	"union",
	"discriminant",
	"take"
] as const
export type AgreementFeature = (typeof agreementFeatures)[number]

/** What a drawn case reached: its constructs, and the engine's verdict on it. */
export type AgreementNote =
	| AgreementFeature
	| "get proved"
	| "get refused"
	| "a key below the heading"

type Rel = "Item" | "Tag" | "Note"
type Kind = "uuid" | "int"

interface Field {
	readonly rel: Rel
	readonly name: string
	readonly kind: Kind
}

const fieldsOf: { readonly [R in Rel]: Arr.NonEmptyReadonlyArray<Field> } = {
	Item: [
		{ rel: "Item", name: "id", kind: "uuid" },
		{ rel: "Item", name: "owner", kind: "uuid" },
		{ rel: "Item", name: "n", kind: "int" },
		{ rel: "Item", name: "m", kind: "int" }
	],
	Tag: [
		{ rel: "Tag", name: "item", kind: "uuid" },
		{ rel: "Tag", name: "label", kind: "int" },
		{ rel: "Tag", name: "w", kind: "int" }
	],
	Note: [
		{ rel: "Note", name: "item", kind: "uuid" },
		{ rel: "Note", name: "k", kind: "int" }
	]
}
const rels: Arr.NonEmptyReadonlyArray<Rel> = ["Item", "Tag", "Note"]
const allFields: Arr.NonEmptyReadonlyArray<Field> = Arr.flatMap(rels, (rel) => fieldsOf[rel])
/** The integer field a parameter compared with a constant is typed by, where the rule binds no variable. */
const integerField: Field = { rel: "Item", name: "n", kind: "int" }

/** The relation values the built query matches, and their field descriptors, which its parameters are typed by. */
const sources: { readonly [R in Rel]: unknown } = { Item, Tag, Note }
const descriptors: { readonly [R in Rel]: Readonly<Record<string, unknown>> } = {
	Item: Item.fields,
	Tag: Tag.fields,
	Note: Note.fields
}

/**
 * A variable v mints over a relation's field; `copy` tells apart the variables of a relation the rule matches twice.
 */
interface Var {
	readonly field: Field
	readonly copy: number
}

type Term =
	| { readonly kind: "var"; readonly v: Var }
	| { readonly kind: "param"; readonly name: string; readonly at: Field }
	| { readonly kind: "literal"; readonly type: Kind; readonly value: number }
	| { readonly kind: "constant"; readonly value: number }
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

type HeadTerm =
	| { readonly kind: "term"; readonly t: Term }
	| { readonly kind: "headLiteral"; readonly value: number | string }
	| { readonly kind: "count" }
	| { readonly kind: "sum"; readonly of: Term }

interface Match {
	readonly rel: Rel
	readonly copy: number
	readonly bindings: ReadonlyArray<readonly [string, Term]>
}

interface RuleSpec {
	readonly matches: Arr.NonEmptyReadonlyArray<Match>
	readonly filters: ReadonlyArray<Pred>
	readonly head: Arr.NonEmptyReadonlyArray<readonly [string, HeadTerm]>
}

/** One query: its arms (a union when two), and the take that closes it, if any. */
interface QuerySpec {
	readonly arms: Arr.NonEmptyReadonlyArray<RuleSpec>
	readonly take: 1 | 2 | undefined
}

/** A form a draw may take: the construct it uses, and the part it draws. */
type Form<A> = readonly [AgreementFeature, () => A]

/**
 * One query's drawing: the case's swarm, the source its decisions come from, the constructs it reached and its fresh
 * names.
 */
class Drawing {
	readonly #source: Source
	readonly #swarm: Swarm<AgreementFeature>
	#params = 0
	readonly reached = new Set<AgreementFeature>()

	constructor(source: Source, drawn: Swarm<AgreementFeature>) {
		this.#source = source
		this.#swarm = drawn
	}

	/** Whether `feature` appears at this place, as the swarm keeps it; noted when it does. */
	keep(feature: AgreementFeature): boolean {
		const kept = this.#source.draw(keep(this.#swarm, feature))
		if (kept) {
			this.reached.add(feature)
		}
		return kept
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
		return { kind: "param", name, at }
	}
}

const sameVar = (a: Var, b: Var): boolean =>
	a.field.rel === b.field.rel && a.field.name === b.field.name && a.copy === b.copy

const varTerm = (v: Var): Term => ({ kind: "var", v })

const literalOf = (d: Drawing, type: Kind): Term => ({
	kind: "literal",
	type,
	value: d.from([0, 1, 2, 3])
})

/** A value fixed per binding: a parameter or a literal, or Compute over a constant and a parameter. */
const inputOf = (d: Drawing, at: Field): Term => {
	const plain: Arr.NonEmptyReadonlyArray<Form<Term>> = [
		["param", () => d.param(at)],
		["literal", () => literalOf(d, at.kind)]
	]
	return at.kind === "int"
		? d.choose([
				...plain,
				[
					"computedFix",
					() => ({
						kind: "arith",
						op: d.from(["add", "mul"] as const),
						a: { kind: "constant", value: d.from([1, 2]) },
						b: d.param(at)
					})
				]
			])
		: d.choose(plain)
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
			a: { kind: "constant", value: 1 },
			b: d.param(integerField),
			via
		}
	}
	const v = d.from(bound)
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

/** A match's bindings, field by field, each drawn over the variables bound before it, a join among them. */
const bindingsOf = (d: Drawing, rel: Rel, copy: number, before: ReadonlyArray<Var>): Bound =>
	Arr.reduce(fieldsOf[rel], { bindings: [], bound: before }, (drawn: Bound, field): Bound => {
		const term = d.choose(bindingForms(d, field, { field, copy }, drawn.bound))
		return term === undefined
			? drawn
			: {
					bindings: [...drawn.bindings, [field.name, term] as const],
					bound: withVariable(drawn.bound, term)
				}
	})

const withVariable = (bound: ReadonlyArray<Var>, term: Term): ReadonlyArray<Var> =>
	term.kind === "var" && !Arr.some(bound, (b) => sameVar(b, term.v)) ? [...bound, term.v] : bound

/** A rule: its matches, its filters and its head, over the variables its matches bind. */
const drawRule = (d: Drawing): RuleSpec => {
	const count = d.keep("secondMatch") ? (d.keep("thirdMatch") ? 3 : 2) : 1
	const matched: Array<Rel> = []
	let bound: ReadonlyArray<Var> = []
	const matches: Array<Match> = []
	for (let i = 0; i < count; i++) {
		const drawn = d.from(rels)
		const unmatched = Arr.filter(rels, (rel) => !Arr.contains(matched, rel))
		const rel =
			Arr.contains(matched, drawn) && Arr.isReadonlyArrayNonEmpty(unmatched) && !d.keep("repeat")
				? d.from(unmatched)
				: drawn
		const copy = Arr.filter(matched, (m) => m === rel).length
		matched.push(rel)
		const bindings = bindingsOf(d, rel, copy, bound)
		bound = bindings.bound
		matches.push({ rel, copy, bindings: bindings.bindings })
	}
	return {
		matches: [defined(matches[0], "the first match"), ...matches.slice(1)],
		filters: filtersOver(d, bound),
		head: headOver(d, bound)
	}
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
			b: literalOf(d, "int"),
			via: viaOf(d)
		})
	}
	const [first, second, ...rest] = simple
	if (first === undefined || second === undefined) {
		return simple
	}
	if (d.keep("disjunction")) {
		return [{ kind: "or", ps: [first, second], via: viaOf(d) }, ...rest]
	}
	if (d.keep("conjunction")) {
		return [{ kind: "and", ps: [first, second], via: viaOf(d) }, ...rest]
	}
	return simple
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
			: { kind: "constant", value: 1 }
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
 * The head: a grouped aggregate, or one to three fields of variables, computations, conditionals and literals. A
 * parameter stands in a head only inside a computation, which types it: alone it meets no term.
 */
const headOver = (
	d: Drawing,
	bound: ReadonlyArray<Var>
): Arr.NonEmptyReadonlyArray<readonly [string, HeadTerm]> => {
	const ints = Arr.filter(bound, (b) => b.field.kind === "int")
	if (d.keep("aggregate")) {
		const groups = groupsOver(d, bound)
		const sums: ReadonlyArray<HeadTerm> =
			Arr.isReadonlyArrayNonEmpty(ints) && d.keep("sum")
				? [{ kind: "sum", of: varTerm(d.from(ints)) }]
				: []
		const terms: Arr.NonEmptyReadonlyArray<HeadTerm> = [
			{ kind: "count" },
			...Arr.map(groups, (g): HeadTerm => ({ kind: "term", t: varTerm(g) })),
			...sums
		]
		return Arr.map(terms, (t, i) => [`h${i}`, t] as const)
	}
	const fields = Arr.map(Arr.range(0, d.from([0, 1, 2])), (i) => {
		const anywhere: ReadonlyArray<Form<HeadTerm>> = [
			["condHead", () => ({ kind: "term", t: condOver(d, bound, ints) })],
			["literalHead", () => ({ kind: "headLiteral", value: d.from([0, 1, "a", "b"]) })]
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
			: [
					["literalHead", () => ({ kind: "headLiteral", value: d.from([0, 1, "a", "b"]) })],
					...anywhere
				]
		return [`h${i}`, d.choose(forms)] as const
	})
	return fields
}

/** A union's second arm: the first's, with its parameters renamed and, under a discriminant, each arm told apart. */
const secondArm = (arm: RuleSpec): RuleSpec => ({ ...arm, ...renamed(arm) })

const renamed = (arm: RuleSpec): Pick<RuleSpec, "matches" | "filters" | "head"> => {
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
				return t
		}
	}
	const pred = (p: Pred): Pred =>
		p.kind === "cmp"
			? { ...p, a: term(p.a), b: term(p.b) }
			: { ...p, ps: [pred(p.ps[0]), pred(p.ps[1])] }
	const head = (h: HeadTerm): HeadTerm => {
		switch (h.kind) {
			case "term":
				return { kind: "term", t: term(h.t) }
			case "sum":
				return { kind: "sum", of: term(h.of) }
			case "headLiteral":
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
		head: Arr.map(arm.head, ([n, h]) => [n, head(h)] as const)
	}
}

const discriminated = (arm: RuleSpec, value: string): RuleSpec => ({
	...arm,
	head: [...arm.head, ["d", { kind: "headLiteral", value }]]
})

/** The query a drawing draws: a rule, a union of it with its renamed twin, and a take that closes it. */
const drawQuery = (d: Drawing): QuerySpec => {
	const first = drawRule(d)
	const arms: Arr.NonEmptyReadonlyArray<RuleSpec> = d.keep("union")
		? d.keep("discriminant")
			? [discriminated(first, "a"), discriminated(secondArm(first), "b")]
			: [first, secondArm(first)]
		: [first]
	const take = d.keep("take") ? d.from([1, 2] as const) : undefined
	return { arms, take }
}

const uuidOf = (value: number): string =>
	`00000000-0000-4000-8000-${pipe(String(value), Str.padStart(12, "0"))}`

const varName = (v: Var): string => `${v.field.rel}${v.copy}`

/** The names a rendered query imports beside query and Agree. */
type Imported = "Compute" | "pg" | "v" | Rel

/** The source of one query, with the names it imports. */
class Rendering {
	readonly uses = new Set<Imported>()

	term(t: Term): string {
		switch (t.kind) {
			case "var":
				return `${varName(t.v)}.${t.v.field.name}`
			case "param":
				this.uses.add(t.at.rel)
				return `r.param(${JSON.stringify(t.name)}, ${t.at.rel}.fields.${t.at.name})`
			case "literal":
				return t.type === "int" ? String(t.value) : JSON.stringify(uuidOf(t.value))
			case "constant":
				this.uses.add("Compute")
				this.uses.add("pg")
				return `Compute.literal(pg.integer, ${t.value})`
			case "arith":
				this.uses.add("Compute")
				return `Compute.${t.op}(${this.term(t.a)}, ${this.term(t.b)})`
			case "neg":
				this.uses.add("Compute")
				return `Compute.neg(${this.term(t.a)})`
			case "cond":
				this.uses.add("Compute")
				return `Compute.cond(${this.pred(t.p)}, ${this.term(t.onTrue)}, ${this.term(t.onFalse)})`
		}
	}

	pred(p: Pred): string {
		const callee = p.via === "rule" ? "r" : "Compute"
		if (p.via === "compute") {
			this.uses.add("Compute")
		}
		return p.kind === "cmp"
			? `${callee}.${p.op}(${this.term(p.a)}, ${this.term(p.b)})`
			: `${callee}.${p.kind}(${this.pred(p.ps[0])}, ${this.pred(p.ps[1])})`
	}

	head(h: HeadTerm): string {
		switch (h.kind) {
			case "term":
				return this.term(h.t)
			case "headLiteral":
				return `r.literal(${JSON.stringify(h.value)})`
			case "count":
				return "r.count()"
			case "sum":
				return `r.sum(${this.term(h.of)})`
		}
	}

	rule(arm: RuleSpec): string {
		const matches = Arr.map(arm.matches, (m) => {
			this.uses.add(m.rel)
			const bindings = Arr.map(m.bindings, ([f, t]) => `${f}: ${this.term(t)}`)
			const record = Arr.isReadonlyArrayNonEmpty(bindings)
				? `{ ${Arr.join(bindings, ", ")} }`
				: "{}"
			return `.match(${m.rel}, ${record})`
		})
		const filters = Arr.isReadonlyArrayNonEmpty(arm.filters)
			? [
					`.where(${Arr.join(
						Arr.map(arm.filters, (p) => this.pred(p)),
						", "
					)})`
				]
			: []
		const head = `.find({ ${Arr.join(
			Arr.map(arm.head, ([n, h]) => `${n}: ${this.head(h)}`),
			", "
		)} })`
		const declared = Arr.map(variablesOf(arm), (v) => {
			this.uses.add("v")
			this.uses.add(v.field.rel)
			return `\t\tconst ${varName(v)} = v(${v.field.rel})`
		})
		const body = `r${Arr.join([...matches, ...filters, head], "")}`
		return Arr.isReadonlyArrayNonEmpty(declared)
			? Arr.join(["(r) => {", ...declared, `\t\treturn ${body}`, "\t}"], "\n")
			: `(r) => ${body}`
	}

	query(spec: QuerySpec): string {
		const arms = Arr.map(spec.arms, (arm) => `\t.rule(${this.rule(arm)})`)
		const first = defined(spec.arms[0].head[0], "the first head field")[0]
		const take =
			spec.take === undefined
				? []
				: [`\t.orderBy([${JSON.stringify(first)}, "asc"])`, `\t.take(${spec.take})`]
		return Arr.join(["query(Agree)", ...arms, ...take], "\n")
	}
}

/** Every variable an arm reads, one per relation copy, in the order of first use. */
const variablesOf = (arm: RuleSpec): ReadonlyArray<Var> => {
	const seen = new Map<string, Var>()
	const term = (t: Term): void => {
		switch (t.kind) {
			case "var":
				if (!seen.has(varName(t.v))) {
					seen.set(varName(t.v), t.v)
				}
				return
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
				return
		}
	}
	const pred = (p: Pred): void => {
		if (p.kind === "cmp") {
			term(p.a)
			term(p.b)
			return
		}
		pred(p.ps[0])
		pred(p.ps[1])
	}
	for (const m of arm.matches) {
		for (const [, t] of m.bindings) {
			term(t)
		}
	}
	for (const p of arm.filters) {
		pred(p)
	}
	for (const [, h] of arm.head) {
		if (h.kind === "term") {
			term(h.t)
		}
		if (h.kind === "sum") {
			term(h.of)
		}
	}
	return [...seen.values()]
}

/** The query a spec states, built through the query builder's JavaScript view, as the engine compiles it. */
const built = (spec: QuerySpec): unknown => {
	const arms = Arr.map(spec.arms, (arm) => (r: RuleValue) => {
		const minted = new Map<string, Readonly<Record<string, unknown>>>()
		const variable = (v: Var): unknown => {
			const name = varName(v)
			const vars = minted.get(name) ?? varsOver(sources[v.field.rel])
			minted.set(name, vars)
			return vars[v.field.name]
		}
		const term = (t: Term): unknown => {
			switch (t.kind) {
				case "var":
					return variable(t.v)
				case "param":
					return r.param(t.name, descriptors[t.at.rel][t.at.name])
				case "literal":
					return t.type === "int" ? t.value : uuidOf(t.value)
				case "constant":
					return computeCore.literal(pg.integer, t.value)
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
				case "headLiteral":
					return r.literal(h.value)
				case "count":
					return r.count()
				case "sum":
					return r.sum(term(h.of))
			}
		}
		const matched = Arr.reduce(arm.matches, r, (rule, m) =>
			rule.match(
				sources[m.rel],
				Rec.fromEntries(Arr.map(m.bindings, ([f, t]) => [f, term(t)] as const))
			)
		)
		const filtered = Arr.isReadonlyArrayNonEmpty(arm.filters)
			? matched.where(...Arr.map(arm.filters, pred))
			: matched
		return filtered.find(Rec.fromEntries(Arr.map(arm.head, ([n, h]) => [n, head(h)] as const)))
	})
	const [first, ...rest] = arms
	const union = Arr.reduce(rest, queryOver(Agree).rule(first), (q, arm) => q.rule(arm))
	const name = defined(spec.arms[0].head[0], "the first head field")[0]
	return spec.take === undefined ? union : union.orderBy([name, "asc"]).take(spec.take)
}

/**
 * What the engine proves of a query's root: whether get may read it, and its minimal keys, each over its classes of
 * equal columns (ir/keys.ts keyClasses): one column of each class, together, are a key. Each class is in name order,
 * and a key's classes by their first names.
 */
export interface Verdict {
	readonly get: boolean
	readonly keys: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>
}

/** A claimed key over its classes, each in name order, by their first names. */
const classesInNameOrder = (k: ClaimedKey): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.sort(
		Arr.map(claimedClasses(k), (members) => Arr.sort(members, Str.Order)),
		Arr.makeOrder(Str.Order)
	)

const verdictOf = (spec: QuerySpec, source: string): Verdict => {
	const template = compileTemplate(built(spec), undefined, testCompile)
	if (!template.ok) {
		throw new Error(
			`the engine refuses a drawn query, a defect of the generator: ${messageOf(template.error)}\n${source}`
		)
	}
	const root = template.value.analyzed.roots[0]
	return {
		get: requireGet(root, SourceLoc("agreement", [])).ok,
		keys: Arr.map(root.meta.logicalKeys, classesInNameOrder)
	}
}

/**
 * The one disagreement out of scope: a variable's origin is its identity only in a
 * rule that matches no relation twice. A rule that matches a relation twice mints two variables of one origin, whose
 * types are one type, so no type can tell which a key binds: the types prove such a rule no key through its variables,
 * and a get the engine proves of it they may refuse. The program asserts no get the engine proves of a query with such
 * a rule; it asserts every get the engine refuses, and every key the types claim.
 */
export const repeatedScope =
	"a rule that matches a relation twice: the types tell its variables apart by origin alone"

/**
 * What the program asserts of the types' get: the engine's verdict, accepted or refused, or nothing for a get the
 * engine proves of a query out of scope (repeatedScope).
 */
type Asserted = "accepted" | "refused" | "out of scope"

/** One drawn query: its source, the engine's verdict, what the program asserts of the types, and what it reached. */
export interface AgreementCase {
	readonly source: string
	readonly uses: ReadonlySet<Imported>
	readonly verdict: Verdict
	readonly asserted: Asserted
	readonly notes: ReadonlySet<AgreementNote>
}

/** A drawn query and the constructs its drawing reached. */
interface Drawn {
	readonly spec: QuerySpec
	readonly reached: ReadonlySet<AgreementFeature>
}

/** One query: the case's swarm over the constructs, then the query under it. */
const drawnGen: Gen<Drawn> = (source) => {
	const d = new Drawing(source, source.draw(swarm(agreementFeatures)))
	return { spec: drawQuery(d), reached: d.reached }
}

const caseOf = ({ spec, reached }: Drawn): AgreementCase => {
	const rendering = new Rendering()
	const source = rendering.query(spec)
	const verdict = verdictOf(spec, source)
	const repeated = Arr.some(spec.arms, (arm) =>
		Arr.some(arm.matches, (m, i) => Arr.some(arm.matches.slice(0, i), (p) => p.rel === m.rel))
	)
	const asserted: Asserted = !verdict.get ? "refused" : repeated ? "out of scope" : "accepted"
	const heading = Arr.length(defined(spec.arms[0], "the first arm").head)
	const notes = new Set<AgreementNote>(reached)
	notes.add(verdict.get ? "get proved" : "get refused")
	if (Arr.some(verdict.keys, (k) => k.length < heading)) {
		notes.add("a key below the heading")
	}
	return { source, uses: rendering.uses, verdict, asserted, notes }
}

/** The queries the program holds. */
export const agreementCount = 240

/**
 * The run's drawn cases: the stream of the agreement's label under the run's seed (`TEST_SEED`, or the seed the run
 * drew), so every process of one run draws the same cases and every run draws new ones.
 */
export const agreementCases = (seed: number): ReadonlyArray<AgreementCase> =>
	Arr.map(
		sample(drawnGen, rotatingSeed(seed, floorSeed("types/evidence agreement")), agreementCount),
		caseOf
	)

/** The refusal db.get's type names for a query not proved at most one row per binding (adapter/types/db.ts). */
const getRefusal = "get needs a query proved at most one row per parameter binding"

/** The modules the program imports, each spelled as an import specifier relative to the program's directory. */
export interface AgreementEntries {
	readonly query: string
	readonly compute: string
	readonly fields: string
	readonly db: string
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
									Arr.map(members, (c) => JSON.stringify(c)),
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
	declare: entry("packages/engine/src/public/schema.ts"),
	schema: entry("test/support/agreement/schema.ts")
})

/**
 * The program over the run's cases: every case's query, the get the types must accept or refuse (a refusal under its
 * directive, which the type-test batch disarms), and the assertion that every key the types claim lies over one the
 * engine proves.
 */
export const agreementProgram = (entries: AgreementEntries, seed: number): string =>
	programOf(entries, agreementCases(seed))

const programOf = (entries: AgreementEntries, cases: ReadonlyArray<AgreementCase>): string => {
	const uses = new Set(Arr.flatMap(cases, (c) => [...c.uses]))
	const schemaNames = ["Agree", ...Arr.filter(rels, (rel) => uses.has(rel))]
	const blocks = Arr.map(cases, (c, i) => {
		const keys = keysType(c.verdict.keys)
		const scope = c.asserted === "out of scope" ? ` (out of scope: ${repeatedScope})` : ""
		const get = (directive: ReadonlyArray<string>): ReadonlyArray<string> => [
			`export const g${i} = (db: DbOf<typeof Reader, unknown>) => (args: GetArg<typeof q${i}>) =>`,
			...directive,
			`\tdb.get(q${i}, args)`
		]
		const asserted: { readonly [A in Asserted]: ReadonlyArray<string> } = {
			accepted: get([]),
			refused: get([`\t// @ts-expect-error -- TS2345 refusal: ${getRefusal}`]),
			"out of scope": []
		}
		return Arr.join(
			[
				`/** The engine ${c.verdict.get ? "proves" : "refuses"} get${scope}; its keys: ${keys}. */`,
				`export const q${i} = ${c.source}`,
				...asserted[c.asserted],
				`export type k${i} = Expect<Equals<Unproved<typeof q${i}, ${keys}>, never>>`,
				""
			],
			"\n"
		)
	})
	return Arr.join(
		[
			"// Generated by test/support/agreement/queries.ts: the type/engine agreement program.",
			...(uses.has("Compute")
				? [`import { Compute } from ${JSON.stringify(entries.compute)}`]
				: []),
			...(uses.has("pg") ? [`import { pg } from ${JSON.stringify(entries.fields)}`] : []),
			`import { type EvidenceOfQuery, query${uses.has("v") ? ", v" : ""} } from ${JSON.stringify(entries.query)}`,
			`import type { DbOf, GetArg } from ${JSON.stringify(entries.db)}`,
			`import { role } from ${JSON.stringify(entries.declare)}`,
			`import { ${Arr.join(schemaNames, ", ")} } from ${JSON.stringify(entries.schema)}`,
			"",
			"/** The role every drawn get reads through: the whole schema. */",
			'const Reader = role(Agree, "reader", Agree.relations)',
			"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
			"type Expect<T extends true> = T",
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
			"type UnprovedOf<K, E> = K extends ReadonlyArray<infer F> ? (true extends Over<F, E> ? never : K) : never",
			"",
			...blocks
		],
		"\n"
	)
}
