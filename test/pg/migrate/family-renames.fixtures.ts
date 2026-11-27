/** What the properties of family-renames.test.ts read: its spaces, models and helpers. */

import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	boolean,
	constant,
	element,
	type Gen,
	int,
	parents,
	shuffled
} from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { type Swarm, swarm, swarmChoice } from "@bjornpagen/testing/swarm"
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
import type { FolderTexts } from "#adapter/migrate/input.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { Declarations, Rename } from "#compiler/deploy/diff/plan.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import {
	type Aim,
	apply,
	checkedAdmission,
	kept,
	openMigrator,
	refusedIn,
	migrationRefusedLaws,
	reviewedSource
} from "#test/pg/migrate/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { numbered, treeOfParents } from "#test/support/families/tree.ts"
import {
	type AuthoredStatementDesc,
	closed,
	closedRelation,
	contained,
	counted,
	f,
	field,
	fin,
	type FixtureField,
	fold,
	literal,
	on,
	onWhere,
	ordered,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	asDrafted,
	compile,
	customDataStep,
	draftCodes,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations,
	type Previous
} from "#test/support/migrate/kit.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

export const kinds = ["counted", "ordered", "tree"] as const

type Kind = (typeof kinds)[number]

/** A fold's accumulators: none, the family folded with them hidden, or named by the step side (never over a counted
 * family). */
type Accumulators = "none" | "hidden" | "named"

/** Which members a fold steps over: every one, those of one kind (a roster's handle), or those whose kind weighs at
 * least another kind's (a closed relation read at a handle). */
const selections = ["every", "kind", "weight"] as const

type Selection = (typeof selections)[number]

/** What a history's family is: its kind, its fold, which members the fold steps over, and whether an axis carries a
 * copy. */
interface Shape {
	readonly kind: Kind
	readonly fold: Accumulators
	readonly selection: Selection
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

/** The roster a member's kind is of, its handles in code order, and the names a rename may give them. */
const roster = "Kind"

const handles = ["a", "b", "c"] as const

type Handle = (typeof handles)[number]

/** How a version names the history's relations, the owner's fields, the roster and its handles, by their names at its
 * first version. */
interface Naming {
	readonly relation: (name: RelationName) => string
	readonly field: (name: OwnerField) => string
	readonly roster: string
	readonly handle: (name: Handle) => string
}

const asFirst: Naming = {
	relation: (name) => name,
	field: (name) => name,
	roster,
	handle: (name) => name
}

/** What a version's family reads: the field its fold steps over (a member's x or y, a tree node's two tags, or the
 * family's copy, ownerTag or parentTag), the owner field its copy reads, its group, and the weights a selection by
 * weight reads, each kind's its handle's code or that code reversed. A tree's group is its parent. */
interface Reading {
	readonly step: "first" | "second" | "copy"
	readonly copied: "tag" | "tag2"
	readonly group: "g" | "h"
	readonly weighed: "by code" | "reversed"
}

const firstReading: Reading = { step: "first", copied: "tag", group: "g", weighed: "by code" }

/** The member field a counted or ordered family's fold steps over, by its reading. */
const steps = { first: "x", second: "y" } as const

/** The handle a selection names: the kind it selects, or the kind whose weight it compares with. */
const selectedHandle: Handle = "b"

/** The closed relation of each kind's weight: its handle's code, or that code reversed (Reading `weighed`). */
const weight = "Weight"

/** The members a selected fold steps over: those of kind b, or those whose kind weighs at least kind b's. */
const selectionOf = (selection: Exclude<Selection, "every">, naming: Naming): ExprDesc => {
	switch (selection) {
		case "kind":
			return {
				kind: "compare",
				op: "eq",
				left: field("kind"),
				right: literal(naming.handle(selectedHandle))
			}
		case "weight":
			return {
				kind: "compare",
				op: "ge",
				left: { kind: "closedAt", relation: weight, field: "w", args: [field("kind")] },
				right: {
					kind: "closedAt",
					relation: weight,
					field: "w",
					args: [literal(naming.handle(selectedHandle))]
				}
			}
	}
}

/** A fold's step side: over every member, or over those its selection holds of. */
const stepSide = (
	shape: Shape,
	naming: Naming,
	relationName: string,
	terms: ReadonlyArray<string>
) =>
	shape.selection === "every"
		? on(relationName, terms)
		: onWhere(relationName, terms, selectionOf(shape.selection, naming))

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
		kind: f.closedId(naming.roster),
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
				stepSide(
					shape,
					naming,
					member,
					named
						? [group, reading.step === "copy" ? "ownerTag" : steps[reading.step], "before", "after"]
						: [group, reading.step === "copy" ? "ownerTag" : steps[reading.step]]
				),
				on(owner, ["id", "end"])
			)
		)
	}
	if (shape.copy) {
		statements.push(
			contained(on(member, [group, "ownerTag"]), on(owner, ["id", naming.field(reading.copied)]))
		)
	}
	return {
		relations: [relation(owner, ownerFieldsAt, ["id"]), relation(member, memberFields, ["member"])],
		statements
	}
}

/**
 * A tree's relation and statements at a version, keyed by its root field doc and its start, `folded` with its sum fold
 * of a tag over each node's children and its copy of the parent's tag down the owner axis, as `shape` states them, or
 * bare, the tree alone, as its first version stores its rows.
 */
const treeSchema = (shape: Shape, naming: Naming, reading: Reading, folded: boolean) => {
	const node = naming.relation("Node")
	const count = naming.field("n")
	const slots = fin(node, count)
	const named = folded && shape.fold === "named"
	const fields: Record<string, FixtureField> = {
		doc: integer,
		parent: f.drawn,
		[naming.field("tag")]: integer,
		[naming.field("tag2")]: integer,
		at: f.drawn,
		[count]: f.drawn,
		start: f.drawn,
		end: f.drawn,
		kind: f.closedId(naming.roster),
		...(!folded || shape.fold === "none" ? {} : { total: f.accumulated(integer, 0) }),
		...(named ? { before: f.accumulated(integer, 0), after: f.accumulated(integer, 0) } : {}),
		...(folded && shape.copy ? { parentTag: f.accumulated(integer, 0) } : {})
	}
	const statements: Array<AuthoredStatementDesc> = [
		{ kind: "tree", member: on(node, ["parent", "at"]), slots, root: ["doc"] }
	]
	if (!folded) {
		return { relations: [relation(node, fields, ["doc", "start"])], statements }
	}
	if (shape.fold !== "none") {
		const step =
			reading.step === "copy"
				? "parentTag"
				: naming.field(reading.step === "first" ? "tag" : "tag2")
		statements.push(
			fold(
				slots,
				"sum",
				stepSide(
					shape,
					naming,
					node,
					named ? ["doc", "parent", step, "before", "after"] : ["doc", "parent", step]
				),
				on(node, ["doc", "start", "total"])
			)
		)
	}
	if (shape.copy) {
		statements.push(
			contained(
				onWhere(node, ["doc", "parent", "parentTag"], nonRoot),
				on(node, ["doc", "start", naming.field(reading.copied)])
			)
		)
	}
	return { relations: [relation(node, fields, ["doc", "start"])], statements }
}

