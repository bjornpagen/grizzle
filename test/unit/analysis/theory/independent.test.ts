/**
 * Families stay independent (rows-first §1, §5): a relation is a member of any number of counted families, and each
 * family the theory resolves is its own Family, with its own axes and its own law columns, named by its own identity
 * (owner and count, and fold and plane). Two counted families on one member, under one owner or two, by one group
 * field or two, with or without a fold each and a sequence of another relation beside them, resolve to disjoint
 * families; and each family's law is violated exactly when its own family is, whatever the other's state. A counted
 * family's member is no sequence's member (analysis/theory/fill.ts), so the sequence beside them orders L, not G. The
 * oracle is the statements read as the specification of the families they state, and for the laws each family's
 * theorem checked on its own.
 *
 * - Shape: every arrangement of the two counted families (one owner or two, one group field or two, a fold each or
 *   none, a sequence beside them or none), exhausted. Plant: family-columns-named-by-member (every family's drawn
 *   columns named as one family's, so two families share a law column).
 * - Laws: every state of the two counted families beside a lawful sequence, counts 0 to 2, up to two members each
 *   naming each owner or none, exhausted, each family's law violated exactly when its own theorem fails. Plant:
 *   counted-violation-no-off-arm (a counted family's violation omits its count's mismatch).
 *
 * Plants are patches in ~/.cache/grizzle-release/BR03/plants. Features: each arrangement for the shape; each family's
 * verdict, and the other's state beside it, for the laws.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import type { Theory } from "#compiler/analysis/theory/theory.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { NativeColumn } from "#compiler/ir/law.ts"
import { assert, defined } from "#test/support/assert.ts"
import { f, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	accumulatedOf,
	drawnNatural,
	type HostFacts,
	natural,
	schemaOf,
	theoryOf,
	uuidOf,
	violates
} from "#test/unit/analysis/theory/support.ts"

/** A box configuration: the owners the two counted families have, their group fields, a fold each, a sequence. */
interface Shape {
	readonly owners: "one owner" | "two owners"
	readonly groups: "one group field" | "two group fields"
	readonly folds: boolean
	readonly sequence: boolean
}

const shape: Gen<Shape> = (source) => ({
	owners: element(["one owner", "two owners"] as const)(source),
	groups: element(["one group field", "two group fields"] as const)(source),
	folds: boolean(source),
	sequence: boolean(source)
})

/** The owner of the first and the second counted family. */
const ownersOf = (s: Shape): readonly [string, string] =>
	s.owners === "one owner" ? ["O", "O"] : ["O1", "O2"]

/** G's group field for the first and the second counted family. */
const groupsOf = (s: Shape): readonly [string, string] =>
	s.groups === "one group field" ? ["o1", "o1"] : ["o1", "o2"]

/**
 * G counted twice, as counted(on(G, g1), fin(A, n)) and counted(on(G, g2), fin(B, m)), each with a sum fold of G's x
 * into its owner's t1 or t2 when the shape folds, and beside them ordered(on(L, s, at), fin(S, k)) when it has a
 * sequence.
 */
const schemaFor = (s: Shape): SchemaDesc => {
	const [a, b] = ownersOf(s)
	const [g1, g2] = groupsOf(s)
	const total = accumulatedOf(natural, 0n)
	const owners =
		a === b
			? [
					relation(
						a,
						{
							id: f.uuid,
							n: drawnNatural,
							m: drawnNatural,
							...(s.folds ? { t1: total, t2: total } : {})
						},
						["id"]
					)
				]
			: [
					relation(a, { id: f.uuid, n: drawnNatural, ...(s.folds ? { t1: total } : {}) }, ["id"]),
					relation(b, { id: f.uuid, m: drawnNatural, ...(s.folds ? { t2: total } : {}) }, ["id"])
				]
	return schemaOf(
		[
			...owners,
			...(s.sequence
				? [
						relation("S", { id: f.uuid, k: drawnNatural }, ["id"]),
						relation("L", { id: f.uuid, s: f.uuid, at: drawnNatural }, ["id"])
					]
				: []),
			relation("G", { gid: f.uuid, o1: f.uuid, o2: f.uuid, x: natural }, ["gid"])
		],
		[
			{ kind: "family", order: "counted", member: on("G", [g1]), slots: { owner: a, count: "n" } },
			{ kind: "family", order: "counted", member: on("G", [g2]), slots: { owner: b, count: "m" } },
			...(s.folds
				? [
						{
							kind: "fold" as const,
							family: { owner: a, count: "n" },
							monoid: "sum" as const,
							step: on("G", [g1, "x"]),
							end: on(a, ["id", "t1"])
						},
						{
							kind: "fold" as const,
							family: { owner: b, count: "m" },
							monoid: "sum" as const,
							step: on("G", [g2, "x"]),
							end: on(b, ["id", "t2"])
						}
					]
				: []),
			...(s.sequence
				? [
						{
							kind: "family" as const,
							order: "ordered" as const,
							member: on("L", ["s", "at"]),
							slots: { owner: "S", count: "k" }
						}
					]
				: [])
		]
	)
}

