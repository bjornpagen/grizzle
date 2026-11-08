import { describe, it } from "@effect/vitest"
import { type Case, drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, element, filter, type Gen, int, weighted } from "@grizzle/testing/gen"
import {
	type Corruption,
	type CorruptedFeature,
	corrupted,
	corruptedFeature
} from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import {
	familyShape,
	type RidingPair,
	type RidingSide,
	ridesOf,
	treeShape
} from "#compiler/analysis/theory/families.ts"
import type { LawDetail, TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import type { Theory } from "#compiler/analysis/theory/theory.ts"
import {
	type CompareOp,
	compareOps,
	type ExprDesc,
	type FieldDesc,
	type LiteralDesc,
	type SideDesc,
	type StatementDesc,
	type TermDesc,
	termText
} from "#compiler/ir/desc.ts"
import type { AxisKind, AxisPair } from "#compiler/ir/family.ts"
import type { NativeColumn } from "#compiler/ir/law.ts"
import { assert, defined, nonEmpty, refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import {
	contained,
	f,
	type FixtureField,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import {
	accumulatedOf,
	decodedStatements,
	drawnNatural,
	lawOfShape,
	natural,
	relationsOf,
	schemaOf,
	theoryOf,
	theoryResult
} from "#test/unit/analysis/theory/support.ts"

/**
 * The theory's families (fin.md §4, w4-w7 §2.1 to §2.3, §3.7): every family and tree statement resolves to one Family
 * IR; a containment rides a family axis exactly when §2.1's rule holds, its pairs beyond the axis's key joining the
 * axis's; every drawn and every accumulated field is named by exactly one statement; and the theory refuses what §3.7
 * names. The oracles are §2.1's rule written again over SideDescs, a second implementation the riding box is judged
 * against, and the statements themselves, read as the specification of the IR they resolve to.
 */

const field = (name: string): TermDesc => ({ kind: "field", field: name })
const pred = (name: string): TermDesc => ({ kind: "pred", field: name })
const literal0: ExprDesc = { kind: "literal", value: 0n, type: undefined }
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
const treeStatementOf = (desc: SchemaDesc): Extract<StatementDesc, { readonly kind: "tree" }> => {
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
const columnText = (c: NativeColumn): string =>
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
const ridingSchema = (was: boolean, statements: SchemaDesc["statements"]): SchemaDesc =>
	schemaOf(
		[
			relation("O", { id: f.uuid, n: drawnNatural, k: natural }, ["id"]),
			relation(
				"F",
				{
					fid: f.uuid,
					o: f.uuid,
					at: drawnNatural,
					w: natural,
					...(was ? { was: accumulatedOf(natural, 0n) } : {})
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
interface RideCase {
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
		const pairs = Arr.makeBy(width, () => defined(options[source.pick(0, options.length - 1)]))
		return { left, right, leftSelected, rightSelected, pairs }
	}

/** The box over the fields of a family without accumulated fields. */
const rideCase: Gen<RideCase> = boxCase(false)

/** A containment of the box as its statement reads, so two equal statements, which are one, are one text. */
const containmentText = (c: RideCase): string =>
	`${c.left}${c.leftSelected ? " selected" : ""} ⊆ ${c.right}${c.rightSelected ? " selected" : ""}: ${Arr.join(
		Arr.map(c.pairs, ([l, r]) => `${l.kind} ${l.field} → ${r.kind} ${r.field}`),
		", "
	)}`

/** Whether no term of a side repeats. */
const distinctTerms = (terms: ReadonlyArray<TermDesc>): boolean =>
	new Set(Arr.map(terms, (t) => `${t.kind} ${t.field}`)).size === terms.length

/** A side of the box: its relation's terms, over every fact or the box's selection of it. */
const sideOf = (rel: Rel, selected: boolean, terms: ReadonlyArray<TermDesc>): SideDesc =>
	selected ? onWhere(rel, terms, selectionOf[rel]) : on(rel, terms)

/** The axis a containment law lowers onto, `own` for its own native. */
const axisOf = (detail: LawDetail): string =>
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
const ruleOf = (c: RideCase): Verdict => {
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

type RideFeature =
	| "rides owner"
	| "rides predecessor"
	| "rides last"
	| Extract<Verdict, { readonly kind: "own" }>["near"]

describe("riding a family axis (§2.1)", () => {
	const desc = ridingSchema(false, [])
	const t = theoryOf(desc)
	const shape = familyShape(familyStatementOf(desc), relationsOf(t))
	const fieldOf = (rel: Rel, name: string) =>
		defined(
			Arr.findFirst(defined(t.relations[rel]).fields, (x) => x.name === name).pipe(
				Option.getOrUndefined
			)
		)
	const ridingSide = (rel: Rel, selected: boolean): RidingSide => ({
		relation: rel,
		selection: { conjuncts: selected ? [{ predicate: selectionOf[rel] }] : [] }
	})

	it.effect(
		"a containment rides an axis exactly when §2.1's rule holds, carrying its pairs beyond the key",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/riding",
						generator: rideCase,
						literal: Formatter.format,
						limit: 40_000,
						box: "every containment over O and F of at most three typed pairs, each side selected or not",
						oracle: { kind: "specification", name: "§2.1's riding rule over SideDescs" },
						coverage: requiredInSpace<RideFeature>([
							"rides owner",
							"rides predecessor",
							"rides last",
							"a wrong selection",
							"a reordered key",
							"a carried pred term",
							"no axis"
						]),
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const pairs = Arr.map(c.pairs, ([l, r]): RidingPair => ({
								from: { ...l, column: fieldOf(c.left, l.field) },
								to: { ...r, column: fieldOf(c.right, r.field) }
							}))
							const [first, ...rest] = pairs
							const ride = ridesOf(
								[shape],
								ridingSide(c.left, c.leftSelected),
								ridingSide(c.right, c.rightSelected),
								[defined(first), ...rest]
							)
							const verdict = ruleOf(c)
							if (verdict.kind === "own") {
								k.note(verdict.near)
								assert.equal(ride, undefined, `${Formatter.format(c)} rides no axis`)
								return
							}
							k.note(`rides ${verdict.axis}`)
							assert.equal(ride?.axis, verdict.axis, `${Formatter.format(c)} rides ${verdict.axis}`)
							assert.deepEqual(
								Arr.map(ride?.carried ?? [], (p) => `${p.from.field}→${p.to.field}`),
								Arr.map(Arr.drop(c.pairs, verdict.width), ([l, r]) => `${l.field}→${r.field}`),
								"it carries its pairs after the key"
							)
						})
				)
			)
	)

	/**
	 * A containment of the box aimed at an axis: its key pairs in order or reversed, then up to two typed pairs, each
	 * side selected one draw in four. The uniform box draws an axis's key one case in thousands; these put every axis,
	 * its near misses and two copies of one pair within a small search.
	 */
	const aimedCase =
		(was: boolean): Gen<RideCase> =>
		(source) => {
			const axis = source.draw(element(boxAxes))
			const key = Arr.zip(axis.sourceKey, axis.targetKey)
			const options = typedPairs(axis.source, axis.target, was)
			return {
				left: axis.source,
				right: axis.target,
				leftSelected: source.draw(int(0, 3)) === 0,
				rightSelected: source.draw(int(0, 3)) === 0,
				pairs: [
					...(source.draw(int(0, 3)) === 0 ? Arr.reverse(key) : key),
					...Arr.map(source.draw(array(pickGen, { min: 0, max: 2 })), (pick) =>
						pickFrom(options, pick)
					)
				]
			}
		}

	/** A containment of the box, aimed at an axis or drawn from the whole box, its terms distinct on each side. */
	const ridingCase = (was: boolean): Gen<RideCase> =>
		filter(
			weighted([
				[1, boxCase(was)],
				[3, aimedCase(was)]
			]),
			(c) =>
				distinctTerms(Arr.map(c.pairs, ([l]) => l)) &&
				distinctTerms(Arr.map(c.pairs, ([, r]) => r)),
			16
		)

	/**
	 * Two containments that ride one axis by construction, its key in order and no side selected, the second the first
	 * with one more field pair after its own: two statements that share every pair the first carries, so two laws carry
	 * each of them. The first fills `was` half the time where the axis's source holds it, and so the second does too.
	 */
	const extendedCases =
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
			const [filling, ...fillings] = Arr.filter(fieldPairs, ([l]) => l.field === "was")
			const carried = Arr.map(source.draw(array(pickGen, { min: 1, max: 2 })), (pick) =>
				pickFrom(fieldPairs, pick)
			)
			const first: RideCase = {
				left: axis.source,
				right: axis.target,
				leftSelected: false,
				rightSelected: false,
				pairs: [
					...Arr.zip(axis.sourceKey, axis.targetKey),
					...carried,
					...(filling !== undefined && source.draw(boolean)
						? [pickFrom([filling, ...fillings], source.draw(pickGen))]
						: [])
				]
			}
			const second = {
				...first,
				pairs: [...first.pairs, pickFrom(fieldPairs, source.draw(pickGen))]
			}
			const distinct = (c: RideCase) =>
				distinctTerms(Arr.map(c.pairs, ([l]) => l)) && distinctTerms(Arr.map(c.pairs, ([, r]) => r))
			return Arr.filter([first, second], distinct)
		}

	type TheoryRideFeature =
		| RideFeature
		| "a pair two laws carry"
		| "a key carried alone"
		| "an accumulated field one statement fills"
		| "an accumulated field no statement fills"
		| "an accumulated field two statements fill"

	it.effect(
		"the theory lowers each containment onto the axis §2.1's rule names, its axes carrying exactly the riding pairs, and fills an accumulated field by exactly one",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/analysis/theory/riding-theory",
						literal: Formatter.format,
						draw: drawn((source) => {
							const was = source.draw(boolean)
							return [
								was,
								source.draw(
									weighted([
										[2, array(ridingCase(was), { min: 1, max: 2 })],
										[1, extendedCases(was)]
									])
								)
							] as const
						}),
						runs: 200,
						shrink: completeShrink,
						coverage: required<TheoryRideFeature>(
							[
								"rides owner",
								"rides predecessor",
								"rides last",
								"a wrong selection",
								"a reordered key",
								"a carried pred term",
								"no axis",
								"a pair two laws carry",
								"a key carried alone",
								"an accumulated field one statement fills",
								"an accumulated field no statement fills",
								"an accumulated field two statements fill"
							],
							{ cases: 2000, sense: notesOnly }
						),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: { kind: "specification", name: "§2.1's riding rule and §3.7's one filler" }
					},
					([was, cases], k) =>
						Effect.sync(() => {
							const verdicts = Arr.map(cases, ruleOf)
							const carriedBy = (i: number): ReadonlyArray<readonly [TermDesc, TermDesc]> => {
								const v = defined(verdicts[i])
								return v.kind === "rides" ? Arr.drop(defined(cases[i]).pairs, v.width) : []
							}
							const result = theoryResult(
								ridingSchema(
									was,
									Arr.map(cases, (c) =>
										contained(
											sideOf(
												c.left,
												c.leftSelected,
												Arr.map(c.pairs, ([l]) => l)
											),
											sideOf(
												c.right,
												c.rightSelected,
												Arr.map(c.pairs, ([, r]) => r)
											)
										)
									)
								)
							)
							const fills = new Set(
								Arr.flatMap(cases, (c, i) =>
									Arr.some(carriedBy(i), ([l]) => l.field === "was") ? [containmentText(c)] : []
								)
							)
							if (was && fills.size !== 1) {
								k.note(
									fills.size === 0
										? "an accumulated field no statement fills"
										: "an accumulated field two statements fill"
								)
								assert.deepEqual(
									Arr.takeRight(refusalLoc(refused(result, "MalformedDescription")).path, 2),
									["fields", "was"],
									"refused at the accumulated field"
								)
								return
							}
							if (was) {
								k.note("an accumulated field one statement fills")
							}
							const theory = succeeded(result)
							const family = defined(theory.families[0])
							const containments = Arr.filter(
								theory.laws,
								(law) => law.detail.kind === "containment"
							)
							const termsText = (terms: ReadonlyArray<TermDesc>): string =>
								Arr.join(Arr.map(terms, termText), ", ")
							const states = (detail: LawDetail, c: RideCase): boolean =>
								detail.kind === "containment" &&
								detail.from.relation === c.left &&
								detail.to.relation === c.right &&
								detail.from.selection.conjuncts.length > 0 === c.leftSelected &&
								detail.to.selection.conjuncts.length > 0 === c.rightSelected &&
								termsText(detail.from.terms) === termsText(Arr.map(c.pairs, ([l]) => l)) &&
								termsText(detail.to.terms) === termsText(Arr.map(c.pairs, ([, r]) => r))
							const lawOf = (i: number): TheoryLaw => {
								const [law, ...more] = Arr.filter(containments, (l) =>
									states(l.detail, defined(cases[i]))
								)
								assert.equal(more.length, 0, "each containment is one law")
								return defined(law)
							}
							for (const [i, v] of verdicts.entries()) {
								const law = lawOf(i)
								if (v.kind === "own") {
									k.note(v.near)
									assert.equal(axisOf(law.detail), "own", "it keeps its own native")
									continue
								}
								k.note(`rides ${v.axis}`)
								if (carriedBy(i).length === 0) {
									k.note("a key carried alone")
								}
								assert.equal(axisOf(law.detail), v.axis, `it rides the ${v.axis} axis`)
							}
							for (const axis of ["owner", "predecessor", "last"] as const) {
								const expected = new Map<string, ReadonlySet<string>>()
								for (const [i, v] of verdicts.entries()) {
									if (v.kind !== "rides" || v.axis !== axis) {
										continue
									}
									for (const [l, r] of carriedBy(i)) {
										const pair = `${l.field}→${r.field}`
										expected.set(pair, new Set([...(expected.get(pair) ?? []), lawOf(i).id]))
									}
								}
								const carried = new Map(
									Arr.map(family.axes[axis], (p) => [
										`${columnText(p.from)}→${columnText(p.to)}`,
										new Set<string>(p.laws)
									])
								)
								if (Arr.some(family.axes[axis], (p) => p.laws.length > 1)) {
									k.note("a pair two laws carry")
								}
								assert.deepEqual<ReadonlyMap<string, ReadonlySet<string>>>(
									carried,
									expected,
									`the ${axis} axis carries exactly its riding containments' pairs, each with its laws`
								)
							}
						})
				)
			)
	)

	const treeDesc = schemaOf(
		[
			relation(
				"T",
				{
					id: f.uuid,
					parent: f.uuid,
					doc: f.uuid,
					kind: natural,
					at: drawnNatural,
					children: drawnNatural,
					start: drawnNatural,
					end: drawnNatural
				},
				["id"]
			)
		],
		[
			{
				kind: "tree",
				member: on("T", ["parent", "at"]),
				slots: { owner: "T", count: "children" },
				root: "doc"
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

	const comparisonGen: Gen<Comparison> = (source) => ({
		op: source.draw(element(compareOps)),
		field: source.draw(boolean) ? "start" : "at",
		literal: source.draw(bigint(0n, 2n)),
		fieldLeft: source.draw(boolean)
	})

	const conjunctOf = (c: Comparison): ExprDesc => {
		const literal: ExprDesc = { kind: "literal", value: c.literal, type: undefined }
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
	const selectsMembers = (conjuncts: ReadonlyArray<Comparison>): boolean =>
		Arr.every(Arr.range(0, 3), (start) =>
			Arr.every(Arr.range(0, 3), (at) => {
				const value = (c: Comparison): bigint => BigInt(c.field === "start" ? start : at)
				const selected = Arr.every(conjuncts, (c) =>
					c.fieldLeft ? holds(c.op, value(c), c.literal) : holds(c.op, c.literal, value(c))
				)
				return selected === start > 0
			})
		)

	it.effect(
		"a tree's parent copy rides its owner axis exactly when its selection is one comparison of start with zero that selects the members",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/analysis/theory/riding-tree",
						literal: Formatter.format,
						draw: drawn(array(comparisonGen, { min: 0, max: 2 })),
						runs: 300,
						shrink: completeShrink,
						coverage: required<"rides" | "a wrong selection" | "another spelling of the members">(
							["rides", "a wrong selection", "another spelling of the members"],
							{ cases: 1000, sense: notesOnly }
						),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "specification",
							name: "§2.2: a tree's members are select(T, start > 0), evaluated over the naturals"
						}
					},
					(conjuncts, k) =>
						Effect.sync(() => {
							const tt = theoryOf(treeDesc)
							const tree = treeShape(treeStatementOf(treeDesc), relationsOf(tt))
							const column = (name: string) =>
								defined(
									Arr.findFirst(defined(tt.relations["T"]).fields, (x) => x.name === name).pipe(
										Option.getOrUndefined
									)
								)
							const ride = ridesOf(
								[tree],
								{
									relation: "T",
									selection: {
										conjuncts: Arr.map(conjuncts, (c) => ({ predicate: conjunctOf(c) }))
									}
								},
								{ relation: "T", selection: { conjuncts: [] } },
								[
									{
										from: { ...field("parent"), column: column("parent") },
										to: { ...field("id"), column: column("id") }
									},
									{
										from: { ...field("kind"), column: column("kind") },
										to: { ...field("kind"), column: column("kind") }
									}
								]
							)
							const [only, ...more] = conjuncts
							const spelled =
								only !== undefined &&
								more.length === 0 &&
								only.field === "start" &&
								only.literal === 0n
							const members = selectsMembers(conjuncts)
							if (members && spelled) {
								k.note("rides")
								assert.equal(ride?.axis, "owner", "the tree's members ride its owner axis")
								return
							}
							k.note(members ? "another spelling of the members" : "a wrong selection")
							assert.equal(ride, undefined, "any other selection rides no axis")
						})
				)
			)
	)
})

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
const familyCaseGen: Gen<FamilyCase> = (source) => {
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
			id: f.uuid,
			parent: f.uuid,
			doc: f.uuid,
			at: drawnNatural,
			children: drawnNatural,
			start: drawnNatural,
			end: drawnNatural,
			...fields
		},
		key
	)

