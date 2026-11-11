import { canonicalTextOf, Refusal } from "#compiler/core/canonical.ts"
import { malformedArtifact } from "#compiler/core/errors.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import type { PhysicalObject } from "#compiler/ir/products.ts"
import { parseIdent, qualifiedIdent } from "#compiler/physical/obligations/graph.ts"
import {
	type ColumnDef,
	type CreateConstant,
	type CreateDomain,
	type CreateConstraintTrigger,
	type CreateGuardTrigger,
	type CreateLiveSecret,
	type CreateIndex,
	type CreateMaterializedView,
	type CreatePolicy,
	type CreatePublication,
	type CreateRole,
	type CreateSchema,
	type CreateStatistics,
	type CreateTable,
	type CreateView,
	type DomainConstraint,
	type ForeignKey,
	type GrantRole,
	type InlineConstraint,
	type ObjectName,
	type PackConstant,
	type PlFunction,
	type PrimaryKey,
	type SqlFunction,
	type SqlStatement,
	type TableConstraint,
	tableConstraints
} from "#compiler/sql/ast.ts"

import { type AstHooks, identityHooks, transformStatements } from "#compiler/sql/transform.ts"

/** An object of an installation manifest, as the deployment passes read it. */
export type ManifestObject = PhysicalObject<SqlStatement>

/**
 * A snapshot's installed object `ident` that is not the form `what` states, which grizzle wrote: a malformed snapshot.
 * A function declaration, so that control flow knows a call never returns.
 */
export function refuse(ident: string, what: string): never {
	throw new Refusal(malformedArtifact("snapshot", ["objects", ident], what))
}

/**
 * A snapshot's record of the law `law` that is not the form `what` states: a malformed snapshot. A function declaration,
 * so that control flow knows a call never returns.
 */
export function refuseLaw(law: string, what: string): never {
	throw new Refusal(malformedArtifact("snapshot", ["laws", law], what))
}

export const same = (a: unknown, b: unknown): boolean => canonicalTextOf(a) === canonicalTextOf(b)

/** An installed object read once with the statement that defines it, by its kind: the diff reads each object through
 * this view, so every object's form is checked here, once, and no rule probes a statement list again. An object whose
 * statements are not its kind's form is a defect of the compiler that built the snapshot.
 * A domain carries at most one CHECK. A `constant` is a function named by its content's digest, created by a CREATE
 * FUNCTION ... RETURN, a closed relation's stated as its hex literal, then its EXECUTE revoked from PUBLIC. A `worldFunction` is a writable
 * entry's filter function. A `role` is a login's
 * or a theory role's CREATE ROLE, and a `membership` a theory role's membership in its login. A `roleSchema` is a
 * role's schema, a `view` a role relation's view in it, a `policy` a role's policy on a table it writes, and a
 * `rowSecurity` a table's row security. A `lawColumn` is a column a law adds beside the declared fields (a constant, a
 * partial term, an arm tag): the table, the column's name, and the column as the object's one ALTER TABLE ... ADD
 * COLUMN declares it. A key, check or foreign key is a constraint of a table, by its name: a key or check the table
 * owns, where its definition stands, or a reference out of it with the definition its one ALTER TABLE ... ADD
 * CONSTRAINT adds (a foreign key is never inline). The `ledger` is the migrations ledger, by the CREATE TABLE of its
 * table. */
