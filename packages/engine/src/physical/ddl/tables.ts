import { appendAll } from "#compiler/core/array.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { CompileError } from "#compiler/core/errors.ts"
import { type Identity, identifierOf } from "#compiler/core/identity.ts"
import type { ConstraintName, IdentityKind, LawId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	appendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { codecOf } from "#compiler/ir/codes.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { LawField, NativeColumn, NativeOf, TableRelation } from "#compiler/ir/law.ts"
import { baseOf, type ScalarType, spanOf } from "#compiler/ir/scalar.ts"
import type { NamedPrimaryKey } from "#compiler/laws/model/model.ts"
import { addDateRanges, dateRanges } from "#compiler/physical/date/storage.ts"
import { closedMembership } from "#compiler/physical/ddl/constants.ts"
import type { InstallBuilder, TargetField } from "#compiler/physical/ddl/context.ts"
import { lowerPersistent, persistentClosed } from "#compiler/physical/ddl/expr.ts"
import { addIsolationTrigger } from "#compiler/physical/ddl/isolation.ts"
import { type ColumnType, columnType, lawColumnType } from "#compiler/physical/ddl/names.ts"
import {
	enforcement,
	lawReasons,
	type Node,
	type NodeIdent
} from "#compiler/physical/obligations/graph.ts"
import { addVectorNorms, isVectorType, vectorNorms } from "#compiler/physical/vector/storage.ts"
import {
	btreeEntry,
	datumBound,
	type EntryColumn,
	setDatumBound
} from "#compiler/schema/representability.ts"
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
	SqlStatement,
	TableConstraint
} from "#compiler/sql/ast.ts"
import { and, tableCol } from "#compiler/sql/build.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"

/** A stored relation's table before it is added: its columns, one per field of its theory relation in declared order,
 * its primary key, and the objects it is created after: the schema, each
 * domain a column is typed by, each constant a generated column calls, and the vector extension when a field is a
 * vector. */
interface PlannedTable {
	readonly relation: string
	readonly named: Identity<"table" | "rosterDomain" | "view">
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
				: periodKeyColumns(b, relation, o.key.scalars, o.span)
	}
}

/**
 * A field's column's generation: a serial field's identity, a generated field's `GENERATED ALWAYS AS (e) STORED`, its
 * expression lowered over the row's own columns, or none for a field the caller writes and for one the host writes, a
 * family's drawn field or a fold's accumulated one.
 */
const fieldGeneration = (
	b: InstallBuilder,
	relation: TableRelation,
	field: LawField
): ColumnGeneration | undefined => {
	switch (field.writing.kind) {
		case "serial":
			return { kind: "identity", sequence: b.names.sequence(relation.name, field.name) }
		case "generated":
			return {
				kind: "stored",
				expr: lowerRow(
					b,
					relation,
					field.writing.expr,
					`generated field ${relation.name}.${field.name}`
				)
			}
		case "caller":
		case "drawn":
		case "accumulated":
			return undefined
	}
}

