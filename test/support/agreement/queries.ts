import { floorPopulation, type Reached } from "@grizzle/testing/features"
import { array, element, type Gen, int, shuffled } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample, type Source } from "@grizzle/testing/source"
import { keep, type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { Array as Arr, Option, pipe, Record as Rec, String as Str } from "effect"
import { requireGet } from "#compiler/analysis/logical/get.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { type ClaimedKey, claimedColumns, claimedMembers } from "#compiler/ir/keys.ts"
import { pg } from "#compiler/public/fields.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import {
	type AdmissionCell,
	admissionCells,
	admissionModule,
	admissionSize,
	combinatorCells
} from "#test/support/agreement/admission.ts"
import { Agree, Item, Note, Tag, Tone, Tones } from "#test/support/agreement/schema.ts"
import { defined } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { argumentsOf } from "#test/support/list.ts"
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
 * The draws are two populations of one generator: the floor's witnesses (floorPopulation), the same in every run, which
 * alone meet the required constructs, and the run's own stream (agreementCases samples it from the run's seed), new
 * every run: the program the type-test batch checks and the cases the test reads are one population in every process
 * of a run. Each case first draws a swarm over the constructs (@grizzle/testing/swarm), then its query construct by
 * construct: the swarm turns constructs off for a whole case and thins the rest, so the forms that crowd others out are
 * left out of some cases and the rest combine. Each constant's construct is drawn at a place every case visits, so a
 * case whose swarm keeps it holds it and the floor reaches it by construction: a constant of Tone through the rule's
 * anchor (Anchor), a handle discriminant before the union's own gates, a constant at Tones as the rule's last match.
 * So is a self-join whose get the engine proves (pinnedSelfJoin), drawn as a rule's second match: two scopes of one
 * relation, each with a key bound to values fixed per binding, in a query of no other arm, which reaches the pair a
 * repeat and a proved get make (agreementPairs) wherever the swarm keeps it.
 *
 * A constant stands in every term position: a JavaScript value (`literal`), Tone's handle (`handle`) at Item.tone in a
 * binding, a filter, first in a comparison, a head, a union's discriminant and a binding at Tones, the union source of
 * ./schema.ts, whose arm it selects, and `Compute.literal(pg.integer, v)`
 * (`constant`) where its value never reaches the evidence (Compute operands, a conditional's branch): its type keeps its
 * descriptor's whole host type, the one approximation of a typed constant's value, so the evidence never reads it.
 *
 * The program is emitted twice, in the drawn order and in a second drawn order, as two modules, and a third asserts
 * every query's head and keys equal across the two: TypeScript's evaluation of the evidence must not depend on the
 * order of unrelated statements. A fourth module is the admission agreement (./admission.ts).
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
	"headVar",
	"computedHead",
	"condHead",
	"literalHead",
	"constantBinding",
	"constantFirst",
	"constantFilter",
	"constantHead",
	"handleDiscriminant",
	"constantAtUnionSource",
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
	| "a variable two filters fix"

/**
 * The pairs of notes one case must reach together: a self-join whose get the engine proves, which pinnedSelfJoin
 * draws by construction.
 */
export const agreementPairs: ReadonlyArray<readonly [AgreementNote, AgreementNote]> = [
	["repeat", "get proved"]
]

type Rel = "Item" | "Tag" | "Note"
/** What a match reads: a relation, or Tones, the union of Item's facts by tone (./schema.ts). */
type MatchSource = Rel | "Tones"
type Kind = "uuid" | "int" | "enum"

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
		{ rel: "Item", name: "m", kind: "int" },
		{ rel: "Item", name: "tone", kind: "enum" }
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
/** Each relation's keys, by their fields (./schema.ts). */
const keysOf: { readonly [R in Rel]: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>> } = {
	Item: [["id"], ["owner", "n"]],
	Tag: [["item", "label"]],
	Note: [["item"]]
}
const allFields: Arr.NonEmptyReadonlyArray<Field> = Arr.flatMap(rels, (rel) => fieldsOf[rel])
/** The integer field a parameter compared with a constant is typed by, where the rule binds no variable. */
const integerField: Field = { rel: "Item", name: "n", kind: "int" }
/** Item.tone, the field a rule's first match binds when it draws a constant of Tone by construction (Anchor). */
const toneField: Field = { rel: "Item", name: "tone", kind: "enum" }

/** The values the built query matches, and the relations' field descriptors, which its parameters are typed by. */
const sources: { readonly [R in MatchSource]: unknown } = { Item, Tag, Note, Tones }
const descriptors: { readonly [R in Rel]: Readonly<Record<string, unknown>> } = {
	Item: Item.fields,
	Tag: Tag.fields,
	Note: Note.fields
}

/**
 * A variable v mints over a relation's field, in the scope of the relation's `copy`-th match in its rule: a self-join's
 * two matches mint in two scopes (scopeOf).
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

type HeadTerm =
	| { readonly kind: "term"; readonly t: Term }
	| { readonly kind: "literal"; readonly value: number | string }
	| { readonly kind: "count" }
	| { readonly kind: "sum"; readonly of: Term }

interface Match {
	readonly rel: MatchSource
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
						a: { kind: "constant", value: d.from([1, 2]) },
						b: d.param(at)
					})
				]
			])
		case "enum":
			return d.choose([...plain, ["constantFilter", () => handleOf(d)]])
		case "uuid":
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
			a: { kind: "constant", value: 1 },
			b: d.param(integerField),
			via
		}
	}
	const v = d.from(bound)
	if (v.field.kind === "enum" && d.keep("constantFirst")) {
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
		...(field.kind === "enum" ? [["constantBinding", () => handleOf(d)] as const] : []),
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
	rel: Rel,
	copy: number,
	before: ReadonlyArray<Var>,
	anchor: Anchor | undefined,
	inputs: ReadonlyArray<string>
): Bound =>
	Arr.reduce(fieldsOf[rel], { bindings: [], bound: before }, (drawn: Bound, field): Bound => {
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
		const drawn = i === 0 && anchor !== undefined ? toneField.rel : d.from(rels)
		const unmatched = Arr.filter(rels, (rel) => !Arr.contains(matched, rel))
		const rel =
			Arr.contains(matched, drawn) && Arr.isReadonlyArrayNonEmpty(unmatched) && !d.keep("repeat")
				? d.from(unmatched)
				: drawn
		const copy = Arr.filter(matched, (m) => m === rel).length
		matched.push(rel)
		const bindings = bindingsOf(d, rel, copy, bound, i === 0 ? anchor : undefined, [])
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
	const rel = anchor === undefined ? d.from(rels) : toneField.rel
	const first = bindingsOf(d, rel, 0, [], anchor, d.from(keysOf[rel]))
	const second = bindingsOf(d, rel, 1, first.bound, undefined, d.from(keysOf[rel]))
	return {
		matches: [
			{ rel, copy: 0, bindings: first.bindings },
			{ rel, copy: 1, bindings: second.bindings }
		],
		bound: second.bound
	}
}

/** A drawn rule, and whether it is a pinned self-join, which no union's arm is. */
interface DrawnRule {
	readonly rule: RuleSpec
	readonly pinned: boolean
}

/**
 * A rule: its matches, its filters and its head, over the variables its matches bind. A second match may be a pinned
 * self-join's (pinnedMatches), the rule's matches alone; any other rule's are drawn, and its last, under
 * constantAtUnionSource, is Tones with a constant bound at tone, a handle or its member's JavaScript value, which
 * selects the arm holding it.
 */
const drawRule = (d: Drawing): DrawnRule => {
	const anchor = anchorOf(d)
	const second = d.keep("secondMatch")
	const pinned = second && d.keep("pinnedSelfJoin")
	const { matches, bound } = pinned ? pinnedMatches(d, anchor) : drawnMatches(d, anchor, second)
	const atUnion: ReadonlyArray<Match> =
		!pinned && d.keep("constantAtUnionSource")
			? [{ rel: "Tones", copy: 0, bindings: [["tone", tonesConstant(d)]] }]
			: []
	return {
		rule: {
			matches: Arr.appendAll(matches, atUnion),
			filters: [...anchorFilters(d, anchor), ...filtersOver(d, bound)],
			head: headOver(d, bound)
		},
		pinned
	}
}

/** A constant some arm of Tones holds at tone: low or mid, as a handle or as the member's JavaScript value. */
const tonesConstant = (d: Drawing): Term => {
	const value = d.from([0, 1])
	return d.from([0, 1]) === 0 ? { kind: "handle", value } : { kind: "literal", type: "enum", value }
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
			b: d.from([0, 1]) === 0 ? literalOf(d, "int") : { kind: "constant", value: d.from([1, 2]) },
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
			["literalHead", () => ({ kind: "literal", value: d.from([0, 1, "a", "b"]) })],
			["constantHead", () => ({ kind: "term", t: handleOf(d) })]
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
			case "handle":
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
		head: Arr.map(arm.head, ([n, h]) => [n, head(h)] as const)
	}
}

