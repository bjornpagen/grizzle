/** What the properties of projection.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import {
	type Aimed,
	aimed,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	subset
} from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr } from "effect"
import { type Installation, installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { natural, pg } from "#compiler/public/fields.ts"
import {
	contained,
	key,
	mirrors,
	mutable,
	on,
	pred,
	relation,
	type RowScalars,
	schema,
	select,
	type Selection,
	type Statement,
	unit
} from "#compiler/public/schema.ts"
import type {
	BinaryOperator,
	ColumnDef,
	Expr,
	ForeignKey,
	IndexKey,
	SqlStatement,
	TableConstraint,
	TypeRef
} from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"
import { Id } from "#test/support/ids.ts"
import { installationNamesOf, type Names } from "#test/support/kernel/naming.ts"
import { owning } from "#test/support/policy.ts"

const Owner = relation("Owner", { id: Id, rank: pg.integer, live: pg.boolean, slots: natural }, [
	"id"
])

const Item = relation(
	"Item",
	{ id: Id, owner: Id, code: pg.integer, live: pg.boolean, at: natural },
	["id"]
)

const Note = relation("Note", { id: Id, owner: Id }, ["id"])

/** Two relations of their keys alone, which no write replaces at a referenced key: only a cycle defers a key into them. */
const Profile = relation("Profile", { owner: Id }, ["owner"])

const Seat = relation("Seat", { owner: Id }, ["owner"])

const ops = ["gt", "ge", "lt", "le"] as const

/** A comparison of a field with a constant. */
interface Comparison {
	readonly op: (typeof ops)[number]
	readonly value: number
}

const comparisonGen: Gen<Comparison> = (source) => ({
	op: source.draw(element(ops)),
	value: source.draw(int(-2, 2))
})

/** An Item side's facts: every one, or those a selection holds of, live fixed, code compared, or both. */
type ItemSelection =
	| Readonly<{ kind: "every" }>
	| Readonly<{ kind: "a boolean field"; live: boolean }>
	| Readonly<{ kind: "a comparison"; code: Comparison }>
	| Readonly<{ kind: "a conjunction"; live: boolean; code: Comparison }>

type ItemPhi = Exclude<ItemSelection, Readonly<{ kind: "every" }>>

const itemSelectionGen: Gen<ItemSelection> = oneOf<ItemSelection>([
	constant<ItemSelection>({ kind: "every" }),
	map(boolean, (live): ItemSelection => ({ kind: "a boolean field", live })),
	map(comparisonGen, (code): ItemSelection => ({ kind: "a comparison", code })),
	(source): ItemSelection => ({
		kind: "a conjunction",
		live: source.draw(boolean),
		code: source.draw(comparisonGen)
	})
])

/** An Owner selection that fixes no field: rank compared, or a range of rank `width` wide above `low`. */
type OwnerPhi =
	| Readonly<{ kind: "a comparison"; rank: Comparison }>
	| Readonly<{ kind: "a range"; low: number; width: number }>

/** A second containment into Owner's id, from Note's owner, of a constant selection too, or none. */
type Second = Readonly<{ kind: "none" }> | Readonly<{ kind: "from Note"; live: boolean }>

/** A containment's target facts: every Owner, those a selection fixing no field holds of, or those of one live. */
type Target =
	| Readonly<{ kind: "every" }>
	| Readonly<{ kind: "selected"; phi: OwnerPhi }>
	| Readonly<{ kind: "constant"; live: boolean; second: Second }>

const targetGen: Gen<Target> = oneOf<Target>([
	constant<Target>({ kind: "every" }),
	oneOf<Target>([
		map(comparisonGen, (rank): Target => ({
			kind: "selected",
			phi: { kind: "a comparison", rank }
		})),
		(source): Target => ({
			kind: "selected",
			phi: { kind: "a range", low: source.draw(int(-2, 2)), width: source.draw(int(2, 4)) }
		})
	]),
	(source): Target => ({
		kind: "constant",
		live: source.draw(boolean),
		second: source.draw(
			oneOf<Second>([
				constant<Second>({ kind: "none" }),
				map(boolean, (live): Second => ({ kind: "from Note", live }))
			])
		)
	})
])

