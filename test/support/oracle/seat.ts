import { Context, Effect, type Scope } from "effect"
import { pgCluster } from "#test/support/env.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { type RolledBack, type SubstrateShape } from "#test/support/substrate/substrate.ts"

/**
 * A connection and the statements around a piece of an oracle case's work on it: `open` sent in one flush with the
 * work's first statements, `close` after its last.
 */
interface Bracketed {
	readonly connection: PgConnection
	readonly open: ReadonlyArray<string>
	readonly close: ReadonlyArray<string>
}

/**
 * Where an oracle case runs (runner.ts runOracle and every helper of it): its database and the owner its installations
 * are planned for, a schema name of the case's own, where an installation the case's readings share lasts
 * (Installations), and where one reading of the case runs, undone after it.
 */
interface OracleSeatShape {
	readonly database: string
	readonly owner: string
	/** A unique schema name under `label`, which no other case takes. */
	readonly schema: (label: string) => Effect.Effect<string, SqlError, Scope.Scope>
	readonly lasting: Bracketed
	readonly reading: Effect.Effect<Bracketed, never, Scope.Scope>
}

/** The savepoint one reading of a case runs under inside the case's transaction, and what undoes it. */
const readingSavepoint: Pick<Bracketed, "open" | "close"> = {
	open: ["SAVEPOINT grizzle_oracle_reading"],
	close: [
		"ROLLBACK TO SAVEPOINT grizzle_oracle_reading",
		"RELEASE SAVEPOINT grizzle_oracle_reading"
	]
}

export class OracleSeat extends Context.Service<OracleSeat, OracleSeatShape>()(
	"grizzle-workspace/test/support/oracle/seat/OracleSeat"
) {
	/**
	 * An oracle case in the case's one rolled-back transaction on the worker's own clone (Substrate.rolledBack,
	 * Substrate.rolledBack): an installation lasts the case, each statement its own savepoint; a reading runs on the
	 * transaction's connection itself under a savepoint of its own, rolled back to after it; a schema name is the
	 * transaction's to allocate. Nothing a case installs or reads outlives it.
	 */
	static readonly rolledBack = (held: RolledBack<unknown>): OracleSeatShape => ({
		database: held.database,
		owner: pgCluster.owner,
		schema: held.schema,
		lasting: { connection: held.connection, open: [], close: [] },
		reading: Effect.succeed({ connection: held.bare, ...readingSavepoint })
	})
	/**
	 * An oracle case on a substrate of the case's own (Substrate.fresh): an installation committed in a transaction of
	 * its own, a reading in its own transaction on a pinned owner session, rolled back, a schema name the substrate
	 * allocates and drops with its roles when the case's scope closes. For a case that reads its substrate beside its seat
	 * (its owner, its admin session), which the rolled-back seat has none of.
	 */
	static readonly ofSubstrate = (substrate: SubstrateShape): OracleSeatShape => ({
		database: substrate.database,
		owner: substrate.owner.role,
		schema: (label: string) => substrate.schema({ create: false, label }),
		lasting: { connection: substrate.admin, open: ["BEGIN"], close: ["COMMIT"] },
		reading: Effect.map(substrate.admin.pin, (connection) => ({
			connection,
			open: ["BEGIN"],
			close: ["ROLLBACK"]
		}))
	})
}
