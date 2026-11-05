import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import {
	familyShape,
	type RidingPair,
	type RidingSide,
	ridesOf,
	treeShape
} from "#compiler/analysis/theory/families.ts"
import type { LawDetail } from "#compiler/analysis/theory/laws.ts"
import type { Theory } from "#compiler/analysis/theory/theory.ts"
import type { ExprDesc, SideDesc, StatementDesc, TermDesc } from "#compiler/ir/desc.ts"
import type { AxisKind, AxisPair } from "#compiler/ir/family.ts"
import type { NativeColumn } from "#compiler/ir/law.ts"
import { assert, defined, refusalLoc, refused } from "#test/support/assert.ts"
import {
	contained,
	f,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
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
const compare = (
	op: "eq" | "ne" | "gt" | "lt" | "ge",
	left: ExprDesc,
	right: ExprDesc
): ExprDesc => ({
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
 * O(id, n drawn, k) owns F(fid, o, at drawn, w) by ordered(on(F, o, at), fin(O, n)): the box's schema. Its uuid
 * fields pair with uuid fields, its naturals and their preds with naturals.
 */
const ridingSchema = (statements: SchemaDesc["statements"]): SchemaDesc =>
	schemaOf(
		[
			relation("O", { id: f.uuid, n: drawnNatural, k: natural }, ["id"]),
			relation("F", { fid: f.uuid, o: f.uuid, at: drawnNatural, w: natural }, ["fid"])
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
const naturalTerms: Readonly<Record<Rel, ReadonlyArray<TermDesc>>> = {
	O: [field("n"), field("k"), pred("n")],
	F: [field("at"), field("w"), pred("at")]
}
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

/** Every containment over the box's two relations with at most three pairs, each pair of two terms of one type. */
const rideCase: Gen<RideCase> = (source) => {
	const left = element(["F", "O"] as const)(source)
	const right = element(["O", "F"] as const)(source)
	const leftSelected = boolean(source)
	const rightSelected = boolean(source)
	const width = int(1, 3)(source)
	const options: ReadonlyArray<readonly [TermDesc, TermDesc]> = [
		...Arr.flatMap(uuidTerms[left], (l) => Arr.map(uuidTerms[right], (r) => [l, r] as const)),
		...Arr.flatMap(naturalTerms[left], (l) => Arr.map(naturalTerms[right], (r) => [l, r] as const))
	]
	const pairs = Arr.makeBy(width, () => defined(options[source.pick(0, options.length - 1)]))
	return { left, right, leftSelected, rightSelected, pairs }
}

/** An axis as §2.1's table states it over the box: its source's and target's relations and key terms. */
interface AxisRule {
	readonly axis: AxisKind
	readonly source: Rel
	readonly target: Rel
	readonly sourceKey: ReadonlyArray<TermDesc>
	readonly targetKey: ReadonlyArray<TermDesc>
}

/** The box's family's three axes, in §2.1's order: owner, predecessor, last. */
const boxAxes: ReadonlyArray<AxisRule> = [
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
	const desc = ridingSchema([])
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

	/** How a riding containment is spelled: an axis's shape exactly, or one near miss of it. */
	type Spelling =
		| "an owner copy"
		| "a predecessor copy"
		| "a last copy"
		| "a restated lemma"
		| "two copies of one pair"
		| "a wrong selection"
		| "a reordered key"

	it.effect(
		"the theory lowers a riding containment onto its axis, its law on the pairs it carries",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/riding-theory",
						generator: element([
							"an owner copy",
							"a predecessor copy",
							"a last copy",
							"a restated lemma",
							"two copies of one pair",
							"a wrong selection",
							"a reordered key"
						] as const),
						literal: Formatter.format,
						limit: 7,
						box: "each spelling of a containment of an axis's shape, and its near misses",
						oracle: { kind: "specification", name: "§2.1's table and merging rule" },
						coverage: requiredInSpace<Spelling>([
							"an owner copy",
							"a predecessor copy",
							"a last copy",
							"a restated lemma",
							"two copies of one pair",
							"a wrong selection",
							"a reordered key"
						]),
						caseHang
					},
					(spelling, k) =>
						Effect.sync(() => {
							k.note(spelling)
							const statements: ReadonlyArray<readonly [SideDesc, SideDesc]> = ((): ReadonlyArray<
								readonly [SideDesc, SideDesc]
							> => {
								switch (spelling) {
									case "an owner copy":
										return [[on("F", ["o", "w"]), on("O", ["id", "k"])]]
									case "a predecessor copy":
										return [[on("F", ["o", pred("at"), "w"]), on("F", ["o", "at", "w"])]]
									case "a last copy":
										return [[on("O", ["id", pred("n"), "k"]), on("F", ["o", "at", "w"])]]
									case "a restated lemma":
										return [[on("F", ["o"]), on("O", ["id"])]]
									case "two copies of one pair":
										return [
											[on("F", ["o", "w"]), on("O", ["id", "k"])],
											[on("F", ["o", "w", "at"]), on("O", ["id", "k", "n"])]
										]
									case "a wrong selection":
										return [[onWhere("F", ["o", "w"], selectionOf.F), on("O", ["id", "k"])]]
									case "a reordered key":
										return [[on("F", [pred("at"), "o", "w"]), on("F", ["at", "o", "w"])]]
								}
							})()
							const theory = theoryOf(
								ridingSchema(Arr.map(statements, ([l, r]) => contained(l, r)))
							)
							const family = defined(theory.families[0])
							const containments = Arr.filter(
								theory.laws,
								(law) => law.detail.kind === "containment"
							)
							const lowers = Arr.map(containments, (law): LawDetail => law.detail)
							const axisOf = (detail: LawDetail): string =>
								detail.kind === "containment"
									? detail.lowers.kind === "own"
										? "own"
										: detail.lowers.axis
									: "none"
							switch (spelling) {
								case "an owner copy":
								case "a predecessor copy":
								case "a last copy": {
									const axis: AxisKind =
										spelling === "an owner copy"
											? "owner"
											: spelling === "a last copy"
												? "last"
												: "predecessor"
									assert.deepEqual(
										Arr.map(lowers, axisOf),
										[axis],
										`${spelling} rides the ${axis} axis`
									)
									const law = defined(containments[0]).id
									const carried = family.axes[axis]
									assert.deepEqual(
										pairsText(carried),
										[
											spelling === "an owner copy"
												? "w→k"
												: spelling === "a last copy"
													? "k→w"
													: "w→w"
										],
										"the axis carries its pair"
									)
									assert.deepEqual(defined(carried[0]).laws, [law], "and its law")
									return
								}
								case "a restated lemma":
									assert.deepEqual(Arr.map(lowers, axisOf), ["owner"], "it rides the owner axis")
									assert.deepEqual(
										pairsText(family.axes.owner),
										[],
										"carrying nothing beyond the key"
									)
									return
								case "two copies of one pair": {
									assert.deepEqual(
										Arr.map(lowers, axisOf),
										["owner", "owner"],
										"both ride the owner axis"
									)
									const [shared] = family.axes.owner
									const sharedLaws: ReadonlyArray<string> = Arr.sort(
										Arr.map(defined(shared).laws, (law): string => law),
										Order.String
									)
									assert.deepEqual(
										pairsText(family.axes.owner),
										["w→k", "at→n"],
										"the pair they share once"
									)
									assert.deepEqual(
										sharedLaws,
										Arr.sort(
											Arr.map(containments, (law): string => law.id),
											Order.String
										),
										"stating both laws"
									)
									return
								}
								case "a wrong selection":
								case "a reordered key":
									assert.deepEqual(
										Arr.map(lowers, axisOf),
										["own"],
										`${spelling} keeps its own native`
									)
									assert.deepEqual(
										pairsText(family.axes.owner),
										[],
										"the owner axis carries nothing"
									)
									assert.deepEqual(
										pairsText(family.axes.predecessor),
										[],
										"the predecessor axis carries nothing"
									)
							}
						})
				)
			)
	)

	/** A selection of a tree's member side: none, `start > 0` spelled four ways, or one that selects other rows. */
	type TreeSelection =
		| "none"
		| "start > 0"
		| "0 < start"
		| "start <> 0"
		| "0 <> start"
		| "start >= 1"
		| "start > 1"
		| "at > 0"
		| "start > 0 and at > 0"
	const selections: Readonly<Record<TreeSelection, ReadonlyArray<ExprDesc>>> = {
		none: [],
		"start > 0": [compare("gt", fieldExpr("start"), literal0)],
		"0 < start": [compare("lt", literal0, fieldExpr("start"))],
		"start <> 0": [compare("ne", fieldExpr("start"), literal0)],
		"0 <> start": [compare("ne", literal0, fieldExpr("start"))],
		"start >= 1": [
			compare("ge", fieldExpr("start"), { kind: "literal", value: 1n, type: undefined })
		],
		"start > 1": [
			compare("gt", fieldExpr("start"), { kind: "literal", value: 1n, type: undefined })
		],
		"at > 0": [compare("gt", fieldExpr("at"), literal0)],
		"start > 0 and at > 0": [
			compare("gt", fieldExpr("start"), literal0),
			compare("gt", fieldExpr("at"), literal0)
		]
	}
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

	it.effect(
		"a tree's parent copy rides its owner axis exactly over the tree's members, start above zero",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/riding-tree",
						generator: element([
							"none",
							"start > 0",
							"0 < start",
							"start <> 0",
							"0 <> start",
							"start >= 1",
							"start > 1",
							"at > 0",
							"start > 0 and at > 0"
						] as const),
						literal: Formatter.format,
						limit: 9,
						box: "every spelling of start > 0 and its wrong selections",
						oracle: {
							kind: "specification",
							name: "§2.2: a tree's members are select(T, start > 0)"
						},
						coverage: requiredInSpace<"rides" | "a wrong selection">([
							"rides",
							"a wrong selection"
						]),
						caseHang
					},
					(selection, k) =>
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
										conjuncts: Arr.map(selections[selection], (predicate) => ({ predicate }))
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
							const members = ["start > 0", "0 < start", "start <> 0", "0 <> start"]
							if (Arr.contains(members, selection)) {
								k.note("rides")
								assert.equal(ride?.axis, "owner", `select(T, ${selection}) is the tree's members`)
								return
							}
							k.note("a wrong selection")
							assert.equal(ride, undefined, `select(T, ${selection}) is not the tree's members`)
						})
				)
			)
	)
})

