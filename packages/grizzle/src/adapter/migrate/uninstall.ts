import { Array as Arr, Effect, Order, type Scope } from "effect"
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
import { C, databaseLock, emptyNameMap, type UninstallStatement } from "#compiler/plan/catalog.ts"
import { costChosen, defect, emit, emitCatalog } from "#compiler/plan/common.ts"
import {
	identifierOf,
	identity,
	type InstallationRole,
	installationRoleOf,
	liveSlotOf
} from "#compiler/plan/migration.ts"

/**
 * `grizzle roles` and `grizzle uninstall`: an installation's roles in the cluster, and its removal from its database
 * and the cluster.
 *
 * An installation is its database and its role space (MigrationConnection: `database`, `rolePrefix`). What it holds is
 * read from its levels' schemas, every configured schema's snapshot's, and the catalogs:
 *
 * - in its database, each of its levels' PostgreSQL schemas, each level's schema of whole views, `__<level>`
 *   (core/identity.ts identity.wholeSchema), and its roles' schemas, each its role's stem's name, those the database
 *   holds;
 * - in the cluster, every role its migrations create under its role space, read from pg_roles by the one reading of an
 *   installation's roles (core/identity.ts installationRoleOf): a login's or a role's of any snapshot it was ever at,
 *   `<level>__<conversion>`, its live source's decoder login and its function owner, each minted from a level's schema;
 * - each publication of the database that publishes a relation of its schemas, its live source's, whatever its name;
 * - each replication slot of the database its live sources' leaders name as they make it, by each decoder login's
 *   source and the database (pool/live.ts, core/identity.ts liveSlotOf).
 *
 * No other role, schema, publication or slot is read as the installation's, and the extension's schema, which the
 * installation was given, is never one of them.
 *
 * `roles` lists the installation's roles, by name, in code point order. `uninstall` drops all of it in one SERIALIZABLE
 * transaction (sql/catalog.ts UninstallStatement): its publications and its slots, which PostgreSQL refuses to drop
 * while a leader streams from one, its schemas CASCADE, with every row they hold, then its roles, after the migration
 * identity takes on their privileges, every session holding a temporary object of one of them ends (a write's carrier:
 * sql/ast.ts EndHolders), and DROP OWNED revokes what they hold in the database and on its shared
 * objects, under the database lock (sql/catalog.ts databaseLock), as every writer of a row the database's installations
 * share takes it. PostgreSQL refuses DROP ROLE (2BP01) while anything of another database depends on a role, its DETAIL
 * naming that database: the transaction rolls back whole, nothing is dropped, and the refusal carries PostgreSQL's
 * message and detail (UninstallRefused). Each role is named by the name pg_roles read, so the role dropped is the role
 * listed.
 */

/** An installation's namespace: its levels' PostgreSQL schemas, every configured schema's; and its connection. */
interface Namespace {
	readonly levels: ReadonlySet<string>
	readonly session: MigrationSession
}

