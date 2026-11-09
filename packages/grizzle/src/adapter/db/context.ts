import type { RoleContext } from "#adapter/served/role.ts"
import { type Frame, type Prologue, readFrame, writeFrame } from "#adapter/wire/batch.ts"
import type { SessionPool } from "#adapter/wire/session.ts"

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
}

/**
 * The context of a Db its layer compiled in-process (pool/registry.ts compiledDbLayer), the served one's with its role's
 * compilation, which its every program compiles through for the call. Only the tests still on that path read it.
 */
export type DbContext = ServedDbContext & RoleContext

/** The frame of every read of the Db, and of every write and refresh. */
export const dbReadFrame = (ctx: Pick<DbContext, "prologue">): Frame => readFrame(ctx.prologue)
export const dbWriteFrame = (ctx: Pick<DbContext, "prologue">): Frame => writeFrame(ctx.prologue)
