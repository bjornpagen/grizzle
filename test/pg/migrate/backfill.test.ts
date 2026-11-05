/**
 * Adding a counted family with a fold to populated relations, on PostgreSQL 19rc1 (rows-first §6): A4's backfill data
 * step draws every member's hidden index, ‹i› = row_number() OVER (PARTITION BY g ORDER BY its key) − 1, its copy of the
 * count, and each fold plane's before and after as running sums in ‹i› order, and the owner's count and end; VALIDATE
 * then proves every native over the backfilled rows.
 *
 * - **A second implementation:** the reference fold (test/support/families/fold.ts) of each owner's members in key
 *   order states every backfilled value; what the migration leaves must be exactly that.
 * - **PostgreSQL as the judge:** the migration commits, and no constraint of the installation is left NOT VALID.
 *
 * The box: owners with 0, 1 and 3 existing members, so the backfill meets an empty family, a family of one (its first
 * slot its last), and a family whose predecessor chain the running sum must close; the same family with each owner's
 * tag copied onto its members along the owner axis; and a forest of a tree folded by count over each node's children,
 * as NP's fold suite folds it (test/pg/fin/fold.test.ts), with each node's parent's kind copied down the parent axis,
 * the root its own.
 */
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import {
	type AnySchema,
	contained,
	counted,
	fin,
	fold,
	Monoid,
	on,
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
import { type Node, numbered } from "#test/support/families/tree.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The rows before the family: owner 0 with no member, owner 1 with one, owner 2 with three, members keyed apart. */
const EXISTING: ReadonlyArray<{
	readonly owner: number
	readonly members: ReadonlyArray<{ readonly member: number; readonly x: number }>
}> = [
	{ owner: 0, members: [] },
	{ owner: 1, members: [{ member: 10, x: 5 }] },
	{
		owner: 2,
		members: [
			{ member: 22, x: 1 },
			{ member: 20, x: 2 },
			{ member: 21, x: 3 }
		]
	}
] as const

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
		{ id: pg.int4, n: drawn(natural), end: accumulated(pg.int4, 0) },
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

/** Writes the existing rows, as the owner, in one SERIALIZABLE transaction, into the first version's tables. */
const written = (owner: RawSession, schemaName: string): Effect.Effect<void> =>
	Effect.gen(function* () {
		const schemaIdent = quoteIdent(identifierOf(identity.schema(parsedSchemaName(schemaName))))
		const table = (r: string) =>
			`${schemaIdent}.${quoteIdent(identifierOf(identity.table(parsedName(r))))}`
		const column = (f: string) => quoteIdent(identifierOf(identity.column(parsedName(f))))
		const owners = Arr.join(
			Arr.map(EXISTING, (o) => `(${o.owner})`),
			", "
		)
		const members = Arr.join(
			Arr.flatMap(EXISTING, (o) =>
				Arr.map(o.members, (mb) => `(${mb.member}, ${o.owner}, ${mb.x})`)
			),
			", "
		)
		yield* owner.query("BEGIN ISOLATION LEVEL SERIALIZABLE", [])
		yield* owner.query(`INSERT INTO ${table("Owner")} (${column("id")}) VALUES ${owners}`, [])
		yield* owner.query(
			`INSERT INTO ${table("Member")} (${column("member")}, ${column("g")}, ${column("x")}) VALUES ${members}`,
			[]
		)
		yield* owner.query("COMMIT", [])
	}).pipe(Effect.orDie)

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
		{ id: pg.int4, tag: pg.int4, n: drawn(natural), end: accumulated(pg.int4, 0) },
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

/** Each owner's tag. */
const tagOf = (owner: number): number => 100 + owner

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
			at: drawn(natural),
			children: drawn(natural),
			start: drawn(natural),
			end: drawn(natural),
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

/** The stored forest: a root whose children and grandchildren are keyed out of their order, and a root of one child,
 * each node's kind drawn from its key. */
const FOREST = Arr.map(
	[
		[1, 1, 1],
		[6, 1, 1],
		[2, 1, 1],
		[4, 1, 1],
		[9, 2, 1],
		[7, 2, 1],
		[8, 4, 1],
		[11, 7, 1],
		[30, 30, 30],
		[31, 30, 30]
	] as const,
	([id, parent, doc]) => ({ id, parent, doc, kind: (id * 5) % 7 })
)

/** A relation's stored rows, each a value per field. */
interface Stored {
	readonly relation: string
	readonly rows: ReadonlyArray<Readonly<Record<string, number>>>
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
 * The rows of `relation` after migrating from `before` to `after` over `stored`, each its `fields` as text joined by
 * spaces, sorted; and no constraint of the installation left NOT VALID.
 */
const migratedRows = (
	label: string,
	before: (name: string) => AnySchema,
	after: (name: string) => AnySchema,
	stored: ReadonlyArray<Stored>,
	reads: ReadonlyArray<{ readonly relation: string; readonly fields: ReadonlyArray<string> }>
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
			register: false,
			declared: () => noDeclarations,
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
		const { table, column } = namesOf(m.declared)
		const out: Record<string, ReadonlyArray<string>> = {}
		for (const r of reads) {
			const rows = yield* s.admin.queryValues(
				`SELECT ${Arr.join(
					Arr.map(r.fields, (f) => `${column(f)}::text`),
					", "
				)} FROM ${table(r.relation)}`,
				[]
			)
			out[r.relation] = Arr.sort(
				Arr.map(rows, (row) => Arr.join(Arr.map(row, String), " ")),
				Order.String
			)
		}
		return out
	})

layer(Substrate.layer)("backfilling a counted family with a fold on PostgreSQL 19rc1", (it) => {
	it.effect(
		"draw every hidden index, copy, accumulator, count and end of populated relations in key order, and VALIDATE every native",
		() =>
			Effect.gen(function* () {
				const s = yield* Substrate
				let schemaName = ""
				const m = yield* migrated({
					label: "backfill",
					schemaName: { kind: "unique" },
					first: (name) => {
						schemaName = name
						return { schema: before(name), logins: [] }
					},
					later: [(name) => ({ schema: after(name), logins: [] })],
					apply: { kind: "noPlaceholders" },
					register: false,
					declared: () => noDeclarations,
					observe: Option.some((v: number, owner: RawSession) =>
						v !== 0 ? Effect.void : written(owner, schemaName)
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
				const seat = yield* seatOfInstalled(m, ["Owner", "Member"], "backfill")
				const f = foldSeatOf({ ...SPEC, schema: after(m.declared) }, seat)
				const read = yield* foldRead(f)
				const expected = foldStoredOf(
					SPEC.monoid,
					Arr.map(EXISTING, (o) => ({
						owner: o.owner,
						members: Arr.map(
							Arr.sort(
								o.members,
								Order.mapInput(Order.Number, (mb: { readonly member: number }) => mb.member)
							),
							(mb: { readonly member: number; readonly x: number }) => ({
								member: mb.member,
								x: BigInt(mb.x),
								selected: true
							})
						)
					}))
				)
				assert.deepEqual(
					read,
					byMember(expected),
					"the backfill draws the reference fold of each family in key order"
				)
			})
	)
	it.effect(
		"draw a copy along the owner axis: each member's owner's tag, and every native VALIDATEd",
		() =>
			Effect.gen(function* () {
				const members = Arr.flatMap(EXISTING, (o) =>
					Arr.map(o.members, (mb) => ({ member: mb.member, g: o.owner, x: mb.x }))
				)
				const rows = yield* migratedRows(
					"backfillcopy",
					copyBefore,
					copyAfter,
					[
						{
							relation: "Owner",
							rows: Arr.map(EXISTING, (o) => ({ id: o.owner, tag: tagOf(o.owner) }))
						},
						{ relation: "Member", rows: members }
					],
					[{ relation: "Member", fields: ["member", "ownerTag"] }]
				)
				assert.deepEqual(
					rows["Member"],
					Arr.sort(
						Arr.map(members, (mb) => `${mb.member} ${tagOf(mb.g)}`),
						Order.String
					),
					"each member holds its owner's tag"
				)
			})
	)

	it.effect(
		"draw a tree's numbering, its count fold over each node's siblings, the root its one admitted state, and each parent copy, the root its own",
		() =>
			Effect.gen(function* () {
				const rows = yield* migratedRows(
					"backfilltree",
					treeBefore,
					treeAfter,
					[{ relation: "Node", rows: FOREST }],
					[
						{
							relation: "Node",
							fields: [
								"id",
								"at",
								"children",
								"start",
								"end",
								"before",
								"after",
								"total",
								"parentKind"
							]
						}
					]
				)
				const byId = (id: number) =>
					defined(Option.getOrUndefined(Arr.findFirst(FOREST, (n) => n.id === id)))
				const nodeOf = (id: number): Node => ({
					id,
					children: Arr.map(
						Arr.sort(
							Arr.filter(FOREST, (n) => n.parent === id && n.id !== id),
							Order.mapInput(Order.Number, (n: { readonly id: number }) => n.id)
						),
						(n) => nodeOf(n.id)
					)
				})
				const roots = Arr.filter(FOREST, (n) => n.parent === n.id)
				assert.deepEqual(
					rows["Node"],
					Arr.sort(
						Arr.map(numbered(Arr.map(roots, (r) => ({ root: r.doc, tree: nodeOf(r.id) }))), (r) =>
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
})
