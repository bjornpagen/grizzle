import { Array as Arr, Option, Order, Record as Rec } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import {
	type BuiltinTypeName,
	type ColumnDef,
	type CreateDomain,
	type CreateIndex,
	type CreateTable,
	type ForeignKeyColumn,
	type Grant,
	type KeyColumn,
	type ObjectName,
	type SqlStatement,
	type TableConstraint,
	type TypeRef,
	tableConstraints
} from "#compiler/sql/ast.ts"
import { storedSettingValue } from "#compiler/sql/print.ts"

import { types } from "#compiler/sql/build.ts"
import type {
	Catalog,
	CatalogGeneration,
	CatalogGrant,
	CatalogType
} from "#test/support/catalog/read.ts"

interface ProjectedType {
	readonly schema: string
	readonly name: string
	readonly typmod: number
}

/** How a column's value is made, as the manifest decides it: the default and the expression are PostgreSQL's deparse. */
type ProjectedGeneration =
	| { readonly kind: "given" }
	| { readonly kind: "default"; readonly expression: string }
	| { readonly kind: "identity"; readonly always: boolean; readonly sequence: string }
	| { readonly kind: "computed"; readonly stored: boolean }

const projectGeneration = (g: CatalogGeneration): ProjectedGeneration => {
	switch (g.kind) {
		case "given":
			return Option.match(g.default, {
				onNone: (): ProjectedGeneration => ({ kind: "given" }),
				onSome: (expression): ProjectedGeneration => ({ kind: "default", expression })
			})
		case "identity":
			return { kind: "identity", always: g.always, sequence: g.sequence }
		case "computed":
			return { kind: "computed", stored: g.stored }
	}
}

export interface ProjectedCatalog {
	readonly tables: ReadonlyArray<{
		readonly name: string
		readonly columns: ReadonlyArray<{
			readonly name: string
			readonly type: ProjectedType
			readonly notNull: boolean
			readonly collation: Option.Option<string>
			readonly generation: ProjectedGeneration
		}>
		readonly constraints: ReadonlyArray<{
			readonly name: string
			readonly type: string
			readonly columns: ReadonlyArray<string>
			readonly withoutOverlaps: boolean
			readonly period: boolean
			readonly references: Option.Option<string>
			readonly referencedColumns: ReadonlyArray<string>
			readonly deferrable: boolean
			readonly deferred: boolean
			/** Validated: a fresh install leaves no NOT VALID constraint. */
			readonly validated: boolean
		}>
	}>
	readonly indexes: ReadonlyArray<{
		readonly name: string
		readonly table: string
		readonly unique: boolean
		readonly method: string
		readonly columns: ReadonlyArray<string>
		readonly partial: boolean
		/** pg_index.indisvalid: a fresh install builds every index valid. */
		readonly valid: boolean
	}>
	/** The pg_enum rows of the schema's types: none, a roster being a smallint domain. */
	readonly enumLabels: number
	readonly domains: ReadonlyArray<{
		readonly name: string
		readonly base: ProjectedType
		readonly notNull: boolean
		readonly collation: Option.Option<string>
		readonly constraints: ReadonlyArray<string>
	}>
	readonly sequences: ReadonlyArray<{ readonly name: string; readonly ownedBy: string }>
	readonly roles: ReadonlyArray<{
		readonly name: string
		readonly login: boolean
		readonly config: ReadonlyArray<string>
		/** The roles it is a member of, sorted. */
		readonly memberOf: ReadonlyArray<string>
	}>
	/** Each world's schema to its views' names, sorted. */
	readonly worlds: Readonly<Record<string, ReadonlyArray<string>>>
	/** The tables with row security, sorted, and each policy as `<table>.<name> to <role>`, sorted. */
	readonly rowSecure: ReadonlyArray<string>
	readonly policies: ReadonlyArray<string>
	/**
	 * Every grant but the owner's, by its object's kind and name (an object of a world's schema `<schema>.<name>`, a
	 * column `<table>.<column>`), grantee and privilege, each once, in that order.
	 */
	readonly grants: ReadonlyArray<ProjectedGrant>
}

/** pg_type.typname of every builtin type, by its SQL spelling. */
const builtinTypname: { readonly [K in BuiltinTypeName]: string } = {
	smallint: "int2",
	integer: "int4",
	bigint: "int8",
	numeric: "numeric",
	real: "float4",
	"double precision": "float8",
	boolean: "bool",
	text: "text",
	uuid: "uuid",
	date: "date",
	bytea: "bytea",
	jsonb: "jsonb",
	money: "money",
	int4range: "int4range",
	int8range: "int8range",
	int4multirange: "int4multirange",
	int8multirange: "int8multirange",
	daterange: "daterange",
	datemultirange: "datemultirange",
	record: "record",
	"bit varying": "varbit",
	name: "name"
}