/** A family as the resolution box states it: its order, its group's width, or a tree. */
type FamilyCase =
	| { readonly kind: "family"; readonly order: "ordered" | "counted"; readonly width: 1 | 2 }
	| { readonly kind: "tree" }

/** The schema of a resolution case: O keyed by its group's width, F its members, or one tree relation T. */
const familyCaseSchema = (c: FamilyCase): SchemaDesc => {
	if (c.kind === "tree") {
		return schemaOf(
			[
				relation(
					"T",
					{
						id: f.uuid,
						parent: f.uuid,
						doc: f.uuid,
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
	}
	const keys = c.width === 1 ? ["a"] : ["a", "b"]
	const group = c.width === 1 ? ["ga"] : ["ga", "gb"]
	return schemaOf(
		[
			relation("O", { a: f.uuid, b: f.uuid, n: drawnNatural }, keys),
			relation(
				"F",
				c.order === "ordered"
					? { fid: f.uuid, ga: f.uuid, gb: f.uuid, at: drawnNatural }
					: { fid: f.uuid, ga: f.uuid, gb: f.uuid },
				["fid"]
			)
		],
		[
			{
				kind: "family",
				order: c.order,
				member: on("F", c.order === "ordered" ? [...group, "at"] : group),
				slots: { owner: "O", count: "n" }
			}
		]
	)
}

describe("resolution", () => {
	it.effect(
		"each family and tree statement resolves to one Family IR, as its statement states it",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/resolution",
						generator: element([
							{ kind: "family", order: "ordered", width: 1 },
							{ kind: "family", order: "ordered", width: 2 },
							{ kind: "family", order: "counted", width: 1 },
							{ kind: "family", order: "counted", width: 2 },
							{ kind: "tree" }
						] as const satisfies ReadonlyArray<FamilyCase>),
						literal: Formatter.format,
						limit: 5,
						box: "ordered and counted families of group width 1 and 2, and a tree",
						oracle: {
							kind: "specification",
							name: "the statement, read as the IR it names (§3.4)"
						},
						coverage: requiredInSpace<"ordered" | "counted" | "tree">([
							"ordered",
							"counted",
							"tree"
						]),
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const t: Theory = theoryOf(familyCaseSchema(c))
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
								assert.deepEqual(
									pairsText(fam.axes.predecessor),
									["start→end"],
									"T4 rides the predecessor"
								)
								assert.deepEqual(pairsText(fam.axes.last), ["end→end"], "T5 rides the last")
								for (const p of [...fam.axes.owner, ...fam.axes.predecessor, ...fam.axes.last]) {
									assert.deepEqual(p.laws, [law], "each states the tree's law")
								}
								return
							}
							k.note(c.order)
							assert.deepEqual(fam.id, { owner: "O", count: "n" }, "its slots")
							assert.equal(fam.owner.name, "O", "its owner")
							assert.equal(fam.member.name, "F", "its member")
							assert.equal(fam.count.name, "n", "its count")
							assert.deepEqual(
								Arr.map(fam.group, (p) => [p.member.name, p.owner.name]),
								c.width === 1
									? [["ga", "a"]]
									: [
											["ga", "a"],
											["gb", "b"]
										],
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
							assert.deepEqual(
								[
									fam.axes.owner.length,
									fam.axes.predecessor.length,
									fam.axes.last.length,
									fam.folds.length
								],
								[0, 0, 0, 0],
								"no statement carries anything"
							)
							assert.equal(
								lawOfShape(t, "family").detail.kind,
								"family",
								"its law's detail is the family"
							)
						})
				)
			)
	)
})