export type Installed =
	| { readonly kind: "table"; readonly object: ManifestObject; readonly create: CreateTable }
	| {
			readonly kind: "constant"
			readonly object: ManifestObject
			readonly create: CreateConstant | PackConstant
	  }
	| {
			readonly kind: "domain"
			readonly object: ManifestObject
			readonly create: CreateDomain
			readonly constraint: DomainConstraint | undefined
	  }
	| {
			readonly kind: "materializedView"
			readonly object: ManifestObject
			readonly create: CreateMaterializedView
	  }
	| {
			readonly kind: "index" | "uniqueIndex"
			readonly object: ManifestObject
			readonly create: CreateIndex
	  }
	| {
			readonly kind: "statistics"
			readonly object: ManifestObject
			readonly create: CreateStatistics
	  }
	| {
			readonly kind: "isolationTrigger"
			readonly object: ManifestObject
			readonly create: CreateGuardTrigger
	  }
	| {
			readonly kind: "lawTrigger"
			readonly object: ManifestObject
			readonly create: CreateConstraintTrigger
	  }
	| {
			readonly kind:
				| "refusalFunction"
				| "advanceFunction"
				| "isolationFunction"
				| "snapshotGuard"
				| "lawFunction"
			readonly object: ManifestObject
			readonly create: PlFunction
	  }
	| {
			readonly kind: "worldFunction"
			readonly object: ManifestObject
			readonly create: SqlFunction
	  }
	| { readonly kind: "role"; readonly object: ManifestObject; readonly create: CreateRole }
	| { readonly kind: "membership"; readonly object: ManifestObject; readonly grant: GrantRole }
	| { readonly kind: "privileges"; readonly object: ManifestObject; readonly grantee: string }
	| { readonly kind: "roleSchema"; readonly object: ManifestObject; readonly create: CreateSchema }
	| { readonly kind: "view"; readonly object: ManifestObject; readonly create: CreateView }
	| { readonly kind: "policy"; readonly object: ManifestObject; readonly create: CreatePolicy }
	| { readonly kind: "rowSecurity"; readonly object: ManifestObject; readonly table: ObjectName }
	| {
			readonly kind: "replicaIdentity"
			readonly object: ManifestObject
			readonly table: ObjectName
	  }
	| {
			readonly kind: "liveSecret"
			readonly object: ManifestObject
			readonly create: CreateLiveSecret
	  }
	| {
			readonly kind: "publication"
			readonly object: ManifestObject
			readonly create: CreatePublication
	  }
	| { readonly kind: "decoder"; readonly object: ManifestObject; readonly create: CreateRole }
	| {
			readonly kind: "lawColumn"
			readonly object: ManifestObject
			readonly table: ObjectName
			readonly column: string
			readonly definition: ColumnDef
	  }
	| {
			readonly kind: "primaryKey" | "unique" | "check"
			readonly object: ManifestObject
			readonly table: ObjectName
			readonly name: string
			readonly placement: Placement
	  }
	| {
			readonly kind: "foreignKey"
			readonly object: ManifestObject
			readonly table: ObjectName
			readonly name: string
			readonly constraint: ForeignKey
	  }
	| { readonly kind: "ledger"; readonly object: ManifestObject; readonly create: CreateTable }
	| {
			readonly kind: "schema" | "extension" | "validation" | "databaseDefault"
			readonly object: ManifestObject
	  }

/** The definition a key or CHECK object's kind admits: a primary key's, a candidate key's (a unique key, or a span key's
 * exclusion constraint, which installs as a unique key's object), or a CHECK's. */
export type KeyOrCheck = PrimaryKey | InlineConstraint

/** Where a key's or CHECK's definition stands: inside its table's CREATE TABLE, or in its own ALTER TABLE ... ADD
 * CONSTRAINT, as a span column's CHECK is. */
export type Placement =
	| { readonly kind: "inline" }
	| { readonly kind: "own"; readonly constraint: KeyOrCheck }

/** A constraint as the definition of an object of kind `kind`, none when that kind admits no such constraint. */
const keyOrCheckOf = (
	kind: "primaryKey" | "unique" | "check",
	c: TableConstraint
): KeyOrCheck | undefined => {
	switch (c.kind) {
		case "primaryKey":
			return kind === "primaryKey" ? c : undefined
		case "unique":
		case "exclude":
			return kind === "unique" ? c : undefined
		case "check":
			return kind === "check" ? c : undefined
		case "foreignKey":
			return undefined
	}
}

