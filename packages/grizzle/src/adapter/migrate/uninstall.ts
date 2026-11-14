import { Array as Arr, Effect, type Scope } from "effect"
import { textArray } from "#adapter/admission/roles.ts"
import {
	type MigrateError,
	NamespaceUnread,
	stopped,
	UninstallRefused
} from "#adapter/migrate/errors.ts"
import type { MigrationTarget } from "#adapter/migrate/input.ts"
import {
	apartRows,
	decidingFailure,
	type MigrationConnection,
	type MigrationSession,
	openMigrationSession
} from "#adapter/migrate/session.ts"
import { type BatchStatement, oneShotStatement, sentAnswer } from "#adapter/wire/batch.ts"
import type { CatalogQuery } from "#adapter/wire/statement.ts"
import {
	C,
	databasePrivilegeLock,
	emptyNameMap,
	type UninstallStatement
} from "#compiler/plan/catalog.ts"
import { defect, emit, emitCatalog } from "#compiler/plan/common.ts"
import { namespaceStem } from "#compiler/plan/migration.ts"

/**
 * `grizzle roles` and `grizzle uninstall`: an installation's roles in the cluster, and its removal from its database
 * and the cluster.
 *
 * An installation is its database and its role space (MigrationConnection: `database`, `rolePrefix`). What it holds is
 * read from what its migrations recorded in the catalogs, never from names the naming door derives now, so a change of
 * a derivation since a migration ran (a decoder login's name, e1c1fc23) leaves nothing of the installation behind:
 *
 * - in its database, each of its levels' PostgreSQL schemas, every configured schema's snapshot's, and its roles'
 *   schemas, each its role's stem's name, those the database holds;
 * - in the cluster, every role `<level>__<conversion>` under its role space (core/identity.ts namespaceStem), a login's
 *   or a role's of any snapshot it was ever at, read from pg_roles;
 * - each decoder login, read as a grantee of the installation's own grants: a role a privilege on a relation of its
 *   schemas was granted to by that relation's owner, the migration identity, and that is none of the roles above. Its
 *   migrations grant those relations to its logins, its roles and its decoder login alone (physical/ddl/live.ts, the
 *   decoder's SELECT on the live secret), so the decoder login is found by the grant its migration made, whatever
 *   name it gave it;
 * - each publication of the database that publishes a relation of its schemas, its live source's, whatever its name;
 * - each replication slot of the database named as one of its decoder logins, as its leader names the slot it makes
 *   (pool/live.ts: the slot is the decoder login's role).
 *
 * No other role, schema, publication or slot is read as the installation's, and the extension's schema, which the
 * installation was given, is never one of them.
 *
 * `roles` lists the installation's roles, by name, in code point order. `uninstall` drops all of it in one SERIALIZABLE
 * transaction (sql/catalog.ts UninstallStatement): its publications and its slots, which PostgreSQL refuses to drop
 * while a leader streams from one, its schemas CASCADE, with every row they hold, then its roles, after the migration
 * identity takes on their privileges and DROP OWNED revokes what they hold in the database and on its shared objects,
 * under the database privilege's lock (sql/catalog.ts databasePrivilegeLock), as every writer of the database's ACL
 * takes it. PostgreSQL refuses DROP ROLE (2BP01) while anything of another database depends on a role, its DETAIL
 * naming that database: the transaction rolls back whole, nothing is dropped, and the refusal carries PostgreSQL's
 * message and detail (UninstallRefused). Each role is named by the name pg_roles read, so the role dropped is the role
 * listed.
 */

/** An installation's namespace: its levels' PostgreSQL schemas, every configured schema's; and its connection. */
interface Namespace {
	readonly levels: ReadonlySet<string>
	readonly session: MigrationSession
}

/**
 * A role of the installation, by its name in the cluster: a login's or a role's, read in its namespace by its stem,
 * the name of its schema where it has one; or a decoder login, read as a grantee of the installation's grants.
 */
type InstallationRole =
	| { readonly kind: "namespace"; readonly role: string; readonly stem: string }
	| { readonly kind: "decoder"; readonly role: string }

/** What uninstall dropped: the installation's schemas in its database and its roles in the cluster, each by name. */
export interface UninstallReport {
	readonly schemas: ReadonlyArray<string>
	readonly roles: ReadonlyArray<string>
}

const clusterRoles = C.from("pg_roles", "r")

/** Every role of the cluster, by name. */
const roleNames: CatalogQuery<string> = {
	sql: emitCatalog(
		C.query([C.asText(clusterRoles.col("rolname"))], [clusterRoles.item], undefined)
	),
	what: "a role name",
	row: ([name]) => name
}

const namespaces = C.from("pg_namespace", "n")

