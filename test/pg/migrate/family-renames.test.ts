/**
 * A family over stored rows across a migration that renames it or changes what fills it, on PostgreSQL 19rc1,
 * generated.
 *
 * A history: relations with rows stored at their first version; a family over them at the second, counted, ordered or
 * a tree, with a fold whose accumulators are hidden, named or absent and an axis copy or none, backfilled over the rows;
 * then a third version that either
 *
 * - **renames** it: the relations mapped injectively onto their own names, each other's or fresh ones, so swaps, chains
 *   and cycles occur, the owner, the member and a spare relation among them, and the owner's count and caller fields
 *   likewise, each rename declared (`--rename`); or
 * - **changes what fills it**: the field its fold steps over, the field its axis copy reads, or a counted or ordered
 *   family's group, nothing declared.
 *
 * The oracles, PostgreSQL the judge:
 *
 * - **A rename changes no stored byte.** Every table keeps its OID and its relfilenode, so nothing rewrote it; every
 *   column its attribute number and its values, so no law column or drawn field was dropped and added again; and every
 *   row its xmin, so no backfill UPDATE touched it. The family's law columns (‹n›, a counted index, a tree's ‹ps›, a
 *   fold's hidden accumulators, the generated terms) and its drawn fields are renamed in place.
 * - **A changed filler is drawn again.** The migration commits, so PostgreSQL validated every constraint it added over
 *   the values it drew; a field kept with its old filler's values fails the fold's CHECK or the axis's foreign key.
 * - Either way, migrate's drift check and the installed-catalog checker match the catalog against the snapshot after
 *   every step, and no constraint is left NOT VALID: every law holds.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, element, type Gen, int, parents, shuffled } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import type { FolderSource } from "#adapter/migrate/input.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Declarations, Rename } from "#compiler/deploy/diff/plan.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	apply,
	checkedAdmission,
	kept,
	openMigrator,
	reviewedSource
} from "#test/pg/migrate/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import {
	type AuthoredStatementDesc,
	contained,
	counted,
	f,
	type FixtureField,
	field,
	fin,
	fold,
	literal,
	on,
	onSource,
	ordered,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	draftCodes,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations,
	type Previous
} from "#test/support/migrate/kit.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { owning } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const kinds = ["counted", "ordered", "tree"] as const
type Kind = (typeof kinds)[number]

/** A fold's accumulators: none, the family folded with them hidden, or named by the step side (never over a counted
 * family). */
type Accumulators = "none" | "hidden" | "named"

/** What a history's family is: its kind, its fold and whether an axis carries a copy. */
interface Shape {
	readonly kind: Kind
	readonly fold: Accumulators
	readonly copy: boolean
}

/** The relations of a history, by their names at its first version: a counted or ordered family's owner and member,
 * a tree's one relation, and a spare relation a rename may swap with them. */
const familyRelations = ["Owner", "Member", "Spare"] as const
const treeRelations = ["Node", "Spare"] as const
type RelationName = (typeof familyRelations)[number] | (typeof treeRelations)[number]

/** The names a rename may give a relation beside the history's own. */
const freshRelations = ["Fresh", "Other"] as const

/** The owner's fields a rename may rename: its count and two caller fields. */
const ownerFields = ["n", "tag", "tag2"] as const
type OwnerField = (typeof ownerFields)[number]

/** How a version names the history's relations and the owner's fields, by their names at its first version. */
interface Naming {
	readonly relation: (name: RelationName) => string
	readonly field: (name: OwnerField) => string
}

const asFirst: Naming = { relation: (name) => name, field: (name) => name }

/** What a version's family reads: the member field its fold steps over, the owner field its copy reads, and its
 * group. A tree's group is its parent, and its fold counts. */
interface Reading {
	readonly step: "x" | "y"
	readonly copied: "tag" | "tag2"
	readonly group: "g" | "h"
}

const firstReading: Reading = { step: "x", copied: "tag", group: "g" }

const integer = f.integer

/** The tree's members: every row but its root, whose start is 0. */
const nonRoot = { kind: "compare", op: "gt", left: field("start"), right: literal(0n) } as const