/**
 * A history's relations before its family, and their statements: the caller's fields alone, or a tree's bare relation
 * and its tree, which keys the rows it stores by their root field and start.
 */
const plainSchema = (shape: Shape) => {
	const kind = f.closedId(roster)
	return shape.kind === "tree"
		? treeSchema(shape, asFirst, firstReading, false)
		: {
				relations: [
					relation("Owner", { id: integer, tag: integer, tag2: integer }, ["id"]),
					relation(
						"Member",
						{ member: integer, g: integer, h: integer, x: integer, y: integer, kind },
						["member"]
					)
				],
				statements: []
			}
}

/** A version's schema under the declared name `name`: the plain relations, or the family as `naming` and `reading`
 * state it, with the spare relation. */
const versionOf = (
	name: string,
	shape: Shape,
	at:
		| { readonly kind: "plain" }
		| { readonly kind: "family"; readonly naming: Naming; readonly reading: Reading }
): SchemaDesc => {
	const naming = at.kind === "plain" ? asFirst : at.naming
	const weighed = at.kind === "plain" ? firstReading.weighed : at.reading.weighed
	const spare = relation(naming.relation("Spare"), { id: integer }, ["id"])
	const kinds = closed.ordered(naming.roster, Arr.map(handles, naming.handle))
	const weights = closedRelation(
		weight,
		{ kind: { kind: "closedId", roster: naming.roster, only: undefined }, w: integer },
		["kind"],
		Arr.map(handles, (h, code) => ({
			kind: naming.handle(h),
			w: weighed === "by code" ? code : handles.length - 1 - code
		}))
	)
	if (at.kind === "plain") {
		const plain = plainSchema(shape)
		return {
			name,
			relations: [kinds, weights, ...plain.relations, spare],
			statements: plain.statements,
			bases: []
		}
	}
	const family =
		shape.kind === "tree"
			? treeSchema(shape, at.naming, at.reading, true)
			: familySchema(shape, at.naming, at.reading)
	return {
		name,
		relations: [kinds, weights, ...family.relations, spare],
		statements: family.statements,
		bases: []
	}
}

/**
 * The rows a history stores at its first version: each relation's, each a value per field, or per `‹s›`, a tree node's
 * successor among its siblings, which its direct writer writes beside the tree's drawn fields.
 */
interface Stored {
	readonly relation: RelationName
	readonly rows: ReadonlyArray<Readonly<Record<string, number>>>
}

/** The keys a drawn row takes, apart from one another. */
const keyRange: Arr.NonEmptyReadonlyArray<number> = Arr.range(1, 40)

const valueGen = int(-9, 9)

/** A kind's code: its handle's position in the roster. */
const codeGen = int(0, handles.length - 1)

/** How a family's rows are drawn: how many owners, how many members, and whether the first two members share their
 * owner under g, so some owner's family under g holds several. */
interface RowsDraw {
	readonly owners: Gen<number>
	readonly total: Gen<number>
	readonly sharing: boolean
}

/** One to three owners, each with two tags, and up to six members, each keyed apart, falling among them under both
 * groups, each with two values; the keys drawn in any order; the first two members under g with one owner where
 * `sharing`. */
const familyRowsOf =
	(d: RowsDraw): Gen<ReadonlyArray<Stored>> =>
	(source) => {
		const owners = nonEmpty(
			upTo(source.draw(d.owners), (i) => i + 1),
			"one to three owners"
		)
		const total = source.draw(d.total)
		const keys = source.draw(shuffled(keyRange, { min: total, max: total }))
		const ownerOf = element(owners)
		const shared = source.draw(ownerOf)
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
				rows: Arr.map(keys, (member, i) => ({
					member,
					g: d.sharing && i < 2 ? shared : source.draw(ownerOf),
					h: source.draw(ownerOf),
					x: source.draw(valueGen),
					y: source.draw(valueGen),
					kind: source.draw(codeGen)
				}))
			}
		]
	}

/**
 * One or two trees of one to five nodes, each tree's shape drawn by its parents, its root value apart from the other's,
 * stored as NP numbers it, and each node's two tags and kind.
 */
const treeRows: Gen<ReadonlyArray<Stored>> = (source) => {
	const forest = upTo(source.draw(int(1, 2)), (doc) => ({
		root: [String(doc)],
		tree: treeOfParents(source.draw(parents({ min: 1, max: 5 })), [])
	}))
	const rows = Arr.map(numbered(forest), (r) => ({
		doc: Number(Arr.headNonEmpty(nonEmpty(r.root, "a tree's root value"))),
		parent: r.parent,
		at: r.at,
		n: r.children,
		start: r.start,
		end: r.end,
		"‹s›": r.next,
		tag: source.draw(valueGen),
		tag2: source.draw(valueGen),
		kind: source.draw(codeGen)
	}))
	return [{ relation: "Node", rows }]
}

/** Up to two spare rows. */
const spareRows: Gen<Stored> = (source) => ({
	relation: "Spare",
	rows: Arr.map(
		upTo(source.draw(int(0, 2)), (i) => i + 1),
		(id) => ({ id })
	)
})

const anyRows: RowsDraw = { owners: int(1, 3), total: int(0, 6), sharing: false }

const familyRows: Gen<ReadonlyArray<Stored>> = familyRowsOf(anyRows)

const rowsOf =
	(kind: Kind): Gen<ReadonlyArray<Stored>> =>
	(source) => [...source.draw(kind === "tree" ? treeRows : familyRows), source.draw(spareRows)]

/** The relations of a history of a kind, by their first names. */
const relationsOf = (kind: Kind): ReadonlyArray<RelationName> =>
	kind === "tree" ? treeRelations : familyRelations

/** The relation whose fields the owner fields are: a counted or ordered family's owner, a tree's node. */
const ownerOf = (kind: Kind): RelationName => (kind === "tree" ? "Node" : "Owner")

/** A rename of a history: each relation's name, each owner field's, the roster's and each handle's at the third
 * version. */
interface Renaming {
	readonly relations: ReadonlyMap<RelationName, string>
	readonly fields: ReadonlyMap<OwnerField, string>
	readonly roster: string
	readonly handles: ReadonlyMap<Handle, string>
}