const treeStatement: SchemaDesc["statements"][number] = {
	kind: "tree",
	member: on("T", ["parent", "at"]),
	slots: { owner: "T", count: "children" },
	root: "doc"
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

const partsOf = (c: FamilyCase): Parts =>
	c.kind === "tree"
		? { relations: [treeRelation({}, ["id"])], statements: [treeStatement] }
		: familyParts(c, f.bigint, 0n)

const schemaOfParts = (parts: Parts): SchemaDesc => schemaOf(parts.relations, parts.statements)

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
	| "a tree keyed by two fields"
	| "a tree with no drawn start"
	| "a drawn field no statement names"
	| "a drawn field two families name"
	| "one count counting two families"
	| "a relation in two ordered families"
	| "a relation in a tree and an ordered family"
	| "a group key no caller writes"
	| "a group key of another identity than its owner's key"

const atStatement: RefusedAt = { kind: "statement" }

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

const refusals: Arr.NonEmptyReadonlyArray<Corruption<FamilyCase, Refused, Refusal>> = [
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
		"a tree keyed by two fields",
		(c) =>
			c.kind === "tree"
				? { relations: [treeRelation({ id2: f.uuid }, ["id", "id2"])], statements: [treeStatement] }
				: undefined,
		atStatement
	),
	refusal(
		"a tree with no drawn start",
		(c) =>
			c.kind === "tree"
				? { relations: [treeRelation({ start: natural }, ["id"])], statements: [treeStatement] }
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
					[relation("G", { gid: f.uuid, t: f.uuid }, ["gid"])],
					[
						{
							kind: "family",
							order: "counted",
							member: on("G", ["t"]),
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
							treeRelation({ o: f.uuid, slot: drawnNatural }, ["id"])
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
				? withFields(partsOf(c), "F", { ga: f.bigserial })
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

type FamilyFeature = CorruptedFeature<Refusal> | "ordered" | "counted" | "tree" | FoldCase

/**
 * A lawful family resolves to one Family IR as its statement states it: its slots, its owner and member, its group
 * paired with the owner's key in key order, its index by its order, a tree's root and interval and the pairs its
 * formers ride, and a fold's monoid and planes, a named accumulator its field and a hidden one a drawn law column.
 */
const resolvesAsStated = (c: FamilyCase, t: Theory, k: Case<FamilyFeature>): void => {
	const [family, ...more] = t.families
	assert.equal(more.length, 0, "one family")
	const fam = defined(family)
	if (c.kind === "tree") {
		k.note("tree")
		assert.deepEqual(fam.id, { owner: "T", count: "children" }, "its slots")
		assert.equal(fam.owner.name, "T", "it is its own owner")
		assert.equal(fam.member.name, "T", "and its own member")
		assert.deepEqual(
			Arr.map(fam.group, (p) => [p.member.name, p.owner.name]),
			[["parent", "id"]],
			"its parent pairs with its key"
		)
		assert.equal(columnText(fam.index), "at", "its index is at")
		if (fam.members.kind !== "tree") {
			return assert.fail("a tree's members are every row but its root")
		}
		assert.deepEqual(
			[fam.members.root.name, fam.members.start.name, fam.members.end.name],
			["doc", "start", "end"],
			"its root field and interval"
		)
		const law = lawOfShape(t, "tree").id
		const ps = `‹${fam.members.parentStart}›`
		assert.deepEqual(
			pairsText(fam.axes.owner),
			[`${ps}→start`, "doc→doc"],
			"T3 and T0 ride the owner axis"
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
	assert.equal(fam.owner.name, "O", "its owner")
	assert.equal(fam.member.name, "F", "its member")
	assert.equal(fam.count.name, "n", "its count")
	assert.deepEqual<ReadonlyArray<ReadonlyArray<string>>>(
		Arr.map(fam.group, (p) => [p.member.name, p.owner.name]),
		Arr.map(Arr.zip(group, keys), ([g, key]) => [g, key]),
		"its group pairs with its owner's key, in key order"
	)
	assert.equal(
		fam.index.kind,
		c.order === "ordered" ? "field" : "law",
		"its index arm is its order's"
	)
	if (fam.index.kind === "field") {
		assert.equal(fam.index.field.name, "at", "an ordered index is the side's last term")
	}
	assert.equal(fam.members.kind, "every", "its members are every fact")
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

describe("resolution and refusals (§3.4, §3.7, rows-first §4)", () => {
	it.effect(
		"each lawful family and tree resolves to one Family IR as its statement states it, and each named malformation of one is refused where it is stated",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/resolution",
						generator: (source) => source.draw(corrupted(source.draw(familyCaseGen), refusals)),
						literal: Formatter.format,
						limit: 5000,
						box: "ordered and counted families of group width 1 to 3 over uuid and bigint keys, with no fold, a hidden or a named sum, and a tree, each lawful or under each refusal it offers",
						oracle: {
							kind: "specification",
							name: "the statement read as the IR it names (§3.4), and §3.7's refusals"
						},
						coverage: requiredInSpace<FamilyFeature>([
							"live",
							"ordered",
							"counted",
							"tree",
							"no fold",
							"hidden accumulators",
							"named accumulators",
							...Arr.map(refusals, (r): FamilyFeature => `${r.from} ${r.rule}`)
						]),
						caseHang
					},
					(drawnCase, k) =>
						Effect.sync(() => {
							k.note(corruptedFeature(drawnCase))
							if (drawnCase.kind === "live") {
								resolvesAsStated(
									drawnCase.value,
									theoryOf(schemaOfParts(partsOf(drawnCase.value))),
									k
								)
								return
							}
							const at = refusalLoc(
								refused(
									theoryResult(drawnCase.refusal.schema),
									"MalformedDescription",
									`${drawnCase.rule} is refused`
								)
							)
							const stated = drawnCase.refusal.at
							if (stated.kind === "statement") {
								assert.equal(
									at.path[0],
									"statements",
									`${drawnCase.rule} is refused at its statement`
								)
								return
							}
							assert.deepEqual(
								Arr.takeRight(at.path, 2),
								["fields", stated.field],
								`${drawnCase.rule} is refused at ${stated.field}`
							)
						})
				)
			)
	)
})