/** A role of the installation, by its name in the cluster and what it is (installationRoleOf). */
interface HeldRole {
	readonly role: string
	readonly is: InstallationRole
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
					C.inNamespace(
						C.join(
							C.join(p.item, r.item, C.eq(r.col("prpubid"), p.col("oid"))),
							c.item,
							C.eq(c.col("oid"), r.col("prrelid"))
						),
						n,
						c.col("relnamespace")
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

/** The installation's roles in the cluster (see the header), each once, in code point order. */
const installationRolesOf = (
	namespace: Namespace
): Effect.Effect<ReadonlyArray<HeldRole>, MigrateError> =>
	Effect.gen(function* () {
		const names = yield* readAlone(namespace.session, roleNames, [], "roles")
		const roleOf = installationRoleOf(namespace.session.installation.roles, namespace.levels)
		const held = Arr.flatMap(Arr.dedupe(names), (role): ReadonlyArray<HeldRole> => {
			const is = roleOf(role)
			return is === undefined ? [] : [{ role, is }]
		})
		return Arr.sort(
			held,
			Order.mapInput(Order.String, (r: HeldRole) => r.role)
		)
	})

/** A catalog statement as uninstall sends it, printed: every role in it named as pg_roles read it. */
const sent = (statement: UninstallStatement): BatchStatement =>
	oneShotStatement(emitCatalog(statement), [])

/** The database lock, as a statement of uninstall's transaction (sql/catalog.ts databaseLock). */
const privilegeLock = (): BatchStatement => {
	const lock = emit(databaseLock, emptyNameMap, costChosen())
	if (!lock.ok) {
		defect("the database lock prints")
	}
	return oneShotStatement(lock.value.text, [])
}

/** A statement of the SQL AST as uninstall sends it, printed. */
const emitted = (statement: Parameters<typeof emit>[0]): BatchStatement => {
	const printed = emit(statement, emptyNameMap, costChosen())
	if (!printed.ok) {
		defect(`uninstall's ${statement.kind} prints`)
	}
	return oneShotStatement(printed.value.text, [])
}

/**
 * The drop of each replication slot of the database named as one of `slots`, the slots of the installation's live
 * sources in it (liveSlotOf), where its leader made one: PostgreSQL refuses it while a leader streams from the slot
 * (55006).
 */
const droppedSlots = (slots: ReadonlyArray<string>): BatchStatement => {
	const s = C.from("pg_replication_slots", "s")
	return oneShotStatement(
		emitCatalog(
			C.query(
				[C.catalogCall("pg_drop_replication_slot", [s.col("slot_name")])],
				[s.item],
				C.and([
					C.eq(s.col("database"), C.catalogCall("current_database", [])),
					C.any(C.asText(s.col("slot_name")), C.arrayParam(1, "text"))
				])
			)
		),
		[textArray(slots)]
	)
}

/**
 * The statements of the transaction that drops `publications`, the slots in `database` of the live sources whose
 * decoder logins are among `roles`, wherever their leaders made one, `schemas` and `roles`, in order
 * (sql/catalog.ts UninstallStatement); none for an installation that holds none.
 */
const uninstallStatements = (
	publications: ReadonlyArray<string>,
	schemas: ReadonlyArray<string>,
	roles: ReadonlyArray<HeldRole>,
	database: string
): ReadonlyArray<BatchStatement> => {
	const slots = Arr.flatMap(roles, (r) =>
		r.is.kind === "liveSource"
			? [liveSlotOf(identifierOf(identity.liveSource(r.is.level)), database)]
			: []
	)
	const dropped = [
		...Arr.map(publications, (name) => emitted({ kind: "dropPublication", name })),
		...(Arr.isReadonlyArrayNonEmpty(slots) ? [droppedSlots(slots)] : []),
		...(Arr.isReadonlyArrayNonEmpty(schemas) ? [sent({ kind: "dropSchemas", schemas })] : [])
	]
	const names = Arr.map(roles, (r) => r.role)
	return Arr.isReadonlyArrayNonEmpty(names)
		? [
				...dropped,
				sent({ kind: "adoptRoles", roles: names }),
				privilegeLock(),
				sent({ kind: "endHolders", roles: names }),
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
		...Arr.map([...namespace.levels], (level) => identifierOf(identity.wholeSchema(level))),
		...Arr.flatMap(roles, (r) => (r.is.kind === "stem" ? [r.is.stem] : []))
	]
	const schemas = yield* readAlone(session, schemasNamed, [textArray(candidates)], "schemas")
	const publications = yield* readAlone(
		session,
		publicationsOf,
		[textArray([...namespace.levels])],
		"publications"
	)
	const published = Arr.dedupe(publications)
	const statements = uninstallStatements(published, schemas, roles, session.installation.database)
	if (Arr.isReadonlyArrayNonEmpty(statements)) {
		yield* Effect.mapError(session.transaction(statements), (failure) =>
			stopped(
				new UninstallRefused({
					failure: failure._tag === "InputTooLarge" ? failure : decidingFailure(failure)
				})
			)
		)
	}
	return { schemas: Arr.sort(schemas, Order.String), roles: Arr.map(roles, (r) => r.role) }
}, Effect.scoped)