const namingOf = (r: Renaming): Naming => ({
	relation: (name) => r.relations.get(name) ?? name,
	field: (name) => r.fields.get(name) ?? name,
	roster: r.roster,
	handle: (name) => r.handles.get(name) ?? name
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
		return {
			kind,
			fold,
			selection: fold === "none" ? "every" : source.draw(element(selections)),
			copy: source.draw(boolean)
		}
	}

/** A renaming history: its family, its stored rows and its third version's names. */
interface RenameCase {
	readonly shape: Shape
	readonly stored: ReadonlyArray<Stored>
	readonly renaming: Renaming
}

export const renameCaseGen: Gen<RenameCase> = (source) => {
	const shape = source.draw(shapeGen(["counted", "ordered", "tree"]))
	return {
		shape,
		stored: source.draw(rowsOf(shape.kind)),
		renaming: {
			relations: source.draw(injection(relationsOf(shape.kind), freshRelations)),
			fields: source.draw(injection(ownerFields, ["m"])),
			roster: source.draw(element([roster, "Sort"])),
			handles: source.draw(injection(handles, ["d"]))
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
		),
		...(naming.roster === roster
			? []
			: [
					{
						from: { kind: "relation" as const, relation: parsedName(roster) },
						to: { kind: "relation" as const, relation: parsedName(naming.roster) }
					}
				]),
		...Arr.flatMap(handles, (handle): ReadonlyArray<Rename> =>
			naming.handle(handle) === handle
				? []
				: [
						{
							from: { kind: "handle", roster: parsedName(roster), handle },
							to: {
								kind: "handle",
								roster: parsedName(naming.roster),
								handle: naming.handle(handle)
							}
						}
					]
		)
	]
	return { renames, drops: [] }
}

/** The installation of a version's schema under the installed schema `name`, owned by `owner`, under `codes`. */
const compiledAt = (desc: SchemaDesc, name: string, codes: Codebook): Installation => {
	const owned = owning(desc)
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, [identity.schema(parsedSchemaName(name))], [], [], codes)
		)
	)
}

/** What a version holds of one table, read by its OID: its relfilenode, its constraints' and its indexes' OIDs, and
 * each live column's attribute number with every row's value of it, beside each row's xmin, rows in the order of the
 * table's key. */