/** The relations the references draw among, each with whether it holds a field beside the key every reference into it
 * names: a write can replace such a fact at its key. */
const besideKey = { Note: true, Profile: false, Seat: false } as const

type Referenced = keyof typeof besideKey

/** Every reference between the three relations, from a field of one into another's key. */
const edges = [
	"Note → Seat",
	"Note → Profile",
	"Profile → Seat",
	"Seat → Profile",
	"Profile → Note",
	"Seat → Note"
] as const

type Edge = (typeof edges)[number]

/** A reference's relations, the field it reads and the key field it names, and its statement. */
interface EdgeSpec {
	readonly from: Referenced
	readonly field: string
	readonly to: Referenced
	readonly key: string
	readonly statement: Statement
}

const edgeOf = (e: Edge): EdgeSpec => {
	switch (e) {
		case "Note → Seat":
			return {
				from: "Note",
				field: "owner",
				to: "Seat",
				key: "owner",
				statement: contained(on(Note, "owner"), on(Seat, "owner"))
			}
		case "Note → Profile":
			return {
				from: "Note",
				field: "owner",
				to: "Profile",
				key: "owner",
				statement: contained(on(Note, "owner"), on(Profile, "owner"))
			}
		case "Profile → Seat":
			return {
				from: "Profile",
				field: "owner",
				to: "Seat",
				key: "owner",
				statement: contained(on(Profile, "owner"), on(Seat, "owner"))
			}
		case "Seat → Profile":
			return {
				from: "Seat",
				field: "owner",
				to: "Profile",
				key: "owner",
				statement: contained(on(Seat, "owner"), on(Profile, "owner"))
			}
		case "Profile → Note":
			return {
				from: "Profile",
				field: "owner",
				to: "Note",
				key: "id",
				statement: contained(on(Profile, "owner"), on(Note, "id"))
			}
		case "Seat → Note":
			return {
				from: "Seat",
				field: "owner",
				to: "Note",
				key: "id",
				statement: contained(on(Seat, "owner"), on(Note, "id"))
			}
	}
}

/** The side mirrors pairs with Profile's owner: Owner's id, or an Item side's id. */
type MirrorLeft = Readonly<{ kind: "Owner" }> | Readonly<{ kind: "Item"; selection: ItemSelection }>

/** One law of the box. */
type Law =
	| Readonly<{ kind: "key"; selection: ItemSelection; second: "code" | "pred" }>
	| Readonly<{ kind: "containment"; selection: ItemSelection; superkey: boolean; target: Target }>
	| Readonly<{ kind: "references"; edges: ReadonlyArray<Edge> }>
	| Readonly<{ kind: "mirrors"; left: MirrorLeft }>

const lawGen: Gen<Law> = oneOf<Law>([
	(source): Law => ({
		kind: "key",
		selection: source.draw(itemSelectionGen),
		second: source.draw(element(["code", "pred"] as const))
	}),
	(source): Law => ({
		kind: "containment",
		selection: source.draw(itemSelectionGen),
		superkey: source.draw(boolean),
		target: source.draw(targetGen)
	}),
	map(subset(edges, { min: 1, max: edges.length }), (drawnEdges): Law => ({
		kind: "references",
		edges: drawnEdges
	})),
	(source): Law => ({
		kind: "mirrors",
		left: source.draw(
			oneOf<MirrorLeft>([
				constant<MirrorLeft>({ kind: "Owner" }),
				map(itemSelectionGen, (selection): MirrorLeft => ({ kind: "Item", selection }))
			])
		)
	})
])

/**
 * A containment into one constant selection of Owner beside Note's into it, both at one liveness and neither by a
 * superkey: the two share the constant selection's own column.
 */
