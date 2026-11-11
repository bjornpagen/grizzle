/**
 * Adding a counted family with a fold to populated relations, on PostgreSQL 19rc1 (rows-first §6): A4's backfill data
 * step draws every member's hidden index, ‹i› = row_number() OVER (PARTITION BY g ORDER BY its key) − 1, its copy of the
 * count, and each fold plane's before and after as running sums in ‹i› order, and the owner's count and end; VALIDATE
 * then proves every native over the backfilled rows.
 *
 * - **A second implementation:** the reference fold (test/support/families/fold.ts) of each owner's members in key
 *   order states every backfilled value of a family, each owner's tag is what its members' copy holds, and for a tree
 *   the direct pre-order numbering (test/support/families/tree.ts), its children in key order, states every node's
 *   slot, count, interval, sibling count and parent's kind; what the migration leaves must be exactly that.
 * - **PostgreSQL as the judge:** the migration commits, and no constraint of the installation is left NOT VALID.
 *
 * The spaces, generated: one to three owners whose members fall among them in any counts, so a backfill meets empty
 * families, families of one (the first slot the last) and families whose predecessor chain the running sum must close;
 * member keys drawn apart and written out of their order, and each member's value; and the same family with each
 * owner's tag copied onto its members along the owner axis, or without. And one or two trees of one to five nodes,
 * each under its own root value, folded by count over each node's children, as NP's fold suite folds it
 * (test/pg/fin/fold.test.ts), each node's parent's kind copied down the parent axis, the root its own, node keys drawn
 * apart and written out of their order. And members stored by a vector key that the migration which keys them by their
 * group and a new drawn index keeps as a field, renames or drops, declared: its backfill orders and joins the stored
 * members by that key at the extension's operators, the dropped one's column standing until the migration's removals.
 *
 * Features: an empty family, a family of one and of several, members written out of their key order, tags copied or
 * not; two trees, a root alone, a node of several children, a grandchild, siblings written out of their key order; and
 * each fate of a vector key. Each pending situation is aimed at by a case constructed to reach it (a leading owner of a
 * drawn size, keys written from the highest down, a fixed tree shape, a fixed fate), never by filtering draws.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): backfill-family-index-from-one (a family's backfilled index counts
 * from 1), backfill-tree-siblings-unordered (a tree's siblings are numbered in no stated order) and
 * backfill-vector-stored-key-ignored (members keyed anew are ordered by their new key, not the one their rows were
 * distinct by).
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	boolean,
	composition,
	constant,
	element,
	type Gen,
	int,
	map,
	parents,
	shuffled
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { accumulated, drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
import {
	type AnySchema,
	contained,
	counted,
	fin,
	fold,
	Monoid,
	on,
	ordered,
	relation,
	schema,
	select,
	tree
} from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { byMember, FOLD_SPECS, foldRead, foldSeatOf } from "#test/pg/fin/folds.ts"
import { seatOfInstalled } from "#test/pg/fin/installed.ts"
import { type Aim, aimedAt } from "#test/pg/migrate/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { foldStoredOf } from "#test/support/families/fold.ts"
import { type Node, numbered, type Rooted } from "#test/support/families/tree.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** The counted family before it: owners keyed by id, members keyed by member, each with its owner g and a value x. */
const before = (name: string) =>
	schema(
		name,
		[
			relation("Owner", { id: pg.int4 }, ["id"]),
			relation("Member", { member: pg.int4, g: pg.int4, x: pg.int4 }, ["member"])
		],
		[]
	)

const after = (name: string) => {
	const Owner = relation(
		"Owner",
		{ id: pg.int4, n: drawnField(natural), end: accumulated(pg.int4, 0) },
		["id"]
	)
	const Member = relation("Member", { member: pg.int4, g: pg.int4, x: pg.int4 }, ["member"])
	const family = counted(on(Member, "g"), fin(Owner, "n"))
	return schema(
		name,
		[Owner, Member],
		[family, fold(family, Monoid.sum, on(Member, "g", "x"), on(Owner, "id", "end"))]
	)
}

const SPEC = defined(
	Arr.findFirst(FOLD_SPECS, (s) => s.label === "sum of int4 over a counted family").pipe(
		Option.getOrUndefined
	)
)