interface TableRead {
	readonly relfilenode: string
	readonly constraints: ReadonlyArray<string>
	readonly indexes: ReadonlyArray<string>
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
				const constraints = yield* values(
					`SELECT oid::int8::text FROM pg_catalog.pg_constraint WHERE conrelid = ${oid} ORDER BY oid`
				)
				const indexes = yield* values(
					`SELECT indexrelid::int8::text FROM pg_catalog.pg_index WHERE indrelid = ${oid} ORDER BY indexrelid`
				)
				const read: TableRead = { relfilenode, constraints, indexes, columns, xmins }
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

/**
 * Writes the stored rows into the first version's tables, in one transaction: each field's column by its name, and
 * `‹s›` the column of the successor of the family whose member the relation is, as `installation` names it.
 */
const store = (schemaName: string, installation: Installation, stored: ReadonlyArray<Stored>) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const schemaIdent = quoteIdent(identifierOf(identity.schema(parsedSchemaName(schemaName))))
		const columnOf = (relation: string, name: string) =>
			quoteIdent(
				name === "‹s›"
					? defined(
							Option.getOrUndefined(
								Arr.findFirst(installation.laws.families, (g) => g.member.name === relation)
							),
							`the family whose member is ${relation}`
						).next
					: identifierOf(identity.column(parsedName(name)))
			)
		const inserts = Arr.flatMap(stored, (r) => {
			const [first] = r.rows
			if (first === undefined) {
				return []
			}
			const fields = Rec.keys(first)
			return [
				`INSERT INTO ${schemaIdent}.${quoteIdent(identifierOf(identity.table(parsedName(r.relation))))} (${Arr.join(
					Arr.map(fields, (field) => columnOf(r.relation, field)),
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
 * and applied with the drift check and the installed-catalog checker; the rows stored after the first; each step's data
 * step, `dataStep`'s SQL for it, a custom migration over the snapshot before it (test/support/migrate/kit.ts
 * customDataStep), drafted at the ordinal its version's folder leaves before it on the tests' one clock and applied with
 * it, so the runner brackets it with every immutability guard (adapter/migrate/apply.ts guardBracket); `observe` run
 * after each step with its index. A refused apply fails the history with migrate's error.
 */
const migrateHistory = <A>(
	label: string,
	versions: ReadonlyArray<{
		readonly desc: (name: string) => SchemaDesc
		readonly declared: Declarations
	}>,
	stored: ReadonlyArray<Stored>,
	dataStep: (step: number, schemaName: string) => ReadonlyArray<string>,
	observe: (step: number, schemaName: string) => Effect.Effect<A, never, Substrate>
): Effect.Effect<ReadonlyArray<A>, MigrateError | SqlError, Substrate> =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const name = yield* substrate.schema({ create: false, label })
			const m = yield* openMigrator(substrate, substrate.owner)
			const folders: Array<FolderTexts> = []
			const observed: Array<A> = []
			let previous: Previous = fromEmpty
			for (const [i, version] of versions.entries()) {
				const desc = version.desc(name)
				const installation = compiledAt(
					desc,
					name,
					succeeded(draftCodes(desc, previous, version.declared))
				)
				const g = succeeded(
					generate({
						previous,
						installation,
						name: `step_${i + 1}`,
						timestamp: draftedAt(2 * (i + 1)),
						workload: noWorkload,
						declared: version.declared
					}),
					`step ${i + 1} drafts`
				)
				const steps = dataStep(i, name)
				if (Arr.isReadonlyArrayNonEmpty(steps)) {
					if (previous.kind !== "snapshot") {
						return yield* Effect.die("a data step follows an applied version")
					}
					folders.push(customDataStep(previous.snapshot, 2 * i + 1, steps))
				}
				folders.push(reviewedSource(g, kept))
				yield* apply(
					m,
					{ snapshot: g.snapshot, folders: [...folders] },
					checkedAdmission(installation, substrate.admin)
				)
				previous = fromSnapshot(g.snapshot)
				if (i === 0) {
					yield* store(name, installation, stored)
				}
				const pending = yield* notValid(name)
				assert.deepEqual(pending, [], `step ${i + 1} leaves no constraint NOT VALID`)
				const seen = yield* observe(i, name)
				observed.push(seen)
			}
			return observed
		})
	)

export type RenameFeature =
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
	| "roster renamed"
	| "handles swapped"
	| "handles chained"
	| `fold selecting by ${Exclude<Selection, "every">}`
	| `${Exclude<Selection, "every">} selection's handle renamed`
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
	const kinds = movesOf(c.renaming.handles)
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
		...(naming.roster === roster ? [] : (["roster renamed"] as const)),
		...(kinds.swapped ? (["handles swapped"] as const) : []),
		...(kinds.chained ? (["handles chained"] as const) : []),
		...(c.shape.selection === "every" ? [] : [`fold selecting by ${c.shape.selection}` as const]),
		...(c.shape.selection !== "every" && naming.handle(selectedHandle) !== selectedHandle
			? [`${c.shape.selection} selection's handle renamed` as const]
			: []),
		...(members ? (["stored members"] as const) : [])
	]
}

export const renameCase = (c: RenameCase, k: Case<RenameFeature>) =>
	Effect.gen(function* () {
		k.noteAll(renameNotes(c))
		const relations = relationsOf(c.shape.kind)
		const reads = yield* Effect.orDie(
			migrateHistory(
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
				() => [],
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
		)
		const before = defined(Option.getOrUndefined(defined(reads[1], "the family's read")), "a read")
		const after = defined(Option.getOrUndefined(defined(reads[2], "the rename's read")), "a read")
		assert.deepEqual(after.oids, before.oids, "every relation keeps its table")
		for (const [i, table] of after.tables.entries()) {
			const was = defined(before.tables[i], "a table before the rename")
			assert.equal(table.relfilenode, was.relfilenode, "a rename rewrites no table")
			assert.deepEqual(
				table.constraints,
				was.constraints,
				"a rename keeps every constraint, renamed in place, never added and validated again"
			)
			assert.deepEqual(table.indexes, was.indexes, "a rename keeps every index, never built again")
			assert.deepEqual(table.xmins, was.xmins, "a rename updates no row")
			assert.deepEqual(
				table.columns,
				was.columns,
				"a rename keeps every column, the family's law columns and drawn fields among them, with its attribute number and every value"
			)
		}
	})

export type ChangeFeature =
	| Kind
	| `fold ${Accumulators}`
	| "copy"
	| `fold selecting by ${Exclude<Selection, "every">}`
	| `${Change} on a ${Kind}`
	| Change
	| "stored members"
	| "group kept on an ordered family"
	| `group refused, moved onto ${Onto}, on an ordered family`
	| "group redrawn as declared on an ordered family"

/** What a reshaping history changes at its third version: the field its fold steps over, the field its copy reads,
 * its group, a fold it adds, or the weights its fold's selection by weight reads, a closed relation's rows. */
type Change = "fold step" | "copy target" | "group" | "fold added" | "weights"

/**
 * How a history whose ordered family's group changes from g to h moves its members, by the data step before the third
 * version: `kept` writes each member's h as `onto` maps its owner under g, a permutation of the owners, so each new
 * group's stored indices stay 0 … n − 1; `broken` writes h as g but for `moved`, the first member by key of an owner's
 * family of several under g (its index 0), which goes to `to`, another owner, so the owner it leaves starts at 1;
 * `redrawn` writes nothing and declares the index dropped (`--drop Member.at`).
 */
type Regroup =
	| { readonly kind: "kept"; readonly onto: ReadonlyMap<number, number> }
	| { readonly kind: "broken"; readonly moved: number; readonly to: number; readonly onto: Onto }
	| { readonly kind: "redrawn" }

/**
 * Where a broken regroup moves its member: onto an owner holding a family under g, whose member at index 0 the moved
 * one then repeats, so the backfill's check of the family's key (h, at) refuses it under the family's law; or onto an
 * owner holding none, so only the gap the owner it leaves starts with breaks a law, at VALIDATE.
 */
const ontos = ["a family", "no family"] as const

type Onto = (typeof ontos)[number]

const regroups = ["kept", "broken onto a family", "broken onto no family", "redrawn"] as const

type RegroupKind = (typeof regroups)[number]

interface ChangeCase {
	readonly shape: Shape
	readonly change: Change
	readonly stored: ReadonlyArray<Stored>
	/** How an ordered family's group change moves its members; none for any other change. */
	readonly regroup: Option.Option<Regroup>
}

/** A stored relation's rows, none where the history stores none of it. */
const storedRows = (stored: ReadonlyArray<Stored>, relation: RelationName) =>
	Option.match(
		Arr.findFirst(stored, (r) => r.relation === relation),
		{ onNone: () => [], onSome: (r) => r.rows }
	)

/** A stored row's value of a field the history writes every row of. */
const valueOf = (row: Readonly<Record<string, number>>, field: string): number =>
	defined(row[field], `a stored row's ${field}`)

/** The members of each owner's family under g with more than one member, each family's first by key, its index 0. */
const firstsOfSeveral = (
	stored: ReadonlyArray<Stored>
): ReadonlyArray<Readonly<Record<string, number>>> => {
	const members = storedRows(stored, "Member")
	return Arr.flatMap(storedRows(stored, "Owner"), (o) => {
		const family = Arr.sort(
			Arr.filter(members, (m) => valueOf(m, "g") === valueOf(o, "id")),
			Order.mapInput(Order.Number, (m: Readonly<Record<string, number>>) => valueOf(m, "member"))
		)
		return family.length > 1 ? Arr.take(family, 1) : []
	})
}

/** A regroup of the stored rows: its kind the case's swarm chooses among those the rows admit (`broken` needs an
 * owner's family of several and another owner), and its permutation or its move drawn. */
const regroupOf =
	(
		stored: ReadonlyArray<Stored>,
		kind: (admitted: Arr.NonEmptyReadonlyArray<RegroupKind>) => Gen<RegroupKind>
	): Gen<Regroup> =>
	(source) => {
		const owners = Arr.map(storedRows(stored, "Owner"), (o) => valueOf(o, "id"))
		const members = storedRows(stored, "Member")
		/** Each move of a first member of several onto another owner, by whether that owner holds a family under g. */
		const moves = (onto: Onto) =>
			Arr.flatMap(firstsOfSeveral(stored), (first) =>
				Arr.flatMap(owners, (to) =>
					to !== valueOf(first, "g") &&
					Arr.some(members, (m) => valueOf(m, "g") === to) === (onto === "a family")
						? [{ moved: valueOf(first, "member"), to, onto }]
						: []
				)
			)
		const broken = (onto: Onto) => source.draw(element(nonEmpty(moves(onto), "a move")))
		const admitted: Arr.NonEmptyReadonlyArray<RegroupKind> = [
			"kept",
			...Arr.flatMap(ontos, (onto): ReadonlyArray<RegroupKind> =>
				Arr.isReadonlyArrayNonEmpty(moves(onto)) ? [`broken onto ${onto}`] : []
			),
			"redrawn"
		]
		switch (source.draw(kind(admitted))) {
			case "kept": {
				const onto = source.draw(shuffled(owners, { min: owners.length, max: owners.length }))
				return {
					kind: "kept",
					onto: new Map(
						Arr.map(owners, (o, i) => [o, defined(onto[i], "an owner's image")] as const)
					)
				}
			}
			case "broken onto a family":
				return { kind: "broken", ...broken("a family") }
			case "broken onto no family":
				return { kind: "broken", ...broken("no family") }
			case "redrawn":
				return { kind: "redrawn" }
		}
	}

/** A changed filler: its change, its shape and its rows, and, for an ordered family's group, its regroup, of the
 * kinds `kind` weighs. */
const changeCaseOf =
	(
		change: Gen<Change>,
		among: (change: Change) => Arr.NonEmptyReadonlyArray<Kind>,
		rows: (kind: Kind) => Gen<ReadonlyArray<Stored>>,
		kind: (
			swarmed: Swarm<RegroupKind>
		) => (admitted: Arr.NonEmptyReadonlyArray<RegroupKind>) => Gen<RegroupKind>
	): Gen<ChangeCase> =>
	(source) => {
		const drawnChange = source.draw(change)
		const base = source.draw(shapeGen(among(drawnChange)))
		const shape: Shape =
			drawnChange === "weights"
				? { ...base, fold: base.fold === "none" ? "hidden" : base.fold, selection: "weight" }
				: (drawnChange === "fold step" || drawnChange === "fold added") && base.fold === "none"
					? { ...base, fold: "hidden" }
					: drawnChange === "copy target"
						? { ...base, copy: true }
						: base
		const stored = source.draw(rows(shape.kind))
		const swarmed = source.draw(swarm(regroups))
		return {
			shape,
			change: drawnChange,
			stored,
			regroup:
				drawnChange === "group" && shape.kind === "ordered"
					? Option.some(source.draw(regroupOf(stored, kind(swarmed))))
					: Option.none()
		}
	}

/** The case's swarm's choice among the regroups the rows admit. */
const swarmedRegroup =
	(swarmed: Swarm<RegroupKind>) =>
	(admitted: Arr.NonEmptyReadonlyArray<RegroupKind>): Gen<RegroupKind> =>
		swarmChoice(swarmed, admitted)

export const changeCaseGen: Gen<ChangeCase> = changeCaseOf(
	element<Change>(["fold step", "copy target", "group", "fold added"]),
	(change) => (change === "group" ? ["counted", "ordered"] : kinds),
	rowsOf,
	swarmedRegroup
)

/** An ordered family's group change regrouped as `kind` says over two or three owners and the first two of two to six
 * members sharing their owner under g, where those rows admit it, and kept where they do not: a broken regroup onto a
 * family needs another owner holding one, onto no family another owner holding none. */
const regroupedAs = (kind: RegroupKind): Gen<ChangeCase> =>
	changeCaseOf(
		constant<Change>("group"),
		() => ["ordered"],
		() => (source) => [
			...source.draw(familyRowsOf({ owners: int(2, 3), total: int(2, 6), sharing: true })),
			source.draw(spareRows)
		],
		() => (admitted) => constant(Arr.contains(admitted, kind) ? kind : "kept")
	)

/** The cases each required regroup is aimed at while it is pending: the generator draws the one a case's turn aims at
 * (aimed) in place of its plain draw. */
export const changeAims: ReadonlyArray<Aim<ChangeCase, ChangeFeature>> = [
	["group kept on an ordered family", regroupedAs("kept")],
	["group refused, moved onto a family, on an ordered family", regroupedAs("broken onto a family")],
	[
		"group refused, moved onto no family, on an ordered family",
		regroupedAs("broken onto no family")
	],
	["group redrawn as declared on an ordered family", regroupedAs("redrawn")]
]

/** What a reshaping history's second version is: its family without the fold it adds, or as it is. */
const shapeBefore = (c: ChangeCase): Shape =>
	c.change === "fold added" ? { ...c.shape, fold: "none", selection: "every" } : c.shape

/** What a reshaping history's third version reads: what its second, `before`, reads, with `change` made. */
const changedReading = (change: Change, before: Reading): Reading => {
	switch (change) {
		case "fold step":
			return { ...before, step: "second" }
		case "copy target":
			return { ...before, copied: "tag2" }
		case "group":
			return { ...before, group: "h" }
		case "fold added":
			return before
		case "weights":
			return { ...before, weighed: "reversed" }
	}
}

/** A member of an ordered family whose group changes, as the history reads it after a step: its key, its h and its
 * index. */
interface Indexed {
	readonly member: number
	readonly h: number
	readonly at: number
}

const byKey = Order.mapInput(Order.Number, (m: Indexed) => m.member)

/** The history's Member rows (Indexed), by key. */
const indexedOf = (schemaName: string) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const schemaIdent = quoteIdent(identifierOf(identity.schema(parsedSchemaName(schemaName))))
		const column = (name: string) => quoteIdent(identifierOf(identity.column(parsedName(name))))
		const rows = yield* Effect.orDie(
			substrate.admin.queryValues(
				`SELECT ${column("member")}::int8::text, ${column("h")}::int8::text, ${column("at")}::int8::text FROM ${schemaIdent}.${quoteIdent(identifierOf(identity.table(parsedName("Member"))))}`,
				[]
			)
		)
		return Arr.sort(
			Arr.map(rows, (row): Indexed => ({
				member: Number(row[0]),
				h: Number(row[1]),
				at: Number(row[2])
			})),
			byKey
		)
	})

/** The data step of a regroup over the stored rows, as SQL in the installed schema `schemaName`: each member's h, as
 * `kept` maps its owner under g or as `broken` moves one; none for `redrawn`, which declares its index dropped. */
const regroupSteps = (
	schemaName: string,
	stored: ReadonlyArray<Stored>,
	regroup: Regroup
): ReadonlyArray<string> => {
	const members = storedRows(stored, "Member")
	const hOf = (m: Readonly<Record<string, number>>): Option.Option<number> => {
		const g = valueOf(m, "g")
		switch (regroup.kind) {
			case "kept":
				return Option.fromUndefinedOr(regroup.onto.get(g))
			case "broken":
				return Option.some(valueOf(m, "member") === regroup.moved ? regroup.to : g)
			case "redrawn":
				return Option.none()
		}
	}
	const values = Arr.flatMap(members, (m) =>
		Option.match(hOf(m), {
			onNone: () => [],
			onSome: (h) => [`(${valueOf(m, "member")}, ${h})`]
		})
	)
	if (!Arr.isReadonlyArrayNonEmpty(values)) {
		return []
	}
	const schemaIdent = quoteIdent(identifierOf(identity.schema(parsedSchemaName(schemaName))))
	const column = (name: string) => quoteIdent(identifierOf(identity.column(parsedName(name))))
	return [
		`UPDATE ${schemaIdent}.${quoteIdent(identifierOf(identity.table(parsedName("Member"))))} AS "t" SET ${column("h")} = "v"."h" FROM (VALUES ${Arr.join(values, ", ")}) AS "v" ("member", "h") WHERE "t".${column("member")} = "v"."member"`
	]
}

/** What a regroup reaches. */
const regroupFeature = (regroup: Regroup): ChangeFeature => {
	switch (regroup.kind) {
		case "kept":
			return "group kept on an ordered family"
		case "broken":
			return `group refused, moved onto ${regroup.onto}, on an ordered family`
		case "redrawn":
			return "group redrawn as declared on an ordered family"
	}
}

/** The declarations of a reshaping history's third version: the index dropped where its regroup redraws it. */
const changeDeclarations = (c: ChangeCase): Declarations =>
	Option.exists(c.regroup, (r) => r.kind === "redrawn")
		? {
				renames: [],
				drops: [{ kind: "field", relation: parsedName("Member"), field: parsedName("at") }]
			}
		: noDeclarations

/** Each member's index in its group under h by member key, from 0: what a redrawn index holds. */
const keyOrderIndices = (members: ReadonlyArray<Indexed>): ReadonlyArray<Indexed> =>
	Arr.map(members, (m) => ({
		...m,
		at: Arr.filter(members, (other) => other.h === m.h && other.member < m.member).length
	}))

export const changeCase = (c: ChangeCase, k: Case<ChangeFeature>) =>
	Effect.gen(function* () {
		k.noteAll([
			c.shape.kind,
			`fold ${c.shape.fold}`,
			c.change,
			`${c.change} on a ${c.shape.kind}`,
			...(c.shape.copy ? (["copy"] as const) : []),
			...(c.shape.selection === "every" ? [] : [`fold selecting by ${c.shape.selection}` as const]),
			...(storesMembers(c.stored) ? (["stored members"] as const) : []),
			...Option.match(c.regroup, { onNone: () => [], onSome: (r) => [regroupFeature(r)] })
		])
		const changed = (name: string) =>
			versionOf(name, c.shape, {
				kind: "family",
				naming: asFirst,
				reading: changedReading(c.change, firstReading)
			})
		let schemaName = ""
		const outcome = yield* Effect.result(
			migrateHistory(
				"family_changes",
				[
					{ desc: (name) => versionOf(name, c.shape, { kind: "plain" }), declared: noDeclarations },
					{
						desc: (name) =>
							versionOf(name, shapeBefore(c), {
								kind: "family",
								naming: asFirst,
								reading: firstReading
							}),
						declared: noDeclarations
					},
					{ desc: changed, declared: changeDeclarations(c) }
				],
				c.stored,
				(step, name) =>
					step === 2
						? Option.match(c.regroup, {
								onNone: () => [],
								onSome: (r) => regroupSteps(name, c.stored, r)
							})
						: [],
				(step, name) => {
					schemaName = name
					return step > 0 && Option.isSome(c.regroup)
						? indexedOf(name)
						: Effect.succeed<ReadonlyArray<Indexed>>([])
				}
			)
		)
		const broken = Option.exists(c.regroup, (r) => r.kind === "broken")
		if (outcome._tag === "Failure") {
			const failure = outcome.failure
			if (failure._tag !== "MigrateError" || !broken) {
				return assert.fail(
					`the history was refused where its data step keeps every new group a sequence: ${failure.message}\n${Formatter.format(c)}`
				)
			}
			const family = defined(
				Option.getOrUndefined(
					Arr.findFirst(
						compile(changed(schemaName), asDrafted).laws.families,
						(f) => f.member.name === "Member"
					)
				),
				"the regrouped family's compiled form"
			)
			const laws = new Set<string>([family.law, ...Arr.map(family.folds, (f) => f.law)])
			assert.ok(
				Option.exists(refusedIn(failure), Str.endsWith("_step_3")),
				`the refusal names the third folder: ${failure.message}`
			)
			assert.ok(
				Arr.some(migrationRefusedLaws(failure), (law) => laws.has(law)),
				`the refusal names the regrouped family's law or its fold's: ${failure.message}`
			)
			return
		}
		if (broken) {
			return assert.fail(
				`the history applied though its data step left an owner's indices other than 0 … n − 1\n${Formatter.format(c)}`
			)
		}
		yield* Option.match(c.regroup, {
			onNone: () => Effect.void,
			onSome: (r) =>
				Effect.sync(() => {
					const before = defined(outcome.success[1], "the family's read")
					const after = defined(outcome.success[2], "the regroup's read")
					if (r.kind === "redrawn") {
						assert.deepEqual(
							after,
							keyOrderIndices(after),
							"an index declared dropped is drawn anew: each member's place in its group's member-key order"
						)
						return
					}
					assert.deepEqual(
						Arr.map(after, (m) => [m.member, m.at]),
						Arr.map(before, (m) => [m.member, m.at]),
						"a group change whose data step keeps each new group a sequence keeps every member's stored index"
					)
				})
		})
	})

/**
 * How many of a changed filler's stored rows its new filler draws as the old one drew them: a row is alike where its
 * second field holds its first's, a member's y its x and its h its g, an owner's or a node's tag2 its tag, so a fold
 * over y, a copy of tag2 or a family grouped by h draws it as before. `every` makes the change a re-draw that moves no
 * value, as C18's Node string-value fold is; `some` one that moves the values of the rows left apart; `drawn` leaves
 * the rows as drawn.
 */
const alikes = ["drawn", "some", "every"] as const

type Alike = (typeof alikes)[number]

/** A changed filler over stored rows whose second fields are alike to their first as `alike` says, and, for a copy's
 * target changed beside a fold, whether the fold steps over the copy (`foldsCopy`), so the change draws the fold
 * again with the fold itself unchanged, its CHECK, its key and its foreign key along its members held as they are, as
 * C18's Node string-value fold over its codes is. */
interface RedrawCase {
	readonly change: ChangeCase
	readonly alike: Alike
	readonly foldsCopy: boolean
}

/** `rows` with the second field of each row `chosen` picks set to its first's. */
const alikeRows = (
	stored: ReadonlyArray<Stored>,
	chosen: (relation: RelationName, i: number) => boolean
): ReadonlyArray<Stored> =>
	Arr.map(stored, (r) => ({
		...r,
		rows: Arr.map(r.rows, (row, i) => {
			if (!chosen(r.relation, i)) {
				return row
			}
			switch (r.relation) {
				case "Member":
					return { ...row, y: valueOf(row, "x"), h: valueOf(row, "g") }
				case "Owner":
				case "Node":
					return { ...row, tag2: valueOf(row, "tag") }
				case "Spare":
					return row
			}
		})
	}))

/** A changed filler among `changes` on a family among `among`, a group change on a counted one alone, the weights change
 * the closed relation a fold's selection by weight reads, whose stored rows are alike as drawn and whose fold over a
 * copy target's change steps over the copy as `overCopy` says: no data step runs between its versions, so every row the
 * third version's migration writes is one its backfill writes. */
const redrawCaseOf =
	(
		changes: Arr.NonEmptyReadonlyArray<Change>,
		among: Arr.NonEmptyReadonlyArray<Kind>,
		overCopy: "drawn" | "always"
	): Gen<RedrawCase> =>
	(source) => {
		const drawn = source.draw(
			changeCaseOf(
				element(changes),
				(c) => (c === "group" ? ["counted"] : among),
				rowsOf,
				swarmedRegroup
			)
		)
		const change =
			overCopy === "always" && drawn.shape.fold === "none"
				? { ...drawn, shape: { ...drawn.shape, fold: "hidden" as const } }
				: drawn
		return source.draw(redrawnOver(change, overCopy))
	}

/** A changed filler's stored rows made alike as drawn, and whether its fold steps over the copy: always, or as drawn. */
const redrawnOver =
	(change: ChangeCase, overCopy: "drawn" | "always"): Gen<RedrawCase> =>
	(source) => {
		const alike = source.draw(element(alikes))
		const picks = new Map<string, boolean>()
		const chosen = (relation: RelationName, i: number): boolean => {
			switch (alike) {
				case "drawn":
					return false
				case "every":
					return true
				case "some": {
					const at = `${relation}:${i}`
					const known = picks.get(at)
					if (known !== undefined) {
						return known
					}
					const pick = source.draw(boolean)
					picks.set(at, pick)
					return pick
				}
			}
		}
		const foldsCopy =
			change.change === "copy target" &&
			change.shape.fold !== "none" &&
			(overCopy === "always" || source.draw(boolean))
		return { change: { ...change, stored: alikeRows(change.stored, chosen) }, alike, foldsCopy }
	}

export const redrawCaseGen: Gen<RedrawCase> = redrawCaseOf(
	["fold step", "copy target", "group", "fold added", "weights"],
	kinds,
	"drawn"
)

/**
 * A counted family's group change that empties a family: two owners, every member under owner 1 at g and under owner 2
 * at h, its rows as drawn (no second field alike its first), so owner 1 holds members under g and none under h.
 */
const emptiedByRegroup: Gen<RedrawCase> = (source) => {
	const shape = source.draw(shapeGen(["counted"]))
	const total = source.draw(int(1, 3))
	const keys = source.draw(shuffled(keyRange, { min: total, max: total }))
	return {
		change: {
			shape,
			change: "group",
			stored: [
				{
					relation: "Owner",
					rows: Arr.map([1, 2], (id) => ({
						id,
						tag: source.draw(valueGen),
						tag2: source.draw(valueGen)
					}))
				},
				{
					relation: "Member",
					rows: Arr.map(keys, (member) => ({
						member,
						g: 1,
						h: 2,
						x: source.draw(valueGen),
						y: source.draw(valueGen),
						kind: source.draw(codeGen)
					}))
				},
				source.draw(spareRows)
			],
			regroup: Option.none()
		},
		alike: "drawn",
		foldsCopy: false
	}
}

/** The cases each required situation the plain draw reaches too rarely is aimed at while it is pending (aimed): a
 * tree's change, a copy target's change under a fold that steps over the copy, and a group change that empties a
 * family. */
export const redrawAims: ReadonlyArray<Aim<RedrawCase, RedrawFeature>> = [
	["tree", redrawCaseOf(["fold step", "copy target", "fold added", "weights"], ["tree"], "drawn")],
	["a fold over the copy", redrawCaseOf(["copy target"], kinds, "always")],
	["a family emptied by its regroup", emptiedByRegroup]
]

export type RedrawFeature =
	| Kind
	| Change
	| "every row alike"
	| "some rows alike"
	| "a family emptied by its regroup"
	| "a fold over the copy"
	| "a table the re-draw writes no row of"
	| "a table the re-draw writes some rows of"

/** Whether a group change empties some owner's family: an owner with members under g and none under h. */
const emptiesAFamily = (c: ChangeCase): boolean => {
	const members = storedRows(c.stored, "Member")
	return (
		c.change === "group" &&
		Arr.some(
			storedRows(c.stored, "Owner"),
			(o) =>
				Arr.some(members, (m) => valueOf(m, "g") === valueOf(o, "id")) &&
				!Arr.some(members, (m) => valueOf(m, "h") === valueOf(o, "id"))
		)
	)
}

/** One table of a version as the re-draw oracle reads it: its relfilenode; each live column's attribute number and,
 * where its rows predating it read a fast default, that value as text; and each row, in the order of its primary key,
 * by its key, its xmin and its value of each column, as text. */
interface RowsRead {
	readonly table: string
	readonly relfilenode: string
	readonly columns: ReadonlyArray<{
		readonly attnum: string
		readonly missing: Option.Option<string>
	}>
	readonly rows: ReadonlyArray<{
		readonly key: string
		readonly xmin: string
		readonly values: ReadonlyArray<Option.Option<string>>
	}>
}

/** The family's tables of a version (RowsRead). */
const rowsReadOf = (schemaName: string, kind: Kind) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const oids = yield* oidsOf(schemaName, relationsOf(kind))
		/** A value as the admin's session reads it, the server's text, or NULL. */
		const cell = (v: unknown): Option.Option<string> =>
			typeof v === "string" ? Option.some(v) : Option.none()
		return yield* Effect.forEach(oids, (oid) =>
			Effect.gen(function* () {
				const query = (sql: string) => Effect.orDie(substrate.admin.queryValues(sql, []))
				const [named] = yield* query(
					`SELECT c.oid::regclass::text, c.relfilenode::text FROM pg_catalog.pg_class AS c WHERE c.oid = ${oid}`
				)
				const table = String(defined(named, "a table")[0])
				const relfilenode = String(defined(named, "a table")[1])
				const attributes = yield* query(
					`SELECT a.attnum::text, a.attname::text, CASE WHEN a.atthasmissing THEN (a.attmissingval::text::text[])[1] END FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = ${oid} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`
				)
				const keys = yield* query(
					`SELECT a.attname::text FROM pg_catalog.pg_index AS i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, place) JOIN pg_catalog.pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = k.attnum WHERE i.indrelid = ${oid} AND i.indisprimary ORDER BY k.place`
				)
				const key = Arr.join(
					Arr.map(keys, (k) => quoteIdent(String(k[0]))),
					", "
				)
				const rows = yield* query(
					`SELECT ROW(${key})::text, xmin::text, ${Arr.join(
						Arr.map(attributes, (a) => `${quoteIdent(String(a[1]))}::text`),
						", "
					)} FROM ${table} ORDER BY ${key}`
				)
				const read: RowsRead = {
					table,
					relfilenode,
					columns: Arr.map(attributes, (a) => ({ attnum: String(a[0]), missing: cell(a[2]) })),
					rows: Arr.map(rows, (row) => ({
						key: String(row[0]),
						xmin: String(row[1]),
						values: Arr.map(Arr.drop(row, 2), cell)
					}))
				}
				return read
			})
		)
	})

