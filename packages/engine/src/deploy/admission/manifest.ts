import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedArtifact } from "#compiler/core/errors.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type * as Result from "#compiler/core/result.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type {
	AlterRole,
	AlterRoleAction,
	AlterTable,
	AlterTableAction,
	SqlStatement
} from "#compiler/sql/ast.ts"

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
					| "createGuardTrigger"
					| "createConstraintTrigger"
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
		case "createGuardTrigger":
		case "createConstraintTrigger":
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
		case "begin":
		case "commit":
		case "rollback":
		case "setConstraintsImmediate":
		case "refresh":
		case "analyze":
		case "createCarrier":
			return refuse(`a manifest of installation statements, not ${s.kind}`)
	}
}

/** The statements that install a snapshot, each a manifest statement, parsed once: every object's DDL in install order,
 * then the PUBLIC revokes and the logins' defaults.
 * Admission reads them twice over: the role checks read the grants, memberships, policies and defaults each login and
 * role is installed with, and the drift check replays the objects' statements into scratch schemas, where PostgreSQL
 * deparses them beside the installed ones. Each statement is one of the installation subset of the SQL AST
 * (`ManifestStatement`); a statement only a migration runs (a drop, a rename, a revocation, a constraint's validation,
 * a domain altered, a default reset, a lock) or any data or transaction statement is a
 * malformed snapshot, refused as MalformedArtifact. */
export const manifestStatements = (
	snapshot: DeploySnapshot
): Result.Result<ReadonlyArray<ManifestStatement>, CompileError> =>
	catchRefusal(() =>
		[
			...snapshot.manifest.objects.flatMap((o) => o.ddl),
			...snapshot.manifest.publicRevokes,
			...snapshot.manifest.roleDefaults,
			...snapshot.manifest.comments
		].map((s) => manifestStatement(s))
	)
