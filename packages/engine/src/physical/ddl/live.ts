import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { LivePlan, LiveTable } from "#compiler/live/notify.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { primaryKeyColumns } from "#compiler/physical/ddl/tables.ts"
import { enforcement, type Node } from "#compiler/physical/obligations/graph.ts"
import type { Grant, ObjectName, PublishedTable, Select } from "#compiler/sql/ast.ts"
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
 * footprint tables from, by logical decoding, where its live plan reads any relation (live/notify.ts LivePlan):
 *
 * - its secret, `<root>.__live_secret`, one AES-256 key drawn as the table is created (sql/ast.ts CreateLiveSecret),
 *   which the runtime seals and opens the fan-out channel's payloads with, and which every login and the decoder login
 *   read, and nothing else (`secretGrants`);
 * - each footprint table's REPLICA IDENTITY (`identityOf`): its primary key's, PostgreSQL's default, where every field
 *   it routes by lies in the key, so an update's or a delete's record keeps every old routing value; FULL otherwise;
 * - its publication (identity.liveSource): every footprint table, every kind of change, a FULL table whole and a
 *   key-identity table by its key's columns (`publishedTables`); a materialized view of the plan is no table of it,
 *   since its refresh announces itself;
 * - its decoder login (identity.liveSource, under the role space), LOGIN NOINHERIT, the replication right migrate
 *   grants it once the installation's files commit, and SELECT on the secret.
 *
 * The slot is the runtime's: the leader creates it on first leadership (live/replication.ts), so a migrate-only
 * installation retains no WAL.
 */

/** The secret table of an installation with a live source, and the object that creates it; none without one. */
export type LiveSecretTable =
	| { readonly kind: "none" }
	| { readonly kind: "secret"; readonly table: ObjectName; readonly node: Node<"structure"> }

const why = enforcement("the live source of the installation's live programs")

/** Whether `plan` reads any relation, so the installation holds a live source. */
const sourced = (plan: LivePlan): boolean => plan.tables.length + plan.views.length > 0

/** The secret table, created in Structure in the root's schema, where `plan` reads any relation. */
export const addLiveSecret = (b: InstallBuilder, plan: LivePlan): LiveSecretTable => {
	if (!sourced(plan)) {
		return { kind: "none" }
	}
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
	return { kind: "secret", table, node }
}

/** SELECT on the secret for the role `role`, none where the installation holds no live source. */
export const secretGrants = (secret: LiveSecretTable, role: string): ReadonlyArray<Grant> =>
	secret.kind === "none"
		? []
		: [
				{
					kind: "grant",
					privileges: ["SELECT"],
					on: { kind: "TABLE", names: [secret.table] },
					to: [{ kind: "role", name: role }]
				}
			]

/**
 * The REPLICA IDENTITY a footprint table takes: `key`, its primary key's, where every field it routes by is a column
 * of the key; `full` otherwise, so the old value of each routed column survives in an update's or a delete's record.
 */
export const identityOf = (b: InstallBuilder, table: LiveTable): "key" | "full" => {
	const key = new Set(primaryKeyColumns(b, table.relation))
	return table.routes.every((field) => key.has(b.names.column(table.relation, field)))
		? "key"
		: "full"
}

/** The publication's tables: each footprint table, a FULL one whole, a key-identity one by its key's columns. */
export const publishedTables = (b: InstallBuilder, plan: LivePlan): ReadonlyArray<PublishedTable> =>
	plan.tables.map((table) => ({
		table: b.names.relation(table.relation),
		columns:
			identityOf(b, table) === "full"
				? { kind: "whole" }
				: { kind: "listed", columns: primaryKeyColumns(b, table.relation) }
	}))

/**
 * The live source's replica identities, publication and decoder login, after the tables and the secret: none where the
 * installation holds no live source.
 */
export const addLiveSource = (b: InstallBuilder, plan: LivePlan, secret: LiveSecretTable): void => {
	if (secret.kind === "none") {
		return
	}
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
			ddl: [{ kind: "createPublication", name, tables: publishedTables(b, plan) }],
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
			ddl: secretGrants(secret, name),
			reasons: [why],
			phase: "publish"
		},
		[decoder, secret.node]
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
