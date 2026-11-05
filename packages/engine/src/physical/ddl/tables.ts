import { refuse } from "#compiler/analysis/theory/build.ts"
import { appendAll } from "#compiler/core/array.ts"
import { type Identity, identifierOf } from "#compiler/core/identity.ts"
import type { ConstraintName, IdentityKind, LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	appendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import {
	type FieldValue,
	fieldNames,
	type LawField,
	type LawRelation,
	type NativeColumn,
	type NativeObject,
	type NativeOf,
	type SpanField
} from "#compiler/ir/law.ts"
import type { IndexRows } from "#compiler/ir/products.ts"
import { type ScalarType, spanOf } from "#compiler/ir/scalar.ts"
import type { NamedPrimaryKey } from "#compiler/laws/model/model.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { lowerPersistent, persistentLiteral } from "#compiler/physical/ddl/expr.ts"
import { addIsolationTrigger } from "#compiler/physical/ddl/isolation.ts"
import { type ColumnType, columnType, lawColumnType } from "#compiler/physical/ddl/names.ts"
import {
	enforcement,
	lawReasons,
	type Node,
	type NodeIdent
} from "#compiler/physical/obligations/graph.ts"
import { addVectorNorms, isVectorType, vectorNorms } from "#compiler/physical/vector/storage.ts"
import type {
	ColumnDef,
	ColumnGeneration,
	Expr,
	ObjectName,
	ForeignKey,
	ForeignKeyColumn,
	InlineConstraint,
	KeyColumn,
	PrimaryKey,
	TableConstraint
} from "#compiler/sql/ast.ts"
import { and, eq, or, tableCol } from "#compiler/sql/build.ts"

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
const typeNodes = (b: InstallBuilder, t: ScalarType): ReadonlyArray<Node<"setup">> =>
	typeNodeOf(b, columnType(b.names, t))

/** The enum or domain of the installed schema a column type names; none for any other type. */
const typeNodeOf = (b: InstallBuilder, t: ColumnType): ReadonlyArray<Node<"setup">> => {
	const node = b.typeNode(t.type)
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

/** The installed column a native object reads on `relation`'s table: a field's column, or a law column's own
 * identifier. */
const nativeColumn = (b: InstallBuilder, relation: string, c: NativeColumn): string =>
	c.kind === "field" ? b.names.column(relation, c.field.name) : c.column

/**
 * The name a key index and an index request give a native object's column: a field's name, or a law column's
 * identifier. Like every name grizzle derives, a law column's identifier starts with `__`, which no declared name does,
 * so the two never meet in one relation.
 */
export const indexedName = (c: NativeColumn): string =>
	c.kind === "field" ? c.field.name : c.column

/** The names a key index and an index request give native columns, in their order (`indexedName`). */
const indexedNames = (columns: ReadonlyArray<NativeColumn>): ReadonlyArray<string> =>
	columns.map(indexedName)

/** The law columns among native columns, by identifier: the columns a key or reference over them is created after. */
const lawColumnsAmong = (columns: ReadonlyArray<NativeColumn>): ReadonlyArray<string> =>
	columns.flatMap((c) => (c.kind === "law" ? [c.column] : []))

/** A foreign key's columns on `relation`, each a field's or a law column's (`nativeColumn`). */
const nativeFkColumns = (
	b: InstallBuilder,
	relation: string,
	columns: NonEmptyReadonlyArray<NativeColumn>
): NonEmptyReadonlyArray<ForeignKeyColumn> =>
	mapNonEmpty(columns, (c) => ({ column: nativeColumn(b, relation, c), period: false }))

/** A period foreign key's columns: its scalar columns, each a field's or a law column's (`nativeColumn`), its span
 * last. */
const periodFkColumns = (
	b: InstallBuilder,
	relation: string,
	columns: ReadonlyArray<NativeColumn>,
	span: SpanField
): NonEmptyReadonlyArray<ForeignKeyColumn> =>
	appendNonEmpty(
		columns.map((c): ForeignKeyColumn => ({ column: nativeColumn(b, relation, c), period: false })),
		{ column: b.names.column(relation, span.name), period: true }
	)

/** A literal selector of the rows an index holds, its field typed: the field's name and type, and the literal. */
interface TypedSelector {
	readonly column: string
	readonly type: ScalarType
	readonly value: TypedLiteral
}

/** A literal selection as a partial index's WHERE: a persistent predicate over the row's own columns, base-typed, each
 * selector an equality in the selection's order, as the selected probe of the law it serves spells it, so PostgreSQL
 * finds the index's predicate implied by the probe. */
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
 * object carries no statement, only its reasons and its place in the order; or a key over a column a law adds (a law
 * column, an alternatives parent's arm tag), its own ALTER TABLE ... ADD CONSTRAINT after the columns, which an inline
 * key could not name (42703). A key's index joins the key indexes once its object is added. A span key's exclusion
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
			readonly kind: "ownUnique"
			readonly relation: string
			readonly named: Identity<IdentityKind>
			readonly constraint: Extract<TableConstraint, { readonly kind: "unique" }>
			readonly laws: ReadonlyArray<LawId>
			readonly key: KeyShape
			/** The columns a law adds that it holds, which its table adds after its CREATE TABLE. */
			readonly lawColumns: NonEmptyReadonlyArray<string>
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

/** A key's index, which holds every row: one whose column is null holds it too, under NULLS DISTINCT. */
export interface KeyIndex {
	readonly object: Node<"structure">
	readonly name: ConstraintName
	readonly relation: string
	readonly method: "btree" | "gist"
	/** Its columns' names (`indexedName`), in index column order. */
	readonly columns: ReadonlyArray<string>
	readonly unique: true
}

/** Every stored relation's table, then every native object of the law model on it: law columns, keys, checks and
 * references.
 *
 * - A stored relation is `CREATE TABLE <schema>.<table> (...)` with its fields in declared order, every column NOT
 *   NULL. A wildcard text column names pg_catalog.pg_c_utf8; a refined column is typed by its domain,
 *   which carries that collation. A serial field is `GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME
 *   <schema>.<table>_<col>_seq)`, its sequence owned by the column.
 * - A law column, added before every key and reference because they name it, is a private STORED generated column of
 *   its type's base (`lawColumnType`), the keyword STORED always emitted, since PostgreSQL defaults to VIRTUAL, which
 *   no key or reference can name. A constant, which a constant selection of a target places on its source, is
 *   `GENERATED ALWAYS AS (<literal>) STORED NOT NULL`. A partial term, a selected side's term or a pred term, is
 *   `GENERATED ALWAYS AS (CASE WHEN <φ> THEN <t> END) STORED`, null outside φ, so a key over it holds only the
 *   selected rows and a reference out of it binds only them. Each is its own object, `ALTER TABLE ... ADD COLUMN`, with
 *   the reasons of the laws that need it.
 * - An alternatives parent with an arm relation of several handles has an arm tag, such a column of its
 *   discriminator's type computed from the discriminator (`lawColumnGeneration`).
 * - Every native constraint is its own object with its own law reasons. The row-local ones over fields alone are
 *   declared inline by the table's CREATE TABLE, as a hand-written table declares them, so their objects carry
 *   no statement of their own: the primary key `<table>__pk`, each candidate key and generated unique
 *   `<table>__key__<cols>`, always `UNIQUE NULLS DISTINCT`, a span key with its span last WITHOUT OVERLAPS or, when the
 *   span is its only field, `EXCLUDE USING gist (<span> WITH &&)` under the key's name (PostgreSQL requires a column
 *   before the span of WITHOUT OVERLAPS, 42601; the exclusion constraint raises the same 23P01, needs no btree_gist, and
 *   its GiST index serves the span key's lookups), each row CHECK and each specialized CHECK (finite membership,
 *   conditional closed facts, a capacity's own-row bound), wrapped in IS TRUE by the printer. A key over a column a law
 *   adds is its own `ALTER TABLE ... ADD CONSTRAINT` after those columns, which an inline key could not name (42703).
 *   The references follow every table as `ALTER TABLE ... ADD CONSTRAINT`: a foreign key `MATCH SIMPLE` into a
 *   non-deferrable key over exactly its referenced columns, immediate or DEFERRABLE INITIALLY DEFERRED as the law model
 *   decides, and a PERIOD foreign key, so cyclic foreign keys need no order between tables.
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
		if (n.namespace !== "constraint") {
			continue
		}
		const o = n.object
		const named = n.named
		const name = identifierOf(n.named)
		const keyShape = (method: "btree" | "gist", columns: ReadonlyArray<string>): KeyShape => ({
			name,
			relation: o.relation.name,
			method,
			columns,
			unique: true
		})
		/** A key over the columns `columns`, some of which a law adds (`lawColumns`), created after those. */
		const ownUnique = (
			columns: NonEmptyReadonlyArray<string>,
			names: ReadonlyArray<string>,
			lawColumns: NonEmptyReadonlyArray<string>
		): void => {
			plans.push({
				kind: "ownUnique",
				relation: o.relation.name,
				named,
				constraint: {
					kind: "unique",
					name,
					columns: mapNonEmpty(columns, (column) => ({ column, withoutOverlaps: false }))
				},
				laws: o.lawIds,
				key: keyShape("btree", names),
				lawColumns
			})
		}
		switch (o.kind) {
			case "PrimaryKey":
				declarePrimary(
					o.relation.name,
					named,
					o.lawIds,
					keyShape("btree", fieldNames(o.columns)),
					false
				)
				continue
			case "Unique": {
				const columns = mapNonEmpty(o.columns, (c) => nativeColumn(b, o.relation.name, c))
				const lawColumns = lawColumnsAmong(o.columns)
				if (isNonEmpty(lawColumns)) {
					ownUnique(columns, indexedNames(o.columns), lawColumns)
					continue
				}
				declare(
					o.relation.name,
					named,
					{
						kind: "unique",
						name,
						columns: mapNonEmpty(columns, (column) => ({ column, withoutOverlaps: false }))
					},
					o.lawIds,
					keyShape("btree", indexedNames(o.columns)),
					false
				)
				continue
			}
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
						keyShape("gist", [o.span.name]),
						false
					)
					continue
				}
				const key = keyShape("gist", [...scalars, o.span.name])
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
			case "TableCheck":
				declare(
					o.relation.name,
					named,
					{
						kind: "check",
						name,
						predicate: lowerRow(b, o.relation, o.predicate, `check ${name}`)
					},
					o.lawIds,
					undefined,
					false
				)
				continue
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
			case "ForeignKey":
			case "PeriodForeignKey":
				continue
		}
	}
	return plans
}