/** Every ordinary relation's table, in name order, with the primary key the law model holds for it. */
const plannedTables = (b: InstallBuilder): ReadonlyArray<PlannedTable> =>
	[...b.model.relations.values()]
		.toSorted((x, y) => compareStrings(x.relation.name, y.relation.name))
		.map(({ relation: r, primaryKey }): PlannedTable => {
			const name = r.name
			const after: Array<Node<"setup">> = [b.levelNode(name)]
			const columns = mapNonEmpty(r.fields, (c): ColumnDef => {
				const { type, collation } = columnType(b.names, c.type)
				appendAll(after, typeNodes(b, c.type))
				return {
					name: b.names.column(name, c.name),
					type,
					collation,
					generated: fieldGeneration(b, r, c)
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

/** The domain of the installed schema a column of type `t` is typed by, which the column's object is created after;
 * none for any other type. */
const typeNodes = (b: InstallBuilder, t: ScalarType): ReadonlyArray<Node<"setup">> =>
	typeNodeOf(b, columnType(b.names, t))

/** The domain of the installed schema a column type names; none for any other type. */
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

/** A span key's columns: its scalar columns, then its span column WITHOUT OVERLAPS, each a field's or a law column's
 * (`nativeColumn`). */
const periodKeyColumns = (
	b: InstallBuilder,
	relation: string,
	scalars: ReadonlyArray<NativeColumn>,
	span: NativeColumn
): NonEmptyReadonlyArray<KeyColumn> =>
	appendNonEmpty(
		scalars.map((c): KeyColumn => ({
			column: nativeColumn(b, relation, c),
			withoutOverlaps: false
		})),
		{ column: nativeColumn(b, relation, span), withoutOverlaps: true }
	)

/** The installed column a native object reads on `relation`'s table: a field's column, or a law column's own
 * identifier. */
const nativeColumn = (b: InstallBuilder, relation: string, c: NativeColumn): string =>
	c.kind === "field" ? b.names.column(relation, c.field.name) : c.column

/**
 * A UNIQUE's B-tree entry over a set, sized by the installation's codes, or the refusal of one past BTMaxItemSize. The
 * law model planned every UNIQUE with its entry proved within the limit, each column's datum bounded (laws/model/plan.ts
 * plannedEntry), a set's counted at its roster's live handles alone: a set is its roster's bit(n), n every code the
 * roster has minted, holes included, which only the installation's codebook holds, and a roster grown and pruned may
 * hold codes enough that the entry outgrows the limit, where PostgreSQL would refuse an insert with 54000. So only a
 * UNIQUE over a set is counted again, every column as the law model counted it but a set at its codes.
 */
const setUniqueBound = (
	b: InstallBuilder,
	relation: string,
	columns: NonEmptyReadonlyArray<NativeColumn>
): void => {
	/** A law column's field, the one whose values it holds, from the law model's natives: no table exists yet. */
	const lawField = (column: string): TargetField | undefined => {
		for (const n of b.model.natives) {
			if (
				n.namespace === "column" &&
				n.object.relation.name === relation &&
				n.object.column === column
			) {
				return n.object.field
			}
		}
		return undefined
	}
	const fields = columns.map((c) => {
		const field = c.kind === "field" ? c.field : lawField(c.column)
		if (field === undefined) {
			throw defect(
				`the law column ${nativeColumn(b, relation, c)} a UNIQUE of ${relation} reads, which the law model plans`
			)
		}
		return { column: c, field }
	})
	if (!fields.some((f) => baseOf(f.field.type).carrier === "bits")) {
		return
	}
	const entryColumns = fields.map(({ column, field }): EntryColumn => {
		const base = baseOf(field.type)
		const datum =
			base.carrier === "bits"
				? setDatumBound(codecOf(b.names.codes, base.roster).size)
				: datumBound(field.desc)
		const name = column.kind === "field" ? column.field.name : column.column
		if (datum === undefined) {
			throw defect(`a bounded datum of ${name}, which the law model's UNIQUE of ${relation} proved`)
		}
		return { name, datum, nullable: column.kind === "law" }
	})
	const entry = btreeEntry(entryColumns)
	if (!entry.ok) {
		const key = columns.map((c) => (c.kind === "field" ? c.field.name : c.column))
		throw new Refusal(
			CompileError.make({
				_tag: "UnrepresentableKey",
				at: SourceLoc(relation, []),
				subject: `the UNIQUE (${key.join(", ")}) of ${relation}, over a set its roster's codes size`,
				key,
				fault: entry.error
			})
		)
	}
}

/** Whether two native columns are one column: one field, or one law column. */
const sameNativeColumn = (a: NativeColumn, b: NativeColumn): boolean =>
	a.kind === "field"
		? b.kind === "field" && a.field.name === b.field.name
		: b.kind === "law" && a.column === b.column

/** A field as a native column. */
const fieldColumn = (field: LawField): NativeColumn => ({ kind: "field", field })

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
	span: NativeColumn
): NonEmptyReadonlyArray<ForeignKeyColumn> =>
	appendNonEmpty(
		columns.map((c): ForeignKeyColumn => ({ column: nativeColumn(b, relation, c), period: false })),
		{ column: nativeColumn(b, relation, span), period: true }
	)

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
			/** A CHECK that reads a column a law adds, its own ALTER TABLE ... ADD CONSTRAINT after those columns, which an
			 * inline CHECK could not name (42703). */
			readonly kind: "ownCheck"
			readonly relation: string
			readonly named: Identity<IdentityKind>
			readonly constraint: Extract<TableConstraint, { readonly kind: "check" }>
			readonly laws: ReadonlyArray<LawId>
			readonly lawColumns: NonEmptyReadonlyArray<string>
	  }
	| {
			readonly kind: "ownUnique"
			readonly relation: string
			readonly named: Identity<IdentityKind>
			/** A UNIQUE, a span key's with its span last WITHOUT OVERLAPS, or a span-only key's exclusion constraint. */
			readonly constraint: Extract<TableConstraint, { readonly kind: "unique" | "exclude" }>
			readonly laws: ReadonlyArray<LawId>
			readonly key: KeyShape
			/** The columns a law adds that it holds, which its table adds after its CREATE TABLE. */
			readonly lawColumns: NonEmptyReadonlyArray<string>
			/** Whether it compares a scalar column through btree_gist, which must stand first. */
			readonly gist: boolean
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

/** A foreign key's update action as its constraint spells it: CASCADE, or NO ACTION, PostgreSQL's default, by none. */
const onUpdateOf: Readonly<Record<NativeOf<"ForeignKey">["onUpdate"], "CASCADE" | undefined>> = {
	cascade: "CASCADE",
	noAction: undefined
}

/** The graph identity of the constraint or column `named` of `relation`'s table. */
const constraintIdent = (
	b: InstallBuilder,
	relation: string,
	named: Identity<IdentityKind>
): NodeIdent => ({
	kind: "constraint",
	schema: b.names.levelOf(relation),
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
	/** Its columns, each a field's or a law column's, in index column order. */
	readonly columns: NonEmptyReadonlyArray<NativeColumn>
	readonly unique: true
}

/** Every stored relation's table, then every native object of the law model on it: law columns, keys, checks and
 * references.
 *
 * - A stored relation is `CREATE TABLE <schema>.<table> (...)` with its fields in declared order, every column NOT
 *   NULL. A wildcard text column names pg_catalog.pg_c_utf8; a refined
 *   column is typed by its domain, which carries that collation; a closed id by its roster's domain. A serial field is
 *   `GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME <schema>.<table>_<col>_seq)`, its sequence owned by the column. A
 *   generated field is `GENERATED ALWAYS AS (<e>) STORED`, its expression over the row's written fields, a closed read
 *   among them reading the closed relation's constants, which the table is created after.
 * - A drawn law column, a family's count copy, index, parent start or fold accumulator, is a plain NOT NULL column of
 *   its type's base that the host writes, its own `ALTER TABLE ... ADD COLUMN` after its table, as a generated
 *   law column is (`lawColumnDdl`), so a migration adds a family to a relation that stands by the same statements.
 * - A generated law column, added before every key and reference because they name it, is a private STORED generated column of
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
 *   its GiST index serves the span key's lookups), each row CHECK and each specialized CHECK (a containment into a
 *   closed relation's side, reading the side's constant, physical/ddl/constants.ts closedMembership; a family's row
 *   conditions over its drawn columns), wrapped in IS TRUE by the printer. A key over a column a law
 *   adds, and a CHECK that reads one, is its own `ALTER TABLE ... ADD CONSTRAINT` after those columns, which an inline
 *   constraint could not name (42703).
 *   The references follow every table as `ALTER TABLE ... ADD CONSTRAINT`: a foreign key `MATCH SIMPLE` into a
 *   non-deferrable key over exactly its referenced columns, immediate or DEFERRABLE INITIALLY DEFERRED as the law model
 *   decides, `ON UPDATE CASCADE` on a family's owner axis, and a PERIOD foreign key, deferred as the law model decides
 *   and never with an action, so cyclic foreign keys need no order between tables.
 *
 * The deferral rule is the law model's; the names are the law model's and ownership's; this module only spells them.
 * Each vector column also carries its cosine-domain CHECK (`vectorNorms`) and each date column its range CHECK
 * (`dateRanges`); a bytes column carries none, since its type's own bound is its value's (core/limits.ts bytesMaxLength).
 * Every table is added before the objects on it, so the inline constraints are planned first. */
export const addTables = (b: InstallBuilder): PlacedNatives => {
	const inline: Inline = new Map()
	const plans = planNatives(b, inline)
	const norms = vectorNorms(b)
	for (const n of norms) {
		declareInline(inline, n.relation, n.constraint)
	}
	const ranges = dateRanges(b)
	for (const r of ranges) {
		declareInline(inline, r.relation, r.constraint)
	}
	const planned = plannedTables(b)
	for (const t of planned) {
		const ddl: ReadonlyArray<SqlStatement> = [
			{
				kind: "createTable",
				table: b.names.relation(t.relation),
				columns: t.columns,
				primaryKey: t.primaryKey,
				secondary: inline.get(t.relation) ?? []
			}
		]
		/** A generated column and a closed CHECK read constants, which the table is created after. */
		const table = b.addTable(
			t.relation,
			{
				kind: "table",
				ident: b.qualifiedOf("table", t.relation, t.named),
				ddl,
				reasons: [enforcement(`relation ${t.relation}`)],
				phase: "structure"
			},
			[...t.after, ...b.constantNodes(ddl)]
		)
		addIsolationTrigger(b, t.relation, table)
	}
	addVectorNorms(b, norms)
	addDateRanges(b, ranges)
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
	/** A CHECK: inline in its table, or its own object after the law columns it reads. */
	const declareCheck = (
		relation: TableRelation,
		named: Identity<IdentityKind>,
		constraint: Extract<TableConstraint, { readonly kind: "check" }>,
		laws: ReadonlyArray<LawId>
	): void => {
		const read = lawColumnsRead(b, relation, constraint.predicate)
		if (isNonEmpty(read)) {
			plans.push({
				kind: "ownCheck",
				relation: relation.name,
				named,
				constraint,
				laws,
				lawColumns: read
			})
			return
		}
		declare(relation.name, named, constraint, laws, undefined, false)
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
		const keyShape = (
			method: "btree" | "gist",
			columns: NonEmptyReadonlyArray<NativeColumn>
		): KeyShape => ({
			name,
			relation: o.relation.name,
			method,
			columns,
			unique: true
		})
		/** A key over the columns `columns`, some of which a law adds (`lawColumns`), created after those. */
		const ownUnique = (
			columns: NonEmptyReadonlyArray<string>,
			natives: NonEmptyReadonlyArray<NativeColumn>,
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
				key: keyShape("btree", natives),
				lawColumns,
				gist: false
			})
		}
		switch (o.kind) {
			case "PrimaryKey":
				declarePrimary(
					o.relation.name,
					named,
					o.lawIds,
					keyShape("btree", mapNonEmpty(o.columns, fieldColumn)),
					false
				)
				continue
			case "Unique": {
				setUniqueBound(b, o.relation.name, o.columns)
				const columns = mapNonEmpty(o.columns, (c) => nativeColumn(b, o.relation.name, c))
				const lawColumns = lawColumnsAmong(o.columns)
				if (isNonEmpty(lawColumns)) {
					ownUnique(columns, o.columns, lawColumns)
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
					keyShape("btree", o.columns),
					false
				)
				continue
			}
			case "WithoutOverlaps": {
				/** A span key's scalar columns and its span. */
				const span = o.span
				const scalars = o.key.scalars
				/** A span key over a projected side reads law columns its table adds after its CREATE TABLE, so its
				 * constraint is its own ALTER TABLE ... ADD CONSTRAINT after them, as an inline one could not name them. */
				const lawColumns = lawColumnsAmong([...scalars, span])
				if (isNonEmpty(lawColumns)) {
					plans.push({
						kind: "ownUnique",
						relation: o.relation.name,
						named,
						constraint: isNonEmpty(scalars)
							? {
									kind: "unique",
									name,
									columns: periodKeyColumns(b, o.relation.name, scalars, span)
								}
							: {
									kind: "exclude",
									name,
									method: "gist",
									elements: [{ column: nativeColumn(b, o.relation.name, span), operator: "&&" }]
								},
						laws: o.lawIds,
						key: keyShape("gist", appendNonEmpty(scalars, span)),
						lawColumns,
						gist: scalars.some((c) => c.kind === "law" || spanOf(c.field.type) === undefined)
					})
					continue
				}
				if (!isNonEmpty(scalars)) {
					declare(
						o.relation.name,
						named,
						{
							kind: "exclude",
							name,
							method: "gist",
							elements: [{ column: nativeColumn(b, o.relation.name, span), operator: "&&" }]
						},
						o.lawIds,
						keyShape("gist", [span]),
						false
					)
					continue
				}
				const key = keyShape("gist", appendNonEmpty(scalars, span))
				/** A scalar component, a field of no span type or a law column, which a GiST key holds through btree_gist. */
				const gist = scalars.some((c) => c.kind === "law" || spanOf(c.field.type) === undefined)
				if (o.key.kind === "primary") {
					declarePrimary(o.relation.name, named, o.lawIds, key, gist)
					continue
				}
				declare(
					o.relation.name,
					named,
					{
						kind: "unique",
						name,
						columns: periodKeyColumns(b, o.relation.name, scalars, span)
					},
					o.lawIds,
					key,
					gist
				)
				continue
			}
			case "TableCheck":
				declareCheck(
					o.relation,
					named,
					{
						kind: "check",
						name,
						predicate: lowerRow(b, o.relation, o.predicate, `check ${name}`)
					},
					o.lawIds
				)
				continue
			case "ClosedCheck": {
				const { predicate } = closedMembership(
					b,
					o,
					(c) => tableCol(nativeColumn(b, o.relation.name, c)),
					(g) => lowerRow(b, o.relation, g, `check ${name}`)
				)
				declareCheck(o.relation, named, { kind: "check", name, predicate }, o.lawIds)
				continue
			}
			case "ForeignKey":
			case "PeriodForeignKey":
				continue
		}
	}
	return plans
}

/** The law columns of `relation` a lowered row expression reads, by identifier, each once, in the order it reads them. */
const lawColumnsRead = (
	b: InstallBuilder,
	relation: TableRelation,
	predicate: Expr
): ReadonlyArray<string> => {
	const lawColumns = lawColumnsOfRelation(b, relation)
	const read = new Set<string>()
	transformExpr(predicate, {
		...identityHooks,
		expr: (e) => {
			if (e.kind === "column" && e.table === undefined && lawColumns.has(e.column)) {
				read.add(e.column)
			}
			return e
		}
	})
	return [...read]
}

/** The identifiers of the law columns the law model adds to `relation`. */
const lawColumnsOfRelation = (b: InstallBuilder, relation: TableRelation): ReadonlySet<string> =>
	new Set<string>(
		b.natives.flatMap(({ object: o }) =>
			o.kind === "LawColumn" && o.relation.name === relation.name ? [o.column] : []
		)
	)

/** A row expression of `relation`'s own columns, a CHECK's predicate, a generated field's expression or a law column's
 * selection or term, lowered as persistent SQL over the table's columns: a field's by its name, or a law column the
 * law model adds to the relation by its identifier, which a family's CHECKs and a generated law column read (`at <
 * ‹n›`, a fold's `after = combine(before, x)`). A reference to anything else is refused as MalformedDescription. */
const lowerRow = (
	b: InstallBuilder,
	relation: TableRelation,
	expr: ScalarExpr,
	label: string
): Expr => {
	const lawColumns = lawColumnsOfRelation(b, relation)
	return lowerPersistent(b.names, expr, {
		reads: {
			kind: "row",
			column: (ref) =>
				relation.fields.find((f) => f.name === ref.name)?.column ??
				(lawColumns.has(ref.name) ? ref.name : undefined)
		},
		closed: persistentClosed(b.checked),
		loc: SourceLoc(label, [])
	})
}

/**
 * A row expression of `relation` lowered as `lowerRow` lowers it, with each generated field it reads replaced by that
 * field's own generation, which reads the row's written fields alone: what a generated column reads, since PostgreSQL
 * refuses a generation expression that reads another generated column (42P17, "cannot use generated column in column
 * generation expression"). The stored field holds the same value on every row, so the column computes what the law
 * reads.
 */
const lowerWrittenRow = (
	b: InstallBuilder,
	relation: TableRelation,
	expr: ScalarExpr,
	label: string
): Expr =>
	transformExpr(lowerRow(b, relation, expr, label), {
		...identityHooks,
		expr: (e) => {
			const field =
				e.kind === "column" && e.table === undefined
					? relation.fields.find((f) => f.column === e.column)
					: undefined
			return field?.writing.kind === "generated"
				? lowerRow(
						b,
						relation,
						field.writing.expr,
						`generated field ${relation.name}.${field.name}`
					)
				: e
		}
	})

/** A generated column a law adds, before its table holds it: its STORED generation, its term alone when its guard is
 * empty, a total column, NOT NULL, and otherwise `CASE WHEN <every guard conjunct> THEN <term> END`, null where the
 * guard fails, every expression lowered over the row's written fields (`lowerWrittenRow`). */
const lawColumnGeneration = (
	b: InstallBuilder,
	o: NativeOf<"LawColumn">,
	value: Extract<NativeOf<"LawColumn">["value"], { readonly kind: "generated" }>,
	label: string
): ColumnGeneration => {
	const expr = lowerWrittenRow(b, o.relation, value.term, label)
	const guard = value.guard.map((g) => lowerWrittenRow(b, o.relation, g, label))
	return isNonEmpty(guard)
		? { kind: "partial", when: guard.length === 1 ? guard[0] : and(guard), expr }
		: { kind: "stored", expr }
}

/**
 * A law column's one statement, `ALTER TABLE ... ADD COLUMN` of its field's type's base (`lawColumnType`), after its
 * table: a generated one STORED from its row (`lawColumnGeneration`), and a drawn one, a family's count copy, index,
 * parent start or fold accumulator, a plain NOT NULL column the host writes. Every law column is its own object
 * by one path, so a migration that adds a family to a relation that stands adds its columns as a fresh installation
 * does.
 */
const lawColumnDdl = (b: InstallBuilder, o: NativeOf<"LawColumn">): SqlStatement => {
	const { type, collation } = lawColumnType(b.names, o.field.type)
	return {
		kind: "alterTable",
		table: b.names.relation(o.relation.name),
		actions: [
			{
				kind: "addColumn",
				column: {
					name: o.column,
					type,
					collation,
					generated:
						o.value.kind === "generated"
							? lawColumnGeneration(b, o, o.value, `column ${o.column} of ${o.relation.name}`)
							: undefined
				}
			}
		]
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
		const ddl = [lawColumnDdl(b, o)]
		const added = b.add(
			{
				kind: "lawColumn",
				ident: {
					kind: "column",
					schema: b.names.levelOf(o.relation.name),
					relation: b.names.relationNamed(o.relation.name),
					name: n.named
				},
				ddl,
				reasons: lawReasons(o.lawIds),
				phase: "structure"
			},
			[
				b.table(o.relation.name),
				...typeNodeOf(b, lawColumnType(b.names, o.field.type)),
				...b.constantNodes(ddl)
			]
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
			case "ownCheck": {
				const ddl: ReadonlyArray<SqlStatement> = [
					{
						kind: "alterTable",
						table: b.names.relation(p.relation),
						actions: [{ kind: "addConstraint", constraint: p.constraint, notValid: false }]
					}
				]
				b.add(
					{
						kind: "check",
						ident: constraintIdent(b, p.relation, p.named),
						ddl,
						reasons: lawReasons(p.laws),
						phase: "structure"
					},
					[b.table(p.relation), ...lawColumnsOf(p.relation, p.lawColumns), ...b.constantNodes(ddl)]
				)
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
					[
						b.table(p.relation),
						...lawColumnsOf(p.relation, p.lawColumns),
						...(p.gist ? [b.provider("btree_gist")] : [])
					]
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
		columns: ReadonlyArray<NativeColumn>,
		method: "btree" | "gist"
	): ReadonlyArray<Node<"structure">> =>
		keys
			.filter(
				({ shape: k }) =>
					k.relation === relation &&
					k.method === method &&
					k.columns.length === columns.length &&
					k.columns.every((c) => columns.some((d) => sameNativeColumn(c, d)))
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
						deferrable: o.deferrable ? "INITIALLY DEFERRED" : undefined,
						onUpdate: onUpdateOf[o.onUpdate]
					},
					o.lawIds,
					[
						b.table(o.target.name),
						...keyObjectOf(o.target.name, o.targetColumns, "btree"),
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
						deferrable: o.deferrable ? "INITIALLY DEFERRED" : undefined,
						onUpdate: undefined
					},
					o.lawIds,
					[
						b.table(o.target.name),
						...keyObjectOf(o.target.name, appendNonEmpty(o.targetColumns, o.targetSpan), "gist"),
						...lawColumnsOf(o.relation.name, lawColumnsAmong(o.columns)),
						...lawColumnsOf(o.target.name, lawColumnsAmong(o.targetColumns))
					]
				)
				continue
			case "PrimaryKey":
			case "Unique":
			case "WithoutOverlaps":
			case "TableCheck":
			case "ClosedCheck":
				continue
		}
	}
	return keyIndexes
}
