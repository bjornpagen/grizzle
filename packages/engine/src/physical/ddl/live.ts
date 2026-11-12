import { identifierOf, identity } from "#compiler/core/identity.ts"
import { defect } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { LivePlan, LiveTable } from "#compiler/live/notify.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { enforcement, type Node } from "#compiler/physical/obligations/graph.ts"
import type { ObjectName, PublishedTable, Select } from "#compiler/sql/ast.ts"
import {
	and,
	call,
	col,
	eq,
	lit,
	objectName,
	provedSelect,
	table as fromTable,
	target,
	types
} from "#compiler/sql/build.ts"

/**
 * The installation's live change source: what its live programs' runtime reads every committed change of their
 * footprint tables and every migration the installation applies from, by logical decoding, where it serves any read
 * (live/notify.ts LivePlan), even reads of closed relations alone, whose footprint holds no table:
 *
 * - its secret, `<root>.__live_secret`, one AES-256 key drawn as the table is created (sql/ast.ts CreateLiveSecret),
 *   which the runtime's leader seals the fan-out channel's payloads with and its listeners open them with, each a
 *   session of the decoder login, which alone reads it: a login that held it could seal a payload every listener
 *   takes for its leader's;
 * - each footprint table's REPLICA IDENTITY (`identityOf`): its primary key's, PostgreSQL's default, where every field
 *   it routes by lies in the key, so an update's or a delete's record keeps every old routing value; FULL otherwise;
 * - its publication (identity.liveSource): every footprint table, every kind of change, a FULL table whole and a
 *   key-identity table by its key's columns (`publishedTables`), and the migrations ledger, which the snapshot adds
 *   with the ledger's other objects (deploy/ledger/ledger.ts ledgerPublished); a materialized view of the plan is no
 *   table of it, since its refresh announces itself;
 * - its decoder login (identity.liveSource, under the role space), LOGIN NOINHERIT, the replication right migrate
 *   grants it once the installation's files commit, and USAGE on the root's schema with SELECT on the secret, which
 *   its listeners and its leader read at runtime: every other statement they send needs only what PUBLIC holds (the
 *   LISTEN, the slot check, the advisory lock, the snapshot and settings reads, the fan-out's notify) or the
 *   replication right (the slot's creation and its stream, which reads the publication).
 *
 * The slot is the runtime's: the leader creates it on first leadership (live/replication.ts), so a migrate-only
 * installation retains no WAL.
 */

const why = enforcement("the live source of the installation's live programs")

/** The secret table, created in Structure in the root's schema, and the object that creates it. */
const addLiveSecret = (
	b: InstallBuilder
): { readonly table: ObjectName; readonly node: Node<"structure"> } => {
	const named = identity.liveSecret()
	const table = objectName(b.schema, b.name(named))
	const node = b.add(
		{
			kind: "liveSecret",
			ident: b.qualified("table", named),
			ddl: [
				{ kind: "createLiveSecret", table },
				{
					kind: "revoke",
					privileges: ["ALL"],
					on: { kind: "TABLE", names: [table] },
					from: [{ kind: "PUBLIC" }]
				}
			],
			reasons: [why],
			phase: "structure"
		},
		[b.schemaNode]
	)
	return { table, node }
}

/**
 * The columns of a footprint table's primary key, in key order, as its CREATE TABLE declares it: what its REPLICA
 * IDENTITY DEFAULT holds, which a column list of the publication must cover, a span key's law column among them.
 */
const keyColumns = (b: InstallBuilder, relation: string): NonEmptyReadonlyArray<string> => {
	const created = b.evaluatedOn(relation).find((s) => s.kind === "createTable")
	if (created?.kind !== "createTable") {
		throw defect(`the CREATE TABLE of the footprint table of ${relation}`)
	}
	return mapNonEmpty(created.primaryKey.columns, (c) => c.column)
}

