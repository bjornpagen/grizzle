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
import {
	dropLiveSlot,
	filledText,
	identifierOf,
	identity,
	namespaceStem,
	resolveVariables,
	roleInSpace
} from "#compiler/plan/migration.ts"

/**
 * `grizzle roles` and `grizzle uninstall`: an installation's roles in the cluster, and its removal from its database
 * and the cluster.
 *
 * An installation is its database and its role space (MigrationConnection: `database`, `rolePrefix`). Its namespace is
 * the names its migrations can create: in its database, each of its levels' PostgreSQL schemas, every configured
 * schema's snapshot's; in the cluster, every role `<level>__<conversion>` under its role space (core/identity.ts
 * namespaceStem), a login's or a role's of any snapshot it was ever at, read from pg_roles, never from one snapshot, so
 * a database a newer snapshot has not yet reached loses no role it holds. A role's schema is its stem's name, so the
 * namespace's schemas are its levels' and its roles' stems', those the database holds. No other role or schema is
 * read as the installation's, and the extension's schema, which the installation was given, is never one of them.
 *
 * `roles` lists the namespace's roles, by name, in code point order. `uninstall` drops the namespace in one SERIALIZABLE
 * transaction (sql/catalog.ts UninstallStatement): its schemas CASCADE, with every row they hold, then its roles, after
 * the migration identity takes on their privileges and DROP OWNED revokes what they hold in the database and on its
 * shared objects, under the database privilege's lock (sql/catalog.ts databasePrivilegeLock), as every writer of the
 * database's ACL takes it. PostgreSQL refuses DROP ROLE (2BP01) while anything of another database depends on a role,
 * its DETAIL naming that database: the transaction rolls back whole, nothing is dropped, and the refusal carries
 * PostgreSQL's message and detail (UninstallRefused). Each role is its variable, filled under the connection's role
 * space as migrate fills a drafted file's (deploy/render/variables.ts), so the role dropped is the role listed.
 */

/**
 * An installation's namespace: its levels' PostgreSQL schemas, every configured schema's; the stem of each configured
 * schema's live source (core/identity.ts identity.liveSource of its root), its publication's name in the database and
 * its slot's and decoder login's under the role space; and its connection.
 */
interface Namespace {
	readonly levels: ReadonlySet<string>
	readonly sources: ReadonlyArray<string>
	readonly session: MigrationSession
}

/** A role of the installation: its name in the cluster and its stem. */
interface NamespaceRole {
	readonly role: string
	readonly stem: string
}

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
 * The installation's roles in the cluster: every role in its namespace (namespaceStem), and each decoder login of its
 * live sources the cluster holds, in code point order.
 */
const namespaceRoles = (
	namespace: Namespace
): Effect.Effect<ReadonlyArray<NamespaceRole>, MigrateError> =>
	Effect.map(readAlone(namespace.session, roleNames, [], "roles"), (names) => {
		const space = namespace.session.installation.roles
		const decoders = new Map(
			Arr.flatMap(namespace.sources, (stem) => {
				const role = roleInSpace(space, stem)
				return role.ok ? [[role.value, stem] as const] : []
			})
		)
		return Arr.sort(
			Arr.flatMap(names, (role) => {
				const stem = namespaceStem(space, namespace.levels, role) ?? decoders.get(role)
				return stem === undefined ? [] : [{ role, stem }]
			}),
			(a: NamespaceRole, b: NamespaceRole) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0)
		)
	})

const publications = C.from("pg_publication", "p")

/** The publications of the database among the names $1. */
const publicationsNamed: CatalogQuery<string> = {
	sql: emitCatalog(
		C.query(
			[C.asText(publications.col("pubname"))],
			[publications.item],
			C.any(C.asText(publications.col("pubname")), C.arrayParam(1, "text"))
		)
	),
	what: "a publication name",
	row: ([name]) => name
}

/** The namespace of the session's installation over `targets`' snapshots' levels. */
const namespaceOf = (
	session: MigrationSession,
	targets: ReadonlyArray<MigrationTarget>
): Namespace => ({
	levels: new Set(Arr.flatMap(targets, (t) => Arr.map(t.snapshot.levels, (l) => l.schema))),
	sources: Arr.map(targets, (t) => identifierOf(identity.liveSource(t.snapshot.schema))),
	session
})

/** A catalog statement as uninstall sends it: printed, each role variable filled under the session's installation. */
const sent = (session: MigrationSession, statement: UninstallStatement): BatchStatement => {
	const filled = filledText(emitCatalog(statement), (text) =>
		resolveVariables(text, session.installation)
	)
	if (!filled.ok) {
		throw defect(
			`uninstall's statement names the role of a stem namespaceStem read off a role the cluster holds: ${filled.error.kind}`
		)
	}
	return oneShotStatement(filled.value, [])
}

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
 * The statements of the transaction that drops `sources`' slots, wherever their leaders created one, which PostgreSQL
 * refuses while a leader streams from it, `publications`, `schemas` and `roles`, in order (sql/catalog.ts
 * UninstallStatement); none for an installation that holds none.
 */
const uninstallStatements = (
	session: MigrationSession,
	sources: ReadonlyArray<string>,
	publications: ReadonlyArray<string>,
	schemas: ReadonlyArray<string>,
	roles: ReadonlyArray<NamespaceRole>
): ReadonlyArray<BatchStatement> => {
	const dropped = [
		...Arr.map(publications, (name) => emitted({ kind: "dropPublication", name })),
		...(Arr.isReadonlyArrayNonEmpty(publications)
			? Arr.map(sources, (stem) => emitted(dropLiveSlot(stem)))
			: []),
		...(Arr.isReadonlyArrayNonEmpty(schemas)
			? [sent(session, { kind: "dropSchemas", schemas })]
			: [])
	]
	const stems = Arr.map(roles, (r) => r.stem)
	return Arr.isReadonlyArrayNonEmpty(stems)
		? [
				...dropped,
				sent(session, { kind: "adoptRoles", roles: stems }),
				privilegeLock(),
				sent(session, { kind: "dropOwned", roles: stems }),
				sent(session, { kind: "dropRoles", roles: stems })
			]
		: dropped
}

/** `grizzle roles`: connects as the migration identity and lists the installation's roles in the cluster. */
export const installationRoles = Effect.fn("installationRoles")(function* (input: {
	readonly connection: MigrationConnection
	readonly targets: ReadonlyArray<MigrationTarget>
}): Effect.fn.Return<ReadonlyArray<string>, MigrateError, Scope.Scope> {
	const session = yield* openMigrationSession(input.connection)
	const roles = yield* namespaceRoles(namespaceOf(session, input.targets))
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
	const roles = yield* namespaceRoles(namespace)
	const candidates = [...namespace.levels, ...Arr.map(roles, (r) => r.stem)]
	const schemas = yield* readAlone(session, schemasNamed, [textArray(candidates)], "schemas")
	const published = yield* readAlone(
		session,
		publicationsNamed,
		[textArray(namespace.sources)],
		"publications"
	)
	const statements = uninstallStatements(session, namespace.sources, published, schemas, roles)
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