/** The table and constraint of an object's one statement, an ALTER TABLE whose one action adds the constraint `name`. */
const addedConstraint = (
	o: ManifestObject,
	name: string
): { readonly table: ObjectName; readonly constraint: TableConstraint } | undefined => {
	const [s, ...rest] = o.ddl
	if (s?.kind !== "alterTable" || rest.length > 0) {
		return undefined
	}
	const [action, ...more] = s.actions
	return action.kind === "addConstraint" && more.length === 0 && action.constraint.name === name
		? { table: s.table, constraint: action.constraint }
		: undefined
}

/** The view of one object: its kind's statement, read from its DDL. */
export const installed = (o: ManifestObject): Installed => {
	const s = o.ddl[0]
	const malformed = (form: string): never => refuse(o.ident, form)
	switch (o.kind) {
		case "table":
			return s?.kind === "createTable"
				? { kind: o.kind, object: o, create: s }
				: malformed("a CREATE TABLE")
		case "constant":
			return (s?.kind === "createConstant" || s?.kind === "packConstant") &&
				o.ddl.slice(1).every((r) => r.kind === "revoke")
				? { kind: o.kind, object: o, create: s }
				: malformed("a constant's CREATE FUNCTION or hex literal, then its revokes")
		case "domain": {
			if (o.ddl.length !== 1 || s?.kind !== "createDomain") {
				return malformed("exactly one CREATE DOMAIN")
			}
			const [constraint, ...more] = s.constraints
			return more.length === 0
				? { kind: o.kind, object: o, create: s, constraint }
				: malformed("a CREATE DOMAIN with at most one constraint")
		}
		case "materializedView":
			return s?.kind === "createMaterializedView"
				? { kind: o.kind, object: o, create: s }
				: malformed("a materialized view")
		case "index":
		case "uniqueIndex":
			return s?.kind === "createIndex"
				? { kind: o.kind, object: o, create: s }
				: malformed("a CREATE INDEX")
		case "statistics":
			return s?.kind === "createStatistics"
				? { kind: o.kind, object: o, create: s }
				: malformed("a CREATE STATISTICS")
		case "isolationTrigger":
			return s?.kind === "createGuardTrigger"
				? { kind: o.kind, object: o, create: s }
				: malformed("a table's isolation trigger installed by its CREATE TRIGGER")
		case "lawTrigger":
			return o.ddl.length === 1 && s?.kind === "createConstraintTrigger"
				? { kind: o.kind, object: o, create: s }
				: malformed("a rule's trigger installed by its CREATE CONSTRAINT TRIGGER")
		case "refusalFunction":
		case "advanceFunction":
		case "isolationFunction":
		case "snapshotGuard":
		case "lawFunction":
			return s?.kind === "createFunction" && s.language === "plpgsql"
				? { kind: o.kind, object: o, create: s }
				: malformed("a CREATE FUNCTION ... LANGUAGE plpgsql")
		case "worldFunction":
			return s?.kind === "createFunction" && s.language === "sql"
				? { kind: o.kind, object: o, create: s }
				: malformed("a CREATE FUNCTION ... LANGUAGE sql")
		case "role":
			return s?.kind === "createRole"
				? { kind: o.kind, object: o, create: s }
				: malformed("a CREATE ROLE")
		case "membership":
			return o.ddl.length === 1 && s?.kind === "grantRole"
				? { kind: o.kind, object: o, grant: s }
				: malformed("exactly one GRANT of a role to its login")
		case "roleSchema":
			return o.ddl.length === 1 && s?.kind === "createSchema"
				? { kind: o.kind, object: o, create: s }
				: malformed("exactly one CREATE SCHEMA")
		case "view":
			return o.ddl.length === 1 && s?.kind === "createView"
				? { kind: o.kind, object: o, create: s }
				: malformed("exactly one CREATE VIEW")
		case "policy":
			return o.ddl.length === 1 && s?.kind === "createPolicy"
				? { kind: o.kind, object: o, create: s }
				: malformed("exactly one CREATE POLICY")
		case "rowSecurity": {
			const [action, ...more] = s?.kind === "alterTable" && o.ddl.length === 1 ? s.actions : []
			return s?.kind === "alterTable" && action?.kind === "enableRowSecurity" && more.length === 0
				? { kind: o.kind, object: o, table: s.table }
				: malformed("exactly one ALTER TABLE ... ENABLE ROW LEVEL SECURITY")
		}
		case "replicaIdentity": {
			const [action, ...more] = s?.kind === "alterTable" && o.ddl.length === 1 ? s.actions : []
			return s?.kind === "alterTable" &&
				action?.kind === "replicaIdentity" &&
				action.identity === "full" &&
				more.length === 0
				? { kind: o.kind, object: o, table: s.table }
				: malformed("exactly one ALTER TABLE ... REPLICA IDENTITY FULL")
		}
		case "liveSecret":
			return s?.kind === "createLiveSecret" && o.ddl.slice(1).every((r) => r.kind === "revoke")
				? { kind: o.kind, object: o, create: s }
				: malformed("the live secret's CREATE TABLE ... AS, then its revokes")
		case "publication":
			return o.ddl.length === 1 && s?.kind === "createPublication"
				? { kind: o.kind, object: o, create: s }
				: malformed("exactly one CREATE PUBLICATION")
		case "decoder":
			return o.ddl.length === 1 && s?.kind === "createRole" && s.login
				? { kind: o.kind, object: o, create: s }
				: malformed("exactly one CREATE ROLE ... LOGIN")
		case "privileges": {
			const grantee = o.ddl
				.flatMap((g) => (g.kind === "grant" ? g.to : []))
				.find((to) => to.kind === "role")
			return grantee?.kind === "role"
				? { kind: o.kind, object: o, grantee: grantee.name }
				: malformed("a grant to a role")
		}
		case "lawColumn": {
			const ident = parseIdent(o.ident)
			const [action, ...more] = s?.kind === "alterTable" && o.ddl.length === 1 ? s.actions : []
			return ident.kind === "column" &&
				s?.kind === "alterTable" &&
				action?.kind === "addColumn" &&
				more.length === 0 &&
				action.column.name === ident.name
				? { kind: o.kind, object: o, table: s.table, column: ident.name, definition: action.column }
				: malformed("a column of a table its one ALTER TABLE ... ADD COLUMN adds")
		}
		case "primaryKey":
		case "unique":
		case "check": {
			const ident = parseIdent(o.ident)
			if (ident.kind !== "constraint") {
				return malformed("a table constraint")
			}
			const name = ident.name
			if (o.ddl.length === 0) {
				return {
					kind: o.kind,
					object: o,
					table: { schema: ident.schema, name: ident.relation },
					name,
					placement: { kind: "inline" }
				}
			}
			const kind = o.kind
			const added = addedConstraint(o, name)
			const constraint = added === undefined ? undefined : keyOrCheckOf(kind, added.constraint)
			return added !== undefined && constraint !== undefined
				? {
						kind,
						object: o,
						table: added.table,
						name,
						placement: { kind: "own", constraint }
					}
				: malformed(`a ${o.kind} its table declares or its one ALTER TABLE ... ADD CONSTRAINT adds`)
		}
		case "foreignKey": {
			const ident = parseIdent(o.ident)
			if (ident.kind !== "constraint") {
				return malformed("a table constraint")
			}
			const added = addedConstraint(o, ident.name)
			return added?.constraint.kind === "foreignKey"
				? {
						kind: o.kind,
						object: o,
						table: added.table,
						name: ident.name,
						constraint: added.constraint
					}
				: malformed("a foreign key its one ALTER TABLE ... ADD CONSTRAINT adds")
		}
		case "ledger":
			return s?.kind === "createTable"
				? { kind: o.kind, object: o, create: s }
				: malformed("the migrations ledger by its CREATE TABLE")
		case "schema":
		case "extension":
		case "validation":
		case "databaseDefault":
			return { kind: o.kind, object: o }
	}
}