/** The counted family again, each owner's tag copied onto its members along the owner axis. */
const copyBefore = (name: string) =>
	schema(
		name,
		[
			relation("Owner", { id: pg.int4, tag: pg.int4 }, ["id"]),
			relation("Member", { member: pg.int4, g: pg.int4, x: pg.int4 }, ["member"])
		],
		[]
	)

const copyAfter = (name: string) => {
	const Owner = relation(
		"Owner",
		{ id: pg.int4, tag: pg.int4, n: drawnField(natural), end: accumulated(pg.int4, 0) },
		["id"]
	)
	const Member = relation(
		"Member",
		{ member: pg.int4, g: pg.int4, x: pg.int4, ownerTag: accumulated(pg.int4, 0) },
		["member"]
	)
	const family = counted(on(Member, "g"), fin(Owner, "n"))
	return schema(
		name,
		[Owner, Member],
		[
			family,
			fold(family, Monoid.sum, on(Member, "g", "x"), on(Owner, "id", "end")),
			contained(on(Member, "g", "ownerTag"), on(Owner, "id", "tag"))
		]
	)
}

/** A tree of Node, one per doc, folded by count over each node's children (FoldedTree's), each node's parent's kind
 * copied down. */
const treeBefore = (name: string) =>
	schema(
		name,
		[relation("Node", { id: pg.int4, parent: pg.int4, doc: pg.int4, kind: pg.int4 }, ["id"])],
		[]
	)

const treeAfter = (name: string) => {
	const Node_ = relation(
		"Node",
		{
			id: pg.int4,
			doc: pg.int4,
			parent: pg.int4,
			at: drawnField(natural),
			children: drawnField(natural),
			start: drawnField(natural),
			end: drawnField(natural),
			kind: pg.int4,
			parentKind: accumulated(pg.int4, 0),
			before: accumulated(natural, 0n),
			after: accumulated(natural, 0n),
			total: accumulated(natural, 0n)
		},
		["id"]
	)
	const t = tree(on(Node_, "parent", "at"), fin(Node_, "children"), { root: "doc" })
	return schema(
		name,
		[Node_],
		[
			t,
			fold(t, Monoid.count, on(Node_, "parent", "before", "after"), on(Node_, "id", "total")),
			contained(
				on(
					select(Node_, (n) => n.gt(n.start, 0n)),
					"parent",
					"parentKind"
				),
				on(Node_, "id", "kind")
			)
		]
	)
}

/** The bound on a drawn value: a member's x and an owner's tag lie within it either way, a node's kind below it. */
const valueBound = 9

/** The keys a drawn member or node takes, apart from one another. */
const keyRange: Arr.NonEmptyReadonlyArray<number> = Arr.range(1, 40)

/** One member as written: its key, its owner and its value. */
interface WrittenMember {
	readonly member: number
	readonly g: number
	readonly x: number
}

/** A populated family: its owners, each with its tag, and its members in the order they are written. */
interface Family {
	readonly copied: boolean
	readonly tags: Arr.NonEmptyReadonlyArray<number>
	readonly members: ReadonlyArray<WrittenMember>
}

/** How many members each owner of a drawn family holds: one to three owners, up to six members among them. */
const countsGen: Gen<ReadonlyArray<number>> = (source) => {
	const owners = source.draw(int(1, 3))
	return source.draw(composition(source.draw(int(0, 6)), owners))
}

/** `total` keys apart, drawn in any order, so each family's members may be written out of their key order. */
const anyOrder = (total: number): Gen<ReadonlyArray<number>> =>
	shuffled(keyRange, { min: total, max: total })

/** `total` keys apart, written from the highest down, so every family of two or more is out of its key order. */
const descending = (total: number): Gen<ReadonlyArray<number>> =>
	map(anyOrder(total), (keys) => Arr.sort(keys, Order.flip(Order.Number)))

/**
 * A family: owners, ids 0 up, each holding as many members as `counts` draws and a tag; the members keyed apart, their
 * keys as `keys` draws them, written owner by owner; each member's value; and whether `copied` copies the tags onto the
 * members.
 */
