import {
	type Census,
	type Censused,
	censused,
	displayOf,
	type StandingName
} from "#compiler/core/identity.ts"
import { defect } from "#compiler/core/invariant.ts"
import {
	type AlterTableAction,
	type ColumnDef,
	type Comment,
	type CommentTarget,
	type ObjectName,
	type SqlStatement,
	tableConstraints
} from "#compiler/sql/ast.ts"
import { functionNameOf } from "#compiler/sql/build.ts"

/**
 * What an identifier a statement names is in the installation's census. The one site of the fact that the naming door
 * minted every identifier the installation's statements spell, so its census holds it: the identifier is text read back
 * from a statement, which no type ties to the census, so a miss is a defect.
 */
const mintedName = (census: Census, identifier: string): Censused => {
	const named = censused(census, identifier)
	if (named === undefined) {
		throw defect(`the naming door minted the identifier ${identifier}`)
	}
	return named
}

/** One object a statement creates, under the identifier the naming door minted it. */
interface Created {
	readonly on: CommentTarget
	readonly identifier: string
}

const column = (relation: ObjectName, c: ColumnDef): ReadonlyArray<Created> => [
	{ on: { kind: "COLUMN", relation, column: c.name }, identifier: c.name },
	...(c.generated?.kind === "identity"
		? [
				{
					on: { kind: "SEQUENCE", name: c.generated.sequence } as const,
					identifier: c.generated.sequence.name
				}
			]
		: [])
]

/** The objects one action of an ALTER TABLE on `table` creates: none for an action that creates none. */
const actionCreated = (table: ObjectName, a: AlterTableAction): ReadonlyArray<Created> => {
	switch (a.kind) {
		case "addColumn":
		case "addColumnPlaceholder":
		case "addColumnDefault":
			return column(table, a.column)
		case "addConstraint":
			return [
				{
					on: { kind: "CONSTRAINT", name: a.constraint.name, on: table },
					identifier: a.constraint.name
				}
			]
		case "addConstraintUsingIndex":
			return [{ on: { kind: "CONSTRAINT", name: a.name, on: table }, identifier: a.name }]
		case "addIdentity":
			return [{ on: { kind: "SEQUENCE", name: a.sequence }, identifier: a.sequence.name }]
		case "dropColumn":
		case "dropDefault":
		case "setUuidv7Default":
		case "alterColumnType":
		case "setExpression":
		case "dropIdentity":
		case "validateConstraint":
		case "dropConstraint":
		case "enableRowSecurity":
		case "disableRowSecurity":
			return []
	}
}

/** The objects a statement creates, each with the identifier that names it: none for a statement that creates none. */
const created = (s: SqlStatement): ReadonlyArray<Created> => {
	switch (s.kind) {
		case "createSchema":
			return [{ on: { kind: "SCHEMA", name: s.name }, identifier: s.name }]
		case "createTable":
			return [
				{ on: { kind: "TABLE", name: s.table }, identifier: s.table.name },
				...s.columns.flatMap((c) => column(s.table, c)),
				...tableConstraints(s).map((c): Created => ({
					on: { kind: "CONSTRAINT", name: c.name, on: s.table },
					identifier: c.name
				}))
			]
		case "alterTable":
			return s.actions.flatMap((a) => actionCreated(s.table, a))
		case "createDomain":
			return [
				{ on: { kind: "DOMAIN", name: s.name }, identifier: s.name.name },
				...s.constraints.map((c): Created => ({
					on: { kind: "DOMAIN CONSTRAINT", name: c.name, domain: s.name },
					identifier: c.name
				}))
			]
		case "alterDomain":
			return s.action.kind === "addConstraint"
				? [
						{
							on: { kind: "DOMAIN CONSTRAINT", name: s.action.constraint.name, domain: s.name },
							identifier: s.action.constraint.name
						}
					]
				: []
		case "createIndex":
			return [
				{
					on: { kind: "INDEX", name: { schema: s.table.schema, name: s.name } },
					identifier: s.name
				}
			]
		case "createMaterializedView":
			return [
				{ on: { kind: "MATERIALIZED VIEW", name: s.name }, identifier: s.name.name },
				...s.columns.map((c): Created => ({
					on: { kind: "COLUMN", relation: s.name, column: c },
					identifier: c
				}))
			]
		case "createView":
			return [
				{ on: { kind: "VIEW", name: s.name }, identifier: s.name.name },
				...s.columns.map((c): Created => ({
					on: { kind: "COLUMN", relation: s.name, column: c },
					identifier: c
				}))
			]
		case "createPolicy":
			return [{ on: { kind: "POLICY", name: s.name, on: s.table }, identifier: s.name }]
		case "createGuardTrigger":
		case "createConstraintTrigger":
			return [{ on: { kind: "TRIGGER", name: s.name, on: s.table }, identifier: s.name }]
		case "createRole":
			return [{ on: { kind: "ROLE", name: s.name }, identifier: s.name }]
		case "createFunction":
			return [{ on: { kind: "FUNCTION", name: functionNameOf(s) }, identifier: s.name.name }]
		case "packConstant":
			return [
				{
					on: { kind: "FUNCTION", name: { ...s.function, args: [] } },
					identifier: s.function.name
				}
			]
		case "createConstant":
			return [
				{
					on: { kind: "FUNCTION", name: { ...s.name, args: s.params.map((p) => p.type) } },
					identifier: s.name.name
				}
			]
		case "createStatistics":
			return [{ on: { kind: "STATISTICS", name: s.name }, identifier: s.name.name }]
		case "select":
		case "insert":
		case "update":
		case "delete":
		case "merge":
		case "rename":
		case "renameColumn":
		case "renameConstraint":
		case "dropIndex":
		case "dropPolicy":
		case "drop":
		case "dropFunction":
		case "dropTrigger":
		case "alterDatabaseDefault":
		case "alterRole":
		case "grantRole":
		case "revokeRole":
		case "grant":
		case "revoke":
		case "grantColumns":
		case "alterDefaultPrivileges":
		case "createExtension":
		case "lockTable":
		case "createCarrier":
		case "begin":
		case "commit":
		case "rollback":
		case "setConstraintsImmediate":
		case "refresh":
		case "analyze":
		case "comment":
			return []
	}
}

