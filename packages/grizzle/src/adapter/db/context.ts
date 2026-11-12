import type { RoleContext } from "#adapter/served/role.ts"
import {
	excludesNothing,
	type Frame,
	type Prologue,
	preparedStatement,
	readFrame,
	writeFrame
} from "#adapter/wire/batch.ts"
import type { SessionPool } from "#adapter/wire/session.ts"
import type { WriteExclusion } from "#compiler/plan/change.ts"
import type { Isolation } from "#compiler/plan/common.ts"

/**
 * What every operation of one opened database shares: what each of its transactions begins with, the contexts its
 * claims hold a fact of, and the session pool of its login. Db.open builds one per call over the role its layer loaded
 * from the login's served file (db/served.ts); every program a Db runs was compiled by `grizzle generate`.
 */
export interface ServedDbContext {
	/**
	 * What each of the Db's transactions begins with: the fence against the snapshot it was admitted at, then the role's
	 * PostgreSQL name and the Db's claims setting (wire/batch.ts Prologue).
	 */
	readonly prologue: Prologue
	/**
	 * The contexts the Db's claims hold a fact of, by name, which its writes into query entries fill from
	 * (write/frontend/entry.ts EntryClaims).
	 */
	readonly claims: ReadonlySet<string>
	readonly pool: SessionPool
	/** The level the role's changes begin at, as generate certified it (served/forms.ts ServedRoleForm.isolation). */
	readonly isolation: Isolation
}

/**
 * The context of a Db its layer compiled in-process (pool/registry.ts compiledDbLayer), the served one's with its role's
 * compilation, which its every program compiles through for the call. Only the tests still on that path read it.
 */
export type DbContext = ServedDbContext & RoleContext

/** The frame of every read of the Db: SERIALIZABLE READ ONLY. */
export const dbReadFrame = (ctx: Pick<DbContext, "prologue">): Frame => readFrame(ctx.prologue)

/**
 * The frame of a change of the Db: read-write at its role's level, locking, before its snapshot, what its write's login
 * fences of what it writes (engine runtime/write/flight.ts WriteExclusion).
 */
export const dbChangeFrame = (
	ctx: Pick<DbContext, "prologue" | "isolation">,
	exclusion: WriteExclusion
): Frame =>
	writeFrame(
		ctx.prologue,
		ctx.isolation,
		exclusion.kind === "lock"
			? { kind: "lock", statement: preparedStatement(exclusion.text, []) }
			: excludesNothing
	)

/** The frame of every refresh of the Db: read-write at SERIALIZABLE, whatever its role's changes begin at. */
export const dbRefreshFrame = (ctx: Pick<DbContext, "prologue">): Frame =>
	writeFrame(ctx.prologue, "serializable", excludesNothing)