const familyOf =
	(
		counts: Gen<ReadonlyArray<number>>,
		keys: (total: number) => Gen<ReadonlyArray<number>>,
		copied: Gen<boolean>
	): Gen<Family> =>
	(source) => {
		const drawnCounts = source.draw(counts)
		const total = Arr.reduce(drawnCounts, 0, (sum, n) => sum + n)
		const drawnKeys = source.draw(keys(total))
		const tags = nonEmptyList(
			Arr.map(drawnCounts, () => source.draw(int(-valueBound, valueBound))),
			"the owners' tags"
		)
		let at = 0
		const members: Array<WrittenMember> = []
		for (const [g, count] of drawnCounts.entries()) {
			for (let k = 0; k < count; k += 1) {
				members.push({
					member: defined(drawnKeys[at], "a member's key"),
					g,
					x: source.draw(int(-valueBound, valueBound))
				})
				at += 1
			}
		}
		return { copied: source.draw(copied), tags, members }
	}

/** A drawn family's counts with a first owner holding `count` members before the rest. */
const leading =
	(count: Gen<number>): Gen<ReadonlyArray<number>> =>
	(source) => [source.draw(count), ...source.draw(countsGen)]

/**
 * One to three owners, up to six members falling among them in drawn counts, keyed apart and written in any order, each
 * member's value, and whether the tags are copied onto the members.
 */
const familyGen: Gen<Family> = familyOf(countsGen, anyOrder, boolean)

/** The family each required situation of a family is aimed at while it is pending (Case.steering). */
const familyAims: ReadonlyArray<Aim<Family, FamilyFeature>> = [
	["an empty family", familyOf(leading(constant(0)), anyOrder, boolean)],
	["a family of one", familyOf(leading(constant(1)), anyOrder, boolean)],
	["a family of several", familyOf(leading(int(2, 4)), anyOrder, boolean)],
	["members written out of their key order", familyOf(leading(int(2, 4)), descending, boolean)],
	["tags copied", familyOf(countsGen, anyOrder, constant(true))],
	["a fold without a copy", familyOf(countsGen, anyOrder, constant(false))]
]

/** One node as written: its key, its parent's (its own at a root), its tree's root value and its kind. */
interface WrittenNode {
	readonly id: number
	readonly parent: number
	readonly doc: number
	readonly kind: number
}

/** A forest as written: every tree's nodes, each tree in its node order, its root first. */
interface Forest {
	readonly trees: ReadonlyArray<ReadonlyArray<WrittenNode>>
}

/**
 * A forest: as many trees as `trees` draws, each tree's shape what `shape` draws (its nodes' parents), each tree's root
 * value apart from the others', every node keyed apart, the keys as `keys` draws them, written tree by tree, and each
 * node's kind.
 */
const forestOf =
	(
		trees: Gen<number>,
		shape: Gen<ReadonlyArray<number>>,
		keys: (total: number) => Gen<ReadonlyArray<number>>
	): Gen<Forest> =>
	(source) => {
		const shapes = upTo(source.draw(trees), () => source.draw(shape))
		const total = Arr.reduce(shapes, 0, (sum, nodes) => sum + nodes.length + 1)
		const drawnKeys = source.draw(keys(total))
		const docs = source.draw(
			shuffled(Arr.range(1, valueBound), { min: shapes.length, max: shapes.length })
		)
		let offset = 0
		const forest = Arr.map(shapes, (nodes, t) => {
			const idOf = (node: number) => defined(drawnKeys[offset + node], "a node's key")
			const doc = defined(docs[t], "a tree's root value")
			const written = upTo(nodes.length + 1, (node) => ({
				id: idOf(node),
				parent: idOf(node === 0 ? 0 : defined(nodes[node - 1], "a node's parent")),
				doc,
				kind: source.draw(int(0, valueBound))
			}))
			offset += nodes.length + 1
			return written
		})
		return { trees: forest }
	}

/** A tree of one to five nodes, its shape drawn by its parents. */
const treeShape: Gen<ReadonlyArray<number>> = parents({ min: 1, max: 5 })

/**
 * One or two trees of one to five nodes, each tree's shape drawn by its parents, its root value apart from the other's,
 * every node keyed apart, the keys drawn in any order, so siblings are written out of their key order, and each node's
 * kind.
 */
const forestGen: Gen<Forest> = forestOf(int(1, 2), treeShape, anyOrder)

/** A root and its two children; a root, its child and its grandchild: by their parents. */
const twoChildren: Gen<ReadonlyArray<number>> = constant([0, 0])
const chain: Gen<ReadonlyArray<number>> = constant([0, 1])