/** A row expression of `relation`'s own fields, a CHECK's predicate or a law column's selection or term, lowered as
 * persistent SQL over the table's columns: a reference to anything else is refused as MalformedDescription. */
const lowerRow = (
	b: InstallBuilder,
	relation: LawRelation,
	expr: ScalarExpr,
	label: string
): Expr =>
	lowerPersistent(b.names, expr, {
		reads: {
			kind: "row",
			column: (ref) => relation.fields.find((f) => f.name === ref.name)?.column
		},
		loc: SourceLoc(label, [])
	})

/** The column a law adds, before its table holds it: its column type, its field's type's base (`lawColumnType`), and
 * its STORED generation: its term alone when its guard is empty, a total column, NOT NULL, and otherwise
 * `CASE WHEN <every guard conjunct> THEN <term> END`, null where the guard fails, every expression lowered over the
 * row's own fields. */
const lawColumnGeneration = (
	b: InstallBuilder,
	o: NativeOf<"LawColumn">,
	label: string
): { readonly type: ColumnType; readonly generated: ColumnGeneration } => {
	const expr = lowerRow(b, o.relation, o.value.term, label)
	const guard = o.value.guard.map((g) => lowerRow(b, o.relation, g, label))
	return {
		type: lawColumnType(b.names, o.field.type),
		generated: isNonEmpty(guard)
			? { kind: "partial", when: guard.length === 1 ? guard[0] : and(guard), expr }
			: { kind: "stored", expr }
	}
}

