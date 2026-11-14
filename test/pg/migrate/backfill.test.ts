/**
 * Adding a counted family with a fold to populated relations, on PostgreSQL 19rc2 (rows-first §6): A4's backfill data
 * step draws every member's hidden index, ‹i› = row_number() OVER (PARTITION BY g ORDER BY its key) − 1, its copy of the
 * count, and each fold plane's before and after as running sums in ‹i› order, and the owner's count and end; VALIDATE
 * then proves every native over the backfilled rows.
 *
 * - **A second implementation:** the reference fold (test/support/families/fold.ts) of each owner's members in key
 *   order states every backfilled value of a family, each owner's tag is what its members' copy holds, and for a tree
 *   the direct pre-order numbering of each tree under its root value (test/support/families/tree.ts) states every
 *   node's slot, count, interval, fold and parent's kind; what the migration leaves must be exactly that.
 * - **PostgreSQL as the judge:** the migration commits, and no constraint of the installation is left NOT VALID.
 *
 * The spaces, generated: one to three owners whose members fall among them in any counts, so a backfill meets empty
 * families, families of one (the first slot the last) and families whose predecessor chain the running sum must close;
 * member keys drawn apart and written out of their order, and each member's value; and the same family with each
 * owner's tag copied onto its members along the owner axis, or without. And one or two trees of one to five nodes,
 * keyed by their root value (doc, page) and start, each under its own root value, two of which may share a doc or a
 * page, stored lawful by a direct writer, then folded by count over each node's children, as NP's fold suite folds it
 * (test/pg/fin/fold.test.ts), and each node's parent's kind copied down the parent axis, the root its own, both added by
 * the migration. And members stored by a vector key that the migration which keys them by their
 * group and a new drawn index keeps as a field, renames or drops, declared: its backfill orders and joins the stored
 * members by that key at the extension's operators, the dropped one's column standing until the migration's removals.
 *
 * Features: an empty family, a family of one and of several, members written out of their key order, tags copied or
 * not; two trees, a root alone, a node of several children, a grandchild; and each fate of a vector key. Each pending situation is aimed at by a case constructed to reach it (a leading owner of a
 * drawn size, keys written from the highest down, a fixed tree shape, a fixed fate), never by filtering draws.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): backfill-family-index-from-one (a family's backfilled index counts
 * from 1) and backfill-vector-stored-key-ignored (members keyed anew are ordered by their new key, not the one their
 * rows were distinct by); (~/.cache/grizzle-release/TREEKEY/plants) tree-copy-crosses-roots (a copy along a tree's
 * parent drawn from the node at the parent's start under any root value) and tree-fold-crosses-roots (a fold over a
 * tree's siblings partitioned by their parent's start alone).
 *
 * A stored index is data: an ordered family whose owner is re-keyed keeps each member's stored index (README "A stored
 * index is data"). A case stores one or two ordered families over one owner, keyed by an int4 id, each family's
 * members in a drawn stored order (keys drawn apart, so mostly out of the stored order), the first folded by sum of x
 * into named accumulators, the second folded or not; then migrates to an owner keyed by one to three fields of drawn
 * types (text, int8, uuid), each member's group re-pointed to them, the old id and group dropped, as declared. The
 * reviewer's data step, written before each placeholder's DROP DEFAULT as its line asks, gives each owner its new key and
 * each member its group by a weighted fate the case's swarm draws per family: each member stays with its owner;
 * members move between owners (a regroup, one member moved by construction); or members move and the migration
 * declares the family's index dropped (`--drop M.at`), drawing it anew.
 *
 * - **A second implementation:** the reference fold of each owner's members after the data step, in their stored
 *   order, or in their member key's where the index is declared dropped, states each member's index, before and
 *   after, and each owner's count and end; what the migration leaves must be exactly that.
 * - **PostgreSQL as the judge:** a regroup that leaves some owner's kept indices other than 0 … n − 1 is refused in
 *   the re-key's folder, naming the law of that family or of its fold (migrate's StatementFailed or FileCommitRefused
 *   `law`, the laws the compiled target names); any other case commits, no constraint left NOT VALID.
 *
 * Features: two ordered families on one owner, a fold over a kept order out of member-key order, a regroup refused
 * and a regroup redrawn as declared, each aimed at by a re-key constructed to reach it.
 *
 * Plants (~/.cache/grizzle-release/ORDERKEEP/plants): orderkeep-member-key-redraw (a re-pointed family's index is drawn
 * again in member-key order), orderkeep-fold-in-key-order (the folds over a kept index run in member-key order),
 * orderkeep-silent-renumber (a kept index is renumbered within each new group, so no regroup is refused) and
 * orderkeep-declared-drop-refused (`--drop M.at` beside a declared M.at is refused).
 */
import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
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
} from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { type Swarm, swarm, swarmChoice } from "@bjornpagen/testing/swarm"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { accumulated, drawn as drawnField, natural, pg, uuid } from "#compiler/public/fields.ts"
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
import { str } from "#compiler/public/text.ts"
import { relation as storedRelation } from "#compiler/schema/relation.ts"
import { schema as schemaOf } from "#compiler/schema/schema.ts"
import {
	finBuilder,
	foldBuilder,
	monoids,
	onBuilder,
	orderedBuilder
} from "#compiler/schema/statements.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { byMember, FOLD_SPECS, foldRead, foldSeatOf } from "#test/pg/fin/folds.ts"
import { seatOfInstalled } from "#test/pg/fin/installed.ts"
import { type Aim, aimedAt } from "#test/pg/migrate/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { foldStoredOf } from "#test/support/families/fold.ts"
import {
	type Forest as KeyedForest,
	type Node as TreeNode,
	numbered,
	treeOfParents
} from "#test/support/families/tree.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { asDrafted, compile, noDeclarations } from "#test/support/migrate/kit.ts"
import type { Placeholder } from "#test/support/migrate/review.ts"
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