/** The forest each required situation of a tree is aimed at while it is pending (Case.steering). */
const treeAims: ReadonlyArray<Aim<Forest, TreeFeature>> = [
	["two trees", forestOf(constant(2), treeShape, anyOrder)],
	["a root alone", forestOf(int(1, 2), parents({ min: 1, max: 1 }), anyOrder)],
	["a node of several children", forestOf(int(1, 2), twoChildren, anyOrder)],
	["a grandchild", forestOf(int(1, 2), chain, anyOrder)],
	["siblings written out of their key order", forestOf(int(1, 2), twoChildren, descending)]
]

/** A relation's stored rows, each a value per field, a number or the text of a vector's literal. */
interface Stored {
	readonly relation: string
	readonly rows: ReadonlyArray<Readonly<Record<string, number | string>>>
}

/** The installed identifiers of a schema's relations and fields. */
const namesOf = (schemaName: string) => {
	const schemaIdent = quoteIdent(identifierOf(identity.schema(parsedSchemaName(schemaName))))
	return {
		table: (r: string) =>
			`${schemaIdent}.${quoteIdent(identifierOf(identity.table(parsedName(r))))}`,
		column: (f: string) => quoteIdent(identifierOf(identity.column(parsedName(f))))
	}
}

/** Writes stored rows, as the owner, in one SERIALIZABLE transaction, into the first version's tables. */
const inserted = (
	owner: RawSession,
	schemaName: string,
	stored: ReadonlyArray<Stored>
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const { table, column } = namesOf(schemaName)
		yield* owner.query("BEGIN ISOLATION LEVEL SERIALIZABLE", [])
		for (const r of stored) {
			const [first] = r.rows
			if (first === undefined) {
				continue
			}
			const fields = Rec.keys(first)
			yield* owner.query(
				`INSERT INTO ${table(r.relation)} (${Arr.join(Arr.map(fields, column), ", ")}) VALUES ${Arr.join(
					Arr.map(
						r.rows,
						(row) =>
							`(${Arr.join(
								Arr.map(fields, (f) => String(row[f])),
								", "
							)})`
					),
					", "
				)}`,
				[]
			)
		}
		yield* owner.query("COMMIT", [])
	}).pipe(Effect.orDie)

/**
 * The installation migrated from `before` to `after` over `stored`, written into the first version; no constraint of
 * it left NOT VALID.
 */
const migratedOver = (
	label: string,
	before: (name: string) => AnySchema,
	after: (name: string) => AnySchema,
	stored: ReadonlyArray<Stored>
) => declaredMigratedOver(label, before, after, noDeclarations, stored)

/** migratedOver, its migration declaring `declarations`. */
const declaredMigratedOver = (
	label: string,
	before: (name: string) => AnySchema,
	after: (name: string) => AnySchema,
	declarations: Declarations,
	stored: ReadonlyArray<Stored>
) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		let schemaName = ""
		const m = yield* migrated({
			label,
			schemaName: { kind: "unique" },
			first: (name) => {
				schemaName = name
				return { schema: before(name), logins: [] }
			},
			later: [(name) => ({ schema: after(name), logins: [] })],
			apply: { kind: "noPlaceholders" },
			declared: (version) => (version === 0 ? noDeclarations : declarations),
			observe: Option.some((v: number, owner: RawSession) =>
				v !== 0 ? Effect.void : inserted(owner, schemaName, stored)
			)
		})
		const unvalidated = yield* s.admin.queryValues(
			`SELECT count(*)::int4 FROM pg_catalog.pg_constraint WHERE connamespace = '${quoteIdent(m.schema)}'::regnamespace AND NOT convalidated`,
			[]
		)
		assert.equal(
			Number(Arr.getUnsafe(Arr.getUnsafe(unvalidated, 0), 0)),
			0,
			"VALIDATE leaves no constraint NOT VALID"
		)
		return m
	})

/** The rows of `relation` in the installation declared `declared`, each its `fields` as text joined by spaces, sorted. */
const rowsOf = (declared: string, relation: string, fields: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const { table, column } = namesOf(declared)
		const rows = yield* s.admin.queryValues(
			`SELECT ${Arr.join(
				Arr.map(fields, (f) => `${column(f)}::text`),
				", "
			)} FROM ${table(relation)}`,
			[]
		)
		return Arr.sort(
			Arr.map(rows, (row) => Arr.join(Arr.map(row, String), " ")),
			Order.String
		)
	})

