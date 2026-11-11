import { Array as Arr, Effect, Result } from "effect"
import { DecoderUnreplicated, type MigrateError, stopped } from "#adapter/migrate/errors.ts"
import type { MigrationSession } from "#adapter/migrate/session.ts"
import { oneShotStatement } from "#adapter/wire/batch.ts"
import type { CatalogQuery } from "#adapter/wire/statement.ts"
import { C } from "#compiler/plan/catalog.ts"
import { emitCatalog } from "#compiler/plan/common.ts"
import { identifierOf, identity, roleInSpace, type RoleSpace } from "#compiler/plan/migration.ts"
import type { DeploySnapshot } from "#compiler/plan/serve.ts"

/**
 * The live source's admission by migrate (physical/ddl/live.ts): an installation whose snapshot holds a decoder login
 * reads its changes by logical decoding, so the server's wal_level is logical before any statement of its folders
 * runs (walLevelColumn, read by the survey), and its decoder login holds the replication right once its files commit
 * (grantReplicationRight), which no drafted file can give: the REPLICATION attribute and Amazon RDS's rds_replication
 * are two grants, and which one the migration identity may give only the server knows. The survey reads both, so a
 * migration of an installation whose decoder holds its right sends nothing more.
 */

/** Whether `snapshot` installs a live source: its manifest holds a decoder login. */
export const holdsLiveSource = (snapshot: DeploySnapshot): boolean =>
	Arr.some(snapshot.manifest.objects, (o) => o.kind === "decoder")

/** The decoder login of `snapshot`'s live source under the role space `roles`, or the name past the longest one. */
export const decoderRole = (snapshot: DeploySnapshot, roles: RoleSpace): string => {
	const named = roleInSpace(roles, identifierOf(identity.liveSource(snapshot.schema)))
	return named.ok ? named.value : named.error.role
}

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
 * Gives the decoder login `role` of `snapshot`'s live source its replication right, once its files committed, where the
 * survey found it holding none (`held`): the REPLICATION attribute where the migration identity may give it, else a
 * membership in rds_replication where it may grant that, in one DO block (sql/catalog.ts replicationRightBlock);
 * refused naming both statements where it may give neither, or where the server refuses the block.
 */
export const grantReplicationRight = Effect.fn("grantReplicationRight")(function* (
	session: MigrationSession,
	snapshot: DeploySnapshot,
	role: string,
	held: boolean,
	grants: ReplicationGrants
): Effect.fn.Return<void, MigrateError> {
	if (held || !holdsLiveSource(snapshot)) {
		return
	}
	const refused = stopped(new DecoderUnreplicated({ schema: snapshot.schema, role }))
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