/** The table or materialized view an object belongs to, read off its view: a relation's own, the table an index, a
 * statistics object, a law or isolation trigger, a constraint or a law column is on, and the ledger's. Every other kind
 * stands outside any table. */
export const objectTable = (o: ManifestObject): ObjectName | undefined => {
	const v = installed(o)
	switch (v.kind) {
		case "table":
		case "ledger":
			return v.create.table
		case "materializedView":
			return v.create.name
		case "index":
		case "uniqueIndex":
		case "statistics":
		case "isolationTrigger":
		case "lawTrigger":
			return v.create.table
		case "primaryKey":
		case "unique":
		case "check":
		case "foreignKey":
		case "lawColumn":
		case "rowSecurity":
		case "replicaIdentity":
			return v.table
		case "policy":
		case "liveSecret":
			return v.create.table
		case "constant":
		case "domain":
		case "refusalFunction":
		case "advanceFunction":
		case "isolationFunction":
		case "snapshotGuard":
		case "lawFunction":
		case "worldFunction":
		case "role":
		case "membership":
		case "privileges":
		case "publication":
		case "decoder":
		case "roleSchema":
		case "view":
		case "schema":
		case "extension":
		case "validation":
		case "databaseDefault":
			return undefined
	}
}

/** Every unqualified or qualified column name an expression or statement names, and every column of a trigger's row
 * image, NEW or OLD, it reads. */