/** Whether keys written in this order are out of their own. */
const outOfOrder = (keys: ReadonlyArray<number>): boolean =>
	Arr.some(keys, (key, at) => at > 0 && key < defined(keys[at - 1], "the key before"))

type FamilyFeature =
	| "an empty family"
	| "a family of one"
	| "a family of several"
	| "members written out of their key order"
	| "tags copied"
	| "a fold without a copy"

type TreeFeature =
	| "two trees"
	| "a root alone"
	| "a node of several children"
	| "a grandchild"
	| "siblings written out of their key order"

/** Each owner of a family: its id, its tag, and its members in the order they are written. */
const ownersOf = (family: Family) =>
	Arr.map(family.tags, (tag, owner) => ({
		owner,
		tag,
		members: Arr.filter(family.members, (mb) => mb.g === owner)
	}))

/** What a family reaches: each owner's family by its size, members written out of key order, and the copy or none. */
const familyFeatures = (family: Family): ReadonlyArray<FamilyFeature> => [
	...Arr.flatMap(ownersOf(family), (f): ReadonlyArray<FamilyFeature> => [
		f.members.length === 0
			? "an empty family"
			: f.members.length === 1
				? "a family of one"
				: "a family of several",
		...(outOfOrder(Arr.map(f.members, (mb) => mb.member))
			? ["members written out of their key order" as const]
			: [])
	]),
	family.copied ? "tags copied" : "a fold without a copy"
]

/** The written node of key `id` among `nodes`. */
const nodeIn = (nodes: ReadonlyArray<WrittenNode>, id: number): WrittenNode =>
	defined(Option.getOrUndefined(Arr.findFirst(nodes, (n) => n.id === id)), "a written node")

/** The children of the node of key `id` among `nodes`, in the order they are written. */
const childrenIn = (nodes: ReadonlyArray<WrittenNode>, id: number): ReadonlyArray<WrittenNode> =>
	Arr.filter(nodes, (n) => n.parent === id && n.id !== id)

/** What a forest reaches: two trees, a root alone, a node of several children, a grandchild, siblings out of order. */
const forestFeatures = (forest: Forest): ReadonlyArray<TreeFeature> => {
	const nodes = Arr.flatten(forest.trees)
	return [
		...(forest.trees.length > 1 ? ["two trees" as const] : []),
		...Arr.flatMap(nodes, (n): ReadonlyArray<TreeFeature> => {
			const children = childrenIn(nodes, n.id)
			return [
				...(n.parent === n.id && children.length === 0 ? ["a root alone" as const] : []),
				...(children.length > 1 ? ["a node of several children" as const] : []),
				...(outOfOrder(Arr.map(children, (child) => child.id))
					? ["siblings written out of their key order" as const]
					: []),
				...(n.parent !== n.id && nodeIn(nodes, n.parent).parent !== n.parent
					? ["a grandchild" as const]
					: [])
			]
		})
	]
}

/**
 * What the migration that keys the members by their group and a new drawn index declares of the vector key they were
 * stored by: kept as a field, renamed to item, or dropped. Its backfill orders and joins the stored members by that
 * key (deploy/diff/backfill.ts memberKey), at pgvector's operators, which no search_path holds.
 */
const vectorKeyFates = ["kept", "renamed", "dropped"] as const
type VectorKeyFate = (typeof vectorKeyFates)[number]

/** The members before the migration, keyed by a vector of two dimensions. */
const vectorKeyed = (name: string) =>
	schema(
		name,
		[
			relation("Owner", { id: pg.int4 }, ["id"]),
			relation("Member", { member: pg.vector(2), g: pg.int4, x: pg.int4 }, ["member"])
		],
		[]
	)

/** The owners after the migration: each counts its members and sums their x. */
const countingOwner = relation(
	"Owner",
	{ id: pg.int4, n: drawnField(natural), end: accumulated(pg.int4, 0) },
	["id"]
)