/** A counted or ordered family's relations and statements at a version. */
const familySchema = (shape: Shape, naming: Naming, reading: Reading) => {
	const owner = naming.relation("Owner")
	const member = naming.relation("Member")
	const count = naming.field("n")
	const slots = fin(owner, count)
	const group = reading.group
	const ordered_ = shape.kind === "ordered"
	const folded = shape.fold !== "none"
	const named = shape.fold === "named" && ordered_
	const ownerFieldsAt: Record<string, FixtureField> = {
		id: integer,
		[naming.field("tag")]: integer,
		[naming.field("tag2")]: integer,
		[count]: f.drawn,
		...(folded ? { end: f.accumulated(integer, 0) } : {})
	}
	const memberFields: Record<string, FixtureField> = {
		member: integer,
		g: integer,
		h: integer,
		x: integer,
		y: integer,
		...(ordered_ ? { at: f.drawn } : {}),
		...(named ? { before: f.accumulated(integer, 0), after: f.accumulated(integer, 0) } : {}),
		...(shape.copy ? { ownerTag: f.accumulated(integer, 0) } : {})
	}
	const statements: Array<AuthoredStatementDesc> = [
		ordered_ ? ordered(on(member, [group, "at"]), slots) : counted(on(member, [group]), slots)
	]
	if (folded) {
		statements.push(
			fold(
				slots,
				"sum",
				on(member, named ? [group, reading.step, "before", "after"] : [group, reading.step]),
				on(owner, ["id", "end"])
			)
		)
	}
	if (shape.copy) {
		statements.push(
			contained(
				onSource(member, [group, "ownerTag"], undefined),
				on(owner, ["id", naming.field(reading.copied)])
			)
		)
	}
	return {
		relations: [relation(owner, ownerFieldsAt, ["id"]), relation(member, memberFields, ["member"])],
		statements
	}
}

/** A tree's relation and statements at a version: its count fold over each node's children, and its copy of the
 * parent's tag down the owner axis. */
const treeSchema = (shape: Shape, naming: Naming, reading: Reading) => {
	const node = naming.relation("Node")
	const count = naming.field("n")
	const slots = fin(node, count)
	const named = shape.fold === "named"
	const fields: Record<string, FixtureField> = {
		id: integer,
		parent: integer,
		doc: integer,
		[naming.field("tag")]: integer,
		[naming.field("tag2")]: integer,
		at: f.drawn,
		[count]: f.drawn,
		start: f.drawn,
		end: f.drawn,
		...(shape.fold === "none" ? {} : { total: f.accumulated(f.natural, 0n) }),
		...(named ? { before: f.accumulated(f.natural, 0n), after: f.accumulated(f.natural, 0n) } : {}),
		...(shape.copy ? { parentTag: f.accumulated(integer, 0) } : {})
	}
	const statements: Array<AuthoredStatementDesc> = [
		{ kind: "tree", member: on(node, ["parent", "at"]), slots, root: "doc" }
	]
	if (shape.fold !== "none") {
		statements.push(
			fold(
				slots,
				"count",
				on(node, named ? ["parent", "before", "after"] : ["parent"]),
				on(node, ["id", "total"])
			)
		)
	}
	if (shape.copy) {
		statements.push(
			contained(
				onSource(node, ["parent", "parentTag"], nonRoot),
				on(node, ["id", naming.field(reading.copied)])
			)
		)
	}
	return { relations: [relation(node, fields, ["id"])], statements }
}

/** A history's relations before its family: the caller's fields alone. */
const plainSchema = (shape: Shape) =>
	shape.kind === "tree"
		? [
				relation(
					"Node",
					{ id: integer, parent: integer, doc: integer, tag: integer, tag2: integer },
					["id"]
				)
			]
		: [
				relation("Owner", { id: integer, tag: integer, tag2: integer }, ["id"]),
				relation("Member", { member: integer, g: integer, h: integer, x: integer, y: integer }, [
					"member"
				])
			]

/** A version's schema under the declared name `name`: the plain relations, or the family as `naming` and `reading`
 * state it, with the spare relation. */