/** The schemas of the database among the names $1. */
const schemasNamed: CatalogQuery<string> = {
	sql: emitCatalog(
		C.query(
			[C.asText(namespaces.col("nspname"))],
			[namespaces.item],
			C.any(C.asText(namespaces.col("nspname")), C.arrayParam(1, "text"))
		)
	),
	what: "a schema name",
	row: ([name]) => name
}

/**
 * Every role a privilege on a relation of the schemas $1 was granted to by the relation's owner, by name: the grants
 * the installation's migrations made, each grantee once per grant, PUBLIC never one.
 */
const granteesOfOwners: CatalogQuery<string> = (() => {
	const c = C.from("pg_class", "c")
	const n = C.from("pg_namespace", "n")
	const x = C.fromFunction(
		C.call("aclexplode", [c.col("relacl")]),
		"x",
		["grantor", "grantee", "privilege_type", "is_grantable"],
		true
	)
	return {
		sql: emitCatalog(
			C.query(
				[C.asText(C.call("pg_get_userbyid", [x.col("grantee")]))],
				[C.join(c.item, n.item, C.eq(c.col("relnamespace"), n.col("oid"))), x.item],
				C.and([
					C.any(C.asText(n.col("nspname")), C.arrayParam(1, "text")),
					C.eq(x.col("grantor"), c.col("relowner")),
					C.ne(x.col("grantee"), c.col("relowner")),
					C.ne(x.col("grantee"), C.literal(0n, "oid"))
				])
			)
		),
		what: "a role name",
		row: ([name]) => name
	}
})()

/** Every publication of the database that publishes a relation of the schemas $1, by name. */
const publicationsOf: CatalogQuery<string> = (() => {
	const p = C.from("pg_publication", "p")
	const r = C.from("pg_publication_rel", "pr")
	const c = C.from("pg_class", "c")
	const n = C.from("pg_namespace", "n")
	return {
		sql: emitCatalog(
			C.query(
				[C.asText(p.col("pubname"))],
				[
					C.join(
						C.join(
							C.join(p.item, r.item, C.eq(r.col("prpubid"), p.col("oid"))),
							c.item,
							C.eq(c.col("oid"), r.col("prrelid"))
						),
						n.item,
						C.eq(n.col("oid"), c.col("relnamespace"))
					)
				],
				C.any(C.asText(n.col("nspname")), C.arrayParam(1, "text"))
			)
		),
		what: "a publication name",
		row: ([name]) => name
	}
})()

/** The rows of `query`, read alone on the session, or the namespace unread. */
const readAlone = <Row>(
	session: MigrationSession,
	query: CatalogQuery<Row>,
	params: Parameters<typeof oneShotStatement>[1],
	what: NamespaceUnread["what"]
): Effect.Effect<ReadonlyArray<Row>, MigrateError> =>
	Effect.mapError(
		Effect.flatMap(session.apart([oneShotStatement(query.sql, params)]), (answers) =>
			Effect.fromResult(apartRows(query, sentAnswer(answers, 0)))
		),
		(failure) => stopped(new NamespaceUnread({ what, failure }))
	)

/**
 * The installation's roles in the cluster (see the header): every role in its namespace (namespaceStem), and each
 * grantee of its own grants that is none of those, its decoder logins, each once, in code point order.
 */
const installationRolesOf = (
	namespace: Namespace
): Effect.Effect<ReadonlyArray<InstallationRole>, MigrateError> =>
	Effect.gen(function* () {
		const names = yield* readAlone(namespace.session, roleNames, [], "roles")
		const grantees = yield* readAlone(
			namespace.session,
			granteesOfOwners,
			[textArray([...namespace.levels])],
			"roles"
		)
		const space = namespace.session.installation.roles
		const inNamespace = Arr.flatMap(names, (role): ReadonlyArray<InstallationRole> => {
			const stem = namespaceStem(space, namespace.levels, role)
			return stem === undefined ? [] : [{ kind: "namespace", role, stem }]
		})
		const held = new Set(Arr.map(inNamespace, (r) => r.role))
		const decoders = Arr.map(
			Arr.dedupe(Arr.filter(grantees, (role) => !held.has(role))),
			(role): InstallationRole => ({ kind: "decoder", role })
		)
		return Arr.sort([...inNamespace, ...decoders], (a: InstallationRole, b: InstallationRole) =>
			compareText(a.role, b.role)
		)
	})

/** A catalog statement as uninstall sends it, printed: every role in it named as pg_roles read it. */
const sent = (statement: UninstallStatement): BatchStatement =>
	oneShotStatement(emitCatalog(statement), [])

/** The database privilege's lock, as a statement of uninstall's transaction (sql/catalog.ts databasePrivilegeLock). */
const privilegeLock = (): BatchStatement => {
	const lock = emit(databasePrivilegeLock, emptyNameMap)
	if (!lock.ok) {
		throw defect("the database privilege's lock prints")
	}
	return oneShotStatement(lock.value.text, [])
}

