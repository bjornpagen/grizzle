import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedArtifact } from "#compiler/core/errors.ts"
import { replayedStatement, type SourceDigest } from "#compiler/deploy/snapshot/recorded.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { parseIdent, type QualifiedKind } from "#compiler/physical/obligations/graph.ts"
import type {
	AlterRole,
	AlterRoleAction,
	AlterTable,
	AlterTableAction,
	ObjectName,
	QualifiedFunctionRef,
	SqlStatement,
	TypeRef
} from "#compiler/sql/ast.ts"
import {
	type AstHooks,
	identityHooks,
	type NameSpace,
	transformStatement
} from "#compiler/sql/transform.ts"

/** A function declaration, so that control flow knows a call never returns. */
function refuse(what: string): never {
	throw new Refusal(malformedArtifact("manifest", [], what))
}

/** A column or a constraint added after its table, its row security enabled, or its replica identity set: the only
 * ALTER TABLE an installation runs. */
type ManifestAlterTableAction = Extract<
	AlterTableAction,
	{ readonly kind: "addColumn" | "addConstraint" | "enableRowSecurity" | "replicaIdentity" }
>

const isManifestAction = (a: AlterTableAction): a is ManifestAlterTableAction =>
	a.kind === "addColumn" ||
	a.kind === "addConstraint" ||
	a.kind === "enableRowSecurity" ||
	a.kind === "replicaIdentity"

/** What an installation manifest holds: each object's creating statements, a validation's queries, the database's
 * defaults, the PUBLIC revocations, and the logins' defaults (ALTER ROLE ... SET) with the query that loads
 * the vector library for them. */
export type ManifestStatement =
	| Extract<
			SqlStatement,
			{
				readonly kind:
					| "createSchema"
					| "createTable"
					| "createDomain"
					| "createConstant"
					| "packConstant"
					| "createIndex"
					| "createMaterializedView"
					| "createView"
					| "createPolicy"
					| "createFunction"
					| "createDeclaredFunction"
					| "handOverFunction"
					| "createRowType"
					| "adoptRole"
					| "createGuardTrigger"
					| "createConstraintTrigger"
					| "createTransitionTrigger"
					| "createPublication"
					| "createLiveSecret"
					| "alterDatabaseDefault"
					| "createRole"
					| "grantRole"
					| "grant"
					| "grantColumns"
					| "revoke"
					| "alterDefaultPrivileges"
					| "createExtension"
					| "createStatistics"
					| "comment"
					| "select"
			}
	  >
	| (Omit<AlterTable, "actions"> & {
			readonly actions: NonEmptyReadonlyArray<ManifestAlterTableAction>
	  })
	| (Omit<AlterRole, "action"> & {
			readonly action: Extract<AlterRoleAction, { readonly kind: "set" }>
	  })

/** `s` as a manifest statement; a statement no manifest holds is a malformed snapshot. */
const manifestStatement = (s: SqlStatement): ManifestStatement => {
	switch (s.kind) {
		case "createSchema":
		case "createTable":
		case "createDomain":
		case "createConstant":
		case "packConstant":
		case "createIndex":
		case "createMaterializedView":
		case "createView":
		case "createPolicy":
		case "createFunction":
		case "createDeclaredFunction":
		case "handOverFunction":
		case "createRowType":
		case "adoptRole":
		case "createGuardTrigger":
		case "createConstraintTrigger":
		case "createTransitionTrigger":
		case "createPublication":
		case "createLiveSecret":
		case "alterDatabaseDefault":
		case "createRole":
		case "grantRole":
		case "grant":
		case "grantColumns":
		case "revoke":
		case "alterDefaultPrivileges":
		case "createExtension":
		case "createStatistics":
		case "comment":
		case "select":
			return s
		case "alterRole":
			if (s.action.kind === "set") {
				return { kind: s.kind, name: s.name, action: s.action }
			}
			return refuse(`a manifest whose ALTER ROLE sets a default, not ${s.action.kind}`)
		case "alterTable": {
			const [first, ...rest] = s.actions
			if (isManifestAction(first) && rest.every(isManifestAction)) {
				return { kind: s.kind, table: s.table, actions: [first, ...rest] }
			}
			return refuse(
				"a manifest whose ALTER TABLE only adds a column or a constraint, enables row security, or sets a replica identity"
			)
		}
		case "rename":
		case "renameColumn":
		case "dropPolicy":
		case "revokeRole":
		case "renameConstraint":
		case "alterDomain":
		case "dropIndex":
		case "drop":
		case "dropFunction":
		case "dropTrigger":
		case "dropPublication":
		case "lockTable":
		case "insert":
		case "update":
		case "delete":
		case "merge":
		case "beginRead":
		case "beginWrite":
		case "commit":
		case "rollback":
		case "setConstraintsImmediate":
		case "refresh":
		case "createCarrier":
			return refuse(`a manifest of installation statements, not ${s.kind}`)
	}
}