/** Whether two stored values, as text, are one: both NULL, or both the same text. */
const sameText = (x: Option.Option<string>, y: Option.Option<string>): boolean =>
	Option.isNone(x) ? Option.isNone(y) : Option.isSome(y) && x.value === y.value

/**
 * Each row of `after` the re-draw changed, by key: one whose value of a column `before` holds too differs, or whose
 * value of a column the migration added differs from the fast default every row predating the column reads, as
 * PostgreSQL stores them, compared as text. The rows of a table a re-draw keeps are those it held, by key.
 */
const changedRows = (before: RowsRead, after: RowsRead): ReadonlySet<string> => {
	const was = new Map(Arr.map(before.rows, (r) => [r.key, r] as const))
	const at = new Map(Arr.map(before.columns, (c, i) => [c.attnum, i] as const))
	return new Set(
		Arr.flatMap(after.rows, (r) => {
			const old = defined(was.get(r.key), `${after.table}'s row ${r.key} before the re-draw`)
			const moved = Arr.some(after.columns, (c, i) => {
				const now = defined(r.values[i], "a row's value of each column")
				const j = at.get(c.attnum)
				const then =
					j === undefined ? c.missing : defined(old.values[j], "a row's value of each column")
				return !sameText(now, then)
			})
			return moved ? [r.key] : []
		})
	)
}