const sharedContainmentGen: Gen<Law> = (source) => {
	const live = source.draw(boolean)
	return {
		kind: "containment",
		selection: source.draw(itemSelectionGen),
		superkey: false,
		target: { kind: "constant", live, second: { kind: "from Note", live } }
	}
}

/** The drawn laws, aimed at two containments into one constant selection. */
export const lawSpace: Aimed<Law, Feature> = aimed(lawGen, [
	["two containments into one constant selection, at its own column", sharedContainmentGen]
])

type ItemRow = RowScalars<typeof Item>

type OwnerRow = RowScalars<typeof Owner>

const codeCompared = (i: ItemRow, c: Comparison) => {
	switch (c.op) {
		case "gt":
			return i.gt(i.code, c.value)
		case "ge":
			return i.ge(i.code, c.value)
		case "lt":
			return i.lt(i.code, c.value)
		case "le":
			return i.le(i.code, c.value)
	}
}

const rankCompared = (o: OwnerRow, c: Comparison) => {
	switch (c.op) {
		case "gt":
			return o.gt(o.rank, c.value)
		case "ge":
			return o.ge(o.rank, c.value)
		case "lt":
			return o.lt(o.rank, c.value)
		case "le":
			return o.le(o.rank, c.value)
	}
}

const itemsWhere = (phi: ItemPhi): Selection<typeof Item> => {
	switch (phi.kind) {
		case "a boolean field": {
			const { live } = phi
			return select(Item, (i) => i.eq(i.live, live))
		}
		case "a comparison": {
			const { code } = phi
			return select(Item, (i) => codeCompared(i, code))
		}
		case "a conjunction": {
			const { live, code } = phi
			return select(Item, (i) => i.and([i.eq(i.live, live), codeCompared(i, code)]))
		}
	}
}

const ownersWhere = (phi: OwnerPhi): Selection<typeof Owner> => {
	switch (phi.kind) {
		case "a comparison": {
			const { rank } = phi
			return select(Owner, (o) => rankCompared(o, rank))
		}
		case "a range": {
			const { low, width } = phi
			return select(Owner, (o) => o.and([o.gt(o.rank, low), o.lt(o.rank, low + width)]))
		}
	}
}

/** Owner's facts of one live. */
const ownersLive = (live: boolean): Selection<typeof Owner> =>
	select(Owner, (o) => o.eq(o.live, live))

/** An Item side's source: the relation, or its selection. */
const itemSource = (s: ItemSelection): typeof Item | Selection<typeof Item> =>
	s.kind === "every" ? Item : itemsWhere(s)

/** A containment target's source: the relation, its selection, or its facts of one live. */
const ownerSource = (t: Target): typeof Owner | Selection<typeof Owner> => {
	switch (t.kind) {
		case "every":
			return Owner
		case "selected":
			return ownersWhere(t.phi)
		case "constant":
			return ownersLive(t.live)
	}
}

/** The containment from Note a constant target states beside the law's, or none. */
const secondOf = (t: Target): ReadonlyArray<Statement> =>
	t.kind === "constant" && t.second.kind === "from Note"
		? [contained(on(Note, "owner"), on(ownersLive(t.second.live), "id"))]
		: []

/** The statements a law states beside the five relations. */
export const statementsOf = (law: Law): ReadonlyArray<Statement> => {
	switch (law.kind) {
		case "key":
			return [
				law.second === "code"
					? key(on(itemSource(law.selection), "owner", "code"))
					: key(on(itemSource(law.selection), "owner", pred("at")))
			]
		case "containment":
			return [
				law.superkey
					? contained(
							on(itemSource(law.selection), "owner", "code"),
							on(ownerSource(law.target), "id", "rank")
						)
					: contained(on(itemSource(law.selection), "owner"), on(ownerSource(law.target), "id")),
				...secondOf(law.target)
			]
		case "references":
			return Arr.map(law.edges, (e) => edgeOf(e).statement)
		case "mirrors":
			return law.left.kind === "Owner"
				? [mirrors(on(Owner, "id"), on(Profile, "owner"))]
				: [mirrors(on(itemSource(law.left.selection), "id"), on(Profile, "owner"))]
	}
}