const discriminated = (arm: RuleSpec, value: HeadTerm): RuleSpec => ({
	...arm,
	head: [...arm.head, ["d", value]]
})

/**
 * A union's two discriminants of Tone: the first arm's a handle, the second arm's a handle or its member's JavaScript
 * value, which the first arm's enum types.
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
 * The query a drawing draws: a rule, a union of it with its renamed twin, and a take that closes it. A handle
 * discriminant is drawn first, so a case that keeps it is a discriminated union whatever the union's own gates draw. A
 * pinned self-join is no union's arm, so its get is proved whatever the rest of the case draws.
 */
const drawQuery = (d: Drawing): QuerySpec => {
	const { rule: first, pinned } = drawRule(d)
	const handled = !pinned && d.keep("handleDiscriminant")
	if (handled) {
		d.note("union")
		d.note("discriminant")
	}
	const union = handled || (!pinned && d.keep("union"))
	const tagged = handled
		? handleDiscriminants(d)
		: union && d.keep("discriminant")
			? literalDiscriminants
			: undefined
	const arms: Arr.NonEmptyReadonlyArray<RuleSpec> = union
		? tagged !== undefined
			? [discriminated(first, tagged[0]), discriminated(secondArm(first), tagged[1])]
			: [first, secondArm(first)]
		: [first]
	const take = d.keep("take") ? d.from([1, 2] as const) : undefined
	return { arms, take }
}