/** The rows of `after` its version's migration wrote, by key: each whose xmin is not the one it had. */
const writtenRows = (before: RowsRead, after: RowsRead): ReadonlySet<string> => {
	const was = new Map(Arr.map(before.rows, (r) => [r.key, r.xmin] as const))
	return new Set(Arr.flatMap(after.rows, (r) => (was.get(r.key) === r.xmin ? [] : [r.key])))
}

/** Each constraint of the relation `relation` of a version, by name: its OID and its definition, as PostgreSQL's
 * catalog states them. */
const constraintsOf = (schemaName: string, relation: RelationName) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const [oid] = yield* oidsOf(schemaName, [relation])
		const rows = yield* Effect.orDie(
			substrate.admin.queryValues(
				`SELECT conname::text, oid::int8::text, pg_catalog.pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint WHERE conrelid = ${defined(oid, "the relation's OID")} ORDER BY 1`,
				[]
			)
		)
		return new Map(
			Arr.map(
				rows,
				(row) => [String(row[0]), { oid: String(row[1]), definition: String(row[2]) }] as const
			)
		)
	})

/** What the re-draw oracle reads of a version: its family's tables (RowsRead) and its member's constraints. */
interface VersionRead {
	readonly tables: ReadonlyArray<RowsRead>
	readonly constraints: ReadonlyMap<string, { readonly oid: string; readonly definition: string }>
}