/**
 * A tree of Node keyed by its root value (doc, page) and its start, installed and holding rows; then folded by count over
 * each node's children (FoldedTree's), each node's parent's kind copied down the parent axis, the root its own, both
 * added by the migration over the stored rows.
 */
const treeBefore = (name: string) => {
	const Node_ = relation(
		"Node",
		{
			doc: pg.int4,
			page: str.regex("^p[0-9]{1,2}$"),
			parent: drawnField(natural),
			at: drawnField(natural),
			children: drawnField(natural),
			start: drawnField(natural),
			end: drawnField(natural),
			kind: pg.int4
		},
		["doc", "page", "start"]
	)
	return schema(
		name,
		[Node_],
		[tree(on(Node_, "parent", "at"), fin(Node_, "children"), { root: ["doc", "page"] })]
	)
}

const treeAfter = (name: string) => {
	const Node_ = relation(
		"Node",
		{
			doc: pg.int4,
			page: str.regex("^p[0-9]{1,2}$"),
			parent: drawnField(natural),
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
		["doc", "page", "start"]
	)
	const t = tree(on(Node_, "parent", "at"), fin(Node_, "children"), { root: ["doc", "page"] })
	return schema(
		name,
		[Node_],
		[
			t,
			fold(
				t,
				Monoid.count,
				on(Node_, "doc", "page", "parent", "before", "after"),
				on(Node_, "doc", "page", "start", "total")
			),
			contained(
				on(
					select(Node_, (n) => n.gt(n.start, 0n)),
					"doc",
					"page",
					"parent",
					"parentKind"
				),
				on(Node_, "doc", "page", "start", "kind")
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

/** A forest as stored: each tree under its root value (doc, page), its shape and kinds, numbered as NP numbers it. */
interface Forest {
	readonly trees: ReadonlyArray<KeyedForest[number]>
}

/**
 * A forest: as many trees as `trees` draws, each tree's shape what `shape` draws (its nodes' parents) and each node's
 * kind, each tree's root value apart from the others' and drawn from a few docs and pages, so two trees may share a
 * doc or a page, every tree holding the same starts.
 */
const forestOf =
	(trees: Gen<number>, shape: Gen<ReadonlyArray<number>>): Gen<Forest> =>
	(source) => {
		const count = source.draw(trees)
		const roots = source.draw(
			shuffled(
				Arr.flatMap(Arr.range(1, 2), (doc) =>
					Arr.map(Arr.range(0, 1), (page) => [String(doc), `p${page}`] as const)
				),
				{ min: count, max: count }
			)
		)
		return {
			trees: upTo(count, (t) => {
				const parentOf = source.draw(shape)
				return {
					root: defined(roots[t], "a tree's root value"),
					tree: treeOfParents(
						parentOf,
						upTo(parentOf.length + 1, () => source.draw(int(0, valueBound)))
					)
				}
			})
		}
	}

/** A tree of one to five nodes, its shape drawn by its parents. */
const treeShape: Gen<ReadonlyArray<number>> = parents({ min: 1, max: 5 })

/** One or two trees of one to five nodes, each tree's shape drawn by its parents, its root value apart from the other's. */
const forestGen: Gen<Forest> = forestOf(int(1, 2), treeShape)

/** A root and its two children; a root, its child and its grandchild: by their parents. */
const twoChildren: Gen<ReadonlyArray<number>> = constant([0, 0])
const chain: Gen<ReadonlyArray<number>> = constant([0, 1])

/** The forest each required situation of a tree is aimed at while it is pending (Case.steering). */
const treeAims: ReadonlyArray<Aim<Forest, TreeFeature>> = [
	["two trees", forestOf(constant(2), treeShape)],
	["a root alone", forestOf(int(1, 2), parents({ min: 1, max: 1 }))],
	["a node of several children", forestOf(int(1, 2), twoChildren)],
	["a grandchild", forestOf(int(1, 2), chain)]
]

/**
 * A relation's stored rows, each a value per field, a number or a literal's text, or per `‹n›`, its family's copy of
 * its owner's count, the drawn law column a tree's direct writer writes.
 */
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

/**
 * Writes stored rows, as the owner, in one SERIALIZABLE transaction, into the first version's tables, `before`'s: each
 * field's column by its name, and `‹n›` the column of the copy of the family whose member the relation is, by the law
 * that names it in `before` compiled.
 */
const inserted = (
	owner: RawSession,
	schemaName: string,
	before: AnySchema,
	stored: ReadonlyArray<Stored>
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const { table, column } = namesOf(schemaName)
		const families = compile(before, asDrafted).laws.families
		const columnOf = (relation: string, f: string): string =>
			f === "‹n›"
				? quoteIdent(
						defined(
							Option.getOrUndefined(Arr.findFirst(families, (g) => g.member.name === relation)),
							`the family whose member is ${relation}`
						).copy
					)
				: column(f)
		yield* owner.query("BEGIN ISOLATION LEVEL SERIALIZABLE", [])
		for (const r of stored) {
			const [first] = r.rows
			if (first === undefined) {
				continue
			}
			const fields = Rec.keys(first)
			yield* owner.query(
				`INSERT INTO ${table(r.relation)} (${Arr.join(
					Arr.map(fields, (f) => columnOf(r.relation, f)),
					", "
				)}) VALUES ${Arr.join(
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
				v !== 0 ? Effect.void : inserted(owner, schemaName, before(schemaName), stored)
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

type TreeFeature = "two trees" | "a root alone" | "a node of several children" | "a grandchild"

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

/** The depth of a node's subtree: 1 for a leaf. */
const depthOf = (node: TreeNode): number =>
	1 + Arr.reduce(node.children, 0, (deepest, child) => Math.max(deepest, depthOf(child)))

/** Every node of a tree, itself first. */
const nodesOf = (node: TreeNode): ReadonlyArray<TreeNode> => [
	node,
	...Arr.flatMap(node.children, nodesOf)
]

/** What a forest reaches: two trees, a root alone, a node of several children, a grandchild. */
const forestFeatures = (forest: Forest): ReadonlyArray<TreeFeature> => [
	...(forest.trees.length > 1 ? ["two trees" as const] : []),
	...Arr.flatMap(forest.trees, ({ tree: t }): ReadonlyArray<TreeFeature> => [
		...(t.children.length === 0 ? ["a root alone" as const] : []),
		...(Arr.some(nodesOf(t), (n) => n.children.length > 1)
			? ["a node of several children" as const]
			: []),
		...(depthOf(t) >= 3 ? ["a grandchild" as const] : [])
	])
]

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

/** A field of the re-keyed owner's key, and of each member's group that pairs with it: text, a bigint or a uuid. */
const keyTypes = ["text", "int8", "uuid"] as const
type KeyType = (typeof keyTypes)[number]

/** The values a key field draws its three from, each as PostgreSQL prints it: two owners' keys may share a field. */
const keyPools: { readonly [T in KeyType]: Arr.NonEmptyReadonlyArray<string> } = {
	text: ["", "a", "b", "ab", "é", "Z", "a b"],
	int8: ["-9223372036854775808", "-1", "0", "7", "9223372036854775807"],
	uuid: [
		"00000000-0000-0000-0000-000000000000",
		"0f8fad5b-d9cb-469f-a165-70867728950e",
		"7c9e6679-7425-40de-944b-e07fc1f90ae7",
		"ffffffff-ffff-ffff-ffff-ffffffffffff"
	]
}

/** A text key field, bounded so every index over it beside the other key fields, an index and an accumulator fits. */
const keyText = str.bytes(40, str.regex("^.*$", "su"))

const keyFieldOf = (type: KeyType): FieldBase => {
	switch (type) {
		case "text":
			return keyText
		case "int8":
			return pg.int8
		case "uuid":
			return uuid
	}
}

/** A key value as an SQL literal of its type. */
const keyLiteral = (type: KeyType, value: string): string =>
	`'${Str.replaceAll("'", "''")(value)}'::${type}`

/** A key field of the re-keyed owner: its type, and the three values its owners' keys draw from. */
interface KeyField {
	readonly type: KeyType
	readonly values: Arr.NonEmptyReadonlyArray<string>
}

/**
 * What the migration's data step does with a family's members: each stays with its owner under the owner's new key;
 * members move to other owners and keep their stored indices; or members move and the migration declares the stored
 * index dropped (`--drop M.at`), so it draws the index anew. The last two are regroups: each moves a member.
 */
const fates = ["kept", "regrouped", "redrawn"] as const
type Fate = (typeof fates)[number]

/** A member as stored: its key, its value, and the owner the data step gives it, its own or another's. */
interface Placed {
	readonly member: number
	readonly x: number
	readonly to: number
}

/** An ordered family over the owner: each owner's members in their stored order, the index each holds; whether a sum
 * fold of x runs over it; and its fate in the migration. */
interface Sequence {
	readonly fate: Fate
	readonly folded: boolean
	readonly owners: ReadonlyArray<ReadonlyArray<Placed>>
}

/** A re-key: the owner's new key fields, each owner's new key (one value per field, no two owners' alike), and the one
 * or two ordered families over the owner. Owner o is id o before the migration. */
interface Rekey {
	readonly fields: Arr.NonEmptyReadonlyArray<KeyField>
	readonly keys: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>>
	readonly families: Arr.NonEmptyReadonlyArray<Sequence>
}

const keyFieldGen: Gen<KeyField> = (source) => {
	const type = source.draw(element(keyTypes))
	return {
		type,
		values: nonEmptyList(
			source.draw(shuffled(keyPools[type], { min: 3, max: 3 })),
			"a key field's values"
		)
	}
}

/** Every key the fields' values make, one value per field in field order. */
const keysOver = (fields: ReadonlyArray<KeyField>): ReadonlyArray<ReadonlyArray<string>> => {
	const none: ReadonlyArray<ReadonlyArray<string>> = [[]]
	return Arr.reduce(fields, none, (keys, f) =>
		Arr.flatMap(keys, (key) => Arr.map(f.values, (v) => [...key, v]))
	)
}

/** How a family is drawn: its members' counts among the owners, their keys written owner by owner in stored order,
 * its fate given the case's swarm and whether a member can move, which member a regroup moves, and whether each other
 * member stays with its owner. */
interface SequenceDraw {
	readonly counts: (owners: number) => Gen<ReadonlyArray<number>>
	readonly keys: (total: number) => Gen<ReadonlyArray<number>>
	readonly fate: (swarmed: Swarm<Fate>, movable: boolean) => Gen<Fate>
	readonly moved: (total: number) => Gen<number>
	readonly stays: Gen<boolean>
}

/** Up to six members falling among the owners in drawn counts. */
const memberCounts =
	(owners: number): Gen<ReadonlyArray<number>> =>
	(source) =>
		source.draw(composition(source.draw(int(0, 6)), owners))

/** The first owner holding `count` members, the rest up to six among the others. */
const leadingCounts =
	(count: Gen<number>) =>
	(owners: number): Gen<ReadonlyArray<number>> =>
	(source) => [source.draw(count), ...source.draw(composition(source.draw(int(0, 6)), owners - 1))]

/** The case's swarm's choice of fate where a member can move; else each member stays, the one fate left. */
const swarmedFate = (swarmed: Swarm<Fate>, movable: boolean): Gen<Fate> =>
	movable ? swarmChoice(swarmed, fates) : constant("kept")

const anySequence: SequenceDraw = {
	counts: memberCounts,
	keys: anyOrder,
	fate: swarmedFate,
	moved: (total) => int(0, total - 1),
	stays: boolean
}

/**
 * A family over `owners` owners: members falling among them, keyed apart and written in stored order, each with its
 * value; and its fate. A regroup moves one drawn member to another owner, and each other member stays or moves to a
 * drawn owner, by construction, never by filtering: a family whose members cannot move (one owner, or no member) keeps
 * every member's owner.
 */
const sequenceOf =
	(owners: number, folded: boolean, swarmed: Swarm<Fate>, d: SequenceDraw): Gen<Sequence> =>
	(source) => {
		const counts = source.draw(d.counts(owners))
		const total = Arr.reduce(counts, 0, (sum, n) => sum + n)
		const keys = source.draw(d.keys(total))
		const fate = source.draw(d.fate(swarmed, owners > 1 && total > 0))
		const moved = fate === "kept" ? Option.none() : Option.some(source.draw(d.moved(total)))
		const everyOwner = upTo(owners, (o) => o)
		let at = 0
		const placed = Arr.map(counts, (count, owner) =>
			upTo(count, (): Placed => {
				const index = at
				at += 1
				const to = Option.contains(moved, index)
					? source.draw(
							element(
								nonEmptyList(
									Arr.filter(everyOwner, (o) => o !== owner),
									"another owner"
								)
							)
						)
					: fate === "kept" || source.draw(d.stays)
						? owner
						: source.draw(element(nonEmptyList(everyOwner, "an owner")))
				return {
					member: defined(keys[index], "a member's key"),
					x: source.draw(int(-valueBound, valueBound)),
					to
				}
			})
		)
		return { fate, folded, owners: placed }
	}

/** How a re-key is drawn: its key's arity, its owners, its families, and each family's draw, the first's and the
 * second's. */
interface RekeyDraw {
	readonly arity: Gen<number>
	readonly owners: Gen<number>
	readonly families: Gen<number>
	readonly first: SequenceDraw
	readonly second: SequenceDraw
}

const rekeyOf =
	(d: RekeyDraw): Gen<Rekey> =>
	(source) => {
		const fields = nonEmptyList(
			upTo(source.draw(d.arity), () => source.draw(keyFieldGen)),
			"the key's fields"
		)
		const owners = source.draw(d.owners)
		const keys = nonEmptyList(
			source.draw(shuffled(keysOver(fields), { min: owners, max: owners })),
			"the owners' keys"
		)
		const swarmed = source.draw(swarm(fates))
		const first = source.draw(sequenceOf(owners, true, swarmed, d.first))
		const families = source.draw(d.families)
		const rest =
			families > 1 ? [source.draw(sequenceOf(owners, source.draw(boolean), swarmed, d.second))] : []
		return { fields, keys, families: [first, ...rest] }
	}

const anyRekey: RekeyDraw = {
	arity: int(1, 3),
	owners: int(1, 3),
	families: int(1, 2),
	first: anySequence,
	second: anySequence
}

/** A key of one to three fields of any types, one to three owners, one or two families, each fate the case's swarm
 * weighs. */
const rekeyGen: Gen<Rekey> = rekeyOf(anyRekey)

/** A member after the data step: its key, its value and its stored index. */
interface Regrouped {
	readonly member: number
	readonly x: number
	readonly at: number
}

const byStoredIndex = Order.mapInput(Order.Number, (m: Regrouped) => m.at)
const byMemberKey = Order.mapInput(Order.Number, (m: Regrouped) => m.member)

/**
 * The members each owner holds once the data step has run, each with its stored index, in the order the migration
 * gives them: their stored order, which it keeps, or, where the migration declares the index dropped, their member
 * key's, which it draws anew.
 */
const groupsAfter = (s: Sequence, owners: number): ReadonlyArray<ReadonlyArray<Regrouped>> => {
	const placed = Arr.flatMap(s.owners, (members) =>
		Arr.map(members, (m, at) => ({ member: m.member, x: m.x, at, to: m.to }))
	)
	return upTo(owners, (o) =>
		Arr.sort(
			Arr.filter(placed, (m) => m.to === o),
			s.fate === "redrawn" ? byMemberKey : byStoredIndex
		)
	)
}

/** Whether every owner's kept indices are 0 … n − 1 after the data step: the kept order a lawful sequence under the
 * new groups. A family whose index the migration draws anew keeps none. */
const keepsSequences = (s: Sequence, owners: number): boolean =>
	s.fate === "redrawn" ||
	Arr.every(groupsAfter(s, owners), (group) => Arr.every(group, (m, i) => m.at === i))

/** The family's state the reference fold states: each owner's members in `groups`' order, folded by sum. */
const foldedOver = (groups: ReadonlyArray<ReadonlyArray<Regrouped>>) =>
	foldStoredOf(
		SPEC.monoid,
		Arr.map(groups, (members, owner) => ({
			owner,
			members: Arr.map(members, (m) => ({ member: m.member, x: BigInt(m.x), selected: true }))
		}))
	)

/** The family's state as stored before the migration: each owner's members in stored order. */
const storedState = (s: Sequence) =>
	foldedOver(
		Arr.map(s.owners, (members) =>
			Arr.map(members, (m, at): Regrouped => ({ member: m.member, x: m.x, at }))
		)
	)

/** The names a re-key's relations and fields are declared under: the owner O; the families' members M1 and M2, the
 * i-th family's count n<i> and its fold's end e<i> on O; the key fields k1… on O and the group fields g1… on each
 * member. */
const memberName = (family: number): string => `M${family + 1}`
const countName = (family: number): string => `n${family + 1}`
const endName = (family: number): string => `e${family + 1}`
const keyName = (j: number): string => `k${j + 1}`
const groupName = (j: number): string => `g${j + 1}`

/** A family's fold accumulators on its member, where a fold runs over it. */
const accumulatorsOf = (s: Sequence): ReadonlyArray<readonly [string, FieldBase]> =>
	s.folded
		? [
				["before", accumulated(pg.int4, 0)],
				["after", accumulated(pg.int4, 0)]
			]
		: []

/** The owner's count of each family and, where a fold runs over it, its end. */
const ownerFamilyFields = (r: Rekey): ReadonlyArray<readonly [string, FieldBase]> =>
	Arr.flatMap(r.families, (s, i) => [
		[countName(i), drawnField(natural)] as const,
		...(s.folded ? [[endName(i), accumulated(pg.int4, 0)] as const] : [])
	])

/** The schema of a re-key over `group` on each member, paired with `ownerKey` on O: each family ordered by its member's
 * `at` in its owner's count, and folded by sum of x where it is folded. */
const sequencesSchema = (
	name: string,
	r: Rekey,
	owner: AnyRelation,
	ownerKey: ReadonlyArray<string>,
	group: ReadonlyArray<readonly [string, FieldBase]>
): AnySchema => {
	const members = Arr.map(r.families, (s, i) =>
		storedRelation(
			memberName(i),
			Rec.fromEntries([
				["member", pg.int4] as const,
				...group,
				["x", pg.int4] as const,
				["at", drawnField(natural)] as const,
				...accumulatorsOf(s)
			]),
			["member"],
			[]
		)
	)
	const groupFields = Arr.map(group, ([field]) => field)
	const statements: ReadonlyArray<Statement> = Arr.flatMap(r.families, (s, i) => {
		const member = defined(members[i], "a family's member")
		const family = orderedBuilder(
			onBuilder(member, [...groupFields, "at"]),
			finBuilder(owner, countName(i))
		)
		return [
			family,
			...(s.folded
				? [
						foldBuilder(
							family,
							monoids.sum,
							onBuilder(member, [...groupFields, "x", "before", "after"]),
							onBuilder(owner, [...ownerKey, endName(i)])
						)
					]
				: [])
		]
	})
	return schemaOf(name, [owner, ...members], statements, [])
}

/** Before the migration: O keyed by an int4 id, each member's group g its owner's id. */
const storedSchema = (name: string, r: Rekey): AnySchema =>
	sequencesSchema(
		name,
		r,
		storedRelation(
			"O",
			Rec.fromEntries([["id", pg.int4] as const, ...ownerFamilyFields(r)]),
			["id"],
			[]
		),
		["id"],
		[["g", pg.int4]]
	)

/** After it: O keyed by its new key fields k1…, each member's group g1… paired with them. */
const rekeyedSchema = (name: string, r: Rekey): AnySchema => {
	const ownerKey = Arr.map(r.fields, (_, j) => keyName(j))
	return sequencesSchema(
		name,
		r,
		storedRelation(
			"O",
			Rec.fromEntries([
				...Arr.map(r.fields, (f, j) => [keyName(j), keyFieldOf(f.type)] as const),
				...ownerFamilyFields(r)
			]),
			ownerKey,
			[]
		),
		ownerKey,
		Arr.map(r.fields, (f, j) => [groupName(j), keyFieldOf(f.type)] as const)
	)
}

/** A field's drop, as `--drop` declares it. */
const fieldDrop = (r: string, field: string) =>
	({ kind: "field", relation: parsedName(r), field: parsedName(field) }) as const

/** The re-key's declarations: O's id and each member's g dropped, and the index of each family the migration draws
 * anew. */
const rekeyDeclarations = (r: Rekey): Declarations => ({
	renames: [],
	drops: [
		fieldDrop("O", "id"),
		...Arr.flatMap(r.families, (s, i) => [
			fieldDrop(memberName(i), "g"),
			...(s.fate === "redrawn" ? [fieldDrop(memberName(i), "at")] : [])
		])
	]
})

/** The value each placeholder of the re-key takes until the data step writes each row's: its key field's first. */
const rekeyPlaceholder =
	(r: Rekey) =>
	(placeholder: Placeholder): string => {
		const column = placeholder.column.name
		const j = Arr.findFirstIndex(
			r.fields,
			(_, at) =>
				column === identifierOf(identity.column(parsedName(keyName(at)))) ||
				column === identifierOf(identity.column(parsedName(groupName(at))))
		)
		const field = Option.getOrUndefined(Option.flatMap(j, (at) => Arr.get(r.fields, at)))
		if (field === undefined) {
			throw new Error(`the re-key drafts a placeholder of ${column}, no key or group field`)
		}
		return keyLiteral(field.type, Arr.headNonEmpty(field.values))
	}

/** One table's UPDATE of a data step: before the DROP DEFAULT of `first`, the first column it writes, as the
 * placeholder's line asks. */
interface DataStep {
	readonly table: string
	readonly first: string
	readonly sql: string
}

/** The text with `step` written before the ALTER TABLE of its table that drops its first column's placeholder
 * default; a file with no such statement as it was. A statement runs from its first line to the line its semicolon
 * ends. */
const writtenBefore = (text: string, step: DataStep): string => {
	const lines = Str.split(text, "\n")
	const statementAt = (head: number): ReadonlyArray<string> => {
		const rest = Arr.drop(lines, head)
		return Option.match(Arr.findFirstIndex(rest, Str.endsWith(";")), {
			onNone: () => rest,
			onSome: (end) => Arr.take(rest, end + 1)
		})
	}
	const head = Arr.findFirstIndex(
		lines,
		(line, at) =>
			Str.startsWith(`ALTER TABLE ${step.table}`)(line) &&
			Arr.some(statementAt(at), Str.includes(`ALTER COLUMN ${step.first} DROP DEFAULT`))
	)
	return Option.match(head, {
		onNone: () => text,
		onSome: (at) => Arr.join([...Arr.take(lines, at), `${step.sql};`, ...Arr.drop(lines, at)], "\n")
	})
}

/** The data step of the re-key in schema `declared`: each owner's new key, and each member's group the owner's key its
 * fate gives it. */
const rekeyDataSteps = (declared: string, r: Rekey): ReadonlyArray<DataStep> => {
	const { table, column } = namesOf(declared)
	const literals = (key: ReadonlyArray<string>): ReadonlyArray<string> =>
		Arr.map(r.fields, (f, j) => keyLiteral(f.type, defined(key[j], "a key's value")))
	const keyOf = (owner: number): ReadonlyArray<string> => defined(r.keys[owner], "an owner's key")
	const update = (
		relationName: string,
		by: string,
		fields: ReadonlyArray<string>,
		rows: ReadonlyArray<readonly [number, ReadonlyArray<string>]>
	): DataStep => ({
		table: table(relationName),
		first: column(defined(fields[0], "a written field")),
		sql: `UPDATE ${table(relationName)} AS "t" SET ${Arr.join(
			Arr.map(fields, (f) => `${column(f)} = "v".${column(f)}`),
			", "
		)} FROM (VALUES ${Arr.join(
			Arr.map(rows, ([id, values]) => `(${id}, ${Arr.join(values, ", ")})`),
			", "
		)}) AS "v" (${Arr.join(Arr.map([by, ...fields], column), ", ")}) WHERE "t".${column(by)} = "v".${column(by)}`
	})
	return [
		update(
			"O",
			"id",
			Arr.map(r.fields, (_, j) => keyName(j)),
			Arr.map(r.keys, (_, owner) => [owner, literals(keyOf(owner))] as const)
		),
		...Arr.flatMap(r.families, (s, i) => {
			const rows = Arr.flatMap(s.owners, (members) =>
				Arr.map(members, (m) => [m.member, literals(keyOf(m.to))] as const)
			)
			return Arr.isReadonlyArrayNonEmpty(rows)
				? [
						update(
							memberName(i),
							"member",
							Arr.map(r.fields, (_, j) => groupName(j)),
							rows
						)
					]
				: []
		})
	]
}

/** Writes each family's stored state, as the owner, in one SERIALIZABLE transaction: the owners with their counts and
 * ends, then each family's members with their indices, the owner's count each copies (its hidden column, the name the
 * compiled installation gives it) and their accumulators, all as the reference fold states them in stored order. */
const storedWritten = (owner: RawSession, declared: string, r: Rekey): Effect.Effect<void> =>
	Effect.gen(function* () {
		const { table, column } = namesOf(declared)
		const families = compile(storedSchema(declared, r), asDrafted).laws.families
		const states = Arr.map(r.families, storedState)
		const insert = (
			relationName: string,
			columns: ReadonlyArray<string>,
			rows: ReadonlyArray<ReadonlyArray<string>>
		) =>
			`INSERT INTO ${table(relationName)} (${Arr.join(columns, ", ")}) VALUES ${Arr.join(
				Arr.map(rows, (row) => `(${Arr.join(row, ", ")})`),
				", "
			)}`
		yield* owner.query("BEGIN ISOLATION LEVEL SERIALIZABLE", [])
		yield* owner.query(
			insert(
				"O",
				[
					column("id"),
					...Arr.flatMap(r.families, (s, i) => [
						column(countName(i)),
						...(s.folded ? [column(endName(i))] : [])
					])
				],
				Arr.map(r.keys, (_, o) => [
					String(o),
					...Arr.flatMap(r.families, (s, i) => {
						const state = defined(states[i], "a family's state")
						const held = defined(state.owners[o], "an owner's family")
						return [String(held.count), ...(s.folded ? [String(Arr.headNonEmpty(held.end))] : [])]
					})
				])
			),
			[]
		)
		for (const [i, s] of r.families.entries()) {
			const state = defined(states[i], "a family's state")
			if (!Arr.isReadonlyArrayNonEmpty(state.rows)) {
				continue
			}
			const compiled = defined(
				Option.getOrUndefined(Arr.findFirst(families, (f) => f.member.name === memberName(i))),
				"the family's compiled form"
			)
			yield* owner.query(
				insert(
					memberName(i),
					[
						column("member"),
						column("g"),
						column("x"),
						column("at"),
						quoteIdent(compiled.copy),
						...(s.folded ? [column("before"), column("after")] : [])
					],
					Arr.map(state.rows, (row) => [
						String(row.member),
						String(row.group),
						String(row.x),
						String(row.at),
						String(row.copy),
						...(s.folded
							? [String(Arr.headNonEmpty(row.before)), String(Arr.headNonEmpty(row.after))]
							: [])
					])
				),
				[]
			)
		}
		yield* owner.query("COMMIT", [])
	}).pipe(Effect.orDie)

type RekeyFeature =
	| "two ordered families on one owner"
	| "a fold over a kept order out of member-key order"
	| "a regroup refused"
	| "a regroup kept, its order a sequence of each new group"
	| "a regroup redrawn as declared"
	| `a key of ${1 | 2 | 3} fields`
	| `a ${KeyType} key field`

/** Whether members in this order are out of their keys' order. */
const outOfKeyOrder = (members: ReadonlyArray<Regrouped>): boolean =>
	outOfOrder(Arr.map(members, (m) => m.member))

/** What a re-key reaches. */
const rekeyFeatures = (r: Rekey): ReadonlyArray<RekeyFeature> => {
	const owners = r.keys.length
	const applies = Arr.every(r.families, (s) => keepsSequences(s, owners))
	return [
		...(r.families.length > 1 ? ["two ordered families on one owner" as const] : []),
		...Arr.flatMap(r.families, (s): ReadonlyArray<RekeyFeature> => {
			const lawful = keepsSequences(s, owners)
			const kept = s.fate !== "redrawn" && applies
			return [
				...(kept && s.folded && Arr.some(groupsAfter(s, owners), outOfKeyOrder)
					? ["a fold over a kept order out of member-key order" as const]
					: []),
				...(s.fate === "regrouped" && !lawful ? ["a regroup refused" as const] : []),
				...(s.fate === "regrouped" && lawful
					? ["a regroup kept, its order a sequence of each new group" as const]
					: []),
				...(s.fate === "redrawn" ? ["a regroup redrawn as declared" as const] : [])
			]
		}),
		...(r.fields.length === 1
			? ["a key of 1 fields" as const]
			: r.fields.length === 2
				? ["a key of 2 fields" as const]
				: ["a key of 3 fields" as const]),
		...Arr.map(r.fields, (f): RekeyFeature => `a ${f.type} key field`)
	]
}

/** Each required situation of a re-key, aimed at by a re-key constructed to reach it (Case.steering). */
const rekeyAims: ReadonlyArray<Aim<Rekey, RekeyFeature>> = [
	["two ordered families on one owner", rekeyOf({ ...anyRekey, families: constant(2) })],
	[
		"a fold over a kept order out of member-key order",
		rekeyOf({
			...anyRekey,
			first: {
				...anySequence,
				counts: leadingCounts(int(2, 4)),
				keys: descending,
				fate: () => constant("kept")
			}
		})
	],
	[
		"a regroup refused",
		rekeyOf({
			...anyRekey,
			owners: int(2, 3),
			first: {
				...anySequence,
				counts: leadingCounts(int(2, 4)),
				fate: () => constant("regrouped"),
				moved: () => constant(0),
				stays: constant(true)
			}
		})
	],
	[
		"a regroup redrawn as declared",
		rekeyOf({
			...anyRekey,
			owners: int(2, 3),
			first: { ...anySequence, counts: leadingCounts(int(1, 4)), fate: () => constant("redrawn") }
		})
	]
]

/**
 * The law a migration's refusal names: by migrate's reading of the refused constraint through its folder's laws, or by
 * a violation check, which raises SQLSTATE 23000 under the law's identity, as the backfill's check of a key its
 * derivations rely on does (backfill.ts keyChecks) before any of them runs.
 */
const refusedLaw = (failure: MigrateError): Option.Option<string> => {
	const reason = failure.reason
	if (reason._tag === "FileCommitRefused") {
		return Option.fromUndefinedOr(reason.law)
	}
	if (reason._tag !== "StatementFailed") {
		return Option.none()
	}
	return reason.law !== undefined
		? Option.some(reason.law)
		: reason.failure._tag === "ServerError" && reason.failure.sqlstate === "23000"
			? Option.fromUndefinedOr(reason.failure.constraint)
			: Option.none()
}

/** The folder a migration's refusal names, none for any other failure. */
const refusedIn = (failure: MigrateError): Option.Option<string> => {
	const reason = failure.reason
	return reason._tag === "StatementFailed" || reason._tag === "FileCommitRefused"
		? Option.some(reason.folder)
		: Option.none()
}

/**
 * A re-key migrated over its stored families: the reference fold of each family after the data step where every
 * owner's kept indices are 0 … n − 1, and otherwise the re-key's folder refused naming a broken family's law or its
 * fold's.
 */
const rekeyed = (r: Rekey) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const owners = r.keys.length
		let declared = ""
		const outcome = yield* Effect.result(
			migrated({
				label: "rekey",
				schemaName: { kind: "unique" },
				first: (name) => {
					declared = name
					return { schema: storedSchema(name, r), logins: [] }
				},
				later: [(name) => ({ schema: rekeyedSchema(name, r), logins: [] })],
				apply: {
					kind: "reviewed",
					value: rekeyPlaceholder(r),
					edit: (version, file) =>
						version === 0
							? file.text
							: Arr.reduce(rekeyDataSteps(declared, r), file.text, writtenBefore)
				},
				declared: (version) => (version === 0 ? noDeclarations : rekeyDeclarations(r)),
				observe: Option.some((v: number, owner: RawSession) =>
					v !== 0 ? Effect.void : storedWritten(owner, declared, r)
				)
			})
		)
		const broken = Arr.filter(
			Arr.map(r.families, (family, i) => ({ family, i })),
			({ family }) => !keepsSequences(family, owners)
		)
		if (outcome._tag === "Failure") {
			const failure = outcome.failure
			if (failure._tag !== "MigrateError" || !Arr.isReadonlyArrayNonEmpty(broken)) {
				return assert.fail(
					`the re-key failed where every owner's kept indices are 0 … n − 1: ${failure.message}\n${Formatter.format(r)}`
				)
			}
			const target = compile(rekeyedSchema(declared, r), asDrafted).laws.families
			const laws = new Set<string>(
				Arr.flatMap(broken, ({ i }) => {
					const family = defined(
						Option.getOrUndefined(Arr.findFirst(target, (f) => f.member.name === memberName(i))),
						"a broken family's compiled form"
					)
					return [family.law, ...Arr.map(family.folds, (f) => f.law)]
				})
			)
			assert.ok(
				Option.exists(refusedIn(failure), Str.endsWith("_step_2")),
				`the refusal names the re-key's folder: ${failure.message}`
			)
			assert.ok(
				Option.exists(refusedLaw(failure), (law) => laws.has(law)),
				`the refusal names the law of a family whose kept indices the data step broke, or of its fold: ${failure.message}`
			)
			return
		}
		if (Arr.isReadonlyArrayNonEmpty(broken)) {
			return assert.fail(
				`the re-key applied though an owner's kept indices are not 0 … n − 1\n${Formatter.format(r)}`
			)
		}
		const m = outcome.success
		const unvalidated = yield* s.admin.queryValues(
			`SELECT count(*)::int4 FROM pg_catalog.pg_constraint WHERE connamespace = '${quoteIdent(m.schema)}'::regnamespace AND NOT convalidated`,
			[]
		)
		assert.equal(
			Number(Arr.getUnsafe(Arr.getUnsafe(unvalidated, 0), 0)),
			0,
			"VALIDATE leaves no constraint NOT VALID"
		)
		const keyText = (owner: number): string =>
			Arr.join(defined(r.keys[owner], "an owner's key"), " ")
		const states = Arr.map(r.families, (family) => foldedOver(groupsAfter(family, owners)))
		const ownerRows = yield* rowsOf(m.declared, "O", [
			...Arr.map(r.fields, (_, j) => keyName(j)),
			...Arr.flatMap(r.families, (family, i) => [
				countName(i),
				...(family.folded ? [endName(i)] : [])
			])
		])
		assert.deepEqual(
			ownerRows,
			Arr.sort(
				Arr.map(r.keys, (_, o) =>
					Arr.join(
						[
							keyText(o),
							...Arr.flatMap(r.families, (family, i) => {
								const held = defined(
									defined(states[i], "a family's state").owners[o],
									"an owner's family"
								)
								return [
									String(held.count),
									...(family.folded ? [String(Arr.headNonEmpty(held.end))] : [])
								]
							})
						],
						" "
					)
				),
				Order.String
			),
			"each owner under its new key counts its members after the data step and ends its fold over them"
		)
		for (const [i, family] of r.families.entries()) {
			const memberRows = yield* rowsOf(m.declared, memberName(i), [
				"member",
				...Arr.map(r.fields, (_, j) => groupName(j)),
				"at",
				...(family.folded ? ["before", "after"] : [])
			])
			assert.deepEqual(
				memberRows,
				Arr.sort(
					Arr.map(defined(states[i], "a family's state").rows, (row) =>
						Arr.join(
							[
								String(row.member),
								keyText(row.group),
								String(row.at),
								...(family.folded
									? [String(Arr.headNonEmpty(row.before)), String(Arr.headNonEmpty(row.after))]
									: [])
							],
							" "
						)
					),
					Order.String
				),
				family.fate === "redrawn"
					? "each member's index is its place in its new owner's member-key order, its fold run in that order"
					: "each member keeps its stored index under its owner's new key, its fold run in that kept order"
			)
		}
	})

layer(Substrate.layer)("backfilling a counted family with a fold on PostgreSQL 19rc2", (it) => {
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
		"draw a count fold over each node's siblings, the root its one admitted state, and each parent copy, the root its own, over a stored keyed forest, each tree's rows by its own root value",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/migrate/backfill-tree",
						draw: drawn(forestGen),
						literal: Formatter.format,
						coverage: required<TreeFeature>(
							["two trees", "a root alone", "a node of several children", "a grandchild"],
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
							name: "the direct pre-order numbering of each tree under its root value, NP's lawful count fold, and each parent's kind"
						}
					},
					(drawnForest: Forest, c: Case<TreeFeature>) =>
						Effect.gen(function* () {
							const forest = aimedAt(treeAims)(drawnForest, c)
							c.noteAll(forestFeatures(forest))
							const rows = numbered(forest.trees)
							const m = yield* migratedOver("backfilltree", treeBefore, treeAfter, [
								{
									relation: "Node",
									rows: Arr.map(rows, (r) => {
										const [doc, page] = r.root
										return {
											doc: Number(doc),
											page: `'${page}'`,
											parent: r.parent,
											at: r.at,
											children: r.children,
											start: r.start,
											end: r.end,
											kind: r.kind,
											"‹n›": r.copy
										}
									})
								}
							])
							const migratedRows = yield* rowsOf(m.declared, "Node", [
								"doc",
								"page",
								"start",
								"parent",
								"at",
								"children",
								"end",
								"before",
								"after",
								"total",
								"parentKind"
							])
							assert.deepEqual(
								migratedRows,
								Arr.sort(
									Arr.map(rows, (r) =>
										Arr.join(
											Arr.map(
												[
													...r.root,
													r.start,
													r.parent,
													r.at,
													r.children,
													r.end,
													r.at,
													r.at + 1,
													r.children,
													r.parentKind
												],
												String
											),
											" "
										)
									),
									Order.String
								),
								"each tree's stored numbering kept, NP's lawful count fold, each parent's kind in its own tree"
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
	it.effect(
		"keep each ordered member's stored index across a re-key of its owner, run its fold in that kept order, refuse a data step that leaves an owner's kept indices other than 0 … n − 1, and draw anew an index the migration declares dropped",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/migrate/backfill-rekey",
						draw: drawn(rekeyGen),
						literal: Formatter.format,
						coverage: required<RekeyFeature>(
							[
								"two ordered families on one owner",
								"a fold over a kept order out of member-key order",
								"a regroup refused",
								"a regroup redrawn as declared"
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
							name: "the reference fold of each owner's members after the data step, in their stored order or, declared dropped, their member key's; and the family's or its fold's law refusing exactly where an owner's kept indices are not 0 … n − 1"
						}
					},
					(drawnRekey: Rekey, c: Case<RekeyFeature>) =>
						Effect.gen(function* () {
							const r = aimedAt(rekeyAims)(drawnRekey, c)
							c.noteAll(rekeyFeatures(r))
							yield* rekeyed(r)
						})
				)
			)
	)
})
