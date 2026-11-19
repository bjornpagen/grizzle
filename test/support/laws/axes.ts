/**
 * The families and the tree whose axes the reverse-probe suite plans beside its containments
 * (test/pg/laws/reverse-probe.test.ts), over every case of a box of eight: an ordered family and a counted one, each
 * owner keyed by one or two fields its members are grouped by, and a tree keyed by its root field and its start; the
 * ordered family and the tree folded or not, a fold's accumulators carried along the predecessor and last axes; the
 * ordered family's owner axis carrying a caller copy or not. Every axis is a foreign key whose reverse probe PostgreSQL's RI trigger runs once per referenced
 * row it deletes or rekeys: a family's owner axis (g…, ‹n›, copies…) and predecessor axis (g…, ‹p›, carried…) on its
 * member, its last axis (k…, ‹pn›, carried…) on its owner, and the tree's owner axis (doc, parent, ‹n›), predecessor axis
 * (doc, ‹parent₀›, ‹p›, start, carried…) and last axis (doc, start, ‹pn›, end, carried…).
 */
import { Array as Arr, Record as Rec } from "effect"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import { relationBuilder as relation } from "#compiler/schema/relation.ts"
import {
	containedBuilder,
	countedBuilder,
	finBuilder,
	foldBuilder,
	monoids,
	onBuilder,
	orderedBuilder,
	treeBuilder
} from "#compiler/schema/statements.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { Id } from "#test/support/ids.ts"

/** A set of families and a tree (the header). */
export interface AxesCase {
	/** The fields each owner is keyed by, and its members grouped by. */
	readonly width: 1 | 2
	/** Whether the ordered family and the tree are folded, each by a fold whose accumulators ride their axes. */
	readonly folded: boolean
	/** Whether the ordered family's owner axis carries a caller copy. */
	readonly copied: boolean
}

/** The box, every case of it. */
export const axesBox: ReadonlyArray<AxesCase> = Arr.flatMap([1, 2] as const, (width) =>
	Arr.flatMap([false, true], (folded) =>
		Arr.map([false, true], (copied): AxesCase => ({ width, folded, copied }))
	)
)

/** The situations a case reaches beyond the axes every case has. */
export type AxesFeature = "a group of two fields" | "folded axes" | "an owner axis carrying a copy"

export const axesFeaturesOf = (a: AxesCase): ReadonlyArray<AxesFeature> => [
	...(a.width === 2 ? ["a group of two fields" as const] : []),
	...(a.folded ? ["folded axes" as const] : []),
	...(a.copied ? ["an owner axis carrying a copy" as const] : [])
]

/** The relations the case at a position adds, whose every foreign key is an axis. */
export const axesRelationsAt = (at: number) =>
	({
		orderedOwner: `OrderedOwner${at}`,
		orderedMember: `OrderedMember${at}`,
		countedOwner: `CountedOwner${at}`,
		countedMember: `CountedMember${at}`,
		node: `Node${at}`
	}) as const

/** A relation whose fields and key the case names at run time. */
const relationOf = (
	name: string,
	fields: Readonly<Record<string, FieldBase>>,
	key: ReadonlyArray<string>
): AnyRelation =>
	relation<string, Readonly<Record<string, FieldBase>>, ReadonlyArray<string>>(
		name,
		fields,
		key,
		[]
	)

/** The owner's key fields and the member's group fields that pair with them, by the case's width. */
const keysOf = (a: AxesCase): ReadonlyArray<string> => (a.width === 1 ? ["k0"] : ["k0", "k1"])
const groupOf = (a: AxesCase): ReadonlyArray<string> => (a.width === 1 ? ["g0"] : ["g0", "g1"])

/** The relations and statements of the case at a position, each relation by its name (`axesRelationsAt`). */
export const axesParts = (
	a: AxesCase,
	at: number
): {
	readonly relations: ReadonlyArray<readonly [string, AnyRelation]>
	readonly statements: ReadonlyArray<Statement>
} => {
	const keys = keysOf(a)
	const group = groupOf(a)
	const names = axesRelationsAt(at)
	const keyFields = Rec.fromEntries(Arr.map(keys, (k) => [k, Id] as const))
	const groupFields = Rec.fromEntries(Arr.map(group, (g) => [g, Id] as const))
	const OrderedOwner = relationOf(
		names.orderedOwner,
		{
			...keyFields,
			n: drawn(natural),
			...(a.folded ? { total: accumulated(pg.bigint, 0n) } : {}),
			...(a.copied ? { stamp: pg.bigint } : {})
		},
		keys
	)
	const OrderedMember = relationOf(
		names.orderedMember,
		{
			id: Id,
			...groupFields,
			at: drawn(natural),
			x: pg.bigint,
			...(a.folded
				? { before: accumulated(pg.bigint, 0n), after: accumulated(pg.bigint, 0n) }
				: {}),
			...(a.copied ? { stamp: pg.bigint } : {})
		},
		["id"]
	)
	const CountedOwner = relationOf(names.countedOwner, { ...keyFields, n: drawn(natural) }, keys)
	const CountedMember = relationOf(names.countedMember, { id: Id, ...groupFields }, ["id"])
	const Node = relationOf(
		names.node,
		{
			doc: Id,
			parent: drawn(natural),
			at: drawn(natural),
			children: drawn(natural),
			start: drawn(natural),
			end: drawn(natural),
			...(a.folded
				? {
						before: accumulated(natural, 0n),
						after: accumulated(natural, 0n),
						size: accumulated(natural, 0n)
					}
				: {})
		},
		["doc", "start"]
	)
	const ordered = orderedBuilder(
		onBuilder(OrderedMember, [...group, "at"]),
		finBuilder(OrderedOwner, "n")
	)
	const tree = treeBuilder(onBuilder(Node, ["parent", "at"]), finBuilder(Node, "children"), {
		root: ["doc"]
	})
	const statements: ReadonlyArray<Statement> = [
		ordered,
		countedBuilder(onBuilder(CountedMember, group), finBuilder(CountedOwner, "n")),
		tree,
		...(a.folded
			? [
					foldBuilder(
						ordered,
						monoids.sum,
						onBuilder(OrderedMember, [...group, "x", "before", "after"]),
						onBuilder(OrderedOwner, [...keys, "total"])
					),
					foldBuilder(
						tree,
						monoids.count,
						onBuilder(Node, ["doc", "parent", "before", "after"]),
						onBuilder(Node, ["doc", "start", "size"])
					)
				]
			: []),
		...(a.copied
			? [
					containedBuilder(
						onBuilder(OrderedMember, [...group, "stamp"]),
						onBuilder(OrderedOwner, [...keys, "stamp"])
					)
				]
			: [])
	]
	return {
		relations: [
			[names.orderedOwner, OrderedOwner],
			[names.orderedMember, OrderedMember],
			[names.countedOwner, CountedOwner],
			[names.countedMember, CountedMember],
			[names.node, Node]
		],
		statements
	}
}