const cUtf8 = "pg_catalog.pg_c_utf8"

const byName = <A extends { readonly name: string }>(xs: ReadonlyArray<A>): ReadonlyArray<A> =>
	Arr.sort(
		xs,
		Order.mapInput(Order.String, (x: { readonly name: string }) => x.name)
	)

/**
 * The kinds of object a projected grant is keyed by: an enum's and a domain's grants are both a type's, and a view's a
 * table's.
 */
export type GrantKind = "schema" | "table" | "column" | "sequence" | "type" | "function"

/** One grant of a projection: its object by kind and name, its grantee and its privilege. */
export interface ProjectedGrant {
	readonly kind: GrantKind
	readonly name: string
	readonly grantee: string
	readonly privilege: string
}

/** A projection's grants, each once, in the order ProjectedCatalog.grants keeps. */
export const projectedGrants = (
	grants: ReadonlyArray<ProjectedGrant>
): ReadonlyArray<ProjectedGrant> =>
	Arr.sort(
		Arr.dedupe(grants),
		Order.Struct({
			kind: Order.String,
			name: Order.String,
			grantee: Order.String,
			privilege: Order.String
		})
	)

const type = (t: CatalogType): ProjectedType => ({
	schema: t.schema,
	name: t.name,
	typmod: t.typmod
})

/** The projection of an installed catalog, for comparison with expectedCatalog. */
export const projectCatalog = (catalog: Catalog): ProjectedCatalog => {
	const grants: Array<ProjectedGrant> = []
	const put = (kind: GrantKind, name: string, list: ReadonlyArray<CatalogGrant>) => {
		appendAll(
			grants,
			Arr.map(
				Arr.filter(list, (g) => g.grantee !== catalog.owner),
				(g) => ({ kind, name, grantee: g.grantee, privilege: g.privilege })
			)
		)
	}
	put("schema", catalog.schema, catalog.schemaGrants)
	for (const t of catalog.tables) {
		put("table", t.name, t.grants)
		for (const column of new Set(Arr.map(t.columnGrants, (g) => g.column))) {
			put(
				"column",
				`${t.name}.${column}`,
				Arr.filter(t.columnGrants, (g) => g.column === column)
			)
		}
	}
	for (const w of catalog.worlds) {
		put("schema", w.name, w.grants)
		for (const v of w.relations) {
			put("table", `${w.name}.${v.name}`, v.grants)
		}
	}
	for (const s of catalog.sequences) {
		put("sequence", s.name, s.grants)
	}
	for (const d of catalog.domains) {
		put("type", d.name, d.grants)
	}
	for (const f of catalog.functions) {
		put("function", f.name, f.grants)
	}
	return {
		tables: byName(
			Arr.map(catalog.tables, (t) => ({
				name: t.name,
				columns: Arr.map(t.columns, (c) => ({
					name: c.name,
					type: type(c.type),
					notNull: c.notNull,
					collation: c.collation,
					generation: projectGeneration(c.generation)
				})),
				constraints: byName(
					Arr.map(t.constraints, (k) => ({
						name: k.name,
						type: k.type,
						/**
						 * A CHECK's conkey lists the columns its expression reads; the manifest states the expression.
						 */
						columns: k.type === "c" ? [] : k.columns,
						withoutOverlaps: k.withoutOverlaps,
						period: k.period,
						references: k.references,
						referencedColumns: k.referencedColumns,
						deferrable: k.deferrable,
						deferred: k.deferred,
						validated: k.validated
					}))
				)
			}))
		),
		indexes: byName(
			Arr.map(catalog.indexes, (i) => ({
				name: i.name,
				table: i.table,
				unique: i.unique,
				method: i.method,
				columns: i.columns,
				partial: Option.isSome(i.predicate),
				valid: i.valid
			}))
		),
		enumLabels: catalog.enumLabels,
		domains: byName(
			Arr.map(catalog.domains, (d) => ({
				name: d.name,
				base: type(d.base),
				notNull: d.notNull,
				collation: d.collation,
				constraints: Arr.sort(
					Arr.map(d.constraints, (c) => c.name),
					Order.String
				)
			}))
		),
		sequences: byName(Arr.map(catalog.sequences, (s) => ({ name: s.name, ownedBy: s.ownedBy }))),
		roles: byName(
			Arr.map(catalog.roles, (r) => ({
				name: r.name,
				login: r.login,
				config: r.config,
				memberOf: Arr.sort(
					Arr.map(r.memberOf, (m) => m.role),
					Order.String
				)
			}))
		),
		worlds: Rec.fromEntries(
			Arr.map(catalog.worlds, (w) => [
				w.name,
				Arr.sort(
					Arr.map(w.relations, (v) => v.name),
					Order.String
				)
			])
		),
		rowSecure: Arr.sort(
			Arr.flatMap(catalog.tables, (t) => (t.rowSecurity ? [t.name] : [])),
			Order.String
		),
		policies: Arr.sort(
			Arr.map(catalog.policies, (p) => `${p.table}.${p.name} to ${Arr.join(p.roles, ", ")}`),
			Order.String
		),
		grants: projectedGrants(grants)
	}
}