const columnsOf = (value: unknown): ReadonlyArray<string> => {
	const out = new Set<string>()
	const walk = (v: unknown): void => {
		if (isList(v)) {
			for (const x of v) {
				walk(x)
			}
			return
		}
		if (!isRecord(v)) {
			return
		}
		const r: { readonly [key: string]: unknown } = v
		if (r["kind"] === "column" && typeof r["column"] === "string") {
			out.add(r["column"])
		}
		const record = r["record"]
		if (
			r["kind"] === "field" &&
			isRecord(record) &&
			record["kind"] === "plSpecial" &&
			typeof r["field"] === "string"
		) {
			out.add(r["field"])
		}
		for (const child of Object.values(r)) {
			walk(child)
		}
	}
	walk(value)
	return [...out]
}

/** Every column a generated column's expression reads: none for a column its caller writes. */
export const generationColumns = (c: ColumnDef): ReadonlyArray<string> =>
	c.generated?.kind === "stored" ? columnsOf(c.generated.expr) : []

/** Every column a constraint reads. */
export const constraintColumns = (c: TableConstraint): ReadonlyArray<string> => {
	switch (c.kind) {
		case "primaryKey":
		case "unique":
			return c.columns.map((k) => k.column)
		case "foreignKey":
			return c.columns.map((k) => k.column)
		case "exclude":
			return c.elements.map((e) => e.column)
		case "check":
			return columnsOf(c.predicate)
	}
}

/** Every column an index reads: its keys, its INCLUDE columns and its predicate's. */
const indexColumns = (s: CreateIndex): ReadonlyArray<string> =>
	columnsOf(s.keys).concat(s.include, columnsOf(s.where ?? []))

/** A key or CHECK object, read through its view. */
export type KeyOrCheckView = Installed & { readonly kind: "primaryKey" | "unique" | "check" }

/** The definition of a key or CHECK object: its own, or the one its table's CREATE TABLE among `objects` declares under
 * its name, of its kind. An inline constraint its table does not declare is a defect of the compiler that built the
 * snapshot. */
export const keyOrCheckDefinition = (
	c: KeyOrCheckView,
	objects: ReadonlyMap<string, ManifestObject>
): KeyOrCheck => {
	if (c.placement.kind === "own") {
		return c.placement.constraint
	}
	const table = objects.get(qualifiedIdent("table", c.table.schema, c.table.name))
	const create = table === undefined ? undefined : installed(table)
	const declared =
		create?.kind === "table"
			? tableConstraints(create.create).find((x) => x.name === c.name)
			: undefined
	const inline = declared === undefined ? undefined : keyOrCheckOf(c.kind, declared)
	return inline ?? refuse(c.object.ident, `a ${c.kind} its table declares`)
}

