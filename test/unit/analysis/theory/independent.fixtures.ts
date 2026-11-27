/** What the properties of independent.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import type { Theory } from "#compiler/analysis/theory/theory.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { NativeColumn } from "#compiler/ir/law.ts"
import { f, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import {
	accumulatedOf,
	drawnNatural,
	naturalDesc,
	schemaOf,
	type TestTheory,
	theoryOf
} from "#test/unit/analysis/theory/support.ts"

/** A box configuration: the owners the two counted families have, their group fields, a fold each, a sequence. */
interface Shape {
	readonly owners: "one owner" | "two owners"
	readonly groups: "one group field" | "two group fields"
	readonly folds: boolean
	readonly sequence: boolean
}

export const shape: Gen<Shape> = (source) => ({
	owners: element(["one owner", "two owners"] as const)(source),
	groups: element(["one group field", "two group fields"] as const)(source),
	folds: boolean(source),
	sequence: boolean(source)
})

/** The owner of the first and the second counted family. */
export const ownersOf = (s: Shape): readonly [string, string] =>
	s.owners === "one owner" ? ["O", "O"] : ["O1", "O2"]

/** G's group field for the first and the second counted family. */
export const groupsOf = (s: Shape): readonly [string, string] =>
	s.groups === "one group field" ? ["o1", "o1"] : ["o1", "o2"]

/**
 * G counted twice, as counted(on(G, g1), fin(A, n)) and counted(on(G, g2), fin(B, m)), each with a sum fold of G's x
 * into its owner's t1 or t2 when the shape folds, and beside them ordered(on(L, s, at), fin(S, k)) when it has a
 * sequence.
 */
export const schemaFor = (s: Shape): SchemaDesc => {
	const [a, b] = ownersOf(s)
	const [g1, g2] = groupsOf(s)
	const total = accumulatedOf(naturalDesc, 0n)
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
			relation("G", { gid: f.uuid, o1: f.uuid, o2: f.uuid, x: naturalDesc }, ["gid"])
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

/** Every law column a family draws: ‹s›, a counted ‹i›, and each fold plane's hidden before and after. */
export const lawColumnsOf = (family: Family): ReadonlyArray<string> => [
	`law ${family.next}`,
	...(family.shape.kind === "counted" ? [columnKey(family.shape.index)] : []),
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
export const axisColumnsOf = (family: Family): ReadonlyArray<string> =>
	Arr.flatMap([...family.axes.owner, ...family.axes.predecessor, ...family.axes.last], (p) => [
		columnKey(p.from),
		columnKey(p.to)
	])

/** The family a theory resolves for fin(owner, count). */
export const familyAt = (t: Theory, owner: string, count: string): Family =>
	Arr.findFirst(t.families, (x) => x.id.owner === owner && x.id.count === count).pipe(
		Option.getOrElse(() => assert.fail(`a family of fin(${owner}, ${count})`))
	)

/** The family law of fin(owner, count). */
export const familyLawAt = (t: Theory, owner: string, count: string): TheoryLaw =>
	Arr.findFirst(
		t.laws,
		(law) =>
			law.detail.kind === "family" &&
			law.detail.family.id.owner === owner &&
			law.detail.family.id.count === count
	).pipe(Option.getOrElse(() => assert.fail(`the law of fin(${owner}, ${count})`)))

export type ShapeFeature =
	| Shape["owners"]
	| Shape["groups"]
	| "two folds"
	| "a sequence beside them"

/** A member of the semantic box: whether each counted family's group field names its owner, or no owner. */
export interface Member {
	readonly first: boolean
	readonly second: boolean
}

/** A state of the semantic box: each counted family's count, and every member. */
interface State {
	readonly owners: Shape["owners"]
	readonly counts: readonly [number, number]
	readonly members: ReadonlyArray<Member>
}

export const state: Gen<State> = (source) => ({
	owners: element(["two owners", "one owner"] as const)(source),
	counts: [int(0, 2)(source), int(0, 2)(source)],
	members: array((m): Member => ({ first: boolean(m), second: boolean(m) }), { min: 0, max: 2 })(
		source
	)
})

/** Each owner shape's theory, two counted families on one member beside a sequence, built once. */
export const theories: ReadonlyMap<Shape["owners"], TestTheory> = new Map(
	Arr.map(
		["one owner", "two owners"] as const,
		(owners) =>
			[
				owners,
				theoryOf(schemaFor({ owners, groups: "two group fields", folds: false, sequence: true }))
			] as const
	)
)