/** The members after the migration, keyed by their group and a new drawn index, the vector key kept as `member`. */
const vectorKept = (name: string) => {
	const Member = relation(
		"Member",
		{ member: pg.vector(2), g: pg.int4, at: drawnField(natural), x: pg.int4 },
		["g", "at"]
	)
	const family = ordered(on(Member, "g", "at"), fin(countingOwner, "n"))
	return schema(
		name,
		[countingOwner, Member],
		[family, fold(family, Monoid.sum, on(Member, "g", "x"), on(countingOwner, "id", "end"))]
	)
}

/** vectorKept with the vector key renamed to item. */
const vectorRenamed = (name: string) => {
	const Member = relation(
		"Member",
		{ item: pg.vector(2), g: pg.int4, at: drawnField(natural), x: pg.int4 },
		["g", "at"]
	)
	const family = ordered(on(Member, "g", "at"), fin(countingOwner, "n"))
	return schema(
		name,
		[countingOwner, Member],
		[family, fold(family, Monoid.sum, on(Member, "g", "x"), on(countingOwner, "id", "end"))]
	)
}

/** vectorKept with the vector key dropped. */
const vectorDropped = (name: string) => {
	const Member = relation("Member", { g: pg.int4, at: drawnField(natural), x: pg.int4 }, [
		"g",
		"at"
	])
	const family = ordered(on(Member, "g", "at"), fin(countingOwner, "n"))
	return schema(
		name,
		[countingOwner, Member],
		[family, fold(family, Monoid.sum, on(Member, "g", "x"), on(countingOwner, "id", "end"))]
	)
}

/** Each fate's target and declarations. */
const vectorFates: {
	readonly [F in VectorKeyFate]: {
		readonly after: (name: string) => AnySchema
		readonly declared: Declarations
	}
} = {
	kept: { after: vectorKept, declared: noDeclarations },
	renamed: {
		after: vectorRenamed,
		declared: {
			renames: [
				{
					from: { kind: "field", relation: parsedName("Member"), field: parsedName("member") },
					to: { kind: "field", relation: parsedName("Member"), field: parsedName("item") }
				}
			],
			drops: []
		}
	},
	dropped: {
		after: vectorDropped,
		declared: {
			renames: [],
			drops: [{ kind: "field", relation: parsedName("Member"), field: parsedName("member") }]
		}
	}
}

/** Members stored by a vector key, and its fate: the family as drawn, each member's key [k, 0], whose order is k's. */
interface VectorKeyedFamily {
	readonly fate: VectorKeyFate
	readonly owners: number
	readonly members: ReadonlyArray<WrittenMember>
}

/** Members stored by a vector key: the family `family` draws, and the key's fate `fate` draws. */
const vectorKeyedOf =
	(family: Gen<Family>, fate: Gen<VectorKeyFate>): Gen<VectorKeyedFamily> =>
	(source) => {
		const drawnFamily = source.draw(family)
		return {
			fate: source.draw(fate),
			owners: drawnFamily.tags.length,
			members: drawnFamily.members
		}
	}

const vectorKeyedGen: Gen<VectorKeyedFamily> = vectorKeyedOf(familyGen, element(vectorKeyFates))

type VectorKeyFeature =
	| `the key ${VectorKeyFate}`
	| "a family of several"
	| "members written out of their key order"

/** What a vector-keyed family reaches: its key's fate, a family of several, members written out of key order. */
const vectorKeyFeatures = (f: VectorKeyedFamily): ReadonlyArray<VectorKeyFeature> => [
	`the key ${f.fate}`,
	...Arr.flatMap(
		upTo(f.owners, (owner) => owner),
		(owner): ReadonlyArray<VectorKeyFeature> => {
			const keys = Arr.map(
				Arr.filter(f.members, (mb) => mb.g === owner),
				(mb) => mb.member
			)
			return [
				...(keys.length > 1 ? ["a family of several" as const] : []),
				...(outOfOrder(keys) ? ["members written out of their key order" as const] : [])
			]
		}
	)
]

/** The vector-keyed family each required situation is aimed at while it is pending (Case.steering). */
const vectorKeyAims: ReadonlyArray<Aim<VectorKeyedFamily, VectorKeyFeature>> = [
	...Arr.map(vectorKeyFates, (fate): Aim<VectorKeyedFamily, VectorKeyFeature> => [
		`the key ${fate}`,
		vectorKeyedOf(familyGen, constant(fate))
	]),
	[
		"a family of several",
		vectorKeyedOf(familyOf(leading(int(2, 4)), anyOrder, boolean), element(vectorKeyFates))
	],
	[
		"members written out of their key order",
		vectorKeyedOf(familyOf(leading(int(2, 4)), descending, boolean), element(vectorKeyFates))
	]
]