/** An accumulated field's carriers, as the accumulation box spells them. */
type Carriers =
	| "one carrier"
	| "no carrier"
	| "a second carrier"
	| "a carrier off every axis"
	| "a wrong selection"
	| "a reordered key"

describe("accumulated copies (OPEN-F2 (b))", () => {
	/** F's `was`, the predecessor's state, accumulated from 0 at slot 0, carried as `spelling` says. */
	const copySchema = (spelling: Carriers): SchemaDesc => {
		const copy = contained(on("F", ["o", pred("at"), "was"]), on("F", ["o", "at", "state"]))
		const statements = ((): SchemaDesc["statements"] => {
			switch (spelling) {
				case "one carrier":
					return [copy]
				case "no carrier":
					return []
				case "a second carrier":
					return [copy, contained(on("F", ["o", pred("at"), "was"]), on("F", ["o", "at", "other"]))]
				case "a carrier off every axis":
					return [contained(on("F", ["fid", "was"]), on("F", ["fid", "state"]))]
				case "a wrong selection":
					return [
						contained(
							onWhere("F", ["o", pred("at"), "was"], compare("eq", fieldExpr("state"), literal0)),
							on("F", ["o", "at", "state"])
						)
					]
				case "a reordered key":
					return [contained(on("F", [pred("at"), "o", "was"]), on("F", ["at", "o", "state"]))]
			}
		})()
		return schemaOf(
			[
				relation("O", { id: f.uuid, n: drawnNatural }, ["id"]),
				relation(
					"F",
					{
						fid: f.uuid,
						o: f.uuid,
						at: drawnNatural,
						state: natural,
						other: natural,
						was: accumulatedOf(natural, 0n)
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
	}

	it.effect(
		"every accumulated field is filled by exactly one axis pair, and the theory refuses any other",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/accumulated",
						generator: element([
							"one carrier",
							"no carrier",
							"a second carrier",
							"a carrier off every axis",
							"a wrong selection",
							"a reordered key"
						] as const),
						literal: Formatter.format,
						limit: 6,
						box: "one accumulated copy under each spelling of its carriers",
						oracle: {
							kind: "specification",
							name: "§3.7: an accumulated field no statement names, or two name, is refused"
						},
						coverage: requiredInSpace<Carriers>([
							"one carrier",
							"no carrier",
							"a second carrier",
							"a carrier off every axis",
							"a wrong selection",
							"a reordered key"
						]),
						caseHang
					},
					(spelling, k) =>
						Effect.sync(() => {
							k.note(spelling)
							const result = theoryResult(copySchema(spelling))
							if (spelling === "one carrier") {
								const t = theoryOf(copySchema(spelling))
								const family = defined(t.families[0])
								const fills = Arr.filter(
									[...family.axes.owner, ...family.axes.predecessor, ...family.axes.last],
									(p) => columnText(p.from) === "was"
								)
								assert.deepEqual(
									pairsText(fills),
									["was→state"],
									"one axis pair fills it, from the predecessor's state"
								)
								assert.deepEqual(
									pairsText(family.axes.predecessor),
									["was→state"],
									"on the predecessor axis"
								)
								return
							}
							const at = refusalLoc(
								refused(result, "MalformedDescription", `${spelling} is refused`)
							)
							assert.deepEqual(
								Arr.takeRight(at.path, 2),
								["fields", "was"],
								"at the accumulated field"
							)
						})
				)
			)
	)
})

/** The refusals §3.7 names, each spelled by the smallest schema that makes it. */
type Refusal =
	| "a start off the identity"
	| "a carrier the monoid does not admit"
	| "an accumulator pair over a counted family"
	| "a tree keyed by two fields"
	| "a tree with no drawn start"
	| "a drawn field no statement names"
	| "a drawn field two families name"
	| "one count counting two families"
	| "a relation in two ordered families"
	| "a relation in a tree and an ordered family"
	| "a group key no caller writes"
	| "a group key of another identity than its owner's key"

describe("refusals (§3.7, rows-first §4)", () => {
	/**
	 * A sum fold over F's x into O's total, its accumulators, when the step side names them, and its end starting at
	 * `start`.
	 */
	const sumFold = (order: "ordered" | "counted", start: bigint, pairs: boolean): SchemaDesc =>
		schemaOf(
			[
				relation("O", { id: f.uuid, n: drawnNatural, total: accumulatedOf(f.bigint, start) }, [
					"id"
				]),
				relation(
					"F",
					{
						fid: f.uuid,
						o: f.uuid,
						x: f.bigint,
						...(order === "ordered" ? { at: drawnNatural } : {}),
						...(pairs
							? { before: accumulatedOf(f.bigint, start), after: accumulatedOf(f.bigint, start) }
							: {})
					},
					["fid"]
				)
			],
			[
				{
					kind: "family",
					order,
					member: on("F", order === "ordered" ? ["o", "at"] : ["o"]),
					slots: { owner: "O", count: "n" }
				},
				{
					kind: "fold",
					family: { owner: "O", count: "n" },
					monoid: "sum",
					step: on("F", pairs ? ["o", "x", "before", "after"] : ["o", "x"]),
					end: on("O", ["id", "total"])
				}
			]
		)
	const refusalSchema = (r: Refusal): SchemaDesc => {
		switch (r) {
			case "a start off the identity":
				return sumFold("ordered", 1n, true)
			case "a carrier the monoid does not admit":
				return schemaOf(
					[
						relation("O", { id: f.uuid, n: drawnNatural, total: accumulatedOf(f.pg("real"), 0) }, [
							"id"
						]),
						relation("F", { fid: f.uuid, o: f.uuid, x: f.pg("real") }, ["fid"])
					],
					[
						{
							kind: "family",
							order: "counted",
							member: on("F", ["o"]),
							slots: { owner: "O", count: "n" }
						},
						{
							kind: "fold",
							family: { owner: "O", count: "n" },
							monoid: "sum",
							step: on("F", ["o", "x"]),
							end: on("O", ["id", "total"])
						}
					]
				)
			case "an accumulator pair over a counted family":
				return sumFold("counted", 0n, true)
			case "a tree keyed by two fields":
				return schemaOf(
					[
						relation(
							"T",
							{
								id: f.uuid,
								id2: f.uuid,
								parent: f.uuid,
								doc: f.uuid,
								at: drawnNatural,
								children: drawnNatural,
								start: drawnNatural,
								end: drawnNatural
							},
							["id", "id2"]
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
			case "a tree with no drawn start":
				return schemaOf(
					[
						relation(
							"T",
							{
								id: f.uuid,
								parent: f.uuid,
								doc: f.uuid,
								at: drawnNatural,
								children: drawnNatural,
								start: natural,
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
			case "a drawn field no statement names":
				return schemaOf(
					[
						relation("O", { id: f.uuid, n: drawnNatural, stray: drawnNatural }, ["id"]),
						relation("F", { fid: f.uuid, o: f.uuid, at: drawnNatural }, ["fid"])
					],
					[
						{
							kind: "family",
							order: "ordered",
							member: on("F", ["o", "at"]),
							slots: { owner: "O", count: "n" }
						}
					]
				)
			case "a drawn field two families name":
				return schemaOf(
					[
						relation("O", { id: f.uuid, n: drawnNatural }, ["id"]),
						relation("F", { fid: f.uuid, o: f.uuid, at: drawnNatural }, ["fid"]),
						relation("G", { gid: f.uuid, f: f.uuid }, ["gid"])
					],
					[
						{
							kind: "family",
							order: "ordered",
							member: on("F", ["o", "at"]),
							slots: { owner: "O", count: "n" }
						},
						{
							kind: "family",
							order: "counted",
							member: on("G", ["f"]),
							slots: { owner: "F", count: "at" }
						}
					]
				)
			case "a relation in two ordered families":
				return schemaOf(
					[
						relation("O", { id: f.uuid, n: drawnNatural, m: drawnNatural }, ["id"]),
						relation("F", { fid: f.uuid, o: f.uuid, at: drawnNatural, at2: drawnNatural }, ["fid"])
					],
					[
						{
							kind: "family",
							order: "ordered",
							member: on("F", ["o", "at"]),
							slots: { owner: "O", count: "n" }
						},
						{
							kind: "family",
							order: "ordered",
							member: on("F", ["o", "at2"]),
							slots: { owner: "O", count: "m" }
						}
					]
				)
			case "a relation in a tree and an ordered family":
				return schemaOf(
					[
						relation("O", { id: f.uuid, n: drawnNatural }, ["id"]),
						relation(
							"T",
							{
								id: f.uuid,
								parent: f.uuid,
								doc: f.uuid,
								o: f.uuid,
								at: drawnNatural,
								slot: drawnNatural,
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
						},
						{
							kind: "family",
							order: "ordered",
							member: on("T", ["o", "slot"]),
							slots: { owner: "O", count: "n" }
						}
					]
				)
			case "a group key no caller writes":
				return schemaOf(
					[
						relation("O", { id: f.bigint, n: drawnNatural }, ["id"]),
						relation("G", { gid: f.uuid, o: f.bigserial }, ["gid"])
					],
					[
						{
							kind: "family",
							order: "counted",
							member: on("G", ["o"]),
							slots: { owner: "O", count: "n" }
						}
					]
				)
			case "a group key of another identity than its owner's key":
				return schemaOf(
					[
						relation("O", { id: f.uuid, n: drawnNatural }, ["id"]),
						relation("G", { gid: f.uuid, o: f.bigint }, ["gid"])
					],
					[
						{
							kind: "family",
							order: "counted",
							member: on("G", ["o"]),
							slots: { owner: "O", count: "n" }
						}
					]
				)
			case "one count counting two families":
				return schemaOf(
					[
						relation("O", { id: f.uuid, n: drawnNatural }, ["id"]),
						relation("F", { fid: f.uuid, o: f.uuid, at: drawnNatural }, ["fid"]),
						relation("G", { gid: f.uuid, o: f.uuid }, ["gid"])
					],
					[
						{
							kind: "family",
							order: "ordered",
							member: on("F", ["o", "at"]),
							slots: { owner: "O", count: "n" }
						},
						{
							kind: "family",
							order: "counted",
							member: on("G", ["o"]),
							slots: { owner: "O", count: "n" }
						}
					]
				)
		}
	}
	/** Where each refusal points: a statement, or the field it names. */
	const refusedAtField: Readonly<Record<Refusal, string | undefined>> = {
		"a start off the identity": undefined,
		"a carrier the monoid does not admit": undefined,
		"an accumulator pair over a counted family": undefined,
		"a tree keyed by two fields": undefined,
		"a tree with no drawn start": undefined,
		"a drawn field no statement names": "stray",
		"a drawn field two families name": "at",
		"one count counting two families": undefined,
		"a relation in two ordered families": undefined,
		"a relation in a tree and an ordered family": undefined,
		"a group key no caller writes": undefined,
		"a group key of another identity than its owner's key": undefined
	}
	it.effect("refuses each named malformation as a MalformedDescription where it is stated", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/analysis/theory/refusals",
					generator: element([
						"a start off the identity",
						"a carrier the monoid does not admit",
						"an accumulator pair over a counted family",
						"a tree keyed by two fields",
						"a tree with no drawn start",
						"a drawn field no statement names",
						"a drawn field two families name",
						"one count counting two families",
						"a relation in two ordered families",
						"a relation in a tree and an ordered family",
						"a group key no caller writes",
						"a group key of another identity than its owner's key"
					] as const),
					literal: Formatter.format,
					limit: 12,
					box: "each refusal §3.7 and rows-first §4 name, at its smallest schema",
					oracle: { kind: "specification", name: "§3.7's and rows-first §4's refusals" },
					coverage: requiredInSpace<"at a statement" | "at a field">([
						"at a statement",
						"at a field"
					]),
					caseHang
				},
				(r, k) =>
					Effect.sync(() => {
						const at = refusalLoc(
							refused(theoryResult(refusalSchema(r)), "MalformedDescription", `${r} is refused`)
						)
						const fieldName = refusedAtField[r]
						if (fieldName === undefined) {
							k.note("at a statement")
							assert.equal(at.path[0], "statements", `${r} is refused at its statement`)
							return
						}
						k.note("at a field")
						assert.deepEqual(
							Arr.takeRight(at.path, 2),
							["fields", fieldName],
							`${r} is refused at ${fieldName}`
						)
					})
			)
		)
	)

	it.effect(
		"admits the lawful neighbour of each fold refusal: a sum from 0, its pair over an ordered family",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/refusals-control",
						generator: element(["named accumulators", "hidden accumulators"] as const),
						literal: Formatter.format,
						limit: 2,
						box: "the sum fold of the refusals, from its identity, over an ordered family",
						oracle: { kind: "specification", name: "§3.7's refusals, their nearest lawful input" },
						coverage: requiredInSpace<"named accumulators" | "hidden accumulators">([
							"named accumulators",
							"hidden accumulators"
						]),
						caseHang
					},
					(spelling, k) =>
						Effect.sync(() => {
							k.note(spelling)
							const t = theoryOf(sumFold("ordered", 0n, spelling === "named accumulators"))
							const fold = defined(defined(t.families[0]).folds[0])
							const plane = defined(fold.planes[0])
							assert.equal(fold.monoid, "sum", "the fold is its family's")
							assert.equal(
								plane.before.kind,
								spelling === "named accumulators" ? "field" : "law",
								"a named accumulator is its field, a hidden one a drawn law column"
							)
							assert.equal(lawOfShape(t, "fold").detail.kind, "fold", "its law is the fold")
						})
				)
			)
	)
})