const versionOf = (
	name: string,
	shape: Shape,
	at:
		| { readonly kind: "plain" }
		| { readonly kind: "family"; readonly naming: Naming; readonly reading: Reading }
): SchemaDesc => {
	const spare = relation(
		at.kind === "plain" ? "Spare" : at.naming.relation("Spare"),
		{ id: integer },
		["id"]
	)
	if (at.kind === "plain") {
		return { name, relations: [...plainSchema(shape), spare], statements: [], extends: undefined }
	}
	const family =
		shape.kind === "tree"
			? treeSchema(shape, at.naming, at.reading)
			: familySchema(shape, at.naming, at.reading)
	return {
		name,
		relations: [...family.relations, spare],
		statements: family.statements,
		extends: undefined
	}
}

/** The rows a history stores at its first version: each relation's, each a value per caller field. */
interface Stored {
	readonly relation: RelationName
	readonly rows: ReadonlyArray<Readonly<Record<string, number>>>
}

/** The keys a drawn row takes, apart from one another. */
const keyRange = Arr.range(1, 40)

const valueGen = int(-9, 9)

/** One to three owners, each with two tags, and up to six members, each keyed apart, falling among them under both
 * groups, each with two values; the keys drawn in any order. */
const familyRows: Gen<ReadonlyArray<Stored>> = (source) => {
	const owners = Arr.range(1, source.draw(int(1, 3)))
	const total = source.draw(int(0, 6))
	const keys = source.draw(shuffled(keyRange, { min: total, max: total }))
	const ownerOf = element(owners)
	return [
		{
			relation: "Owner",
			rows: Arr.map(owners, (id) => ({
				id,
				tag: source.draw(valueGen),
				tag2: source.draw(valueGen)
			}))
		},
		{
			relation: "Member",
			rows: Arr.map(keys, (member) => ({
				member,
				g: source.draw(ownerOf),
				h: source.draw(ownerOf),
				x: source.draw(valueGen),
				y: source.draw(valueGen)
			}))
		}
	]
}

/** One or two trees of one to five nodes, each tree's shape drawn by its parents, its root value apart from the
 * other's, every node keyed apart in any order, and each node's two tags. */
const treeRows: Gen<ReadonlyArray<Stored>> = (source) => {
	const shapes = Arr.makeBy(source.draw(int(1, 2)), () => source.draw(parents({ min: 1, max: 5 })))
	const total = Arr.reduce(shapes, 0, (sum, shape) => sum + shape.length + 1)
	const keys = source.draw(shuffled(keyRange, { min: total, max: total }))
	let offset = 0
	const rows = Arr.flatMap(shapes, (shape, doc) => {
		const idOf = (node: number) => defined(keys[offset + node], "a node's key")
		const nodes = Arr.makeBy(shape.length + 1, (node) => ({
			id: idOf(node),
			parent: idOf(node === 0 ? 0 : defined(shape[node - 1], "a node's parent")),
			doc,
			tag: source.draw(valueGen),
			tag2: source.draw(valueGen)
		}))
		offset += shape.length + 1
		return nodes
	})
	return [{ relation: "Node", rows }]
}

/** Up to two spare rows. */
const spareRows: Gen<Stored> = (source) => ({
	relation: "Spare",
	rows: Arr.map(Arr.range(1, source.draw(int(0, 2))), (id) => ({ id }))
})

const rowsOf =
	(kind: Kind): Gen<ReadonlyArray<Stored>> =>
	(source) => [...source.draw(kind === "tree" ? treeRows : familyRows), source.draw(spareRows)]

/** The relations of a history of a kind, by their first names. */
const relationsOf = (kind: Kind): ReadonlyArray<RelationName> =>
	kind === "tree" ? treeRelations : familyRelations

/** The relation whose fields the owner fields are: a counted or ordered family's owner, a tree's node. */
const ownerOf = (kind: Kind): RelationName => (kind === "tree" ? "Node" : "Owner")

/** A rename of a history: each relation's name and each owner field's at the third version. */
interface Renaming {
	readonly relations: ReadonlyMap<RelationName, string>
	readonly fields: ReadonlyMap<OwnerField, string>
}

const namingOf = (r: Renaming): Naming => ({
	relation: (name) => r.relations.get(name) ?? name,
	field: (name) => r.fields.get(name) ?? name
})

/** An injective map of `names` onto their own names and `fresh`, drawn uniformly: swaps, chains and cycles among
 * them. */