layer(Substrate.layer)("backfilling a counted family with a fold on PostgreSQL 19rc1", (it) => {
	it.effect(
		"draw every hidden index, copy, accumulator, count and end of populated families in key order, each owner's tag along the owner axis, and VALIDATE every native",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/migrate/backfill-family",
						draw: drawn(familyGen),
						literal: Formatter.format,
						coverage: required<FamilyFeature>(
							[
								"an empty family",
								"a family of one",
								"a family of several",
								"members written out of their key order",
								"tags copied",
								"a fold without a copy"
							],
							{ cases: 12, sense: notesOnly }
						),
						kept: [],
						runs: 3,
						shrink: { kind: "bounded", candidates: 24 },
						concurrency: 1,
						steerEvery: 4,
						caseHang,
						oracle: {
							kind: "second-implementation",
							name: "the reference fold of each owner's members in key order, and each owner's tag on its members"
						}
					},
					(drawnFamily: Family, c: Case<FamilyFeature>) =>
						Effect.gen(function* () {
							const family = aimedAt(familyAims)(drawnFamily, c)
							c.noteAll(familyFeatures(family))
							const families = ownersOf(family)
							const m = yield* migratedOver(
								"backfill",
								family.copied ? copyBefore : before,
								family.copied ? copyAfter : after,
								[
									{
										relation: "Owner",
										rows: Arr.map(families, (f) =>
											family.copied ? { id: f.owner, tag: f.tag } : { id: f.owner }
										)
									},
									{
										relation: "Member",
										rows: Arr.map(family.members, (mb) => ({ member: mb.member, g: mb.g, x: mb.x }))
									}
								]
							)
							const seat = yield* seatOfInstalled(m, ["Owner", "Member"], "backfill")
							const f = foldSeatOf(
								{ ...SPEC, schema: (family.copied ? copyAfter : after)(m.declared) },
								seat
							)
							const read = yield* foldRead(f)
							const expected = foldStoredOf(
								SPEC.monoid,
								Arr.map(families, (o) => ({
									owner: o.owner,
									members: Arr.map(
										Arr.sort(
											o.members,
											Order.mapInput(Order.Number, (mb: WrittenMember) => mb.member)
										),
										(mb) => ({ member: mb.member, x: BigInt(mb.x), selected: true })
									)
								}))
							)
							assert.deepEqual(
								read,
								byMember(expected),
								"the backfill draws the reference fold of each family in key order"
							)
							if (!family.copied) {
								return
							}
							const tagged = yield* rowsOf(m.declared, "Member", ["member", "ownerTag"])
							assert.deepEqual(
								tagged,
								Arr.sort(
									Arr.map(
										family.members,
										(mb) => `${mb.member} ${defined(family.tags[mb.g], "its owner's tag")}`
									),
									Order.String
								),
								"each member holds its owner's tag"
							)
						})
				)
			)
	)

	it.effect(
		"draw a forest's numbering, its count fold over each node's siblings, the root its one admitted state, and each parent copy, the root its own",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/migrate/backfill-tree",
						draw: drawn(forestGen),
						literal: Formatter.format,
						coverage: required<TreeFeature>(
							[
								"two trees",
								"a root alone",
								"a node of several children",
								"a grandchild",
								"siblings written out of their key order"
							],
							{ cases: 12, sense: notesOnly }
						),
						kept: [],
						runs: 3,
						shrink: { kind: "bounded", candidates: 24 },
						concurrency: 1,
						steerEvery: 4,
						caseHang,
						oracle: {
							kind: "second-implementation",
							name: "the direct pre-order numbering of the forest, its children in key order, and each parent's kind"
						}
					},
					(drawnForest: Forest, c: Case<TreeFeature>) =>
						Effect.gen(function* () {
							const forest = aimedAt(treeAims)(drawnForest, c)
							c.noteAll(forestFeatures(forest))
							const nodes = Arr.flatten(forest.trees)
							const byId = (id: number): WrittenNode => nodeIn(nodes, id)
							const childrenOf = (id: number): ReadonlyArray<WrittenNode> => childrenIn(nodes, id)
							const m = yield* migratedOver("backfilltree", treeBefore, treeAfter, [
								{
									relation: "Node",
									rows: Arr.map(nodes, (n) => ({
										id: n.id,
										parent: n.parent,
										doc: n.doc,
										kind: n.kind
									}))
								}
							])
							const nodeOf = (id: number): Node => ({
								id,
								children: Arr.map(
									Arr.sort(
										childrenOf(id),
										Order.mapInput(Order.Number, (n: WrittenNode) => n.id)
									),
									(n) => nodeOf(n.id)
								)
							})
							const roots: ReadonlyArray<Rooted> = Arr.sort(
								Arr.map(
									Arr.filter(nodes, (n) => n.parent === n.id),
									(r): Rooted => ({ root: r.doc, tree: nodeOf(r.id) })
								),
								Order.mapInput(Order.Number, (r: Rooted) => r.root)
							)
							const numberedRows = yield* rowsOf(m.declared, "Node", [
								"id",
								"at",
								"children",
								"start",
								"end",
								"before",
								"after",
								"total",
								"parentKind"
							])
							assert.deepEqual(
								numberedRows,
								Arr.sort(
									Arr.map(numbered(roots), (r) =>
										Arr.join(
											Arr.map(
												[
													r.id,
													r.at,
													r.children,
													r.start,
													r.end,
													r.at,
													r.at + 1,
													r.children,
													byId(byId(r.id).parent).kind
												],
												String
											),
											" "
										)
									),
									Order.String
								),
								"NP's numbering, NP's lawful count fold, each parent's kind"
							)
						})
				)
			)
	)
	it.effect(
		"order and join members stored by a vector key the migration keeps, renames or drops at the extension's operators, and draw every index, count and end in that key's order",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/migrate/backfill-vector-key",
						draw: drawn(vectorKeyedGen),
						literal: Formatter.format,
						coverage: required<VectorKeyFeature>(
							[
								"the key kept",
								"the key renamed",
								"the key dropped",
								"a family of several",
								"members written out of their key order"
							],
							{ cases: 12, sense: notesOnly }
						),
						kept: [],
						runs: 3,
						shrink: { kind: "bounded", candidates: 24 },
						concurrency: 1,
						steerEvery: 4,
						caseHang,
						oracle: {
							kind: "second-implementation",
							name: "each owner's members in the order of their vector key [k, 0], k's, numbered from 0 and summed"
						}
					},
					(drawnFamily: VectorKeyedFamily, c: Case<VectorKeyFeature>) =>
						Effect.gen(function* () {
							const f = aimedAt(vectorKeyAims)(drawnFamily, c)
							c.noteAll(vectorKeyFeatures(f))
							const fate = vectorFates[f.fate]
							const owners = upTo(f.owners, (owner) => owner)
							const m = yield* declaredMigratedOver(
								"backfillvector",
								vectorKeyed,
								fate.after,
								fate.declared,
								[
									{ relation: "Owner", rows: Arr.map(owners, (id) => ({ id })) },
									{
										relation: "Member",
										rows: Arr.map(f.members, (mb) => ({
											member: `'[${mb.member},0]'`,
											g: mb.g,
											x: mb.x
										}))
									}
								]
							)
							const ownedInKeyOrder = (owner: number) =>
								Arr.sort(
									Arr.filter(f.members, (mb) => mb.g === owner),
									Order.mapInput(Order.Number, (mb: WrittenMember) => mb.member)
								)
							const members = yield* rowsOf(m.declared, "Member", ["g", "at", "x"])
							const owning = yield* rowsOf(m.declared, "Owner", ["id", "n", "end"])
							assert.deepEqual(
								members,
								Arr.sort(
									Arr.flatMap(owners, (owner) =>
										Arr.map(ownedInKeyOrder(owner), (mb, at) => `${owner} ${at} ${mb.x}`)
									),
									Order.String
								),
								"each member's index is its place in its owner's vector key order"
							)
							assert.deepEqual(
								owning,
								Arr.sort(
									Arr.map(owners, (owner) => {
										const mine = ownedInKeyOrder(owner)
										return `${owner} ${mine.length} ${Arr.reduce(mine, 0, (sum, mb) => sum + mb.x)}`
									}),
									Order.String
								),
								"each owner counts its members and sums their x"
							)
						})
				)
			)
	)
})