/** A statement of the SQL AST as uninstall sends it, printed. */
const emitted = (statement: Parameters<typeof emit>[0]): BatchStatement => {
	const printed = emit(statement, emptyNameMap)
	if (!printed.ok) {
		throw defect(`uninstall's ${statement.kind} prints`)
	}
	return oneShotStatement(printed.value.text, [])
}

/**
 * The drop of each replication slot of the database named as one of `slots`, the installation's decoder logins, where
 * its leader made one: PostgreSQL refuses it while a leader streams from the slot (55006).
 */
const droppedSlots = (slots: ReadonlyArray<string>): BatchStatement => {
	const s = C.from("pg_replication_slots", "s")
	return oneShotStatement(
		emitCatalog(
			C.query(
				[C.call("pg_drop_replication_slot", [s.col("slot_name")])],
				[s.item],
				C.and([
					C.eq(s.col("database"), C.call("current_database", [])),
					C.any(C.asText(s.col("slot_name")), C.arrayParam(1, "text"))
				])
			)
		),
		[textArray(slots)]
	)
}

/**
 * The statements of the transaction that drops `publications`, the slots of `roles`' decoder logins, wherever their
 * leaders made one, `schemas` and `roles`, in order (sql/catalog.ts UninstallStatement); none for an installation that
 * holds none.
 */
const uninstallStatements = (
	publications: ReadonlyArray<string>,
	schemas: ReadonlyArray<string>,
	roles: ReadonlyArray<InstallationRole>
): ReadonlyArray<BatchStatement> => {
	const decoders = Arr.flatMap(roles, (r) => (r.kind === "decoder" ? [r.role] : []))
	const dropped = [
		...Arr.map(publications, (name) => emitted({ kind: "dropPublication", name })),
		...(Arr.isReadonlyArrayNonEmpty(decoders) ? [droppedSlots(decoders)] : []),
		...(Arr.isReadonlyArrayNonEmpty(schemas) ? [sent({ kind: "dropSchemas", schemas })] : [])
	]
	const names = Arr.map(roles, (r) => r.role)
	return Arr.isReadonlyArrayNonEmpty(names)
		? [
				...dropped,
				sent({ kind: "adoptRoles", roles: names }),
				privilegeLock(),
				sent({ kind: "dropOwned", roles: names }),
				sent({ kind: "dropRoles", roles: names })
			]
		: dropped
}

/** The namespace of the session's installation over `targets`' snapshots' levels. */
const namespaceOf = (
	session: MigrationSession,
	targets: ReadonlyArray<MigrationTarget>
): Namespace => ({
	levels: new Set(Arr.flatMap(targets, (t) => Arr.map(t.snapshot.levels, (l) => l.schema))),
	session
})

/** `grizzle roles`: connects as the migration identity and lists the installation's roles in the cluster. */
export const installationRoles = Effect.fn("installationRoles")(function* (input: {
	readonly connection: MigrationConnection
	readonly targets: ReadonlyArray<MigrationTarget>
}): Effect.fn.Return<ReadonlyArray<string>, MigrateError, Scope.Scope> {
	const session = yield* openMigrationSession(input.connection)
	const roles = yield* installationRolesOf(namespaceOf(session, input.targets))
	return Arr.map(roles, (r) => r.role)
}, Effect.scoped)

/**
 * `grizzle uninstall`: connects as the migration identity and drops the installation's schemas in its database and its
 * roles in the cluster in one transaction, which PostgreSQL's refusal rolls back whole (see the header).
 */
export const uninstall = Effect.fn("uninstall")(function* (input: {
	readonly connection: MigrationConnection
	readonly targets: ReadonlyArray<MigrationTarget>
}): Effect.fn.Return<UninstallReport, MigrateError, Scope.Scope> {
	const session = yield* openMigrationSession(input.connection)
	const namespace = namespaceOf(session, input.targets)
	const roles = yield* installationRolesOf(namespace)
	const candidates = [
		...namespace.levels,
		...Arr.flatMap(roles, (r) => (r.kind === "namespace" ? [r.stem] : []))
	]
	const schemas = yield* readAlone(session, schemasNamed, [textArray(candidates)], "schemas")
	const publications = yield* readAlone(
		session,
		publicationsOf,
		[textArray([...namespace.levels])],
		"publications"
	)
	const published = Arr.dedupe(publications)
	const statements = uninstallStatements(published, schemas, roles)
	if (Arr.isReadonlyArrayNonEmpty(statements)) {
		yield* Effect.mapError(session.transaction(statements), (failure) =>
			stopped(
				new UninstallRefused({
					failure: failure._tag === "InputTooLarge" ? failure : decidingFailure(failure)
				})
			)
		)
	}
	return { schemas: Arr.sort(schemas, compareText), roles: Arr.map(roles, (r) => r.role) }
}, Effect.scoped)

/** Code point order of two texts. */
const compareText = (a: string, b: string): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0)