/**
 * A column's generation as grizzle declares it: GENERATED ALWAYS AS IDENTITY, the uuidv7() default or a retirement
 * field's false, as pg_get_expr spells each, or GENERATED ALWAYS AS (expr) STORED, a partial projection's expr its CASE.
 */
const expectedGeneration = (g: ColumnDef["generated"]): ProjectedGeneration => {
	if (g === undefined) {
		return { kind: "given" }
	}
	switch (g.kind) {
		case "identity":
			return { kind: "identity", always: true, sequence: `${g.sequence.schema}.${g.sequence.name}` }
		case "uuidv7":
			return { kind: "default", expression: "uuidv7()" }
		case "retirement":
			return { kind: "default", expression: "false" }
		case "stored":
		case "partial":
			return { kind: "computed", stored: true }
	}
}

/**
 * The catalog a manifest promises, and the same projection of an installed catalog, so a test compares the two with one
 * deep equality over columns, typmods and non-nullability; every serial column's GENERATED ALWAYS identity and its
 * named sequence; native constraint validation and timing; unique and index opclass and predicate identity; and the
 * worlds: every login and world role with its defaults and memberships, every world's views, the tables with row
 * security and their policies, and every grant, column grants and the worlds' own included.
 *
 * The expectation is derived from the installation's structured SQL AST, never from its text, and the projection keeps
 * what the manifest decides: names, column order and types, NOT NULL, collation, identities and generated columns,
 * constraint kinds, columns, references, deferral and validation, index methods, columns, uniqueness and validity, no
 * pg_enum row, domain bases and constraint names, sequence ownership, role defaults, and every non-owner grant.
 * Expression texts (CHECK bodies, predicates, generation expressions) are PostgreSQL's deparse and are checked by the
 * erasure verifier's shape rules instead (verify.ts).
 *
 * The catalog the installation's manifest promises.
 */