const unread: VersionRead = { tables: [], constraints: new Map() }

/**
 * A changed filler drawn again over stored rows, judged by PostgreSQL: the migration commits with every law validated,
 * which holds every value it draws to the target's natives, the values the target's fill draws over those rows; and
 * on every table it does not rewrite, the rows its backfill writes, those whose xmin moved, are exactly the rows whose
 * values it changed. A re-draw that moves no value writes no row; one that moves the values of k rows writes those k.
 * Where the fold steps over the copy, every constraint of its member's table the target holds as it is keeps its OID:
 * its CHECK reads one row, which the backfill writes once; its key holds the family's slot key, which no two rows
 * share; and its foreign keys along its members read one table, which one UPDATE writes whole: the migration builds
 * none of them again.
 */
export const redrawCase = (r: RedrawCase, k: Case<RedrawFeature>) =>
	Effect.gen(function* () {
		const c = r.change
		const first: Reading = r.foldsCopy ? { ...firstReading, step: "copy" } : firstReading
		const member: RelationName = c.shape.kind === "tree" ? "Node" : "Member"
		/** Whether a row's second fields alike its first draw it as the change's old filler did: not for a fold added,
		 * which no filler drew before, nor for weights changed, whose selection reads no second field. */
		const alikeMatters = c.change !== "fold added" && c.change !== "weights"
		k.noteAll([
			c.shape.kind,
			c.change,
			...(r.alike === "every" && alikeMatters ? (["every row alike"] as const) : []),
			...(r.alike === "some" && alikeMatters ? (["some rows alike"] as const) : []),
			...(emptiesAFamily(c) ? (["a family emptied by its regroup"] as const) : []),
			...(r.foldsCopy ? (["a fold over the copy"] as const) : [])
		])
		const outcome = yield* Effect.result(
			migrateHistory(
				"family_redraws",
				[
					{ desc: (name) => versionOf(name, c.shape, { kind: "plain" }), declared: noDeclarations },
					{
						desc: (name) =>
							versionOf(name, shapeBefore(c), { kind: "family", naming: asFirst, reading: first }),
						declared: noDeclarations
					},
					{
						desc: (name) =>
							versionOf(name, c.shape, {
								kind: "family",
								naming: asFirst,
								reading: changedReading(c.change, first)
							}),
						declared: noDeclarations
					}
				],
				c.stored,
				() => [],
				(step, name) =>
					step === 0
						? Effect.succeed(unread)
						: Effect.all({
								tables: rowsReadOf(name, c.shape.kind),
								constraints: constraintsOf(name, member)
							})
			)
		)
		if (outcome._tag === "Failure") {
			return assert.fail(
				`a changed filler over lawful rows was refused: ${outcome.failure.message}\n${Formatter.format(r)}`
			)
		}
		const before = defined(outcome.success[1], "the family's tables before the re-draw")
		const after = defined(outcome.success[2], "the family's tables after the re-draw")
		if (r.foldsCopy) {
			for (const [name, now] of after.constraints) {
				const was = before.constraints.get(name)
				if (was !== undefined && was.definition === now.definition) {
					assert.equal(
						now.oid,
						was.oid,
						`the re-draw keeps ${name}, which the target holds as it is, unbuilt\n${Formatter.format(r)}`
					)
				}
			}
		}
		for (const [i, now] of after.tables.entries()) {
			const was = defined(before.tables[i], "a table both versions hold")
			if (was.relfilenode !== now.relfilenode) {
				continue
			}
			const written = writtenRows(was, now)
			const changed = changedRows(was, now)
			if (now.rows.length > 0) {
				k.note(
					written.size === 0
						? "a table the re-draw writes no row of"
						: "a table the re-draw writes some rows of"
				)
			}
			assert.deepEqual(
				Arr.sort([...written], Order.String),
				Arr.sort([...changed], Order.String),
				`the re-draw of ${now.table} writes exactly the rows whose values it changes\n${Formatter.format(r)}`
			)
		}
	})