const injection =
	<N extends string>(
		names: ReadonlyArray<N>,
		fresh: ReadonlyArray<string>
	): Gen<ReadonlyMap<N, string>> =>
	(source) => {
		const to = source.draw(shuffled([...names, ...fresh], { min: names.length, max: names.length }))
		return new Map(Arr.map(names, (name, i) => [name, defined(to[i], "a name's target")] as const))
	}

const shapeGen =
	(among: Arr.NonEmptyReadonlyArray<Kind>): Gen<Shape> =>
	(source) => {
		const kind = source.draw(element(among))
		const fold = source.draw(
			element<Accumulators>(kind === "counted" ? ["none", "hidden"] : ["none", "hidden", "named"])
		)
		return { kind, fold, copy: source.draw(boolean) }
	}

/** A renaming history: its family, its stored rows and its third version's names. */
interface RenameCase {
	readonly shape: Shape
	readonly stored: ReadonlyArray<Stored>
	readonly renaming: Renaming
}

const renameCaseGen: Gen<RenameCase> = (source) => {
	const shape = source.draw(shapeGen(["counted", "ordered", "tree"]))
	return {
		shape,
		stored: source.draw(rowsOf(shape.kind)),
		renaming: {
			relations: source.draw(injection(relationsOf(shape.kind), freshRelations)),
			fields: source.draw(injection(ownerFields, ["m"]))
		}
	}
}

/** What a renaming history declares at its third version: each relation renamed, and each owner field renamed on the
 * owner under its new name. */
const declarationsOf = (c: RenameCase): Declarations => {
	const naming = namingOf(c.renaming)
	const owner = ownerOf(c.shape.kind)
	const renames: Array<Rename> = [
		...Arr.flatMap(relationsOf(c.shape.kind), (r): ReadonlyArray<Rename> =>
			naming.relation(r) === r
				? []
				: [
						{
							from: { kind: "relation", relation: parsedName(r) },
							to: { kind: "relation", relation: parsedName(naming.relation(r)) }
						}
					]
		),
		...Arr.flatMap(ownerFields, (field): ReadonlyArray<Rename> =>
			naming.field(field) === field
				? []
				: [
						{
							from: { kind: "field", relation: parsedName(owner), field: parsedName(field) },
							to: {
								kind: "field",
								relation: parsedName(naming.relation(owner)),
								field: parsedName(naming.field(field))
							}
						}
					]
		)
	]
	return { renames, drops: [] }
}

/** The installation of a version's schema under the installed schema `name`, owned by `owner`, under `codes`. */
const compiledAt = (
	desc: SchemaDesc,
	name: string,
	owner: string,
	codes: Codebook
): Installation => {
	const owned = owning(desc)
	return succeeded(
		compileInstallation(owned, {
			...completeInstallOptions(owned, identity.schema(parsedSchemaName(name)), [], [], codes),
			owner
		})
	)
}

/** What a version holds of one table, read by its OID: its relfilenode, and each live column's attribute number with
 * every row's value of it, beside each row's xmin, rows in the order of the table's key. */
interface TableRead {
	readonly relfilenode: string
	readonly columns: ReadonlyArray<{
		readonly attnum: string
		readonly values: ReadonlyArray<string>
	}>
	readonly xmins: ReadonlyArray<string>
}

const texts = (rows: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<string> =>
	Arr.map(rows, (row) => String(row[0]))

/** The OID of each relation of a version's schema, by its name then. */
const oidsOf = (schemaName: string, names: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const schemaIdent = identifierOf(identity.schema(parsedSchemaName(schemaName)))
		return yield* Effect.forEach(names, (name) =>
			Effect.map(
				Effect.orDie(
					substrate.admin.queryValues(
						`SELECT '${quoteIdent(schemaIdent)}.${quoteIdent(identifierOf(identity.table(parsedName(name))))}'::regclass::oid::int8::text`,
						[]
					)
				),
				(rows) => defined(texts(rows)[0], `${name}'s OID`)
			)
		)
	})