/** A native column by what it is: a field by its relation's name, a law column by its identifier. */
const columnKey = (c: NativeColumn): string =>
	c.kind === "field" ? `field ${c.field.name}` : `law ${c.column}`

/** Every law column a family draws: ‹n›, a counted ‹i›, a tree's ‹ps›, and each fold plane's hidden before and after. */
const lawColumnsOf = (family: Family): ReadonlyArray<string> => [
	`law ${family.copy}`,
	...(family.index.kind === "law" ? [columnKey(family.index)] : []),
	...(family.members.kind === "tree" ? [`law ${family.members.parentStart}`] : []),
	...Arr.flatMap(family.folds, (fold) =>
		Arr.flatMap(fold.planes, (p) =>
			Arr.map(
				Arr.filter([p.before, p.after], (c) => c.kind === "law"),
				columnKey
			)
		)
	)
]

/** Every column a family's axes carry, from and to, by what it is. */
const axisColumnsOf = (family: Family): ReadonlyArray<string> =>
	Arr.flatMap([...family.axes.owner, ...family.axes.predecessor, ...family.axes.last], (p) => [
		columnKey(p.from),
		columnKey(p.to)
	])

/** The family a theory resolves for fin(owner, count). */
const familyAt = (t: Theory, owner: string, count: string): Family =>
	Arr.findFirst(t.families, (x) => x.id.owner === owner && x.id.count === count).pipe(
		Option.getOrElse(() => assert.fail(`a family of fin(${owner}, ${count})`))
	)

/** The family law of fin(owner, count). */
const familyLawAt = (t: Theory, owner: string, count: string): TheoryLaw =>
	Arr.findFirst(
		t.laws,
		(law) =>
			law.detail.kind === "family" &&
			law.detail.family.id.owner === owner &&
			law.detail.family.id.count === count
	).pipe(Option.getOrElse(() => assert.fail(`the law of fin(${owner}, ${count})`)))

type ShapeFeature = Shape["owners"] | Shape["groups"] | "two folds" | "a sequence beside them"