/** mirrors' two containments, written out. */
export const containmentsOf = (left: MirrorLeft): ReadonlyArray<Statement> =>
	left.kind === "Owner"
		? [
				contained(on(Owner, "id"), on(Profile, "owner")),
				contained(on(Profile, "owner"), on(Owner, "id"))
			]
		: [
				contained(on(itemSource(left.selection), "id"), on(Profile, "owner")),
				contained(on(Profile, "owner"), on(itemSource(left.selection), "id"))
			]

/**
 * The installation of a law's statements over the box's five relations, every one mutable, inside the unit of its own
 * id (Owner, Item, Note) or of its owner (Profile, Seat): a containment that joins within one unit, its relations
 * immutable or all in one declared unit, is judged whole and installs no foreign key (laws/model/plan.ts
 * containmentDischarge), and this box's join the rows of two units, so it reads the native lowering.
 */
export const installed = (statements: ReadonlyArray<Statement>): Installation => {
	const relations = [Owner, Item, Note, Profile, Seat] as const
	const owned = owning(
		schema("Projections", relations, [
			...statements,
			unit("Row", { id: Id }),
			unit("Owned", { owner: Id }),
			...Arr.map(relations, (r) => mutable(r))
		])
	)
	const result = compileInstallation(owned, installOptions(owned))
	if (!result.ok) {
		throw result.error
	}
	return result.value
}

/** A table as its DDL builds it: its columns, the column sets of its keys, its foreign keys and its indexes' keys. */
interface Table {
	readonly columns: ReadonlyArray<ColumnDef>
	readonly keys: ReadonlyArray<ReadonlyArray<string>>
	readonly foreignKeys: ReadonlyArray<ForeignKey>
	readonly indexes: ReadonlyArray<ReadonlyArray<IndexKey["key"]>>
}

const emptyTable: Table = { columns: [], keys: [], foreignKeys: [], indexes: [] }

/** Every table of the installation, by its bare identifier, gathered from its CREATE TABLE, ALTER TABLEs and indexes. */
const tablesOf = (statements: ReadonlyArray<SqlStatement>): ReadonlyMap<string, Table> => {
	const tables = new Map<string, Table>()
	const edit = (name: string, f: (t: Table) => Table) => {
		tables.set(name, f(tables.get(name) ?? emptyTable))
	}
	const constrain = (name: string, c: TableConstraint) => {
		switch (c.kind) {
			case "primaryKey":
			case "unique":
				return edit(name, (t) => ({
					...t,
					keys: [...t.keys, Arr.map(c.columns, (k) => k.column)]
				}))
			case "foreignKey":
				return edit(name, (t) => ({ ...t, foreignKeys: [...t.foreignKeys, c] }))
			case "check":
			case "exclude":
				return
		}
	}
	for (const s of statements) {
		if (s.kind === "createTable") {
			edit(s.table.name, (t) => ({ ...t, columns: [...t.columns, ...s.columns] }))
			constrain(s.table.name, s.primaryKey)
			for (const c of s.secondary) {
				constrain(s.table.name, c)
			}
		} else if (s.kind === "alterTable") {
			for (const a of s.actions) {
				if (a.kind === "addColumn") {
					edit(s.table.name, (t) => ({ ...t, columns: [...t.columns, a.column] }))
				} else if (a.kind === "addConstraint") {
					constrain(s.table.name, a.constraint)
				}
			}
		} else if (s.kind === "createIndex") {
			edit(s.table.name, (t) => ({
				...t,
				indexes: [...t.indexes, Arr.map(s.keys, (k) => k.key)]
			}))
		}
	}
	return tables
}