/** The objects of the natives once every table stands: each law column after its table and the type it names; each key and CHECK after its table (a span key with a scalar component after btree_gist too); each key over a
 * column a law adds after those columns; then each reference, after its table, its target's table and key, and the law
 * columns it names. */
const addNatives = (
	b: InstallBuilder,
	plans: ReadonlyArray<NativePlan>
): ReadonlyArray<KeyIndex> => {
	const lawColumns = new Map<string, Map<string, Node<"structure">>>()
	for (const n of b.natives) {
		if (n.namespace !== "column") {
			continue
		}
		const o = n.object
		const column = o.column
		const { type: columnOf, generated } = lawColumnGeneration(
			b,
			o,
			`column ${column} of ${o.relation.name}`
		)
		const added = b.add(
			{
				kind: "lawColumn",
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
									type: columnOf.type,
									collation: columnOf.collation,
									generated
								}
							}
						]
					}
				],
				reasons: lawReasons(o.lawIds),
				phase: "structure"
			},
			[b.table(o.relation.name), ...typeNodeOf(b, columnOf)]
		)
		lawColumns.set(
			o.relation.name,
			new Map([...(lawColumns.get(o.relation.name) ?? []), [column, added]])
		)
	}
	/** The objects of the law columns of `relation` among `columns`. */
	const lawColumnsOf = (
		relation: string,
		columns: ReadonlyArray<string>
	): ReadonlyArray<Node<"structure">> =>
		columns.flatMap((c) => {
			const added = lawColumns.get(relation)?.get(c)
			return added === undefined ? [] : [added]
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
			case "ownUnique": {
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
					[b.table(p.relation), ...lawColumnsOf(p.relation, p.lawColumns)]
				)
				keyIndexes.push({ ...p.key, object })
				keys.push({ shape: p.key, object })
				continue
			}
		}
	}
	/** The key a reference into `columns` of `relation` names: one over exactly those columns, in any order. */
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
						columns: nativeFkColumns(b, o.relation.name, o.columns),
						references: b.names.relation(o.target.name),
						referencedColumns: nativeFkColumns(b, o.target.name, o.targetColumns),
						deferrable: o.deferrable ? "INITIALLY DEFERRED" : undefined
					},
					o.lawIds,
					[
						b.table(o.target.name),
						...keyObjectOf(o.target.name, indexedNames(o.targetColumns), "btree"),
						...lawColumnsOf(o.relation.name, lawColumnsAmong(o.columns)),
						...lawColumnsOf(o.target.name, lawColumnsAmong(o.targetColumns))
					]
				)
				continue
			case "PeriodForeignKey":
				addReference(
					b,
					o.relation.name,
					n.named,
					{
						kind: "foreignKey",
						name,
						columns: periodFkColumns(b, o.relation.name, o.columns, o.span),
						references: b.names.relation(o.target.name),
						referencedColumns: periodFkColumns(b, o.target.name, o.targetColumns, o.targetSpan),
						deferrable: "INITIALLY DEFERRED"
					},
					o.lawIds,
					[
						b.table(o.target.name),
						...keyObjectOf(
							o.target.name,
							[...indexedNames(o.targetColumns), o.targetSpan.name],
							"gist"
						),
						...lawColumnsOf(o.relation.name, lawColumnsAmong(o.columns)),
						...lawColumnsOf(o.target.name, lawColumnsAmong(o.targetColumns))
					]
				)
				continue
			case "PrimaryKey":
			case "Unique":
			case "WithoutOverlaps":
			case "TemporalUnique":
			case "TableCheck":
			case "FiniteCheck":
				continue
		}
	}
	return keyIndexes
}