/**
 * The REPLICA IDENTITY a footprint table takes: `key`, its primary key's, where every field it routes by is a column
 * of the key; `full` otherwise, so the old value of each routed column survives in an update's or a delete's record.
 */
const identityOf = (b: InstallBuilder, table: LiveTable): "key" | "full" => {
	const key = new Set(keyColumns(b, table.relation))
	return table.routes.every((field) => key.has(b.names.column(table.relation, field)))
		? "key"
		: "full"
}

/** The publication's footprint tables, each of `tables`: a FULL one whole, a key-identity one by its key's columns. */
const publishedTables = (
	b: InstallBuilder,
	tables: ReadonlyArray<LiveTable>
): ReadonlyArray<PublishedTable> =>
	tables.map((table) => ({
		table: b.names.relation(table.relation),
		columns:
			identityOf(b, table) === "full"
				? { kind: "whole" }
				: { kind: "listed", columns: keyColumns(b, table.relation) }
	}))

/**
 * The live source's secret, replica identities, publication and decoder login, after the tables: none where `plan` is
 * none, an installation that serves no read.
 */
export const addLiveSource = (b: InstallBuilder, plan: LivePlan): void => {
	if (plan.kind === "none") {
		return
	}
	const secret = addLiveSecret(b)
	const identities = plan.tables.flatMap((table) =>
		identityOf(b, table) === "full"
			? [
					b.add(
						{
							kind: "replicaIdentity",
							ident: b.qualifiedOf(
								"replicaIdentity",
								table.relation,
								b.names.relationNamed(table.relation)
							),
							ddl: [
								{
									kind: "alterTable",
									table: b.names.relation(table.relation),
									actions: [{ kind: "replicaIdentity", identity: "full" }]
								}
							],
							reasons: [why],
							phase: "structure"
						},
						[b.table(table.relation)]
					)
				]
			: []
	)
	const source = identity.liveSource(b.schema)
	const name = b.name(source)
	b.add(
		{
			kind: "publication",
			ident: { kind: "publication", name: source },
			ddl: [{ kind: "createPublication", name, tables: publishedTables(b, plan.tables) }],
			reasons: [why],
			phase: "publish"
		},
		[...plan.tables.map((table) => b.table(table.relation)), ...identities]
	)
	const decoder = b.add(
		{
			kind: "decoder",
			ident: { kind: "role", name: source },
			ddl: [{ kind: "createRole", name: identifierOf(source), login: true }],
			reasons: [why],
			phase: "publish"
		},
		[]
	)
	b.add(
		{
			kind: "privileges",
			ident: { kind: "privileges", name: source },
			ddl: [
				{
					kind: "grant",
					privileges: ["USAGE"],
					on: { kind: "SCHEMA", names: [b.schema] },
					to: [{ kind: "role", name }]
				},
				{
					kind: "grant",
					privileges: ["SELECT"],
					on: { kind: "TABLE", names: [secret.table] },
					to: [{ kind: "role", name }]
				}
			],
			reasons: [why],
			phase: "publish"
		},
		[decoder, b.schemaNode, secret.node]
	)
}

/**
 * SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE database = current_database() AND
 * right(slot_name, <length of stem>) = <stem>: the drop of the slot the installation's leader created, where it stands,
 * named by the live source's stem `stem` under whatever role space the installation is in, which only its own slot in
 * the database ends in. PostgreSQL refuses it while a leader streams from the slot (55006), so a migration that removes
 * the live source fails closed until its leaders stop.
 */
export const dropLiveSlot = (stem: string): Select =>
	provedSelect(
		"keyed",
		[target(call("pg_drop_replication_slot", [col("s", "slot_name")]))],
		[fromTable("pg_catalog", "pg_replication_slots", "s")],
		and([
			eq(col("s", "database"), call("current_database", [])),
			eq(
				call("right", [col("s", "slot_name"), lit.int(BigInt(stem.length), types.integer)]),
				lit.text(stem, types.text)
			)
		])
	)