/** A table and columns of it that an object's definition reads. */
export interface BuiltOver {
	readonly table: ObjectName
	readonly columns: ReadonlyArray<string>
}

/** What an object is built over, read for every installed kind in this one place, so every rule asking what a change of
 * a column reaches (a column converted in place by a type change, dropped and added again, or renamed by a declared
 * rename) asks it here: an index reads its keys, INCLUDE columns and predicate; a statistics object its columns; a
 * constraint its own, `constraint` giving the definition of one declared inside its table's CREATE TABLE; a law column
 * the columns its generation reads, a partial term
 * those of its selection and its term, an alternatives parent's arm tag its discriminator and a constant none. Nothing
 * else is built over a table's columns: a table holds them, a table's isolation trigger reads none, and every other kind
 * stands outside any table. */
export const builtOver = (
	v: Installed,
	constraint: (c: KeyOrCheckView) => KeyOrCheck
): BuiltOver | undefined => {
	switch (v.kind) {
		case "index":
		case "uniqueIndex":
			return { table: v.create.table, columns: indexColumns(v.create) }
		case "statistics":
			return { table: v.create.table, columns: v.create.columns }
		case "primaryKey":
		case "unique":
		case "check":
			return { table: v.table, columns: constraintColumns(constraint(v)) }
		case "foreignKey":
			return { table: v.table, columns: constraintColumns(v.constraint) }
		case "lawColumn":
			return { table: v.table, columns: columnsOf(v.definition.generated) }
		case "lawTrigger":
			return {
				table: v.create.table,
				columns: v.create.events.flatMap((e) => (e.kind === "update" ? e.columns : []))
			}
		case "table":
		case "constant":
		case "domain":
		case "materializedView":
		case "refusalFunction":
		case "advanceFunction":
		case "isolationFunction":
		case "snapshotGuard":
		case "lawFunction":
		case "isolationTrigger":
		case "worldFunction":
		case "role":
		case "membership":
		case "privileges":
		case "roleSchema":
		case "view":
		case "policy":
		case "rowSecurity":
		case "replicaIdentity":
		case "liveSecret":
		case "publication":
		case "decoder":
		case "schema":
		case "extension":
		case "ledger":
		case "validation":
		case "databaseDefault":
			return undefined
	}
}

/** The kinds of part a relation owns under a name of its own, in the order a relation's rename takes them: its
 * constraints, its indexes, its extended statistics objects, the columns it holds beside its declared fields (a law
 * column's), and the identity sequences of its serial fields. A constraint's and a column's name lies in its table's
 * namespace; an index's and a sequence's in its
 * schema's relations and a statistics object's in its schema's statistics objects, but each is built over one table and
 * stands or goes with it. */
const partKinds = ["constraint", "index", "statistics", "column", "sequence"] as const
export type PartKind = (typeof partKinds)[number]

/** A part of a relation: its kind, the table it belongs to, its name, and its definition. A constraint declared inside
 * its table's CREATE TABLE is `inline`. */
export type Part =
	| {
			readonly kind: "constraint"
			readonly table: ObjectName
			readonly name: string
			readonly constraint: TableConstraint
			readonly inline: boolean
	  }
	| {
			readonly kind: "index"
			readonly table: ObjectName
			readonly name: string
			readonly create: CreateIndex
	  }
	| {
			readonly kind: "statistics"
			readonly table: ObjectName
			readonly name: string
			readonly create: CreateStatistics
	  }
	| {
			readonly kind: "column"
			readonly table: ObjectName
			readonly name: string
			readonly definition: ColumnDef
	  }
	| {
			readonly kind: "sequence"
			readonly table: ObjectName
			readonly name: string
			readonly column: string
			readonly sequence: ObjectName
	  }

export type PartOf<K extends PartKind> = Extract<Part, { readonly kind: K }>

