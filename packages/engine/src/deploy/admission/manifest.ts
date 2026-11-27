import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedArtifact } from "#compiler/core/errors.ts"
import { replayedStatement, type SourceDigest } from "#compiler/deploy/snapshot/recorded.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type {
	AlterRole,
	AlterRoleAction,
	AlterTable,
	AlterTableAction,
	ObjectName,
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
					| "stubConstant"
					| "packConstant"
					| "createIndex"
					| "createStoredTable"
					| "createView"
					| "createPolicy"
					| "createFunction"
					| "createDeclaredFunction"
					| "handOverFunction"
					| "createRowType"
					| "adoptRole"
					| "createGuardTrigger"
					| "createImmutableGuardTrigger"
					| "createConstraintTrigger"
					| "createTransitionTrigger"
					| "createPublication"
					| "createLiveSecret"
					| "createRole"
					| "grantRole"
					| "grant"
					| "grantColumns"
					| "revoke"
					| "alterDefaultPrivileges"
					| "createExtension"
					| "declareStatistics"
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
		case "stubConstant":
		case "packConstant":
		case "createIndex":
		case "createStoredTable":
		case "createView":
		case "createPolicy":
		case "createFunction":
		case "createDeclaredFunction":
		case "handOverFunction":
		case "createRowType":
		case "adoptRole":
		case "createGuardTrigger":
		case "createImmutableGuardTrigger":
		case "createConstraintTrigger":
		case "createTransitionTrigger":
		case "createPublication":
		case "createLiveSecret":
		case "createRole":
		case "grantRole":
		case "grant":
		case "grantColumns":
		case "revoke":
		case "alterDefaultPrivileges":
		case "createExtension":
		case "declareStatistics":
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
		case "replaceConstant":
		case "renameColumn":
		case "dropPolicy":
		case "revokeRole":
		case "renameConstraint":
		case "alterDomain":
		case "alterRowType":
		case "dropIndex":
		case "drop":
		case "endHolders":
		case "dropFunction":
		case "dropTrigger":
		case "dropPublication":
		case "guardBracket":
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
		case "fillStored":
			return refuse(`a manifest of installation statements, not ${s.kind}`)
	}
}

/** An installed object as the drift check replays it: its graph identity and its recorded DDL as manifest statements,
 * a PL/pgSQL function with its header and a stub body and a constant as its stub, returning NULL of its type
 * (snapshot/recorded.ts replayedStatement). */
export interface ReplayedObject {
	readonly ident: string
	readonly statements: ReadonlyArray<ManifestStatement>
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
		const objects = snapshot.manifest.objects.map((o): ReplayedObject => ({
			ident: o.ident,
			statements: o.ddl.map((s) => manifestStatement(replayedStatement(s)))
		}))
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