/** What a version holds of the tables `oids` (TableRead). */
const readTables = (oids: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const values = (sql: string) =>
			Effect.map(Effect.orDie(substrate.admin.queryValues(sql, [])), texts)
		return yield* Effect.forEach(oids, (oid) =>
			Effect.gen(function* () {
				const named = yield* values(`SELECT ${oid}::oid::regclass::text`)
				const files = yield* values(
					`SELECT relfilenode::text FROM pg_catalog.pg_class WHERE oid = ${oid}`
				)
				const keys = yield* values(
					`SELECT a.attname::text FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] WHERE i.indrelid = ${oid} AND i.indisprimary`
				)
				const table = defined(named[0], "a table")
				const relfilenode = defined(files[0], "a relfilenode")
				const key = defined(keys[0], "a primary key")
				const attributes = yield* Effect.orDie(
					substrate.admin.queryValues(
						`SELECT a.attnum::text, a.attname::text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = ${oid} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
						[]
					)
				)
				const columns = yield* Effect.forEach(attributes, ([attnum, attname]) =>
					Effect.map(
						values(
							`SELECT ${quoteIdent(String(attname))}::text FROM ${table} ORDER BY ${quoteIdent(key)}`
						),
						(stored) => ({ attnum: String(attnum), values: stored })
					)
				)
				const xmins = yield* values(`SELECT xmin::text FROM ${table} ORDER BY ${quoteIdent(key)}`)
				const read: TableRead = { relfilenode, columns, xmins }
				return read
			})
		)
	})

/** The constraints of the installed schema left NOT VALID. */
const notValid = (schemaName: string) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const schemaIdent = identifierOf(identity.schema(parsedSchemaName(schemaName)))
		const rows = yield* Effect.orDie(
			substrate.admin.queryValues(
				"SELECT c.conname::text FROM pg_catalog.pg_constraint AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.connamespace WHERE n.nspname = $1::text AND NOT c.convalidated ORDER BY 1",
				[schemaIdent]
			)
		)
		return texts(rows)
	})

/** Writes the stored rows into the first version's tables, in one transaction. */
const store = (schemaName: string, stored: ReadonlyArray<Stored>) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const schemaIdent = quoteIdent(identifierOf(identity.schema(parsedSchemaName(schemaName))))
		const column = (name: string) => quoteIdent(identifierOf(identity.column(parsedName(name))))
		const inserts = Arr.flatMap(stored, (r) => {
			const [first] = r.rows
			if (first === undefined) {
				return []
			}
			const fields = Rec.keys(first)
			return [
				`INSERT INTO ${schemaIdent}.${quoteIdent(identifierOf(identity.table(parsedName(r.relation))))} (${Arr.join(
					Arr.map(fields, column),
					", "
				)}) VALUES ${Arr.join(
					Arr.map(
						r.rows,
						(row) =>
							`(${Arr.join(
								Arr.map(fields, (field) => String(row[field])),
								", "
							)})`
					),
					", "
				)}`
			]
		})
		yield* Effect.orDie(transaction(substrate.admin, inserts))
	})

/**
 * A history migrated on PostgreSQL: each version drafted from the snapshot before it under its declarations, reviewed,
 * and applied with the drift check and the installed-catalog checker; the rows stored after the first; `observe` run
 * after each step with its index.
 */
const migrateHistory = <A>(
	label: string,
	versions: ReadonlyArray<{
		readonly desc: (name: string) => SchemaDesc
		readonly declared: Declarations
	}>,
	stored: ReadonlyArray<Stored>,
	observe: (step: number, schemaName: string) => Effect.Effect<A, never, Substrate>
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const owner = substrate.owner.role
			const name = yield* substrate.schema({ create: false, label })
			const m = yield* openMigrator(substrate, substrate.owner)
			const folders: Array<FolderSource> = []
			const observed: Array<A> = []
			let previous: Previous = fromEmpty
			for (const [i, version] of versions.entries()) {
				const desc = version.desc(name)
				const installation = compiledAt(
					desc,
					name,
					owner,
					succeeded(draftCodes(desc, previous, version.declared))
				)
				const g = succeeded(
					generate({
						previous,
						installation,
						name: `step_${i + 1}`,
						timestamp: draftedAt(i + 1),
						workload: noWorkload,
						declared: version.declared
					}),
					`step ${i + 1} drafts`
				)
				folders.push(reviewedSource(g, kept))
				yield* Effect.orDie(
					apply(
						m,
						{ snapshot: g.snapshot, folders: [...folders] },
						checkedAdmission(installation, substrate.admin)
					)
				)
				previous = fromSnapshot(g.snapshot)
				if (i === 0) {
					yield* store(name, stored)
				}
				const pending = yield* notValid(name)
				assert.deepEqual(pending, [], `step ${i + 1} leaves no constraint NOT VALID`)
				const seen = yield* observe(i, name)
				observed.push(seen)
			}
			return observed
		})
	)

type RenameFeature =
	| Kind
	| `fold ${Accumulators}`
	| "copy"
	| "owner renamed"
	| "member renamed"
	| "count renamed"
	| "relations swapped"
	| "relations chained"
	| "fields swapped"
	| "fields chained"
	| "stored members"

/** Whether a history stores more than one row of a relation of its family. */
const storesMembers = (stored: ReadonlyArray<Stored>): boolean =>
	Arr.some(stored, (s) => s.relation !== "Spare" && s.rows.length > 1)

/** The swaps and chains an injection holds: two names exchanged, and a name onto another's whose own moves elsewhere. */
const movesOf = <N extends string>(map: ReadonlyMap<N, string>) => {
	const pairs = Arr.filter([...map], ([from, to]) => from !== to)
	const moved = new Map<string, string>(pairs)
	return {
		swapped: Arr.some(pairs, ([from, to]) => moved.get(to) === from),
		chained: Arr.some(pairs, ([from, to]) => {
			const next = moved.get(to)
			return next !== undefined && next !== from
		})
	}
}

const renameNotes = (c: RenameCase): ReadonlyArray<RenameFeature> => {
	const naming = namingOf(c.renaming)
	const relations = movesOf(c.renaming.relations)
	const fields = movesOf(c.renaming.fields)
	const members = storesMembers(c.stored)
	return [
		c.shape.kind,
		`fold ${c.shape.fold}`,
		...(c.shape.copy ? (["copy"] as const) : []),
		...(naming.relation(ownerOf(c.shape.kind)) === ownerOf(c.shape.kind)
			? []
			: (["owner renamed"] as const)),
		...(c.shape.kind !== "tree" && naming.relation("Member") !== "Member"
			? (["member renamed"] as const)
			: []),
		...(naming.field("n") === "n" ? [] : (["count renamed"] as const)),
		...(relations.swapped ? (["relations swapped"] as const) : []),
		...(relations.chained ? (["relations chained"] as const) : []),
		...(fields.swapped ? (["fields swapped"] as const) : []),
		...(fields.chained ? (["fields chained"] as const) : []),
		...(members ? (["stored members"] as const) : [])
	]
}

const renameCase = (c: RenameCase, k: Case<RenameFeature>) =>
	Effect.gen(function* () {
		k.noteAll(renameNotes(c))
		const relations = relationsOf(c.shape.kind)
		const reads = yield* migrateHistory(
			"family_renames",
			[
				{ desc: (name) => versionOf(name, c.shape, { kind: "plain" }), declared: noDeclarations },
				{
					desc: (name) =>
						versionOf(name, c.shape, { kind: "family", naming: asFirst, reading: firstReading }),
					declared: noDeclarations
				},
				{
					desc: (name) =>
						versionOf(name, c.shape, {
							kind: "family",
							naming: namingOf(c.renaming),
							reading: firstReading
						}),
					declared: declarationsOf(c)
				}
			],
			c.stored,
			(step, name) =>
				step === 0
					? Effect.succeedNone
					: Effect.gen(function* () {
							const naming = step === 1 ? asFirst : namingOf(c.renaming)
							const oids = yield* oidsOf(name, Arr.map(relations, naming.relation))
							const tables = yield* readTables(oids)
							return Option.some({ oids, tables })
						})
		)
		const before = defined(Option.getOrUndefined(defined(reads[1], "the family's read")), "a read")
		const after = defined(Option.getOrUndefined(defined(reads[2], "the rename's read")), "a read")
		assert.deepEqual(after.oids, before.oids, "every relation keeps its table")
		for (const [i, table] of after.tables.entries()) {
			const was = defined(before.tables[i], "a table before the rename")
			assert.equal(table.relfilenode, was.relfilenode, "a rename rewrites no table")
			assert.deepEqual(table.xmins, was.xmins, "a rename updates no row")
			assert.deepEqual(
				table.columns,
				was.columns,
				"a rename keeps every column, the family's law columns and drawn fields among them, with its attribute number and every value"
			)
		}
	})

type ChangeFeature = Kind | `fold ${Accumulators}` | "copy" | Change | "stored members"

/** What a reshaping history changes at its third version: the field its fold steps over, the field its copy reads,
 * or its group. */
type Change = "fold step" | "copy target" | "group"

interface ChangeCase {
	readonly shape: Shape
	readonly change: Change
	readonly stored: ReadonlyArray<Stored>
}

const changeCaseGen: Gen<ChangeCase> = (source) => {
	const change = source.draw(element<Change>(["fold step", "copy target", "group"]))
	const base = source.draw(
		shapeGen(change === "copy target" ? ["counted", "ordered", "tree"] : ["counted", "ordered"])
	)
	const shape: Shape =
		change === "fold step" && base.fold === "none"
			? { ...base, fold: "hidden" }
			: change === "copy target"
				? { ...base, copy: true }
				: base
	return { shape, change, stored: source.draw(rowsOf(shape.kind)) }
}

/** What a reshaping history's third version reads. */
const changedReading = (change: Change): Reading => {
	switch (change) {
		case "fold step":
			return { ...firstReading, step: "y" }
		case "copy target":
			return { ...firstReading, copied: "tag2" }
		case "group":
			return { ...firstReading, group: "h" }
	}
}

const changeCase = (c: ChangeCase, k: Case<ChangeFeature>) =>
	Effect.gen(function* () {
		k.noteAll([
			c.shape.kind,
			`fold ${c.shape.fold}`,
			c.change,
			...(c.shape.copy ? (["copy"] as const) : []),
			...(storesMembers(c.stored) ? (["stored members"] as const) : [])
		])
		yield* migrateHistory(
			"family_changes",
			[
				{ desc: (name) => versionOf(name, c.shape, { kind: "plain" }), declared: noDeclarations },
				{
					desc: (name) =>
						versionOf(name, c.shape, { kind: "family", naming: asFirst, reading: firstReading }),
					declared: noDeclarations
				},
				{
					desc: (name) =>
						versionOf(name, c.shape, {
							kind: "family",
							naming: asFirst,
							reading: changedReading(c.change)
						}),
					declared: noDeclarations
				}
			],
			c.stored,
			() => Effect.void
		)
	})

layer(Substrate.layer)(
	"a family over stored rows renamed or refilled through grizzle's migrations on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"a declared rename of a family's relations or the owner's fields, swaps and chains among them, renames every law column and drawn field in place: no table rewritten, no row updated, every column's attribute number and values kept",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "pg/migrate/family-renames",
							draw: drawn(renameCaseGen),
							literal: Formatter.format,
							oracle: {
								kind: "postgresql",
								name: "a rename changes no stored byte: relfilenodes, xmins, attribute numbers and values, judged by PostgreSQL's catalog"
							},
							coverage: required<RenameFeature>(
								[
									...kinds,
									"fold none",
									"fold hidden",
									"fold named",
									"copy",
									"owner renamed",
									"member renamed",
									"count renamed",
									"relations swapped",
									"relations chained",
									"fields swapped",
									"fields chained",
									"stored members"
								],
								{ cases: 24, sense: notesOnly }
							),
							kept: [],
							runs: 4,
							shrink: { kind: "bounded", candidates: 30 },
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						renameCase
					)
				)
		)
		it.effect(
			"a fold's step, an axis copy's target or a family's group changed over stored rows is drawn again: the migration commits with every law validated",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "pg/migrate/family-changes",
							draw: drawn(changeCaseGen),
							literal: Formatter.format,
							oracle: {
								kind: "postgresql",
								name: "PostgreSQL validates every constraint the migration adds over the values it draws again"
							},
							coverage: required<ChangeFeature>(
								[
									...kinds,
									"fold hidden",
									"fold named",
									"copy",
									"fold step",
									"copy target",
									"group",
									"stored members"
								],
								{ cases: 48, sense: notesOnly }
							),
							kept: [],
							runs: 4,
							shrink: { kind: "bounded", candidates: 30 },
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						changeCase
					)
				)
		)
	}
)