const uuidOf = (value: number): string =>
	`00000000-0000-4000-8000-${pipe(String(value), Str.padStart(12, "0"))}`

/** The words that name the second and third scope of one relation in a rule. */
const ordinals = ["second", "third"] as const

/**
 * A variable's scope name, which the program also declares its variables under: its relation's name in lower camel
 * case for the first match of it, prefixed by the ordinal of its match after that, as a reader would name two scopes
 * of one relation by role.
 */
const varName = (v: Var): string =>
	v.copy === 0
		? Str.uncapitalize(v.field.rel)
		: `${defined(ordinals[v.copy - 1], "a third match at most")}${v.field.rel}`

/** The names a rendered query imports beside query and Agree. */
type Imported = "Compute" | "pg" | "v" | "Tone" | MatchSource

/** The source of one query, with the names it imports. */
class Rendering {
	readonly uses = new Set<Imported>()

	term(t: Term): string {
		switch (t.kind) {
			case "var":
				return `${varName(t.v)}.${t.v.field.name}`
			case "param":
				this.uses.add(t.at.rel)
				return `r.param(${jsonText(t.name)}, ${t.at.rel}.fields.${t.at.name})`
			case "literal":
				return t.type === "int"
					? String(t.value)
					: jsonText(t.type === "uuid" ? uuidOf(t.value) : toneOf(t.value))
			case "constant":
				this.uses.add("Compute")
				this.uses.add("pg")
				return `Compute.literal(pg.integer, ${t.value})`
			case "handle":
				this.uses.add("Tone")
				return `Tone.handle(${jsonText(toneOf(t.value))})`
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
			case "literal":
				return jsonText(h.value)
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
			return `\t\tconst ${varName(v)} = v(${v.field.rel}, ${jsonText(varName(v))})`
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
				: [`\t.orderBy([${jsonText(first)}, "asc"])`, `\t.take(${spec.take})`]
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
			case "handle":
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
			const vars = minted.get(name) ?? varsOver(sources[v.field.rel], name)
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
					return t.type === "int" ? t.value : t.type === "uuid" ? uuidOf(t.value) : toneOf(t.value)
				case "constant":
					return computeCore.literal(pg.integer, t.value)
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
			? matched.where(...argumentsOf(Arr.map(arm.filters, pred)))
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
interface Verdict {
	readonly get: boolean
	readonly keys: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>
}

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
 * One drawn query: its source, the engine's verdict, which the program asserts of the types exactly, a self-join's
 * included, and what it reached.
 */
interface AgreementCase {
	readonly spec: QuerySpec
	readonly source: string
	readonly uses: ReadonlySet<Imported>
	readonly verdict: Verdict
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
	const heading = Arr.length(defined(spec.arms[0], "the first arm").head)
	const notes = new Set<AgreementNote>(reached)
	notes.add(verdict.get ? "get proved" : "get refused")
	if (Arr.some(verdict.keys, (k) => k.length < heading)) {
		notes.add("a key below the heading")
	}
	if (Arr.some(spec.arms, fixedTwice)) {
		notes.add("a variable two filters fix")
	}
	return { spec, source, uses: rendering.uses, verdict, notes }
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
					? [varName(v.v)]
					: []
			return p.op === "eq" ? [...fixedWith(p.a, p.b), ...fixedWith(p.b, p.a)] : []
		}
		case "and":
			return [...fixedBy(p.ps[0]), ...fixedBy(p.ps[1])]
		case "or":
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
	p.kind === "cmp" ? p : { ...p, ps: [swapped(p.ps[1]), swapped(p.ps[0])] }

/** A query with each rule's filters, and every connective's operands, in the other order. */
const reordered = (spec: QuerySpec): QuerySpec => ({
	...spec,
	arms: Arr.map(spec.arms, (arm) => ({
		...arm,
		filters: Arr.reverse(Arr.map(arm.filters, swapped))
	}))
})

/** A verdict as text: whether get reads the query, and its keys as a set. */
const verdictText = (v: Verdict): string =>
	`get ${v.get ? "proved" : "refused"}, keys ${jsonText(
		Arr.sort(
			Arr.map(v.keys, (k) => jsonText(k)),
			Str.Order
		)
	)}`

/** The queries the run's own stream draws. */
export const agreementCount = 240

/** The label both populations are drawn under. */
const agreementLabel = "types/evidence agreement"

/** One case: a drawn query and what the engine says of it. */
const caseGen: Gen<AgreementCase> = (source) => caseOf(drawnGen(source))

/** What a case reached: its notes, and each required pair of them it notes together (agreementPairs). */
const reachedBy = (c: AgreementCase): ReadonlyArray<Reached<AgreementNote>> => [
	...c.notes,
	...Arr.filter(agreementPairs, ([a, b]) => c.notes.has(a) && c.notes.has(b))
]

/**
 * The floor's witnesses: a quarter of the run's count, drawn under the label alone, the same in every run, and the only
 * cases whose constructs and verdicts meet the required situations (test/types/evidence/agreement.test.ts).
 */
export const agreementWitnesses = () =>
	floorPopulation(agreementLabel, caseGen, agreementCount / 4, reachedBy)

/**
 * Every case the program holds: the floor's witnesses, then the stream of the agreement's label under the run's seed
 * (`TEST_SEED`, or the seed the run drew), so every process of one run draws the same cases and every run new ones.
 */
const agreementCases = (seed: number): ReadonlyArray<AgreementCase> => [
	...agreementWitnesses().values,
	...sample(caseGen, rotatingSeed(seed, floorSeed(agreementLabel)), agreementCount)
]

/**
 * The run's cases whose verdict moves when each rule's filters are written in the other order (reordered): none, since
 * the order of a rule's filters is no part of what it means, so a value two filters fix a variable to is one value
 * whichever comes first. Each is its source with its two verdicts.
 */
export const reorderedVerdicts = (seed: number): ReadonlyArray<string> =>
	Arr.flatMap(agreementCases(seed), (c) => {
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
	declare: entry("packages/engine/src/public/schema.ts"),
	schema: entry("test/support/agreement/schema.ts")
})

/**
 * The program over the run's cases, as four modules:
 * - index.ts, every case's query in the drawn order, the get the types must accept or refuse (a refusal under its
 *   directive, which the type-test batch disarms), and the assertion that every key the types claim lies over one the
 *   engine proves;
 * - order.ts, the same in a second order drawn from the run's stream;
 * - invariance.ts, every query's head and keys asserted equal across the two orders;
 * - admission.ts, the admission agreement over every position and constant kind (./admission.ts), its constants drawn
 *   from the run's stream, and over every combinator on every shape of query.
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
	return [
		{ file: "index.ts", source: programOf(entries, cases, indices) },
		{ file: "order.ts", source: programOf(entries, cases, order) },
		{ file: "invariance.ts", source: invarianceOf(entries, cases) },
		{ file: "admission.ts", source: admissionModule(entries, cells, combinatorCells()) }
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

const programOf = (
	entries: AgreementEntries,
	cases: ReadonlyArray<AgreementCase>,
	order: ReadonlyArray<number>
): string => {
	const uses = new Set(Arr.flatMap(cases, (c) => [...c.uses]))
	const schemaNames = [
		"Agree",
		...(uses.has("Tone") ? ["Tone"] : []),
		...Arr.filter([...rels, "Tones"] as const, (source) => uses.has(source))
	]
	const blocks = Arr.map(order, (i) => {
		const c = defined(cases[i], "a case of the drawn order")
		const keys = keysType(c.verdict.keys)
		return Arr.join(
			[
				`/** The engine ${c.verdict.get ? "proves" : "refuses"} get; its keys: ${keys}. */`,
				`export const q${i} = ${c.source}`,
				`export const g${i} = (db: DbOf<typeof Reader, unknown>) => (args: GetArg<typeof q${i}>) =>`,
				...(c.verdict.get ? [] : [`\t// @ts-expect-error -- TS2345 refusal: ${getRefusal}`]),
				`\tdb.get(q${i}, args)`,
				`export type k${i} = Expect<Equals<Unproved<typeof q${i}, ${keys}>, never>>`,
				""
			],
			"\n"
		)
	})
	return Arr.join(
		[
			"// Generated by test/support/agreement/queries.ts: the type/engine agreement program.",
			...(uses.has("Compute") ? [`import { Compute } from ${jsonText(entries.compute)}`] : []),
			...(uses.has("pg") ? [`import { pg } from ${jsonText(entries.fields)}`] : []),
			`import { type EvidenceOfQuery, query${uses.has("v") ? ", v" : ""} } from ${jsonText(entries.query)}`,
			`import type { DbOf, GetArg } from ${jsonText(entries.db)}`,
			`import { role } from ${jsonText(entries.declare)}`,
			`import { ${Arr.join(schemaNames, ", ")} } from ${jsonText(entries.schema)}`,
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