/** The parts of a relation an object is, read for every installed kind in this one place, so every rule that carries a
 * relation's parts across a rename, or takes away what one leaves behind, reads one list and no kind of part can be
 * left out of one of them: a key, check or foreign key, by its name, `constraint` giving the definition of one declared
 * inside its table's CREATE TABLE; an index; a statistics object; a law column; and a table's identity
 * sequences, one per serial field, in its field order. Nothing else is a part: the table itself is the relation, and
 * every other kind stands outside any table. */
const objectParts = (
	v: Installed,
	constraint: (c: KeyOrCheckView) => KeyOrCheck
): ReadonlyArray<Part> => {
	switch (v.kind) {
		case "primaryKey":
		case "unique":
		case "check": {
			const c = constraint(v)
			return [
				{
					kind: "constraint",
					table: v.table,
					name: c.name,
					constraint: c,
					inline: v.placement.kind === "inline"
				}
			]
		}
		case "foreignKey":
			return [
				{
					kind: "constraint",
					table: v.table,
					name: v.name,
					constraint: v.constraint,
					inline: false
				}
			]
		case "index":
		case "uniqueIndex":
			return [{ kind: "index", table: v.create.table, name: v.create.name, create: v.create }]
		case "statistics":
			return [
				{
					kind: "statistics",
					table: v.create.table,
					name: v.create.name.name,
					create: v.create
				}
			]
		case "lawColumn":
			return [{ kind: "column", table: v.table, name: v.column, definition: v.definition }]
		case "table": {
			const table = v.create.table
			return v.create.columns.flatMap((c): ReadonlyArray<Part> =>
				c.generated?.kind === "identity"
					? [
							{
								kind: "sequence",
								table,
								name: c.generated.sequence.name,
								column: c.name,
								sequence: c.generated.sequence
							}
						]
					: []
			)
		}
		case "isolationTrigger":
		case "lawTrigger":
		case "constant":
		case "domain":
		case "materializedView":
		case "refusalFunction":
		case "advanceFunction":
		case "isolationFunction":
		case "snapshotGuard":
		case "lawFunction":
		case "worldFunction":
		case "role":
		case "membership":
		case "privileges":
		case "roleSchema":
		case "view":
		case "policy":
		case "rowSecurity":
		case "replicaIdentity":
		case "liveSecret":
		case "publication":
		case "decoder":
		case "schema":
		case "extension":
		case "ledger":
		case "validation":
		case "databaseDefault":
			return []
	}
}

/** The parts of a relation of each kind, by name, in the order of the objects that hold them. */
export type Parts = { readonly [K in PartKind]: ReadonlyMap<string, PartOf<K>> }

/** The parts of a relation that holds none. */
const noParts: Parts = {
	constraint: new Map(),
	index: new Map(),
	statistics: new Map(),
	column: new Map(),
	sequence: new Map()
}

/** The parts of the relation `t` in `parts` (partsByTable), none where it holds none. */
export const partsAt = (parts: ReadonlyMap<string, Parts>, t: ObjectName): Parts =>
	parts.get(nameKey(t)) ?? noParts

/** The parts of every relation among `among`, by its name key, each of each kind by name, in the order of the objects
 * that hold them (objectParts); a constraint declared inside its table's CREATE TABLE read from `objects`. One pass reads
 * every object once, whatever number of relations a caller then reads the parts of. */
export const partsByTable = (
	among: Iterable<ManifestObject>,
	objects: ReadonlyMap<string, ManifestObject>
): ReadonlyMap<string, Parts> => {
	const byTable = new Map<
		string,
		{
			readonly constraint: Map<string, PartOf<"constraint">>
			readonly index: Map<string, PartOf<"index">>
			readonly statistics: Map<string, PartOf<"statistics">>
			readonly column: Map<string, PartOf<"column">>
			readonly sequence: Map<string, PartOf<"sequence">>
		}
	>()
	for (const o of among) {
		for (const part of objectParts(installed(o), (c) => keyOrCheckDefinition(c, objects))) {
			const key = nameKey(part.table)
			const known = byTable.get(key)
			const parts = known ?? {
				constraint: new Map<string, PartOf<"constraint">>(),
				index: new Map<string, PartOf<"index">>(),
				statistics: new Map<string, PartOf<"statistics">>(),
				column: new Map<string, PartOf<"column">>(),
				sequence: new Map<string, PartOf<"sequence">>()
			}
			if (known === undefined) {
				byTable.set(key, parts)
			}
			switch (part.kind) {
				case "constraint":
					parts.constraint.set(part.name, part)
					continue
				case "index":
					parts.index.set(part.name, part)
					continue
				case "statistics":
					parts.statistics.set(part.name, part)
					continue
				case "column":
					parts.column.set(part.name, part)
					continue
				case "sequence":
					parts.sequence.set(part.name, part)
					continue
			}
		}
	}
	return byTable
}