/** A comment's target as one text, which tells two targets apart (its kind, then its names). */
export const targetKey = (on: CommentTarget): string => {
	const name = (n: ObjectName) => `${n.schema}\u0000${n.name}`
	switch (on.kind) {
		case "SCHEMA":
		case "ROLE":
			return `${on.kind}\u0001${on.name}`
		case "TABLE":
		case "VIEW":
		case "MATERIALIZED VIEW":
		case "DOMAIN":
		case "SEQUENCE":
		case "INDEX":
		case "STATISTICS":
			return `${on.kind}\u0001${name(on.name)}`
		case "COLUMN":
			return `${on.kind}\u0001${name(on.relation)}\u0000${on.column}`
		case "CONSTRAINT":
		case "TRIGGER":
		case "POLICY":
			return `${on.kind}\u0001${name(on.on)}\u0000${on.name}`
		case "DOMAIN CONSTRAINT":
			return `${on.kind}\u0001${name(on.domain)}\u0000${on.name}`
		case "FUNCTION":
			return `${on.kind}\u0001${name(on.name)}`
	}
}

/** The identifier that names a comment's target: the object's own name, never its relation's, domain's or schema's. */
const targetName = (on: CommentTarget): string => {
	switch (on.kind) {
		case "SCHEMA":
		case "ROLE":
		case "CONSTRAINT":
		case "TRIGGER":
		case "POLICY":
		case "DOMAIN CONSTRAINT":
			return on.name
		case "TABLE":
		case "VIEW":
		case "MATERIALIZED VIEW":
		case "DOMAIN":
		case "SEQUENCE":
		case "INDEX":
		case "STATISTICS":
		case "FUNCTION":
			return on.name.name
		case "COLUMN":
			return on.column
	}
}

/**
 * Every hashed name an installation's COMMENTs record, with the identity each spells out: the installation's
 * `manifest.comments`, which name every object it created under a hashed name and no other (commentsOf).
 */
export const hashedNames = (comments: ReadonlyArray<SqlStatement>): ReadonlyArray<StandingName> =>
	comments.flatMap((c) =>
		c.kind === "comment" ? [{ identifier: targetName(c.on), display: c.text }] : []
	)

/** What a RENAME, a column's or a constraint's names under its new name: none for a statement that renames nothing. */
const renamedTo = (s: SqlStatement): ReadonlyArray<CommentTarget> => {
	if (s.kind === "rename") {
		return s.object === "ROLE" || s.object === "SCHEMA"
			? [{ kind: s.object, name: s.to }]
			: [{ kind: s.object, name: { schema: s.name.schema, name: s.to } }]
	}
	if (s.kind === "renameColumn") {
		return [{ kind: "COLUMN", relation: s.table, column: s.to }]
	}
	return s.kind === "renameConstraint" ? [{ kind: "CONSTRAINT", name: s.to, on: s.table }] : []
}

/**
 * The targets, by key (targetKey), of every object `statements` create or rename: a migration's final COMMENT step
 * states each of their comments again, whether or not the previous snapshot held one of that text, since a name a
 * migration frees and takes again (a swap, a chain) carries the comment of the object it held before.
 */
export const touchedTargets = (statements: Iterable<SqlStatement>): ReadonlySet<string> => {
	const out = new Set<string>()
	for (const s of statements) {
		for (const c of created(s)) {
			out.add(targetKey(c.on))
		}
		for (const on of renamedTo(s)) {
			out.add(targetKey(on))
		}
	}
	return out
}

/**
 * The COMMENT of every object `statements` create under a hashed name (core/identity.ts): what its comment holds is its
 * identity's display, the identity spelled out, so a direct SQL writer reads the mapping from the catalog. A readable
 * name spells its identity itself and takes no comment. `census` holds every identifier the installation minted: every
 * object a statement creates is named by one of them. In statement order, each object once.
 */
export const commentsOf = (
	statements: ReadonlyArray<SqlStatement>,
	census: Census
): ReadonlyArray<Comment> => {
	const seen = new Set<string>()
	const out: Array<Comment> = []
	for (const c of statements.flatMap(created)) {
		const key = targetKey(c.on)
		if (seen.has(key)) {
			continue
		}
		seen.add(key)
		const named = mintedName(census, c.identifier)
		if (named.form === "hashed") {
			out.push({ kind: "comment", on: c.on, text: displayOf(named.identity) })
		}
	}
	return out
}