describe("independent families (rows-first §5)", () => {
	it.effect(
		"two counted families on one member resolve to two families of disjoint axes and law columns",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/independent",
						generator: shape,
						literal: Formatter.format,
						limit: 16,
						box: "two counted families on G under one owner or two, by one group field or two, with a sum fold each or none, and an ordered family of L beside them or none",
						oracle: {
							kind: "specification",
							name: "rows-first §1 and §5: each family its own, by its identity"
						},
						coverage: requiredInSpace<ShapeFeature>([
							"one owner",
							"two owners",
							"one group field",
							"two group fields",
							"two folds",
							"a sequence beside them"
						]),
						caseHang
					},
					(s, k) =>
						Effect.sync(() => {
							k.note(s.owners)
							k.note(s.groups)
							if (s.folds) {
								k.note("two folds")
							}
							if (s.sequence) {
								k.note("a sequence beside them")
							}
							const t = theoryOf(schemaFor(s))
							const [a, b] = ownersOf(s)
							const [g1, g2] = groupsOf(s)
							assert.equal(t.families.length, s.sequence ? 3 : 2, "one family per statement")
							const first = familyAt(t, a, "n")
							const second = familyAt(t, b, "m")
							assert.deepEqual(
								[first.group[0].member.name, second.group[0].member.name],
								[g1, g2],
								"each counted family groups G by its own field"
							)
							assert.deepEqual(
								[first.index.kind, second.index.kind],
								["law", "law"],
								"each counted family's index is its own hidden column"
							)
							const columns = Arr.flatMap(t.families, lawColumnsOf)
							assert.equal(
								new Set(columns).size,
								columns.length,
								"no two families share a law column"
							)
							assert.deepEqual(
								Arr.map([first, second], (x) => x.folds.length),
								s.folds ? [1, 1] : [0, 0],
								"each fold is its own family's"
							)
							if (s.folds) {
								assert.deepEqual(
									[
										defined(first.folds[0]?.planes[0]).end.name,
										defined(second.folds[0]?.planes[0]).end.name
									],
									["t1", "t2"],
									"each fold ends on its own owner's field"
								)
							}
							const carried = Arr.map(t.families, axisColumnsOf)
							const shared = Arr.filter(defined(carried[0]), (c) =>
								Arr.some(Arr.drop(carried, 1), (cs) => Arr.contains(cs, c))
							)
							assert.deepEqual(shared, [], "no column rides two families' axes")
							if (s.sequence) {
								const sequence = familyAt(t, "S", "k")
								assert.equal(
									sequence.index.kind,
									"field",
									"the sequence beside them is ordered by its own index"
								)
								assert.equal(sequence.folds.length, 0, "and folds nothing of theirs")
							}
						})
				)
			)
	)

	/** A member of the semantic box: whether each counted family's group field names its owner, or no owner. */
	interface Member {
		readonly first: boolean
		readonly second: boolean
	}

	/** A state of the semantic box: each counted family's count, and every member. */
	interface State {
		readonly owners: Shape["owners"]
		readonly counts: readonly [number, number]
		readonly members: ReadonlyArray<Member>
	}

	const state: Gen<State> = (source) => ({
		owners: element(["two owners", "one owner"] as const)(source),
		counts: [int(0, 2)(source), int(0, 2)(source)],
		members: array((m): Member => ({ first: boolean(m), second: boolean(m) }), { min: 0, max: 2 })(
			source
		)
	})

	const theories = new Map(
		Arr.map(
			["one owner", "two owners"] as const,
			(owners) =>
				[
					owners,
					theoryOf(schemaFor({ owners, groups: "two group fields", folds: false, sequence: true }))
				] as const
		)
	)

	it.effect(
		"each counted family's law is violated exactly when its own family is, whatever the other's",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/independent-laws",
						generator: state,
						literal: Formatter.format,
						limit: 500,
						box: "two counted families of G (under one owner or two) beside a lawful sequence, counts 0 to 2, up to two members each naming each owner or none",
						oracle: {
							kind: "second-implementation",
							name: "each family's bijection, counted on its own"
						},
						coverage: requiredInSpace<
							"both lawful" | "the first alone broken" | "the second alone broken" | "both broken"
						>(["both lawful", "the first alone broken", "the second alone broken", "both broken"]),
						caseHang
					},
					(s, k) =>
						Effect.sync(() => {
							const t = defined(theories.get(s.owners))
							const [a, b] = s.owners === "one owner" ? ["O", "O"] : ["O1", "O2"]
							const lawful = (named: (m: Member) => boolean, count: number): boolean =>
								Arr.every(s.members, named) && count === s.members.length
							const firstLawful = lawful((m) => m.first, s.counts[0])
							const secondLawful = lawful((m) => m.second, s.counts[1])
							k.note(
								firstLawful && secondLawful
									? "both lawful"
									: firstLawful
										? "the second alone broken"
										: secondLawful
											? "the first alone broken"
											: "both broken"
							)
							const owner = uuidOf(1)
							const orphan = uuidOf(9)
							const owners: HostFacts =
								a === b
									? { [a]: [{ id: owner, n: BigInt(s.counts[0]), m: BigInt(s.counts[1]) }] }
									: {
											[a]: [{ id: owner, n: BigInt(s.counts[0]) }],
											[b]: [{ id: owner, m: BigInt(s.counts[1]) }]
										}
							const facts: HostFacts = {
								...owners,
								S: [{ id: uuidOf(2), k: BigInt(s.members.length) }],
								G: Arr.map(s.members, (m, i) => ({
									gid: uuidOf(100 + i),
									o1: m.first ? owner : orphan,
									o2: m.second ? owner : orphan,
									x: 0n
								})),
								L: Arr.map(s.members, (_, i) => ({
									id: uuidOf(200 + i),
									s: uuidOf(2),
									at: BigInt(i)
								}))
							}
							assert.equal(
								violates(t, familyLawAt(t, a, "n"), facts),
								!firstLawful,
								`the first family of ${Formatter.format(s)}`
							)
							assert.equal(
								violates(t, familyLawAt(t, b, "m"), facts),
								!secondLawful,
								`the second family of ${Formatter.format(s)}`
							)
							assert.equal(
								violates(t, familyLawAt(t, "S", "k"), facts),
								false,
								"the sequence beside them stays lawful"
							)
						})
				)
			)
	)
})