/** The key of a name in a set or map: `<schema>.<name>`. */
export const nameKey = (name: ObjectName): string => `${name.schema}.${name.name}`

/** Renames of schema-qualified names of one catalog namespace (`NameSpace`): a relation's, with its indexes' and
 * identity sequences', all in pg_class, a type's, or an extended statistics object's. */
export interface QualifiedNames {
	readonly namespace: "relation" | "type" | "statistics"
	readonly names: ReadonlyMap<string, string>
}

/** Renames of the names that lie in a relation's own namespace, its constraints', by the relation's name in the schema:
 * a key's constraint, whose index PostgreSQL renames with it. */
export interface ConstraintNames {
	readonly namespace: "constraint"
	readonly names: ReadonlyMap<string, ReadonlyMap<string, string>>
}

/** Renames of the names of one namespace: a schema's catalog namespace, or each relation's own. */
export type QualifiedRenames = QualifiedNames | ConstraintNames

export const inRelations = (names: ReadonlyMap<string, string>): QualifiedNames => ({
	namespace: "relation",
	names
})

export const inTypes = (names: ReadonlyMap<string, string>): QualifiedNames => ({
	namespace: "type",
	names
})

export const inStatistics = (names: ReadonlyMap<string, string>): QualifiedNames => ({
	namespace: "statistics",
	names
})

export const inConstraints = (
	names: ReadonlyMap<string, ReadonlyMap<string, string>>
): ConstraintNames => ({ namespace: "constraint", names })

/** The rewrite hooks that rename every name in `schema` that `renames` maps and that is looked up in its namespace, at
 * once, so two names may swap: an object name of that namespace, and for types a named TypeRef; or, a relation's own
 * namespace, a constraint name of a statement on that relation, by the relation's name the statement spells. Every
 * other value is shared. A name of another namespace is never renamed. Across a migration one name may denote a removed
 * relation and an added type, such as a roster renamed onto the name a relation left, and the relation's rename then
 * leaves the type's references alone. */
const renameHooks = (schema: string, renames: QualifiedRenames): AstHooks => {
	switch (renames.namespace) {
		case "constraint": {
			const scoped = renames.names
			return {
				...identityHooks,
				constraintName: (table, name) =>
					(table.schema === schema ? scoped.get(table.name)?.get(name) : undefined) ?? name
			}
		}
		case "relation":
		case "type":
		case "statistics": {
			const { namespace, names } = renames
			const renamed = <Q extends ObjectName>(q: Q): Q => {
				if (q.schema !== schema) {
					return q
				}
				const to = names.get(q.name)
				return to === undefined ? q : { ...q, name: to }
			}
			return {
				...identityHooks,
				objectName: (q, space) => (space === namespace ? renamed(q) : q),
				typeRef: (t) => (namespace === "type" && t.kind === "named" ? renamed(t) : t)
			}
		}
	}
}

/** A list of statements with every schema-qualified name in `schema` that `renames` maps renamed: the same list when
 * none is. */
export const renameQualified = (
	statements: ReadonlyArray<SqlStatement>,
	schema: string,
	renames: QualifiedRenames
): ReadonlyArray<SqlStatement> =>
	renames.names.size === 0
		? statements
		: transformStatements(statements, renameHooks(schema, renames))
