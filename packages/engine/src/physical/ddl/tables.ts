import { refuse } from "#compiler/analysis/theory/build.ts"
import { appendAll } from "#compiler/core/array.ts"
import { type Identity, identifierOf } from "#compiler/core/identity.ts"
import type { ConstraintName, IdentityKind, LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	appendNonEmpty,
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import {
	type FieldValue,
	fieldNames,
	type LawField,
	type NativeObject,
	type NativeOf,
	type Selector,
	type SpanField
} from "#compiler/ir/law.ts"
import { allRows, type IndexRows } from "#compiler/ir/products.ts"
import { type ScalarType, spanOf } from "#compiler/ir/scalar.ts"
import type { NamedPrimaryKey } from "#compiler/laws/model/model.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { lowerPersistent, persistentLiteral } from "#compiler/physical/ddl/expr.ts"
import { addIsolationTrigger } from "#compiler/physical/ddl/isolation.ts"
import { columnType } from "#compiler/physical/ddl/names.ts"
import {
	enforcement,
	lawReasons,
	type Node,
	type NodeIdent
} from "#compiler/physical/obligations/graph.ts"
import { addVectorNorms, isVectorType, vectorNorms } from "#compiler/physical/vector/storage.ts"
import type {
	ColumnDef,
	CreateIndex,
	Expr,
	ObjectName,
	ForeignKey,
	ForeignKeyColumn,
	InlineConstraint,
	KeyColumn,
	PrimaryKey,
	TableConstraint
} from "#compiler/sql/ast.ts"
import { and, columnKey, eq, or, tableCol } from "#compiler/sql/build.ts"

type Native<K extends NativeObject["kind"]> = Extract<NativeObject, { readonly kind: K }>

/** A stored relation's table before it is added: its columns, one per field of its theory relation in declared order,
 * its primary key, and the objects it is created after: the schema, each enum and domain a column is typed by, and the
 * vector extension when a field is a vector. */
interface PlannedTable {
	readonly relation: string
	readonly named: Identity<"table" | "enum" | "view">
	readonly columns: NonEmptyReadonlyArray<ColumnDef>
	readonly primaryKey: PrimaryKey
	readonly after: ReadonlyArray<Node<"setup">>
}

/** A relation's primary key as its CREATE TABLE declares it: PRIMARY KEY over its fields, or over its scalar fields
 * and its span WITHOUT OVERLAPS, under the name ownership minted. */
const primaryKeyOf = (b: InstallBuilder, pk: NamedPrimaryKey): PrimaryKey => {
	const o = pk.object
	const relation = o.relation.name
	return {
		kind: "primaryKey",
		name: identifierOf(pk.named),
		columns:
			o.kind === "PrimaryKey"
				? keyColumns(b, relation, keyNames(o.columns))
				: periodKeyColumns(b, relation, fieldNames(o.key.scalars), o.span.name)
	}
}

/** Every ordinary relation's table, in name order, with the primary key the law model holds for it. */
const plannedTables = (b: InstallBuilder): ReadonlyArray<PlannedTable> =>
	[...b.model.relations.values()]
		.toSorted((x, y) => compareStrings(x.relation.name, y.relation.name))
		.map(({ relation: r, primaryKey }): PlannedTable => {
			const name = r.name
			const after: Array<Node<"setup">> = [b.schemaNode]
			const columns = mapNonEmpty(r.fields, (c): ColumnDef => {
				const { type, collation } = columnType(b.names, c.type)
				appendAll(after, typeNodes(b, c.type))
				return {
					name: b.names.column(name, c.name),
					type,
					collation,
					generated:
						"serial" in c.type
							? { kind: "identity", sequence: b.names.sequence(name, c.name) }
							: undefined
				}
			})
			if (r.fields.some((c) => isVectorType(c.type))) {
				after.push(b.provider("vector"))
			}
			return {
				relation: name,
				named: b.names.relationNamed(name),
				columns,
				primaryKey: primaryKeyOf(b, primaryKey),
				after
			}
		})

/** The enum or domain of the installed schema a column of type `t` is typed by, which the column's object is created
 * after; none for any other type. */
const typeNodes = (b: InstallBuilder, t: ScalarType): ReadonlyArray<Node<"setup">> => {
	const node = b.typeNode(columnType(b.names, t).type)
	return node === undefined ? [] : [node]
}

/** The names of a key's fields, at least one, as a key has. */
const keyNames = (
	fields: NonEmptyReadonlyArray<{ readonly name: string }>
): NonEmptyReadonlyArray<string> => mapNonEmpty(fields, (f) => f.name)

/** A scalar key's columns. */
const keyColumns = (
	b: InstallBuilder,
	relation: string,
	columns: NonEmptyReadonlyArray<string>
): NonEmptyReadonlyArray<KeyColumn> =>
	mapNonEmpty(columns, (f) => ({ column: b.names.column(relation, f), withoutOverlaps: false }))

/** A span key's columns: its scalar fields, then its span field WITHOUT OVERLAPS. */
const periodKeyColumns = (
	b: InstallBuilder,
	relation: string,
	scalars: ReadonlyArray<string>,
	span: string
): NonEmptyReadonlyArray<KeyColumn> =>
	appendNonEmpty(
		scalars.map((f): KeyColumn => ({
			column: b.names.column(relation, f),
			withoutOverlaps: false
		})),
		{ column: b.names.column(relation, span), withoutOverlaps: true }
	)

const fkColumns = (
	b: InstallBuilder,
	relation: string,
	columns: NonEmptyReadonlyArray<string>,
	/** The columns after the fields: a selector's tag. */
	extra: ReadonlyArray<ForeignKeyColumn>
): NonEmptyReadonlyArray<ForeignKeyColumn> =>
	extendNonEmpty(
		mapNonEmpty(columns, (f): ForeignKeyColumn => ({
			column: b.names.column(relation, f),
			period: false
		})),
		extra
	)

/** A period foreign key's columns: its scalar fields, then the columns after them (a selector's tag), its span last. */
const periodFkColumns = (
	b: InstallBuilder,
	relation: string,
	fields: ReadonlyArray<LawField>,
	extra: ReadonlyArray<ForeignKeyColumn>,
	span: SpanField
): NonEmptyReadonlyArray<ForeignKeyColumn> =>
	appendNonEmpty(
		[
			...fields.map((f): ForeignKeyColumn => ({
				column: b.names.column(relation, f.name),
				period: false
			})),
			...extra
		],
		{ column: b.names.column(relation, span.name), period: true }
	)

/** A literal selector of the rows an index holds, its field typed: the field's name and type, and the literal. */
interface TypedSelector {
	readonly column: string
	readonly type: ScalarType
	readonly value: TypedLiteral
}

/** A literal selection as a partial index's WHERE: a persistent predicate over the row's own columns, base-typed, each
 * selector an equality in the selection's order. A capacity's partial unique index and a selected-source probe's
 * partial index spell one selection alike, so PostgreSQL finds the predicate of either implied by the probe of the
 * other's law. */
const selectionPredicate = (
	b: InstallBuilder,
	relation: string,
	selection: NonEmptyReadonlyArray<TypedSelector>
): Expr => {
	const terms = mapNonEmpty(selection, (w) =>
		eq(tableCol(b.names.column(relation, w.column)), persistentLiteral(b.names, w.value, w.type))
	)
	return terms.length === 1 ? terms[0] : and(terms)
}

/** The rows of a relation an index holds (`IndexRows`) as a partial index's WHERE (`selectionPredicate`), each
 * selector's field typed by `typeOf`; none for every row. */
export const rowsPredicate = (
	b: InstallBuilder,
	relation: string,
	rows: IndexRows,
	typeOf: (field: string) => ScalarType
): Expr | undefined =>
	rows.kind === "all"
		? undefined
		: selectionPredicate(
				b,
				relation,
				mapNonEmpty(rows.selection, (w) => ({
					column: w.column,
					type: typeOf(w.column),
					value: w.value
				}))
			)

/** The rows a partial unique index's selection chooses: every row for none. */
const rowsOfWhere = (where: ReadonlyArray<Selector>): IndexRows =>
	isNonEmpty(where) ? { kind: "selected", selection: where } : allRows

/** The predicate of a finite closed-facts containment: membership of the row's projection in the facts, `c IN (...)`
 * for one column and a disjunction of conjunctions for several, never independent per-column lists. */
const finitePredicate = (b: InstallBuilder, n: Native<"FiniteCheck">): Expr => {
	/** Each fact as its checked fields' values: the law model projects a fact onto exactly the checked fields. */
	const facts = n.facts
	if (!isNonEmpty(facts)) {
		return refuse(
			"MalformedDescription",
			SourceLoc(`finite check on ${n.relation.name}`, []),
			"at least one fact"
		)
	}
	const column = (field: LawField): Expr => tableCol(b.names.column(n.relation.name, field.name))
	const value = (v: FieldValue): Expr => persistentLiteral(b.names, v.value, v.field.type)
	const [[only, ...more]] = facts
	if (more.length === 0) {
		return {
			kind: "inList",
			expr: column(only.field),
			list: mapNonEmpty(facts, ([v]) => value(v)),
			not: false
		}
	}
	return or(mapNonEmpty(facts, (f) => and(mapNonEmpty(f, (v) => eq(column(v.field), value(v))))))
}

/** Each table's secondary constraints, which its CREATE TABLE declares inline beside its primary key, as a
 * hand-written table does: its candidate keys, generated uniques and CHECKs in the law model's order, by relation. */
type Inline = Map<string, Array<InlineConstraint>>

/** Declares `constraint` inline in `relation`'s table. */
const declareInline = (inline: Inline, relation: string, constraint: InlineConstraint): void => {
	const own = inline.get(relation)
	if (own === undefined) {
		inline.set(relation, [constraint])
		return
	}
	own.push(constraint)
}

/** A key or CHECK native before its table stands: the constraint its table's CREATE TABLE declares inline, whose own
 * object carries no statement, only its reasons and its place in the order; or a capacity's partial unique index, its
 * own object in Indexes. A key's index joins the key indexes once its object is added. A span key's exclusion
 * constraint is a unique key's object, and one with a scalar component needs btree_gist. */
type NativePlan =
	| {
			readonly kind: "inline"
			readonly relation: string
			readonly named: Identity<IdentityKind>
			/** The kind of its object: an exclusion constraint is a unique key's. */
			readonly object: "primaryKey" | "unique" | "check"
			readonly laws: ReadonlyArray<LawId>
			readonly key: KeyShape | undefined
			readonly gist: boolean
	  }
	| {
			readonly kind: "partialUnique"
			readonly relation: string
			readonly named: Identity<IdentityKind>
			readonly index: CreateIndex
			readonly laws: ReadonlyArray<LawId>
			readonly key: KeyShape
	  }
	| {
			readonly kind: "armUnique"
			readonly relation: string
			readonly named: Identity<IdentityKind>
			readonly constraint: Extract<TableConstraint, { readonly kind: "unique" }>
			readonly laws: ReadonlyArray<LawId>
			/** The key the arms' foreign keys reference, which serves no index request: its arm tag is no field. */
			readonly key: KeyShape
			/** The arm tag column it holds, which its table adds after its CREATE TABLE. */
			readonly tag: string
	  }

/** A key index before its object is added. */
type KeyShape = Omit<KeyIndex, "object">

/** A native reference object: its own ALTER TABLE ... ADD CONSTRAINT, after its table and the objects in `after`. */
const addReference = (
	b: InstallBuilder,
	relation: string,
	named: Identity<IdentityKind>,
	constraint: ForeignKey,
	laws: ReadonlyArray<LawId>,
	after: ReadonlyArray<Node<"structure">>
): void => {
	b.add(
		{
			kind: "foreignKey",
			ident: constraintIdent(b, relation, named),
			ddl: [
				{
					kind: "alterTable",
					table: b.names.relation(relation),
					actions: [{ kind: "addConstraint", constraint, notValid: false }]
				}
			],
			reasons: lawReasons(laws),
			phase: "structure"
		},
		[b.table(relation), ...after]
	)
}

/** The graph identity of the constraint or column `named` of `relation`'s table. */
const constraintIdent = (
	b: InstallBuilder,
	relation: string,
	named: Identity<IdentityKind>
): NodeIdent => ({
	kind: "constraint",
	schema: b.settings.installation,
	relation: b.names.relationNamed(relation),
	name: named
})

/** Where a native object lives: the identity of its table constraint or index, by the native's key. */
interface PlacedNatives {
	/** The constraint objects of keys that can serve index requests: name, relation, method, columns, uniqueness. */
	readonly keyIndexes: ReadonlyArray<KeyIndex>
	/** The tables, in relation name order. */
	readonly tables: ReadonlyArray<ObjectName>
	/** The identity sequences of the tables' serial columns, in table then column order. */
	readonly sequences: ReadonlyArray<ObjectName>
}

export interface KeyIndex {
	readonly object: Node<"structure" | "indexes">
	readonly name: ConstraintName
	readonly relation: string
	readonly method: "btree" | "gist"
	/** Field names, in index column order. */
	readonly columns: ReadonlyArray<string>
	/** The rows it holds: a partial index's, the ones its selection chooses. */
	readonly rows: IndexRows
	readonly unique: true
}

/** Every stored relation's table, then every native object of the law model on it: tags, keys, checks, references
 * and partial unique indexes.
 *
 * - A stored relation is `CREATE TABLE <schema>.<table> (...)` with its fields in declared order, every column NOT
 *   NULL. A wildcard text column names pg_catalog.pg_c_utf8; a refined column is typed by its domain,
 *   which carries that collation. A serial field is `GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME
 *   <schema>.<table>_<col>_seq)`, its sequence owned by the column.
 * - A selected target's constant tag, added before every reference because a reference names it, is a private STORED generated column, `__<selector>` of the selector's type, its
 *   value the selected literal: `GENERATED ALWAYS AS ('Automatic'::work.kind) STORED NOT NULL`, the keyword STORED
 *   always emitted, since PostgreSQL defaults to VIRTUAL, which cannot carry an FK. It is
 *   its own object, `ALTER TABLE ... ADD COLUMN`, with the reasons of the law that needs it.
 * - An alternatives parent with an arm relation of several handles has an arm tag, such a column of its
 *   discriminator's type computed from the discriminator (`tagGeneration`), and its UNIQUE over the parent's key and the
 *   arm tag is its own object after it, `ALTER TABLE ... ADD CONSTRAINT`, which the arms' foreign keys reference: the
 *   column is added after the table, which an inline key could not name (42703).
 * - Every native constraint is its own object with its own law reasons. The row-local ones are declared
 *   inline by the table's CREATE TABLE, as a hand-written table declares them, so their objects carry
 *   no statement of their own: the primary key `<table>__pk`, each candidate key and generated unique
 *   `<table>__key__<cols>`, a span key with its span last WITHOUT OVERLAPS or, when the span is its
 *   only field, `EXCLUDE USING gist (<span> WITH &&)` under the key's name (PostgreSQL requires a column before the span
 *   of WITHOUT OVERLAPS, 42601; the exclusion constraint raises the same 23P01, needs no btree_gist, and its GiST index
 *   serves the span key's lookups), each row CHECK and each
 *   specialized CHECK (finite membership, conditional closed facts, a capacity's own-row bound), wrapped in IS TRUE by
 *   the printer. The references follow every table as `ALTER TABLE ... ADD CONSTRAINT`: a plain foreign key, immediate
 *   or DEFERRABLE INITIALLY DEFERRED as the law model decides, a tagged foreign key over the tag and a generated
 *   composite unique, and a PERIOD foreign key, so cyclic foreign keys need no order between tables.
 * - A capacity's at-most-one partial unique index is an enforcement object, created in the
 *   index phase beside the other indexes.
 *
 * The deferral rule is the law model's; the names are the law model's and ownership's; this module only spells them.
 * Each vector column also carries its cosine-domain CHECK (`vectorNorms`). Every table is added before the objects on
 * it, so the inline constraints are planned first. */
export const addTables = (b: InstallBuilder): PlacedNatives => {
	const inline: Inline = new Map()
	const plans = planNatives(b, inline)
	const norms = vectorNorms(b)
	for (const n of norms) {
		declareInline(inline, n.relation, n.constraint)
	}
	const planned = plannedTables(b)
	for (const t of planned) {
		const table = b.addTable(
			t.relation,
			{
				kind: "table",
				ident: b.qualified("table", t.named),
				ddl: [
					{
						kind: "createTable",
						table: b.names.relation(t.relation),
						columns: t.columns,
						primaryKey: t.primaryKey,
						secondary: inline.get(t.relation) ?? []
					}
				],
				reasons: [enforcement(`relation ${t.relation}`)],
				phase: "structure"
			},
			t.after
		)
		addIsolationTrigger(b, t.relation, table)
	}
	addVectorNorms(b, norms)
	return {
		keyIndexes: addNatives(b, plans),
		tables: planned.map((t) => b.names.relation(t.relation)),
		sequences: planned.flatMap((t) =>
			t.columns.flatMap((c) => (c.generated?.kind === "identity" ? [c.generated.sequence] : []))
		)
	}
}

/** Each key and CHECK native's plan, in the law model's order, its inline constraint declared into `inline`. */
const planNatives = (b: InstallBuilder, inline: Inline): ReadonlyArray<NativePlan> => {
	const plans: Array<NativePlan> = []
	/** A secondary constraint, declared inline in its table, and its object. */
	const declare = (
		relation: string,
		named: Identity<IdentityKind>,
		constraint: InlineConstraint,
		laws: ReadonlyArray<LawId>,
		key: KeyShape | undefined,
		gist: boolean
	): void => {
		declareInline(inline, relation, constraint)
		plans.push({
			kind: "inline",
			relation,
			named,
			object: constraint.kind === "exclude" ? "unique" : constraint.kind,
			laws,
			key,
			gist
		})
	}
	/** A primary key's object: its table declares the key itself (`primaryKeyOf`). */
	const declarePrimary = (
		relation: string,
		named: Identity<IdentityKind>,
		laws: ReadonlyArray<LawId>,
		key: KeyShape,
		gist: boolean
	): void => {
		plans.push({ kind: "inline", relation, named, object: "primaryKey", laws, key, gist })
	}
	for (const n of b.natives) {
		if (n.namespace !== "constraint" && n.namespace !== "index") {
			continue
		}
		const o = n.object
		const named = n.named
		const name = identifierOf(n.named)
		const keyShape = (
			method: "btree" | "gist",
			columns: ReadonlyArray<string>,
			rows: IndexRows
		): KeyShape => ({ name, relation: o.relation.name, method, columns, rows, unique: true })
		switch (o.kind) {
			case "PrimaryKey":
				declarePrimary(
					o.relation.name,
					named,
					o.lawIds,
					keyShape("btree", fieldNames(o.columns), allRows),
					false
				)
				continue
			case "Unique":
				declare(
					o.relation.name,
					named,
					{ kind: "unique", name, columns: keyColumns(b, o.relation.name, keyNames(o.columns)) },
					o.lawIds,
					keyShape("btree", fieldNames(o.columns), allRows),
					false
				)
				continue
			case "ArmUnique":
				plans.push({
					kind: "armUnique",
					relation: o.relation.name,
					named,
					constraint: {
						kind: "unique",
						name,
						columns: appendNonEmpty(keyColumns(b, o.relation.name, keyNames(o.columns)), {
							column: o.tag,
							withoutOverlaps: false
						})
					},
					laws: o.lawIds,
					key: keyShape("btree", [...fieldNames(o.columns), o.tag], allRows),
					tag: o.tag
				})
				continue
			case "WithoutOverlaps":
			case "TemporalUnique": {
				/** A span key's scalar fields; a temporal unique's columns, beside its span. */
				const scalars = fieldNames(o.kind === "WithoutOverlaps" ? o.key.scalars : o.columns)
				if (!isNonEmpty(scalars)) {
					declare(
						o.relation.name,
						named,
						{
							kind: "exclude",
							name,
							method: "gist",
							elements: [{ column: b.names.column(o.relation.name, o.span.name), operator: "&&" }]
						},
						o.lawIds,
						keyShape("gist", [o.span.name], allRows),
						false
					)
					continue
				}
				const key = keyShape("gist", [...scalars, o.span.name], allRows)
				const gist = o.relation.fields.some(
					(f) => scalars.includes(f.name) && spanOf(f.type) === undefined
				)
				if (o.kind === "WithoutOverlaps" && o.key.kind === "primary") {
					declarePrimary(o.relation.name, named, o.lawIds, key, gist)
					continue
				}
				declare(
					o.relation.name,
					named,
					{
						kind: "unique",
						name,
						columns: periodKeyColumns(b, o.relation.name, scalars, o.span.name)
					},
					o.lawIds,
					key,
					gist
				)
				continue
			}
			case "TableCheck": {
				const predicate = lowerPersistent(b.names, o.predicate, {
					reads: {
						kind: "row",
						column: (ref) => o.relation.fields.find((f) => f.name === ref.name)?.column
					},
					loc: SourceLoc(`check ${name}`, [])
				})
				declare(
					o.relation.name,
					named,
					{ kind: "check", name, predicate },
					o.lawIds,
					undefined,
					false
				)
				continue
			}
			case "FiniteCheck":
				declare(
					o.relation.name,
					named,
					{ kind: "check", name, predicate: finitePredicate(b, o) },
					o.lawIds,
					undefined,
					false
				)
				continue
			case "PartialUnique": {
				const rows = rowsOfWhere(o.where.map((w) => ({ column: w.field.name, value: w.value })))
				const where = isNonEmpty(o.where)
					? selectionPredicate(
							b,
							o.relation.name,
							mapNonEmpty(o.where, (w) => ({
								column: w.field.name,
								type: w.field.type,
								value: w.value
							}))
						)
					: undefined
				plans.push({
					kind: "partialUnique",
					relation: o.relation.name,
					named,
					index: {
						kind: "createIndex",
						name,
						table: b.names.relation(o.relation.name),
						unique: true,
						concurrently: false,
						method: "btree",
						keys: mapNonEmpty(o.columns, (f) => columnKey(b.names.column(o.relation.name, f.name))),
						include: [],
						where
					},
					laws: o.lawIds,
					key: keyShape("btree", fieldNames(o.columns), rows)
				})
				continue
			}
			case "ForeignKey":
			case "TaggedForeignKey":
			case "ArmForeignKey":
			case "PeriodForeignKey":
			case "TaggedPeriodForeignKey":
				continue
		}
	}
	return plans
}

/** The type and STORED generation of a tag column: a stored tag's constant, of its selector's type; or an alternatives
 * parent's arm tag, of its discriminator's type, `CASE <discriminator> WHEN <handle> THEN <tag> ... ELSE <discriminator>
 * END` over each handle another handle tags, every other handle its own tag. */
const tagGeneration = (
	b: InstallBuilder,
	o: NativeOf<"StoredTag" | "ArmTag">
): { readonly type: ScalarType; readonly expr: Expr } => {
	switch (o.kind) {
		case "StoredTag":
			return {
				type: o.selector.field.type,
				expr: persistentLiteral(b.names, o.value, o.selector.field.type)
			}
		case "ArmTag": {
			const t = o.discriminator.type
			const kind = tableCol(b.names.column(o.relation.name, o.discriminator.name))
			const handle = (h: string): Expr => persistentLiteral(b.names, { kind: "enum", handle: h }, t)
			return {
				type: t,
				expr: {
					kind: "case",
					operand: kind,
					whens: mapNonEmpty(o.moved, (m) => ({ when: handle(m.handle), result: handle(m.tag) })),
					else: kind
				}
			}
		}
	}
}

/** The objects of the natives once every table stands: each stored tag and arm tag after its table and the type it
 * names; each key and CHECK after its table (a span key with a scalar component after btree_gist too); each partial
 * unique index after its table; each arm unique after its table's arm tag; then each reference, after its table, its
 * target's table and key index, and the tags it names. */
const addNatives = (
	b: InstallBuilder,
	plans: ReadonlyArray<NativePlan>
): ReadonlyArray<KeyIndex> => {
	const tags = new Map<string, Map<string, Node<"structure">>>()
	for (const n of b.natives) {
		if (n.namespace !== "column") {
			continue
		}
		const o = n.object
		const { type: t, expr } = tagGeneration(b, o)
		const { type, collation } = columnType(b.names, t)
		const column = identifierOf(n.named)
		const tag = b.add(
			{
				kind: "storedTag",
				ident: {
					kind: "column",
					schema: b.settings.installation,
					relation: b.names.relationNamed(o.relation.name),
					name: n.named
				},
				ddl: [
					{
						kind: "alterTable",
						table: b.names.relation(o.relation.name),
						actions: [
							{
								kind: "addColumn",
								column: {
									name: column,
									type,
									collation,
									generated: { kind: "stored", expr }
								}
							}
						]
					}
				],
				reasons: lawReasons(o.lawIds),
				phase: "structure"
			},
			[b.table(o.relation.name), ...typeNodes(b, t)]
		)
		tags.set(o.relation.name, new Map([...(tags.get(o.relation.name) ?? []), [column, tag]]))
	}
	const tagsOf = (
		relation: string,
		columns: ReadonlyArray<string>
	): ReadonlyArray<Node<"structure">> =>
		columns.flatMap((c) => {
			const tag = tags.get(relation)?.get(c)
			return tag === undefined ? [] : [tag]
		})
	const keyIndexes: Array<KeyIndex> = []
	/** The key constraints a reference can name, each with its object. */
	const keys: Array<{ readonly shape: KeyShape; readonly object: Node<"structure"> }> = []
	for (const p of plans) {
		switch (p.kind) {
			case "inline": {
				const object = b.add(
					{
						kind: p.object,
						ident: constraintIdent(b, p.relation, p.named),
						ddl: [],
						reasons: lawReasons(p.laws),
						phase: "structure"
					},
					[b.table(p.relation), ...(p.gist ? [b.provider("btree_gist")] : [])]
				)
				if (p.key !== undefined) {
					keyIndexes.push({ ...p.key, object })
					keys.push({ shape: p.key, object })
				}
				continue
			}
			case "partialUnique": {
				const object = b.add(
					{
						kind: "uniqueIndex",
						ident: b.qualified("index", p.named),
						ddl: [p.index],
						reasons: lawReasons(p.laws),
						phase: "indexes"
					},
					[b.table(p.relation)]
				)
				keyIndexes.push({ ...p.key, object })
				continue
			}
			case "armUnique": {
				const object = b.add(
					{
						kind: "unique",
						ident: constraintIdent(b, p.relation, p.named),
						ddl: [
							{
								kind: "alterTable",
								table: b.names.relation(p.relation),
								actions: [{ kind: "addConstraint", constraint: p.constraint, notValid: false }]
							}
						],
						reasons: lawReasons(p.laws),
						phase: "structure"
					},
					[b.table(p.relation), ...tagsOf(p.relation, [p.tag])]
				)
				keys.push({ shape: p.key, object })
				continue
			}
		}
	}
	/** The references, after every table, key and tag: a reference's target key is a key constraint of its target. */
	const keyObjectOf = (
		relation: string,
		columns: ReadonlyArray<string>,
		method: "btree" | "gist"
	): ReadonlyArray<Node<"structure">> =>
		keys
			.filter(
				({ shape: k }) =>
					k.relation === relation &&
					k.method === method &&
					k.rows.kind === "all" &&
					k.columns.length === columns.length &&
					k.columns.every((c) => columns.includes(c))
			)
			.slice(0, 1)
			.map((k) => k.object)
	for (const n of b.natives) {
		if (n.namespace !== "constraint") {
			continue
		}
		const o = n.object
		const name = identifierOf(n.named)
		switch (o.kind) {
			case "ForeignKey":
				addReference(
					b,
					o.relation.name,
					n.named,
					{
						kind: "foreignKey",
						name,
						columns: fkColumns(b, o.relation.name, keyNames(o.columns), []),
						references: b.names.relation(o.target.name),
						referencedColumns: fkColumns(b, o.target.name, keyNames(o.targetColumns), []),
						deferrable: o.deferrable ? "INITIALLY DEFERRED" : undefined
					},
					o.lawIds,
					[
						b.table(o.target.name),
						...keyObjectOf(o.target.name, fieldNames(o.targetColumns), "btree")
					]
				)
				continue
			case "TaggedForeignKey":
				addReference(
					b,
					o.relation.name,
					n.named,
					{
						kind: "foreignKey",
						name,
						columns: fkColumns(b, o.relation.name, keyNames(o.columns), [
							{ column: o.tag, period: false }
						]),
						references: b.names.relation(o.target.name),
						referencedColumns: fkColumns(b, o.target.name, keyNames(o.targetColumns), []),
						deferrable: "INITIALLY DEFERRED"
					},
					o.lawIds,
					[
						b.table(o.target.name),
						...keyObjectOf(o.target.name, fieldNames(o.targetColumns), "btree"),
						...tagsOf(o.relation.name, [o.tag])
					]
				)
				continue
			case "ArmForeignKey":
				addReference(
					b,
					o.relation.name,
					n.named,
					{
						kind: "foreignKey",
						name,
						columns: fkColumns(b, o.relation.name, keyNames(o.columns), [
							{ column: o.tag, period: false }
						]),
						references: b.names.relation(o.target.name),
						referencedColumns: fkColumns(b, o.target.name, keyNames(o.targetColumns), [
							{ column: o.targetTag, period: false }
						]),
						deferrable: "INITIALLY DEFERRED"
					},
					o.lawIds,
					[
						b.table(o.target.name),
						...keyObjectOf(o.target.name, [...fieldNames(o.targetColumns), o.targetTag], "btree"),
						...tagsOf(o.relation.name, [o.tag]),
						...tagsOf(o.target.name, [o.targetTag])
					]
				)
				continue
			case "PeriodForeignKey":
			case "TaggedPeriodForeignKey": {
				/** A tagged reference's STORED tag column follows its scalar columns. */
				const tagColumns = o.kind === "TaggedPeriodForeignKey" ? [o.tag] : []
				addReference(
					b,
					o.relation.name,
					n.named,
					{
						kind: "foreignKey",
						name,
						columns: periodFkColumns(
							b,
							o.relation.name,
							o.columns,
							tagColumns.map((column) => ({ column, period: false })),
							o.span
						),
						references: b.names.relation(o.target.name),
						referencedColumns: periodFkColumns(b, o.target.name, o.targetColumns, [], o.targetSpan),
						deferrable: "INITIALLY DEFERRED"
					},
					o.lawIds,
					[
						b.table(o.target.name),
						...keyObjectOf(
							o.target.name,
							[...fieldNames(o.targetColumns), o.targetSpan.name],
							"gist"
						),
						...tagsOf(o.relation.name, tagColumns)
					]
				)
				continue
			}
			case "PrimaryKey":
			case "Unique":
			case "ArmUnique":
			case "WithoutOverlaps":
			case "TemporalUnique":
			case "TableCheck":
			case "FiniteCheck":
				continue
		}
	}
	return keyIndexes
}