/**
 * An installed object as the drift check replays it: its graph identity, its recorded DDL as manifest statements, a
 * PL/pgSQL function with its header and a stub body and a constant returning the empty value of its type
 * (snapshot/recorded.ts replayedStatement), and the identities of the objects it is created after (`createdAfter`),
 * which a replay creates before it and its proof digest digests (proof.ts).
 */
export interface ReplayedObject {
	readonly ident: string
	readonly statements: ReadonlyArray<ManifestStatement>
	readonly after: ReadonlyArray<string>
}

/**
 * The namespaces a statement names an object of each qualified kind in (sql/transform.ts NameSpace): a table, a view
 * and a materialized view also as the row type PostgreSQL creates under its name. A row security and a replica identity
 * are named by no statement but their own.
 */
const namedIn: Readonly<Record<QualifiedKind, ReadonlyArray<NameSpace>>> = {
	domain: ["type"],
	type: ["type"],
	table: ["relation", "type"],
	materializedView: ["relation", "type"],
	view: ["relation", "type"],
	index: ["relation"],
	statistics: ["statistics"],
	function: ["function"],
	rowSecurity: [],
	replicaIdentity: []
}

/** A schema object's name in the namespace a statement names it in. */
const nameKey = (namespace: NameSpace, schema: string, name: string): string =>
	`${namespace}\u0000${schema}\u0000${name}`

/**
 * What each object is created after: each object the manifest's edges create it after, and each other object of the
 * manifest one of its statements names, by any name sql/transform.ts walks, a type a cast or a literal names, a
 * function a CHECK calls and the schema of every qualified name among them, since PostgreSQL resolves each as it
 * creates the object, whether or not an edge records it. So a replay of an object creates everything its statements
 * name first, and its proof digest covers it: a table whose CHECK casts a literal to a set's domain is created after the
 * domain, which the edges of the table's addition never stated (physical/ddl/tables.ts addTables).
 */