export const expectedCatalog = (installation: Installation): ProjectedCatalog => {
	const schema = installation.names.schema
	const statements: ReadonlyArray<SqlStatement> = installation.statements
	const domains = new Map<string, CreateDomain>()
	for (const s of statements) {
		if (s.kind === "createDomain" && s.name.schema === schema) {
			domains.set(s.name.name, s)
		}
	}
	const projectType = (t: TypeRef): ProjectedType => {
		if (t.kind === "builtin" && t.name === "bit") {
			return { schema: "pg_catalog", name: "bit", typmod: t.length }
		}
		if (t.kind === "builtin") {
			const name = builtinTypname[t.name]
			const typmod =
				t.name === "numeric" && t.precision !== undefined
					? ((t.precision << 16) | ((t.scale ?? 0) & 0xffff)) + 4
					: -1
			return { schema: "pg_catalog", name, typmod }
		}
		return { schema: t.schema, name: t.name, typmod: t.typmod[0] ?? -1 }
	}
	/** The collation a column or domain of this type has: text's and every domain's down to text. */
	const collationOf = (t: TypeRef, declared: ColumnDef["collation"]): Option.Option<string> => {
		if (declared !== undefined) {
			return Option.some(cUtf8)
		}
		if (t.kind === "builtin") {
			return t.name === "text" ? Option.some(cUtf8) : Option.none()
		}
		const d = t.schema === schema ? domains.get(t.name) : undefined
		if (d === undefined) {
			return Option.none()
		}
		return collationOf(d.base, d.collation)
	}
	/**
	 * Each table constraint with whether the manifest leaves it validated: an ADD CONSTRAINT ... NOT VALID does not.
	 */
	const tables = new Map<
		string,
		{
			name: string
			columns: Array<ColumnDef>
			constraints: Array<{ readonly constraint: TableConstraint; readonly validated: boolean }>
		}
	>()
	const indexes: Array<ProjectedCatalog["indexes"][number]> = []
	const sequences: Array<ProjectedCatalog["sequences"][number]> = []
	const grants: Array<ProjectedGrant> = []
	const roles = new Map<
		string,
		{ readonly login: boolean; readonly config: Array<string>; readonly memberOf: Array<string> }
	>()
	const worlds = new Map<string, Array<string>>()
	const rowSecure = new Set<string>()
	const policies: Array<string> = []
	/** An object of the installed schema by its name, one of a world's schema by its qualified name. */
	const objectKey = (name: ObjectName): string =>
		name.schema === schema ? name.name : `${name.schema}.${name.name}`
	const grantTo = (on: readonly [GrantKind, string], grantee: string, privilege: string) => {
		grants.push({ kind: on[0], name: on[1], grantee, privilege })
	}
	const tableOf = (name: ObjectName) => {
		const t = tables.get(name.name)
		if (t === undefined) {
			throw new Error(`expected catalog: no table ${name.name}`)
		}
		return t
	}
	const keyIndex = (table: string, c: TableConstraint) => {
		if (c.kind !== "primaryKey" && c.kind !== "unique") {
			return
		}
		const gist = Arr.some(c.columns, (k: KeyColumn) => k.withoutOverlaps)
		indexes.push({
			name: c.name,
			table,
			unique: true,
			method: gist ? "gist" : "btree",
			columns: Arr.map(c.columns, (k) => k.column),
			partial: false,
			valid: true
		})
	}
	const grantNames = (g: Grant): ReadonlyArray<readonly [GrantKind, string]> => {
		switch (g.on.kind) {
			case "SCHEMA":
				return Arr.map(
					Arr.filter(g.on.names, (n) => n === schema || worlds.has(n)),
					(n) => ["schema", n] as const
				)
			case "TABLE":
				return Arr.map(g.on.names, (n) => ["table", objectKey(n)] as const)
			case "SEQUENCE":
				return Arr.map(g.on.names, (n) => ["sequence", n.name] as const)
			case "DOMAIN":
				return Arr.map(g.on.names, (n) => ["type", n.name] as const)
			case "FUNCTION":
				return Arr.map(g.on.names, (n) => ["function", n.name] as const)
			case "DATABASE":
				return []
		}
	}
	for (const s of statements) {
		switch (s.kind) {
			case "createLiveSecret":
				tables.set(s.table.name, {
					name: s.table.name,
					columns: [
						{ name: "secret", type: types.bytea, collation: undefined, generated: undefined }
					],
					constraints: []
				})
				break
			case "createTable": {
				const t: CreateTable = s
				tables.set(t.table.name, {
					name: t.table.name,
					columns: [...t.columns],
					constraints: Arr.map(tableConstraints(t), (constraint) => ({
						constraint,
						validated: true
					}))
				})
				for (const c of t.columns) {
					if (c.generated?.kind === "identity") {
						sequences.push({
							name: c.generated.sequence.name,
							ownedBy: `${t.table.name}.${c.name}`
						})
					}
				}
				for (const c of tableConstraints(t)) {
					keyIndex(t.table.name, c)
				}
				break
			}
			case "alterTable":
				for (const a of s.actions) {
					if (a.kind === "addColumn") {
						tableOf(s.table).columns.push(a.column)
					} else if (a.kind === "addConstraint") {
						tableOf(s.table).constraints.push({ constraint: a.constraint, validated: !a.notValid })
						keyIndex(s.table.name, a.constraint)
					} else if (a.kind === "enableRowSecurity") {
						rowSecure.add(s.table.name)
					}
				}
				break
			case "createSchema":
				if (s.name !== schema) {
					worlds.set(s.name, [])
				}
				break
			case "createView": {
				const views = worlds.get(s.name.schema)
				if (views === undefined) {
					throw new Error(`expected catalog: the view ${s.name.name} is in no world`)
				}
				views.push(s.name.name)
				break
			}
			case "createPolicy":
				policies.push(`${s.table.name}.${s.name} to ${s.role}`)
				break
			case "grantColumns":
				for (const column of s.columns) {
					grantTo(["column", `${s.table.name}.${column}`], s.to, s.privilege)
				}
				break
			case "grantRole":
				roles.get(s.to)?.memberOf.push(s.role)
				break
			case "createIndex": {
				const i: CreateIndex = s
				indexes.push({
					name: i.name,
					table: i.table.name,
					unique: i.unique,
					method: i.method,
					columns: Arr.map(i.keys, (k) => (k.key.kind === "column" ? k.key.column : "")),
					partial: i.where !== undefined,
					valid: true
				})
				break
			}
			case "createRole":
				roles.set(s.name, { login: s.login, config: [], memberOf: [] })
				break
			case "alterRole":
				if (s.action.kind === "set") {
					const { setting } = s.action
					roles.get(s.name)?.config.push(`${setting.parameter}=${storedSettingValue(setting)}`)
				}
				break
			case "grant":
				for (const key of grantNames(s)) {
					for (const to of s.to) {
						for (const p of s.privileges) {
							grantTo(key, to.kind === "PUBLIC" ? "PUBLIC" : to.name, p)
						}
					}
				}
				break
			case "rename":
			case "renameColumn":
			case "renameConstraint":
			case "lockTable":
			case "createGuardTrigger":
			case "createConstraintTrigger":
			case "createPublication":
			case "dropPublication":
			case "dropTrigger":
			case "createMaterializedView":
			case "drop":
			case "revoke":
			case "createStatistics":
			case "dropIndex":
			case "createDomain":
			case "alterDomain":
			case "createFunction":
			case "createConstant":
			case "packConstant":
			case "dropFunction":
			case "refresh":
			case "dropPolicy":
			case "alterDatabaseDefault":
			case "revokeRole":
			case "alterDefaultPrivileges":
			case "createExtension":
			case "select":
			case "analyze":
			case "comment":
			case "insert":
			case "update":
			case "delete":
			case "merge":
			case "createCarrier":
			case "beginRead":
			case "beginWrite":
			case "commit":
			case "rollback":
			case "setConstraintsImmediate":
				break
		}
	}
	const constraintType = (c: TableConstraint): string =>
		c.kind === "primaryKey"
			? "p"
			: c.kind === "unique"
				? "u"
				: c.kind === "foreignKey"
					? "f"
					: c.kind === "exclude"
						? "x"
						: "c"
	const fkColumns = (cols: ReadonlyArray<ForeignKeyColumn>) => Arr.map(cols, (c) => c.column)
	return {
		tables: byName(
			Arr.map([...tables.values()], (t) => ({
				name: t.name,
				columns: Arr.map(t.columns, (c) => ({
					name: c.name,
					type: projectType(c.type),
					notNull: c.generated?.kind !== "partial",
					collation: collationOf(c.type, c.collation),
					generation: expectedGeneration(c.generated)
				})),
				constraints: byName(
					Arr.map(t.constraints, ({ constraint: c, validated }) => ({
						name: c.name,
						type: constraintType(c),
						columns:
							c.kind === "foreignKey"
								? fkColumns(c.columns)
								: c.kind === "check"
									? []
									: c.kind === "exclude"
										? Arr.map(c.elements, (e) => e.column)
										: Arr.map(c.columns, (k) => k.column),
						withoutOverlaps:
							(c.kind === "primaryKey" || c.kind === "unique") &&
							Arr.some(c.columns, (k) => k.withoutOverlaps),
						period: c.kind === "foreignKey" && Arr.some(c.columns, (k) => k.period),
						references: c.kind === "foreignKey" ? Option.some(c.references.name) : Option.none(),
						referencedColumns: c.kind === "foreignKey" ? fkColumns(c.referencedColumns) : [],
						deferrable: c.kind === "foreignKey" && c.deferrable !== undefined,
						deferred: c.kind === "foreignKey" && c.deferrable === "INITIALLY DEFERRED",
						validated
					}))
				)
			}))
		),
		indexes: byName(indexes),
		enumLabels: 0,
		domains: byName(
			Arr.map([...domains.values()], (d) => ({
				name: d.name.name,
				base: projectType(d.base),
				notNull: false,
				collation: collationOf(d.base, d.collation),
				constraints: Arr.sort(
					Arr.map(d.constraints, (c) => c.name),
					Order.String
				)
			}))
		),
		sequences: byName(sequences),
		roles: byName(
			Arr.map([...roles.entries()], ([name, r]) => ({
				name,
				login: r.login,
				config: Arr.sort([...r.config], Order.String),
				memberOf: Arr.sort([...r.memberOf], Order.String)
			}))
		),
		worlds: Rec.fromEntries(
			Arr.map([...worlds], ([name, views]) => [name, Arr.sort([...views], Order.String)])
		),
		rowSecure: Arr.sort([...rowSecure], Order.String),
		policies: Arr.sort([...policies], Order.String),
		grants: projectedGrants(grants)
	}
}
