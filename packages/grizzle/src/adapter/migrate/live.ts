import { Array as Arr, Effect, Result } from "effect"
import { DecoderUnreplicated, type MigrateError, stopped } from "#adapter/migrate/errors.ts"
import type { MigrationSession } from "#adapter/migrate/session.ts"
import { oneShotStatement } from "#adapter/wire/batch.ts"
import type { CatalogQuery } from "#adapter/wire/statement.ts"
import { C } from "#compiler/plan/catalog.ts"
import { emitCatalog } from "#compiler/plan/common.ts"
import { decoderLoginOf, roleInSpace, type RoleSpace } from "#compiler/plan/migration.ts"
import type { DeploySnapshot } from "#compiler/plan/serve.ts"

/**
 * The live source's admission by migrate (physical/ddl/live.ts): an installation whose snapshot holds a decoder login
 * reads its changes by logical decoding, so the server's wal_level is logical before any statement of its folders
 * runs (walLevelColumn, read by the survey), and its decoder login holds the replication right once its files commit
 * (grantReplicationRight), which no drafted file can give: the REPLICATION attribute and Amazon RDS's rds_replication
 * are two grants, and which one the migration identity may give only the server knows. The survey reads both, so a
 * migration of an installation whose decoder holds its right sends nothing more. The decoder login is the one the
 * snapshot's folders create, by the name the snapshot gives it (decoderLoginOf), whichever grizzle drafted them,
 * never the name the naming door mints now.
 */

/**
 * The decoder login of `snapshot`'s live source, by the name the snapshot gives it (decoderLoginOf), under the role
 * space `roles`, or the name past the longest one; none where it installs no live source.
 */
export const decoderRole = (snapshot: DeploySnapshot, roles: RoleSpace): string | undefined => {
	const decoder = decoderLoginOf(snapshot.manifest.objects)
	if (decoder === undefined) {
		return undefined
	}
	const named = roleInSpace(roles, decoder)
	return named.ok ? named.value : named.error.role
}

/**
 * A schema's decoder login as the survey read it: none where its snapshot installs no live source; else its role
 * (decoderRole) and whether it held the replication right.
 */
export type SurveyedDecoder =
	| { readonly kind: "none" }
	| { readonly kind: "login"; readonly role: string; readonly held: boolean }

/** The server's wal_level, as the survey reads it beside the session's role. */
export const walLevelColumn: C.CatalogExpr = C.call("current_setting", [C.text("wal_level")])

const self = C.from("pg_roles", "s")
const rdsReplication = C.from("pg_roles", "x")

/** Whether the migration identity may give the REPLICATION attribute: it is a superuser or holds it. */
export const attributeGrantColumn: C.CatalogExpr = C.asText(
	C.exists(
		C.query(
			[C.bool(true)],
			[self.item],
			C.and([
				C.eq(self.col("rolname"), C.currentUser),
				C.or([self.col("rolsuper"), self.col("rolreplication")])
			])
		)
	)
)

/** Whether the migration identity may grant a membership in rds_replication: it stands, and the identity holds ADMIN. */
export const membershipGrantColumn: C.CatalogExpr = C.asText(
	C.exists(
		C.query(
			[C.bool(true)],
			[rdsReplication.item],
			C.and([
				C.eq(rdsReplication.col("rolname"), C.literal("rds_replication", "name")),
				C.call("pg_has_role", [
					C.currentUser,
					rdsReplication.col("oid"),
					C.text("USAGE WITH ADMIN OPTION")
				])
			])
		)
	)
)

const rows = C.from("pg_roles", "r")
const memberships = C.from("pg_auth_members", "m")
const granted = C.from("pg_roles", "g")

/**
 * Whether the role $1 holds the replication right: the REPLICATION attribute or a membership in rds_replication. One
 * row; false where no such role stands.
 */
export const replicationHeldQuery: CatalogQuery<boolean> = {
	sql: emitCatalog(
		C.query(
			[
				C.asText(
					C.exists(
						C.query(
							[C.bool(true)],
							[rows.item],
							C.and([
								C.eq(rows.col("rolname"), C.param(1, "name")),
								C.or([
									rows.col("rolreplication"),
									C.exists(
										C.query(
											[C.bool(true)],
											[
												C.join(
													memberships.item,
													granted.item,
													C.eq(granted.col("oid"), memberships.col("roleid"))
												)
											],
											C.and([
												C.eq(memberships.col("member"), rows.col("oid")),
												C.eq(granted.col("rolname"), C.literal("rds_replication", "name"))
											])
										)
									)
								])
							])
						)
					)
				)
			],
			[],
			undefined
		)
	),
	what: "whether a role holds the replication right",
	row: ([held]) => (held === "true" ? true : held === "false" ? false : undefined)
}

/** What the migration identity may give a decoder login, as the survey read it. */
export interface ReplicationGrants {
	readonly attribute: boolean
	readonly membership: boolean
}

/**
 * Gives the decoder login `decoder` of the schema `schema`'s live source its replication right, once its files
 * committed, where the survey found it holding none: the REPLICATION attribute where the migration identity may give
 * it, else a membership in rds_replication where it may grant that, in one DO block (sql/catalog.ts
 * replicationRightBlock); refused naming both statements where it may give neither, or where the server refuses the
 * block. Nothing for a schema whose snapshot installs no live source.
 */
export const grantReplicationRight = Effect.fn("grantReplicationRight")(function* (
	session: MigrationSession,
	schema: string,
	decoder: SurveyedDecoder,
	grants: ReplicationGrants
): Effect.fn.Return<void, MigrateError> {
	if (decoder.kind === "none" || decoder.held) {
		return
	}
	const role = decoder.role
	const refused = stopped(new DecoderUnreplicated({ schema, role }))
	if (!grants.attribute && !grants.membership) {
		return yield* refused
	}
	const block = C.replicationRightBlock(role, grants.attribute ? "attribute" : "rdsReplication")
	const answers = yield* Effect.mapError(
		session.apart([oneShotStatement(emitCatalog(block), [])]),
		() => refused
	)
	if (!Arr.every(answers, Result.isSuccess)) {
		return yield* refused
	}
})