const createdAfter = (
	objects: ReadonlyArray<Omit<ReplayedObject, "after">>,
	edges: DeploySnapshot["manifest"]["edges"]
): ReadonlyArray<ReplayedObject> => {
	/** Each schema the manifest creates by its name, and each schema object by its name in each namespace it is named in. */
	const schemas = new Map<string, string>()
	const byName = new Map<string, string>()
	for (const o of objects) {
		const ident = parseIdent(o.ident)
		switch (ident.kind) {
			case "schema":
				schemas.set(ident.name, o.ident)
				break
			case "domain":
			case "type":
			case "table":
			case "materializedView":
			case "view":
			case "index":
			case "statistics":
			case "function":
			case "rowSecurity":
			case "replicaIdentity":
				for (const namespace of namedIn[ident.kind]) {
					byName.set(nameKey(namespace, ident.schema, ident.name), o.ident)
				}
				break
			case "extension":
			case "role":
			case "membership":
			case "privileges":
			case "publication":
			case "column":
			case "constraint":
			case "trigger":
			case "policy":
			case "other":
				break
		}
	}
	const declared = new Map<string, Array<string>>()
	for (const edge of edges) {
		const known = declared.get(edge.to)
		if (known === undefined) {
			declared.set(edge.to, [edge.from])
		} else {
			known.push(edge.from)
		}
	}
	return objects.map((o): ReplayedObject => {
		const after = new Set(declared.get(o.ident))
		const named = (namespace: NameSpace, schema: string, name: string): void => {
			for (const ident of [byName.get(nameKey(namespace, schema, name)), schemas.get(schema)]) {
				if (ident !== undefined && ident !== o.ident) {
					after.add(ident)
				}
			}
		}
		const hooks: AstHooks = {
			...identityHooks,
			objectName: (n: ObjectName, namespace: NameSpace): ObjectName => {
				named(namespace, n.schema, n.name)
				return n
			},
			typeRef: (t: TypeRef): TypeRef => {
				if (t.kind === "named") {
					named("type", t.schema, t.name)
				}
				return t
			},
			functionRef: (f: QualifiedFunctionRef): QualifiedFunctionRef => {
				named("function", f.schema, f.name)
				return f
			}
		}
		for (const s of o.statements) {
			transformStatement(s, hooks)
		}
		return { ...o, after: [...after] }
	})
}

/** The statements that install a snapshot as the drift check replays them, each a manifest statement, parsed once:
 * `objects`, every object with its replayed statements in install order, and `statements`, theirs in that order, then
 * the PUBLIC revokes, the logins' defaults and the comments.
 * Admission reads them twice over: the role checks read the grants, memberships, policies and defaults each login and
 * role is installed with, and the drift check replays objects' statements into scratch schemas, where PostgreSQL
 * deparses them beside the installed ones, each function but by its header (recordedSources). Each statement is one of
 * the installation subset of the SQL AST (`ManifestStatement`); a statement only a migration runs (a drop, a rename, a
 * revocation, a constraint's validation, a domain altered, a default reset, a lock) or any data or transaction
 * statement is a malformed snapshot, refused as MalformedArtifact. */
export interface InstalledStatements {
	readonly objects: ReadonlyArray<ReplayedObject>
	readonly statements: ReadonlyArray<ManifestStatement>
}

export const manifestStatements = (
	snapshot: DeploySnapshot
): Result.Result<InstalledStatements, CompileError> =>
	catchRefusal(() => {
		const objects = createdAfter(
			snapshot.manifest.objects.map((o) => ({
				ident: o.ident,
				statements: o.ddl.map((s) => manifestStatement(replayedStatement(s)))
			})),
			snapshot.manifest.edges
		)
		return {
			objects,
			statements: [
				...objects.flatMap((o) => o.statements),
				...[
					...snapshot.manifest.publicRevokes,
					...snapshot.manifest.roleDefaults,
					...snapshot.manifest.comments
				].map((s) => manifestStatement(s))
			]
		}
	})

/** A function of a string body a snapshot installs, PL/pgSQL or declared, by its name, with the digest of the source it
 * installs as. */
export interface RecordedSource {
	readonly function: ObjectName
	readonly source: SourceDigest
}

/**
 * Every function of a string body a snapshot installs, a PL/pgSQL function or a declared one, by its name, with the
 * digest of its source (snapshot/recorded.ts RecordedFunction, RecordedDeclaredFunction), in install order: what the
 * drift check holds each installed function's source to, its pg_proc.prosrc's SHA-256, since its replay holds only the
 * function's header.
 */
export const recordedSources = (snapshot: DeploySnapshot): ReadonlyArray<RecordedSource> =>
	snapshot.manifest.objects.flatMap((o) =>
		o.ddl.flatMap((s): ReadonlyArray<RecordedSource> =>
			s.kind === "recordedFunction" || s.kind === "recordedDeclaredFunction"
				? [{ function: s.header.name, source: s.source }]
				: []
		)
	)
