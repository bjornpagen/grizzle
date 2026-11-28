/** What the properties of families.test.ts read: its spaces, models and helpers. */

import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { type CorruptedFeature, type Corruption } from "@bjornpagen/testing/lsw"
import type { Case } from "@bjornpagen/testing/property"
import { bigint } from "@bjornpagen/testing/values"
import { Array as Arr, Option, Record as Rec } from "effect"
import { familyShape, type RidingSide } from "#compiler/analysis/theory/families.ts"
import type { LawDetail } from "#compiler/analysis/theory/laws.ts"
import type { Theory } from "#compiler/analysis/theory/theory.ts"
import {
	type CompareOp,
	compareOps,
	type ExprDesc,
	type FieldDesc,
	type LiteralDesc,
	type SideDesc,
	type StatementDesc,
	type TermDesc
} from "#compiler/ir/desc.ts"
import type { AxisKind, AxisPair } from "#compiler/ir/family.ts"
import type { NativeColumn } from "#compiler/ir/law.ts"
import {
	f,
	type FixtureField,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import {
	accumulatedOf,
	decodedStatements,
	drawnNatural,
	lawOfShape,
	naturalDesc,
	relationsOf,
	schemaOf,
	theoryOf
} from "#test/support/unit/analysis/theory/support.ts"
import { upTo } from "#test/support/up-to.ts"

export const field = (name: string): TermDesc => ({ kind: "field", field: name })

const pred = (name: string): TermDesc => ({ kind: "pred", field: name })

const literal0: ExprDesc = { kind: "literal", value: 0n }

const compare = (op: CompareOp, left: ExprDesc, right: ExprDesc): ExprDesc => ({
	kind: "compare",
	op,
	left,
	right
})

const fieldExpr = (name: string): ExprDesc => ({ kind: "field", field: name })

/** The one family statement of a decoded schema. */
const familyStatementOf = (
	desc: SchemaDesc
): Extract<StatementDesc, { readonly kind: "family" }> => {
	const s = Arr.findFirst(
		decodedStatements(desc),
		(x): x is Extract<StatementDesc, { readonly kind: "family" }> => x.kind === "family"
	)
	if (Option.isNone(s)) {
		return assert.fail("the schema states a family")
	}
	return s.value
}

/** The one tree statement of a decoded schema. */
export const treeStatementOf = (
	desc: SchemaDesc
): Extract<StatementDesc, { readonly kind: "tree" }> => {
	const s = Arr.findFirst(
		decodedStatements(desc),
		(x): x is Extract<StatementDesc, { readonly kind: "tree" }> => x.kind === "tree"
	)
	if (Option.isNone(s)) {
		return assert.fail("the schema states a tree")
	}
	return s.value
}

/** A native column by what it names: a field by its name, a law column by its identifier. */
export const columnText = (c: NativeColumn): string =>
	c.kind === "field" ? c.field.name : `‹${c.column}›`

/** An axis's carried pairs by what they name, `from→to`. */
const pairsText = (pairs: ReadonlyArray<AxisPair>): ReadonlyArray<string> =>
	Arr.map(pairs, (p) => `${columnText(p.from)}→${columnText(p.to)}`)

/** The two relations of the riding box: an owner O and its ordered family's members F. */
type Rel = "O" | "F"

/**
 * O(id, n drawn, k) owns F(fid, o, at drawn, w) by ordered(on(F, o, at), fin(O, n)): the box's schema, F with `was`, a
 * natural accumulated from 0, where `was` holds. Its uuid fields pair with uuid fields, its naturals and their preds
 * with naturals.
 */
export const ridingSchema = (was: boolean, statements: SchemaDesc["statements"]): SchemaDesc =>
	schemaOf(
		[
			relation("O", { id: f.uuid, n: drawnNatural, k: naturalDesc }, ["id"]),
			relation(
				"F",
				{
					fid: f.uuid,
					o: f.uuid,
					at: drawnNatural,
					w: naturalDesc,
					...(was ? { was: accumulatedOf(naturalDesc, 0n) } : {})
				},
				["fid"]
			)
		],
		[
			{
				kind: "family",
				order: "ordered",
				member: on("F", ["o", "at"]),
				slots: { owner: "O", count: "n" }
			},
			...statements
		]
	)

const uuidTerms: Readonly<Record<Rel, ReadonlyArray<TermDesc>>> = {
	O: [field("id")],
	F: [field("o"), field("fid")]
}

/** The natural terms of a relation of the box: F's `was` among them where F has it. */
const naturalTerms = (rel: Rel, was: boolean): ReadonlyArray<TermDesc> =>
	rel === "O"
		? [field("n"), field("k"), pred("n")]
		: [field("at"), field("w"), pred("at"), ...(was ? [field("was")] : [])]

/** The selection a selected side of the box reads: one field fixed to 0. */
const selectionOf: Readonly<Record<Rel, ExprDesc>> = {
	O: compare("eq", fieldExpr("k"), literal0),
	F: compare("eq", fieldExpr("w"), literal0)
}

/** One containment of the box: its two relations, whether each side selects, and its typed pairs. */
export interface RideCase {
	readonly left: Rel
	readonly right: Rel
	readonly leftSelected: boolean
	readonly rightSelected: boolean
	readonly pairs: ReadonlyArray<readonly [TermDesc, TermDesc]>
}

/** Every pair of two terms of one type from `left` to `right`. */
const typedPairs = (
	left: Rel,
	right: Rel,
	was: boolean
): Arr.NonEmptyReadonlyArray<readonly [TermDesc, TermDesc]> =>
	nonEmpty(
		[
			...Arr.flatMap(uuidTerms[left], (l) => Arr.map(uuidTerms[right], (r) => [l, r] as const)),
			...Arr.flatMap(naturalTerms(left, was), (l) =>
				Arr.map(naturalTerms(right, was), (r) => [l, r] as const)
			)
		],
		"a typed pair"
	)

/** Every containment over the box's two relations with at most three pairs, each pair of two terms of one type. */
const boxCase =
	(was: boolean): Gen<RideCase> =>
	(source) => {
		const left = element(["F", "O"] as const)(source)
		const right = element(["O", "F"] as const)(source)
		const leftSelected = boolean(source)
		const rightSelected = boolean(source)
		const width = int(1, 3)(source)
		const options = typedPairs(left, right, was)
		const pairs = upTo(width, () => defined(options[source.pick(0, options.length - 1)]))
		return { left, right, leftSelected, rightSelected, pairs }
	}

/** The box over the fields of a family without accumulated fields. */
export const rideCase: Gen<RideCase> = boxCase(false)

/** A containment of the box as its statement reads, so two equal statements, which are one, are one text. */
export const containmentText = (c: RideCase): string =>
	`${c.left}${c.leftSelected ? " selected" : ""} ⊆ ${c.right}${c.rightSelected ? " selected" : ""}: ${Arr.join(
		Arr.map(c.pairs, ([l, r]) => `${l.kind} ${l.field} → ${r.kind} ${r.field}`),
		", "
	)}`

/** A side of the box: its relation's terms, over every fact or the box's selection of it. */
export const sideOf = (rel: Rel, selected: boolean, terms: ReadonlyArray<TermDesc>): SideDesc =>
	selected ? onWhere(rel, terms, selectionOf[rel]) : on(rel, terms)

/** The axis a containment law lowers onto, `own` for its own native. */
export const axisOf = (detail: LawDetail): string =>
	detail.kind === "containment"
		? detail.lowers.kind === "own"
			? "own"
			: detail.lowers.axis
		: "none"

/** An axis as §2.1's table states it over the box: its source's and target's relations and key terms. */
interface AxisRule {
	readonly axis: AxisKind
	readonly source: Rel
	readonly target: Rel
	readonly sourceKey: ReadonlyArray<TermDesc>
	readonly targetKey: ReadonlyArray<TermDesc>
}

/** The box's family's three axes, in §2.1's order: owner, predecessor, last. */
const boxAxes: Arr.NonEmptyReadonlyArray<AxisRule> = [
	{ axis: "owner", source: "F", target: "O", sourceKey: [field("o")], targetKey: [field("id")] },
	{
		axis: "predecessor",
		source: "F",
		target: "F",
		sourceKey: [field("o"), pred("at")],
		targetKey: [field("o"), field("at")]
	},
	{
		axis: "last",
		source: "O",
		target: "F",
		sourceKey: [field("id"), pred("n")],
		targetKey: [field("o"), field("at")]
	}
]

const sameTerm = (a: TermDesc, b: TermDesc): boolean => a.kind === b.kind && a.field === b.field

/** What §2.1's rule says of a containment: the axis it rides, or why it rides none. */
type Verdict =
	| { readonly kind: "rides"; readonly axis: AxisKind; readonly width: number }
	| {
			readonly kind: "own"
			readonly near: "a wrong selection" | "a reordered key" | "a carried pred term" | "no axis"
	  }

/**
 * §2.1's rule, written again over the box's descriptions: a containment rides the first axis whose source is its left
 * side's relation and whose target its right's, each reading every fact (the family's members are every fact), whose
 * key terms begin its pairs in order, after which every pair is of two field terms. A near miss is named: the key
 * matched under a selection, the key's terms in another order, or a pred term carried.
 */
export const ruleOf = (c: RideCase): Verdict => {
	let near: Extract<Verdict, { readonly kind: "own" }>["near"] = "no axis"
	for (const a of boxAxes) {
		if (c.left !== a.source || c.right !== a.target || c.pairs.length < a.sourceKey.length) {
			continue
		}
		const width = a.sourceKey.length
		const head = Arr.take(c.pairs, width)
		const keyed = Arr.every(
			head,
			([l, r], j) => sameTerm(l, defined(a.sourceKey[j])) && sameTerm(r, defined(a.targetKey[j]))
		)
		const carriedFields = Arr.every(
			Arr.drop(c.pairs, width),
			([l, r]) => l.kind === "field" && r.kind === "field"
		)
		if (keyed && !c.leftSelected && !c.rightSelected && carriedFields) {
			return { kind: "rides", axis: a.axis, width }
		}
		if (keyed && carriedFields) {
			near = "a wrong selection"
		} else if (keyed) {
			near = near === "no axis" ? "a carried pred term" : near
		} else {
			const permuted = Arr.every(a.sourceKey, (t, j) =>
				Arr.some(head, ([l, r]) => sameTerm(l, t) && sameTerm(r, defined(a.targetKey[j])))
			)
			near = permuted && near === "no axis" ? "a reordered key" : near
		}
	}
	return { kind: "own", near }
}

export type RideFeature =
	| "rides owner"
	| "rides predecessor"
	| "rides last"
	| Extract<Verdict, { readonly kind: "own" }>["near"]

const desc = ridingSchema(false, [])

const t = theoryOf(desc)

export const shape = familyShape(familyStatementOf(desc), relationsOf(t))

export const fieldOf = (rel: Rel, name: string) =>
	defined(
		Arr.findFirst(defined(t.relations[rel]).fields, (x) => x.name === name).pipe(
			Option.getOrUndefined
		)
	)

export const ridingSide = (rel: Rel, selected: boolean): RidingSide => ({
	relation: rel,
	selection: { conjuncts: selected ? [{ predicate: selectionOf[rel] }] : [] }
})

/**
 * `count` typed pairs of `options` after `pairs`, each drawn among those whose terms neither side holds yet, as a
 * statement lists each term of a side once; fewer when no such pair is left.
 */
const freshPairs =
	(
		options: ReadonlyArray<readonly [TermDesc, TermDesc]>,
		pairs: ReadonlyArray<readonly [TermDesc, TermDesc]>,
		count: number
	): Gen<ReadonlyArray<readonly [TermDesc, TermDesc]>> =>
	(source) => {
		const out = [...pairs]
		for (let i = 0; i < count; i += 1) {
			const open = Arr.filter(
				options,
				([l, r]) => !Arr.some(out, ([x, y]) => sameTerm(x, l) || sameTerm(y, r))
			)
			if (!Arr.isReadonlyArrayNonEmpty(open)) {
				return out
			}
			out.push(Arr.getUnsafe(open, source.pick(0, open.length - 1)))
		}
		return out
	}

/** A containment of the whole box whose terms are distinct on each side: one to three fresh typed pairs. */
const distinctBoxCase =
	(was: boolean): Gen<RideCase> =>
	(source) => {
		const left = source.draw(element(["F", "O"] as const))
		const right = source.draw(element(["O", "F"] as const))
		return {
			left,
			right,
			leftSelected: source.draw(boolean),
			rightSelected: source.draw(boolean),
			pairs: source.draw(freshPairs(typedPairs(left, right, was), [], source.draw(int(1, 3))))
		}
	}

/**
 * A containment aimed at an axis whose terms are distinct on each side: its key pairs in order or reversed, then up
 * to two fresh typed pairs, each side selected one draw in four.
 */
const distinctAimedCase =
	(was: boolean): Gen<RideCase> =>
	(source) => {
		const axis = source.draw(element(boxAxes))
		const key = Arr.zip(axis.sourceKey, axis.targetKey)
		return {
			left: axis.source,
			right: axis.target,
			leftSelected: source.draw(int(0, 3)) === 0,
			rightSelected: source.draw(int(0, 3)) === 0,
			pairs: source.draw(
				freshPairs(
					typedPairs(axis.source, axis.target, was),
					source.draw(int(0, 3)) === 0 ? Arr.reverse(key) : key,
					source.draw(int(0, 2))
				)
			)
		}
	}

/** A containment of the box, aimed at an axis or drawn from the whole box, its terms distinct on each side. */
export const ridingCase = (was: boolean): Gen<RideCase> =>
	weighted([
		[1, distinctBoxCase(was)],
		[3, distinctAimedCase(was)]
	])

/**
 * Two containments that ride one axis by construction, its key in order and no side selected, the second the first
 * with one more fresh field pair after its own: two statements that share every pair the first carries, so two laws
 * carry each of them. The first fills `was` half the time where the axis's source holds it and it is not carried
 * already, and so the second does too. Every pair is fresh (freshPairs); the second is left out where no field pair
 * is fresh.
 */
export const extendedCases =
	(was: boolean): Gen<ReadonlyArray<RideCase>> =>
	(source) => {
		const axis = source.draw(element(boxAxes))
		const fieldPairs = nonEmpty(
			Arr.filter(
				typedPairs(axis.source, axis.target, was),
				([l, r]) =>
					l.kind === "field" &&
					r.kind === "field" &&
					!Arr.some(axis.sourceKey, (t) => sameTerm(t, l)) &&
					!Arr.some(axis.targetKey, (t) => sameTerm(t, r))
			),
			"a field pair beside the axis's key"
		)
		const carried = source.draw(
			freshPairs(fieldPairs, Arr.zip(axis.sourceKey, axis.targetKey), source.draw(int(1, 2)))
		)
		const fillings = Arr.filter(fieldPairs, ([l]) => l.field === "was")
		const first: RideCase = {
			left: axis.source,
			right: axis.target,
			leftSelected: false,
			rightSelected: false,
			pairs: source.draw(boolean) ? source.draw(freshPairs(fillings, carried, 1)) : carried
		}
		const extended = source.draw(freshPairs(fieldPairs, first.pairs, 1))
		return extended.length > first.pairs.length ? [first, { ...first, pairs: extended }] : [first]
	}

export type TheoryRideFeature =
	| RideFeature
	| "a pair two laws carry"
	| "a key carried alone"
	| "an accumulated field one statement fills"
	| "an accumulated field no statement fills"
	| "an accumulated field two statements fill"
	| "an accumulated field its filler copies from its own predecessor"

export const treeDesc = schemaOf(
	[
		relation(
			"T",
			{
				doc: f.uuid,
				parent: drawnNatural,
				kind: naturalDesc,
				at: drawnNatural,
				children: drawnNatural,
				start: drawnNatural,
				end: drawnNatural
			},
			["doc", "start"]
		)
	],
	[
		{
			kind: "tree",
			member: on("T", ["parent", "at"]),
			slots: { owner: "T", count: "children" },
			root: ["doc"]
		}
	]
)

/** A comparison of a tree's drawn field with a small literal, either way round. */
interface Comparison {
	readonly op: CompareOp
	readonly field: "start" | "at"
	readonly literal: bigint
	readonly fieldLeft: boolean
}

export const comparisonGen: Gen<Comparison> = (source) => ({
	op: source.draw(element(compareOps)),
	field: source.draw(boolean) ? "start" : "at",
	literal: source.draw(bigint(0n, 2n)),
	fieldLeft: source.draw(boolean)
})

export const conjunctOf = (c: Comparison): ExprDesc => {
	const literal: ExprDesc = { kind: "literal", value: c.literal }
	return c.fieldLeft
		? compare(c.op, fieldExpr(c.field), literal)
		: compare(c.op, literal, fieldExpr(c.field))
}

/** Whether `l op r` holds of two integers. */
const holds = (op: CompareOp, l: bigint, r: bigint): boolean => {
	switch (op) {
		case "eq":
			return l === r
		case "ne":
			return l !== r
		case "lt":
			return l < r
		case "le":
			return l <= r
		case "gt":
			return l > r
		case "ge":
			return l >= r
	}
}

/**
 * Whether a selection selects exactly the tree's members, start above zero, over the naturals: start and at over
 * 0..3, past every literal the box draws.
 */
export const selectsMembers = (conjuncts: ReadonlyArray<Comparison>): boolean =>
	Arr.every(Arr.range(0, 3), (start) =>
		Arr.every(Arr.range(0, 3), (at) => {
			const value = (c: Comparison): bigint => BigInt(c.field === "start" ? start : at)
			const selected = Arr.every(conjuncts, (c) =>
				c.fieldLeft ? holds(c.op, value(c), c.literal) : holds(c.op, c.literal, value(c))
			)
			return selected === start > 0
		})
	)

/** The type of an owner's key fields and its members' group fields. */
type KeyType = "uuid" | "bigint"

/** A fold over a family: none, or a sum of F's x into O's total, its accumulators named on the step side or hidden. */
type FoldCase = "no fold" | "named accumulators" | "hidden accumulators"

/** A lawful family as the resolution box states it: its order, its group's width and key type and its fold, or a tree. */
type FamilyCase =
	| {
			readonly kind: "family"
			readonly order: "ordered" | "counted"
			readonly width: number
			readonly keyType: KeyType
			readonly fold: FoldCase
	  }
	| { readonly kind: "tree" }

/** Every lawful case of the box: a counted family hides its accumulators, so only an ordered one names them. */
export const familyCaseGen: Gen<FamilyCase> = (source) => {
	if (source.draw(boolean)) {
		return { kind: "tree" }
	}
	const order = source.draw(boolean) ? "ordered" : "counted"
	const fold = source.draw(int(0, order === "ordered" ? 2 : 1))
	return {
		kind: "family",
		order,
		width: source.draw(int(1, 3)),
		keyType: source.draw(boolean) ? "bigint" : "uuid",
		fold: fold === 0 ? "no fold" : fold === 1 ? "hidden accumulators" : "named accumulators"
	}
}

const ownerKeys = ["a", "b", "c"] as const

const groupFields = ["ga", "gb", "gc"] as const

/** The field descriptor of a key type. */
const keyField = (t: KeyType): FieldDesc => (t === "uuid" ? f.uuid : f.bigint)

/**
 * The parts of a family case's schema: O keyed by its group's width, F its members, a sum fold of F's x into O's total
 * where it states one; or one tree relation T. A corruption edits these parts and builds the schema from them.
 */
interface Parts {
	readonly relations: SchemaDesc["relations"]
	readonly statements: SchemaDesc["statements"]
}

const treeRelation = (fields: Readonly<Record<string, FixtureField>>, key: ReadonlyArray<string>) =>
	relation(
		"T",
		{
			doc: f.uuid,
			parent: drawnNatural,
			at: drawnNatural,
			children: drawnNatural,
			start: drawnNatural,
			end: drawnNatural,
			...fields
		},
		key
	)

/** A tree's key: its root field, then its start. */
const treeKey = ["doc", "start"] as const

const treeStatement: SchemaDesc["statements"][number] = {
	kind: "tree",
	member: on("T", ["parent", "at"]),
	slots: { owner: "T", count: "children" },
	root: ["doc"]
}

/** A family case's group fields and its owner's key fields, in key order. */
const keysOf = (c: Extract<FamilyCase, { readonly kind: "family" }>) =>
	[Arr.take(groupFields, c.width), Arr.take(ownerKeys, c.width)] as const

/** The relations and statements of a family case, the fold's accumulators starting at `start`, typed `step`. */
const familyParts = (
	c: Extract<FamilyCase, { readonly kind: "family" }>,
	step: FieldDesc,
	start: LiteralDesc
): Parts => {
	const [group, keys] = keysOf(c)
	const folds = c.fold !== "no fold"
	const named = c.fold === "named accumulators"
	return {
		relations: [
			relation(
				"O",
				{
					...Rec.fromEntries(Arr.map(keys, (k) => [k, keyField(c.keyType)] as const)),
					n: drawnNatural,
					...(folds ? { total: accumulatedOf(step, start) } : {})
				},
				keys
			),
			relation(
				"F",
				{
					fid: f.uuid,
					...Rec.fromEntries(Arr.map(group, (g) => [g, keyField(c.keyType)] as const)),
					...(c.order === "ordered" ? { at: drawnNatural } : {}),
					...(folds ? { x: step } : {}),
					...(named
						? { before: accumulatedOf(step, start), after: accumulatedOf(step, start) }
						: {})
				},
				["fid"]
			)
		],
		statements: [
			{
				kind: "family",
				order: c.order,
				member: on("F", c.order === "ordered" ? [...group, "at"] : group),
				slots: { owner: "O", count: "n" }
			},
			...(folds
				? [
						{
							kind: "fold" as const,
							family: { owner: "O", count: "n" },
							monoid: "sum" as const,
							step: on("F", named ? [...group, "x", "before", "after"] : [...group, "x"]),
							end: on("O", [...keys, "total"])
						}
					]
				: [])
		]
	}
}

export const partsOf = (c: FamilyCase): Parts =>
	c.kind === "tree"
		? { relations: [treeRelation({}, treeKey)], statements: [treeStatement] }
		: familyParts(c, f.bigint, 0n)

export const schemaOfParts = (parts: Parts): SchemaDesc =>
	schemaOf(parts.relations, parts.statements)

/** Where a refusal is stated: a statement, or the field it names. */
type RefusedAt = Readonly<{ kind: "statement" }> | Readonly<{ kind: "field"; field: string }>

/** A corrupted schema as the theory is handed it, and where its refusal is stated. */
type Refused = Readonly<{ schema: SchemaDesc; at: RefusedAt }>

/** The refusals §3.7 and rows-first §4 name, each a corruption of a lawful family case. */
type Refusal =
	| "a start off the identity"
	| "a carrier the monoid does not admit"
	| "an accumulator pair over a counted family"
	| "an accumulator with no partner"
	| "a tree keyed by its start before its root"
	| "a tree with no drawn start"
	| "a drawn field no statement names"
	| "a drawn field two families name"
	| "one count counting two families"
	| "a relation in two ordered families"
	| "a relation in a tree and an ordered family"
	| "a group key no caller writes"
	| "a group key of another identity than its owner's key"

const atStatement: RefusedAt = { kind: "statement" }

/** The reason each refusal is: a description's malformation, or a rule the types name too (Refused). */
export const ruleTags: { readonly [R in Refusal]: "MalformedDescription" | "Refused" } = {
	"a start off the identity": "MalformedDescription",
	"a carrier the monoid does not admit": "Refused",
	"an accumulator pair over a counted family": "Refused",
	"an accumulator with no partner": "MalformedDescription",
	"a tree keyed by its start before its root": "Refused",
	"a tree with no drawn start": "Refused",
	"a drawn field no statement names": "MalformedDescription",
	"a drawn field two families name": "MalformedDescription",
	"one count counting two families": "MalformedDescription",
	"a relation in two ordered families": "MalformedDescription",
	"a relation in a tree and an ordered family": "MalformedDescription",
	"a group key no caller writes": "MalformedDescription",
	"a group key of another identity than its owner's key": "Refused"
}

/** One refusal, broken at the one site a case offers it: the corrupted schema, where it is refused, what it breaks. */
const refusal = (
	rule: Refusal,
	applies: (c: FamilyCase) => Parts | undefined,
	at: RefusedAt
): Corruption<FamilyCase, Refused, Refusal> => ({
	rule,
	from: "wild",
	weight: 1,
	sites: (c) => {
		const parts = applies(c)
		if (parts === undefined) {
			return []
		}
		const schema = schemaOfParts(parts)
		return [
			{
				value: schema,
				refusal: { schema, at },
				at: c.kind === "tree" ? "a tree" : `a ${c.order} family`
			}
		]
	}
})

/** The parts of a family case, but its relation `name` with `fields` added or replaced. */
const withFields = (
	parts: Parts,
	name: string,
	fields: Readonly<Record<string, FixtureField>>
): Parts => ({
	...parts,
	relations: Arr.map(parts.relations, (r) =>
		r.name === name && r.kind === "relation"
			? relation(r.name, { ...r.fields, ...fields }, r.primaryKey)
			: r
	)
})

/** A family case's parts with more relations and statements. */
const plus = (
	parts: Parts,
	relations: SchemaDesc["relations"],
	statements: SchemaDesc["statements"]
): Parts => ({
	relations: [...parts.relations, ...relations],
	statements: [...parts.statements, ...statements]
})

export const refusals: Arr.NonEmptyReadonlyArray<Corruption<FamilyCase, Refused, Refusal>> = [
	refusal(
		"a start off the identity",
		(c) => (c.kind === "family" && c.fold !== "no fold" ? familyParts(c, f.bigint, 1n) : undefined),
		atStatement
	),
	refusal(
		"a carrier the monoid does not admit",
		(c) =>
			c.kind === "family" && c.fold !== "no fold" ? familyParts(c, f.pg("real"), 0) : undefined,
		atStatement
	),
	refusal(
		"an accumulator pair over a counted family",
		(c) =>
			c.kind === "family" && c.order === "counted" && c.fold !== "no fold"
				? (() => {
						const parts = withFields(familyParts(c, f.bigint, 0n), "F", {
							before: accumulatedOf(f.bigint, 0n),
							after: accumulatedOf(f.bigint, 0n)
						})
						const [group] = keysOf(c)
						return {
							...parts,
							statements: Arr.map(parts.statements, (st) =>
								st.kind === "fold"
									? { ...st, step: on("F", [...group, "x", "before", "after"]) }
									: st
							)
						}
					})()
				: undefined,
		atStatement
	),
	refusal(
		"an accumulator with no partner",
		(c) =>
			c.kind === "family" && c.fold === "named accumulators"
				? (() => {
						const parts = familyParts(c, f.bigint, 0n)
						const [group] = keysOf(c)
						return {
							...parts,
							statements: Arr.map(parts.statements, (st) =>
								st.kind === "fold" ? { ...st, step: on("F", [...group, "x", "before"]) } : st
							)
						}
					})()
				: undefined,
		atStatement
	),
	refusal(
		"a tree keyed by its start before its root",
		(c) =>
			c.kind === "tree"
				? { relations: [treeRelation({}, ["start", "doc"])], statements: [treeStatement] }
				: undefined,
		atStatement
	),
	refusal(
		"a tree with no drawn start",
		(c) =>
			c.kind === "tree"
				? {
						relations: [treeRelation({ start: naturalDesc }, treeKey)],
						statements: [treeStatement]
					}
				: undefined,
		atStatement
	),
	refusal(
		"a drawn field no statement names",
		(c) => withFields(partsOf(c), c.kind === "tree" ? "T" : "O", { stray: drawnNatural }),
		{ kind: "field", field: "stray" }
	),
	refusal(
		"a drawn field two families name",
		(c) =>
			c.kind === "family" && c.order === "ordered"
				? plus(
						partsOf(c),
						[relation("G", { gid: f.uuid, f: f.uuid }, ["gid"])],
						[
							{
								kind: "family",
								order: "counted",
								member: on("G", ["f"]),
								slots: { owner: "F", count: "at" }
							}
						]
					)
				: undefined,
		{ kind: "field", field: "at" }
	),
	refusal(
		"one count counting two families",
		(c) => {
			if (c.kind === "tree") {
				return plus(
					partsOf(c),
					[relation("G", { gid: f.uuid, d: f.uuid, s: naturalDesc }, ["gid"])],
					[
						{
							kind: "family",
							order: "counted",
							member: on("G", ["d", "s"]),
							slots: { owner: "T", count: "children" }
						}
					]
				)
			}
			const [group] = keysOf(c)
			return plus(
				partsOf(c),
				[
					relation(
						"G",
						{
							gid: f.uuid,
							...Rec.fromEntries(Arr.map(group, (g) => [g, keyField(c.keyType)] as const))
						},
						["gid"]
					)
				],
				[
					{
						kind: "family",
						order: "counted",
						member: on("G", group),
						slots: { owner: "O", count: "n" }
					}
				]
			)
		},
		atStatement
	),
	refusal(
		"a relation in two ordered families",
		(c) => {
			if (c.kind !== "family" || c.order !== "ordered") {
				return undefined
			}
			const [group] = keysOf(c)
			const parts = withFields(withFields(partsOf(c), "O", { m: drawnNatural }), "F", {
				at2: drawnNatural
			})
			return plus(
				parts,
				[],
				[
					{
						kind: "family",
						order: "ordered",
						member: on("F", [...group, "at2"]),
						slots: { owner: "O", count: "m" }
					}
				]
			)
		},
		atStatement
	),
	refusal(
		"a relation in a tree and an ordered family",
		(c) =>
			c.kind === "tree"
				? {
						relations: [
							relation("O", { id: f.uuid, n: drawnNatural }, ["id"]),
							treeRelation({ o: f.uuid, slot: drawnNatural }, treeKey)
						],
						statements: [
							treeStatement,
							{
								kind: "family",
								order: "ordered",
								member: on("T", ["o", "slot"]),
								slots: { owner: "O", count: "n" }
							}
						]
					}
				: undefined,
		atStatement
	),
	refusal(
		"a group key no caller writes",
		(c) =>
			c.kind === "family" && c.keyType === "bigint"
				? withFields(partsOf(c), "F", {
						gz: f.bigint,
						ga: f.generated(f.bigint, { kind: "field", field: "gz" })
					})
				: undefined,
		atStatement
	),
	refusal(
		"a group key of another identity than its owner's key",
		(c) =>
			c.kind === "family"
				? withFields(partsOf(c), "F", { ga: keyField(c.keyType === "uuid" ? "bigint" : "uuid") })
				: undefined,
		atStatement
	)
]

export type FamilyFeature = CorruptedFeature<Refusal> | "ordered" | "counted" | "tree" | FoldCase

/**
 * A lawful family resolves to one Family IR as its statement states it: its slots, its owner and member, its group
 * paired with the owner's key in key order, its index by its order, a tree's root and interval and the pairs its
 * formers ride, and a fold's monoid and planes, a named accumulator its field and a hidden one a drawn law column.
 */
export const resolvesAsStated = (c: FamilyCase, t: Theory, k: Case<FamilyFeature>): void => {
	const [family, ...more] = t.families
	assert.equal(more.length, 0, "one family")
	const fam = defined(family)
	if (c.kind === "tree") {
		k.note("tree")
		assert.deepEqual(fam.id, { owner: "T", count: "children" }, "its slots")
		assert.equal<string>(fam.owner.name, "T", "it is its own owner")
		assert.equal<string>(fam.member.name, "T", "and its own member")
		assert.deepEqual(
			Arr.map(fam.group, (p) => [p.member.name, p.owner.name]),
			[
				["doc", "doc"],
				["parent", "start"]
			],
			"its root field pairs with itself and its parent with its start, its key in key order"
		)
		assert.equal(columnText(fam.shape.index), "at", "its index is at")
		if (fam.shape.kind !== "tree") {
			return assert.fail("a tree's members are every row but its roots")
		}
		assert.deepEqual(
			[
				...Arr.map(fam.shape.root, (r) => r.name),
				fam.shape.parent.name,
				fam.shape.start.name,
				fam.shape.end.name
			],
			["doc", "parent", "start", "end"],
			"its root field, parent and interval"
		)
		const law = lawOfShape(t, "tree").id
		assert.deepEqual(
			pairsText(fam.axes.owner),
			[],
			"T0 and T3's parent start are the owner axis's key, no pair of their own"
		)
		assert.deepEqual(pairsText(fam.axes.predecessor), ["start→end"], "T4 rides the predecessor")
		assert.deepEqual(pairsText(fam.axes.last), ["end→end"], "T5 rides the last")
		for (const p of [...fam.axes.owner, ...fam.axes.predecessor, ...fam.axes.last]) {
			assert.deepEqual(p.laws, [law], "each states the tree's law")
		}
		return
	}
	k.note(c.order)
	k.note(c.fold)
	const [group, keys] = keysOf(c)
	assert.deepEqual(fam.id, { owner: "O", count: "n" }, "its slots")
	assert.equal<string>(fam.owner.name, "O", "its owner")
	assert.equal<string>(fam.member.name, "F", "its member")
	assert.equal(fam.count.name, "n", "its count")
	assert.deepEqual<ReadonlyArray<ReadonlyArray<string>>>(
		Arr.map(fam.group, (p) => [p.member.name, p.owner.name]),
		Arr.map(Arr.zip(group, keys), ([g, key]) => [g, key]),
		"its group pairs with its owner's key, in key order"
	)
	assert.equal(
		fam.shape.index.kind,
		c.order === "ordered" ? "field" : "law",
		"its index arm is its order's"
	)
	if (fam.shape.index.kind === "field") {
		assert.equal(fam.shape.index.field.name, "at", "an ordered index is the side's last term")
	}
	assert.notEqual(fam.shape.kind, "tree", "its members are every fact")
	assert.equal(lawOfShape(t, "family").detail.kind, "family", "its law's detail is the family")
	if (c.fold === "no fold") {
		assert.deepEqual(
			[fam.axes.owner.length, fam.axes.predecessor.length, fam.axes.last.length, fam.folds.length],
			[0, 0, 0, 0],
			"no statement carries anything"
		)
		return
	}
	const [fold, ...otherFolds] = fam.folds
	assert.equal(otherFolds.length, 0, "one fold")
	assert.equal(defined(fold).monoid, "sum", "the fold is its family's")
	assert.equal(
		defined(defined(fold).planes[0]).before.kind,
		c.fold === "named accumulators" ? "field" : "law",
		"a named accumulator is its field, a hidden one a drawn law column"
	)
	assert.equal(lawOfShape(t, "fold").detail.kind, "fold", "its law is the fold")
}