/** The columns and binary operators an expression reads. */
const readsOf = (
	e: Expr
): { readonly columns: ReadonlySet<string>; readonly operators: ReadonlySet<BinaryOperator> } => {
	const columns = new Set<string>()
	const operators = new Set<BinaryOperator>()
	transformExpr(e, {
		...identityHooks,
		expr: (x) => {
			if (x.kind === "column") {
				columns.add(x.column)
			} else if (x.kind === "binary") {
				operators.add(x.op)
			}
			return x
		}
	})
	return { columns, operators }
}

const sameSet = (a: Iterable<string>, b: Iterable<string>): boolean => {
	const [x, y] = [new Set(a), new Set(b)]
	return x.size === y.size && Arr.every([...x], (v) => y.has(v))
}

type ColumnKey = Extract<IndexKey["key"], { readonly kind: "column" }>

const isColumnKey = (k: IndexKey["key"]): k is ColumnKey => k.kind === "column"

/** One rule's installation, read through the naming door. */
export class Reading {
	readonly #tables: ReadonlyMap<string, Table>
	readonly #names: Names

	constructor(installation: Installation) {
		this.#tables = tablesOf(installation.statements)
		this.#names = installationNamesOf(installation)
	}

	table(relation: string): Table {
		return defined(
			this.#tables.get(this.#names.tableIdent({ name: relation })),
			`${relation}'s table`
		)
	}

	column(relation: string, field: string): string {
		return this.#names.columnIdent({ name: relation }, field)
	}

