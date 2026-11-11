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
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	composition,
	element,
	type Gen,
	int,
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
		{
			Owner: relation("Owner", { id: pg.int4 }, ["id"]),
			Member: relation("Member", { member: pg.int4, g: pg.int4, x: pg.int4 }, ["member"])
		},
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
	return schema(name, { Owner, Member }, [
		family,
		fold(family, Monoid.sum, on(Member, "g", "x"), on(Owner, "id", "end"))
	])
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
		{
			Owner: relation("Owner", { id: pg.int4, tag: pg.int4 }, ["id"]),
			Member: relation("Member", { member: pg.int4, g: pg.int4, x: pg.int4 }, ["member"])
		},
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
	return schema(name, { Owner, Member }, [
		family,
		fold(family, Monoid.sum, on(Member, "g", "x"), on(Owner, "id", "end")),
		contained(on(Member, "g", "ownerTag"), on(Owner, "id", "tag"))
	])
}

/** A tree of Node, one per doc, folded by count over each node's children (FoldedTree's), each node's parent's kind
 * copied down. */
const treeBefore = (name: string) =>
	schema(
		name,
		{
			Node: relation("Node", { id: pg.int4, parent: pg.int4, doc: pg.int4, kind: pg.int4 }, ["id"])
		},
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
	return schema(name, { Node: Node_ }, [
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
	])
}

/** The bound on a drawn value: a member's x and an owner's tag lie within it either way, a node's kind below it. */
const valueBound = 9

/** The keys a drawn member or node takes, apart from one another. */
const keyRange = Arr.range(1, 40)

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

/**
 * One to three owners, ids 0 up, each with a tag; up to six members falling among them in drawn counts, each keyed
 * apart, the keys drawn in any order, so each family's members are written out of their key order; each member's value;
 * and whether the tags are copied onto the members.
 */
const familyGen: Gen<Family> = (source) => {
	const owners = source.draw(int(1, 3))
	const total = source.draw(int(0, 6))
	const counts = source.draw(composition(total, owners))
	const keys = source.draw(shuffled(keyRange, { min: total, max: total }))
	const tags = nonEmptyList(
		upTo(owners, () => source.draw(int(-valueBound, valueBound))),
		"the owners' tags"
	)
	let at = 0
	const members: Array<WrittenMember> = []
	for (const [g, count] of counts.entries()) {
		for (let k = 0; k < count; k += 1) {
			members.push({
				member: defined(keys[at], "a member's key"),
				g,
				x: source.draw(int(-valueBound, valueBound))
			})
			at += 1
		}
	}
	return {
		copied: source.draw(boolean),
		tags,
		members
	}
}

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
 * One or two trees of one to five nodes, each tree's shape drawn by its parents, its root value apart from the other's,
 * every node keyed apart, the keys drawn in any order, so siblings are written out of their key order, and each node's
 * kind.
 */
const forestGen: Gen<Forest> = (source) => {
	const shapes = upTo(source.draw(int(1, 2)), () => source.draw(parents({ min: 1, max: 5 })))
	const sizes = Arr.map(shapes, (shape) => shape.length + 1)
	const total = Arr.reduce(sizes, 0, (sum, size) => sum + size)
	const keys = source.draw(shuffled(keyRange, { min: total, max: total }))
	const docs = source.draw(
		shuffled(Arr.range(1, valueBound), { min: shapes.length, max: shapes.length })
	)
	let offset = 0
	const trees = Arr.map(shapes, (shape, t) => {
		const idOf = (node: number) => defined(keys[offset + node], "a node's key")
		const doc = defined(docs[t], "a tree's root value")
		const nodes = upTo(shape.length + 1, (node) => ({
			id: idOf(node),
			parent: idOf(node === 0 ? 0 : defined(shape[node - 1], "a node's parent")),
			doc,
			kind: source.draw(int(0, valueBound))
		}))
		offset += shape.length + 1
		return nodes
	})
	return { trees }
}

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
		{
			Owner: relation("Owner", { id: pg.int4 }, ["id"]),
			Member: relation("Member", { member: pg.vector(2), g: pg.int4, x: pg.int4 }, ["member"])
		},
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
	return schema(name, { Owner: countingOwner, Member }, [
		family,
		fold(family, Monoid.sum, on(Member, "g", "x"), on(countingOwner, "id", "end"))
	])
}

/** vectorKept with the vector key renamed to item. */
const vectorRenamed = (name: string) => {
	const Member = relation(
		"Member",
		{ item: pg.vector(2), g: pg.int4, at: drawnField(natural), x: pg.int4 },
		["g", "at"]
	)
	const family = ordered(on(Member, "g", "at"), fin(countingOwner, "n"))
	return schema(name, { Owner: countingOwner, Member }, [
		family,
		fold(family, Monoid.sum, on(Member, "g", "x"), on(countingOwner, "id", "end"))
	])
}

/** vectorKept with the vector key dropped. */
const vectorDropped = (name: string) => {
	const Member = relation("Member", { g: pg.int4, at: drawnField(natural), x: pg.int4 }, [
		"g",
		"at"
	])
	const family = ordered(on(Member, "g", "at"), fin(countingOwner, "n"))
	return schema(name, { Owner: countingOwner, Member }, [
		family,
		fold(family, Monoid.sum, on(Member, "g", "x"), on(countingOwner, "id", "end"))
	])
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

const vectorKeyedGen: Gen<VectorKeyedFamily> = (source) => {
	const family = source.draw(familyGen)
	return {
		fate: source.draw(element(vectorKeyFates)),
		owners: family.tags.length,
		members: family.members
	}
}

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

/** How many candidates a steered case draws for a value that reaches a pending situation. */
const aimCandidates = 32

/**
 * The value a case runs: the drawn one, or, where steering names situations no case has reached, the first of up to
 * `aimCandidates` further draws of `generator` that reaches one, else the drawn one.
 */
const aimed = <A, F extends string>(
	drawnValue: A,
	generator: Gen<A>,
	features: (value: A) => ReadonlyArray<F>,
	c: Case<F>
): A =>
	Option.match(c.steering, {
		onNone: () => drawnValue,
		onSome: (pending) => {
			const reaches = (value: A) => Arr.some(features(value), (f) => pending.has(f))
			return reaches(drawnValue)
				? drawnValue
				: Option.getOrElse(
						Arr.findFirst(
							c.draw(array(generator, { min: aimCandidates, max: aimCandidates })),
							reaches
						),
						() => drawnValue
					)
		}
	})

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
							const family = aimed(drawnFamily, familyGen, familyFeatures, c)
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
							const forest = aimed(drawnForest, forestGen, forestFeatures, c)
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
							const f = aimed(drawnFamily, vectorKeyedGen, vectorKeyFeatures, c)
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