	/** Every foreign key of the installation, of every table. */
	foreignKeys(): ReadonlyArray<ForeignKey> {
		return Arr.flatMap([...this.#tables.values()], (t) => t.foreignKeys)
	}

	/** The columns a law adds to `relation`: every generated column. */
	lawColumns(relation: string): ReadonlyArray<ColumnDef> {
		return Arr.filter(this.table(relation).columns, (c) => c.generated !== undefined)
	}

	/**
	 * The one law column of `relation` holding `CASE WHEN <when> THEN <term> END`, its WHEN reading exactly `when` and
	 * its THEN exactly the term's field: x - 1 under x > 0 for pred, the field itself for a field term.
	 */
	partial(
		relation: string,
		term: { readonly kind: "field" | "pred"; readonly field: string },
		when: ReadonlyArray<string>,
		type: TypeRef
	): string {
		const field = this.column(relation, term.field)
		const whenColumns = Arr.map(term.kind === "pred" ? [...when, term.field] : when, (f) =>
			this.column(relation, f)
		)
		const found = Arr.filter(this.lawColumns(relation), (c) => {
			if (c.generated?.kind !== "partial") {
				return false
			}
			const [w, t] = [readsOf(c.generated.when), readsOf(c.generated.expr)]
			return (
				sameSet(t.columns, [field]) &&
				sameSet(w.columns, whenColumns) &&
				(term.kind === "field" || (t.operators.has("-") && w.operators.has(">")))
			)
		})
		const [only, ...more] = found
		if (only === undefined || more.length > 0) {
			return assert.fail(
				`${relation} has ${found.length} law columns of ${term.kind}(${term.field}) where ${Arr.join(when, ", ")}`
			)
		}
		assert.deepEqual(only.type, type, `${only.name} is typed by its field's base`)
		return only.name
	}

	/** The constant law columns of `relation`: each a STORED expression of no field, NOT NULL by its generation. */
	constants(relation: string): ReadonlyArray<ColumnDef> {
		return Arr.filter(
			this.lawColumns(relation),
			(c) => c.generated?.kind === "stored" && readsOf(c.generated.expr).columns.size === 0
		)
	}

	/** The one constant law column of `relation`, typed by its field's base. */
	constant(relation: string, type: TypeRef): string {
		const found = this.constants(relation)
		assert.equal(found.length, 1, `${relation}'s one constant law column`)
		const only = defined(found[0])
		assert.deepEqual(only.type, type, `${only.name} is typed by its field's base`)
		return only.name
	}

	/** `relation` has exactly `count` keys over the column set `columns`. */
	keys(relation: string, columns: ReadonlyArray<string>, count: number): void {
		assert.equal(
			Arr.filter(this.table(relation).keys, (k) => sameSet(k, columns)).length,
			count,
			`${relation}'s keys over (${Arr.join(columns, ", ")})`
		)
	}

	/**
	 * The one foreign key of `from` over `columns` exactly, in order, into `to`'s `referenced`: `to` has a key over
	 * exactly those columns, and an index of `from` leads with `columns`, but for a constant law column among them,
	 * which holds one value in every row of `from` and so narrows no probe.
	 */
	reference(
		from: string,
		columns: ReadonlyArray<string>,
		to: string,
		referenced: ReadonlyArray<string>
	): ForeignKey {
		const target = this.table(to)
		const into = this.#names.tableIdent({ name: to })
		const found = Arr.filter(
			this.table(from).foreignKeys,
			(fk) =>
				fk.references.name === into &&
				fk.columns.length === columns.length &&
				Arr.every(fk.columns, (c, k) => c.column === columns[k])
		)
		assert.equal(
			found.length,
			1,
			`${from}(${Arr.join(columns, ", ")}) has one foreign key into ${to}`
		)
		const fk = defined(found[0])
		assert.deepEqual<ReadonlyArray<string>>(
			Arr.map(fk.referencedColumns, (c) => c.column),
			referenced,
			"the referenced columns, in term order"
		)
		assert.ok(
			Arr.some(target.keys, (k) => sameSet(k, referenced)),
			`${to} has a key over exactly (${Arr.join(referenced, ", ")})`
		)
		const constant = new Set(Arr.map(this.constants(from), (c) => c.name))
		const probed = Arr.filter(columns, (c) => !constant.has(c))
		const leads = (columnsOf: ReadonlyArray<string>) =>
			sameSet(columnsOf.slice(0, probed.length), probed)
		/** An index's leading column keys: an expression key ends what it leads with. */
		const leading = (index: ReadonlyArray<IndexKey["key"]>): ReadonlyArray<string> =>
			Arr.map(Arr.takeWhile(index, isColumnKey), (k) => k.column)
		const source = this.table(from)
		assert.ok(
			Arr.some(source.indexes, (index) => leads(leading(index))) || Arr.some(source.keys, leads),
			`an index of ${from} leads with (${Arr.join(probed, ", ")})`
		)
		return fk
	}
}

export type Feature =
	| "a key over fields"
	| "a key over a selected side"
	| "a key over a pred term"
	| "a key over a selected pred term"
	| "a containment"
	| "a containment into a superkey"
	| "a containment from a selected side"
	| "a containment into a selected side"
	| "a containment into a constant selection"
	| "two constant selections of one target"
	| "two containments into one constant selection, at its own column"
	| "a reference on a cycle"
	| "a reference into a replaceable target"
	| "a reference off every cycle into a key no write replaces"
	| "mirrors over whole relations"
	| "mirrors over a selected side"
	| `selection: ${ItemPhi["kind"]}`
	| `target selection: ${OwnerPhi["kind"]}`

/** The fields an Item selection reads. */
const itemFields = (phi: ItemPhi): ReadonlyArray<string> => {
	switch (phi.kind) {
		case "a boolean field":
			return ["live"]
		case "a comparison":
			return ["code"]
		case "a conjunction":
			return ["live", "code"]
	}
}

/** A term's field and the base type its law column holds. */
type Term = readonly [field: string, type: TypeRef]

/**
 * An Item side's column of a field term: its own column over every fact, and over a selection the partial law column of
 * the side's guarded term, the one over its earliest field (laws/model/plan.ts sideColumns), and every other term's own
 * column. Owner, the earliest field of every Item side here, is the guarded term.
 */
const itemColumn = (
	at: Reading,
	selection: ItemSelection,
	[field, type]: Term,
	guarded: boolean
): string =>
	selection.kind === "every" || !guarded
		? at.column("Item", field)
		: at.partial("Item", { kind: "field", field }, itemFields(selection), type)

/** A key over Item's owner and its code or pred(at): a law column for a selected side's owner and for pred(at), under
 * one UNIQUE. */
export const checkKey = (
	law: Extract<Law, { readonly kind: "key" }>,
	at: Reading,
	c: Case<Feature>
): void => {
	const { selection } = law
	const owners = itemColumn(at, selection, ["owner", types.uuid], true)
	const second =
		law.second === "code"
			? itemColumn(at, selection, ["code", types.integer], false)
			: at.partial("Item", { kind: "pred", field: "at" }, [], types.bigint)
	assert.equal(
		at.lawColumns("Item").length,
		(selection.kind === "every" ? 0 : 1) + (law.second === "code" ? 0 : 1),
		"a law column for a selected side's guarded term and for a pred term, and no other"
	)
	at.keys("Item", [owners, second], 1)
	if (selection.kind !== "every") {
		c.note(`selection: ${selection.kind}`)
	}
	c.note(
		law.second === "code"
			? selection.kind === "every"
				? "a key over fields"
				: "a key over a selected side"
			: selection.kind === "every"
				? "a key over a pred term"
				: "a key over a selected pred term"
	)
}

/**
 * A containment of Item's owner, and its code, into Owner's id, and its rank: a law column for a selected side's owner
 * or id, its guarded term, every other term its field, a constant column on the source for a target of one live,
 * carried into Owner's superkey over the referenced columns and live, and a deferred reference, since Owner holds slots
 * beside every key a reference names. A target of one live that Note's owner meets too, at that live and at Owner's id
 * alone, is referenced by both at their own columns under that live, which share one law column of Owner, its id's:
 * that column costs the schema less than the superkey's constant on each source, whose UNIQUE the own columns' costs
 * too, one UNIQUE over Owner's id under that live where the containment reads it alone and a second beside it where it
 * reads its rank too.
 */
export const checkContainment = (
	law: Extract<Law, { readonly kind: "containment" }>,
	at: Reading,
	c: Case<Feature>
): void => {
	const { selection, target } = law
	const sourceTerms: ReadonlyArray<Term> = law.superkey
		? [
				["owner", types.uuid],
				["code", types.integer]
			]
		: [["owner", types.uuid]]
	const targetTerms: ReadonlyArray<Term> = law.superkey
		? [
				["id", types.uuid],
				["rank", types.integer]
			]
		: [["id", types.uuid]]
	const sources = Arr.map(sourceTerms, (term, i) => itemColumn(at, selection, term, i === 0))
	const shared =
		target.kind === "constant" &&
		target.second.kind === "from Note" &&
		target.second.live === target.live
	const targets = Arr.map(targetTerms, ([field, type], i) =>
		i > 0
			? at.column("Owner", field)
			: target.kind === "selected"
				? at.partial("Owner", { kind: "field", field }, ["rank"], type)
				: shared
					? at.partial("Owner", { kind: "field", field }, ["live"], type)
					: at.column("Owner", field)
	)
	const constants =
		target.kind === "constant" && !shared ? [at.constant("Item", types.boolean)] : []
	const referenced =
		target.kind === "constant" && !shared ? [...targets, at.column("Owner", "live")] : targets
	assert.equal(
		at.lawColumns("Item").length,
		(selection.kind === "every" ? 0 : 1) + constants.length,
		"the source's law columns: one for a selected side's guarded term, and the constant"
	)
	assert.equal(
		at.lawColumns("Owner").length,
		target.kind === "selected" || shared ? 1 : 0,
		"the target's law columns: one for the guarded term of a selection fixing no field, or of one live two containments meet"
	)
	at.keys("Owner", referenced, 1)
	const fk = at.reference("Item", [...sources, ...constants], "Owner", referenced)
	assert.equal(
		fk.deferrable,
		"INITIALLY DEFERRED",
		"Owner's slots let a write replace it at its key"
	)
	const sourceFacets: ReadonlyArray<Feature> = [
		...(law.superkey ? ["a containment into a superkey" as const] : []),
		...(selection.kind === "every" ? [] : ["a containment from a selected side" as const])
	]
	const targetFacet: ReadonlyArray<Feature> =
		target.kind === "every"
			? []
			: [
					target.kind === "selected"
						? "a containment into a selected side"
						: "a containment into a constant selection"
				]
	c.note("a containment")
	c.noteAll([...sourceFacets, ...targetFacet])
	for (const first of sourceFacets) {
		for (const second of targetFacet) {
			c.pair(first, second)
		}
	}
	if (selection.kind !== "every") {
		c.note(`selection: ${selection.kind}`)
	}
	if (target.kind === "selected") {
		c.note(`target selection: ${target.phi.kind}`)
	}
	if (target.kind === "constant" && target.second.kind === "from Note") {
		if (shared) {
			at.reference("Note", [at.column("Note", "owner")], "Owner", [
				defined(targets[0], "the target's guarded column")
			])
			c.note("two containments into one constant selection, at its own column")
		} else {
			const superkey = [at.column("Owner", "id"), at.column("Owner", "live")]
			at.keys("Owner", superkey, 1)
			at.reference(
				"Note",
				[at.column("Note", "owner"), at.constant("Note", types.boolean)],
				"Owner",
				superkey
			)
		}
		c.note("two constant selections of one target")
	}
}

/** Whether the references lead from `from` to `to`, through relations not yet `seen`. */
const reaches = (
	specs: ReadonlyArray<EdgeSpec>,
	from: Referenced,
	to: Referenced,
	seen: ReadonlySet<Referenced>
): boolean =>
	from === to ||
	Arr.some(
		specs,
		(e) => e.from === from && !seen.has(e.to) && reaches(specs, e.to, to, new Set([...seen, e.to]))
	)

/** Every reference is one foreign key into its target's key, deferred exactly on a cycle or into a replaceable target. */
export const checkReferences = (
	law: Extract<Law, { readonly kind: "references" }>,
	at: Reading,
	c: Case<Feature>
): void => {
	const specs = Arr.map(law.edges, edgeOf)
	for (const e of specs) {
		const fk = at.reference(e.from, [at.column(e.from, e.field)], e.to, [at.column(e.to, e.key)])
		const cycle = reaches(specs, e.to, e.from, new Set([e.to]))
		const replaceable = besideKey[e.to]
		c.note(
			cycle
				? "a reference on a cycle"
				: replaceable
					? "a reference into a replaceable target"
					: "a reference off every cycle into a key no write replaces"
		)
		assert.equal(
			fk.deferrable,
			cycle || replaceable ? "INITIALLY DEFERRED" : undefined,
			`${e.from} → ${e.to}: deferred exactly on a cycle or into a replaceable target`
		)
	}
	assert.equal(at.foreignKeys().length, specs.length, "one foreign key per reference, and no other")
}

export const situations: Arr.NonEmptyReadonlyArray<Feature | readonly [Feature, Feature]> = [
	"a key over fields",
	"a key over a selected side",
	"a key over a pred term",
	"a key over a selected pred term",
	"a containment",
	"a containment into a superkey",
	"a containment from a selected side",
	"a containment into a selected side",
	"a containment into a constant selection",
	"two constant selections of one target",
	"two containments into one constant selection, at its own column",
	"a reference on a cycle",
	"a reference into a replaceable target",
	"a reference off every cycle into a key no write replaces",
	"mirrors over whole relations",
	"mirrors over a selected side",
	"selection: a boolean field",
	"selection: a comparison",
	"selection: a conjunction",
	"target selection: a comparison",
	"target selection: a range",
	["a containment into a superkey", "a containment into a selected side"],
	["a containment into a superkey", "a containment into a constant selection"],
	["a containment from a selected side", "a containment into a selected side"],
	["a containment from a selected side", "a containment into a constant selection"]
]
