import type { DbCapabilities } from "#adapter/admission/expectation.ts"
import { type Frame, type Prologue, readFrame, writeFrame } from "#adapter/wire/batch.ts"
import type { SessionPool } from "#adapter/wire/session.ts"
import type { InstallationWitness } from "#adapter/witness/index.ts"
import type { BindContext } from "#compiler/core/decoder.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type * as Engine from "#compiler/core/result.ts"
import type { RoleDesc } from "#compiler/ir/desc.ts"
import type { QueryInput } from "#compiler/program/compile.ts"
import type { SchemaArtifacts, SchemaInput } from "#compiler/program/schema.ts"
import type { CompiledTemplate, ExecutionRequest } from "#compiler/program/template.ts"

/**
 * What every operation of one opened database shares.
 *
 * Db.open builds one DbContext per call and every operation of the Db it yields reads it: the role the database was
 * opened for, its artifacts (owned base, physical names, law model, the role's views), which its layer computed once
 * when it was built (pool/registry.ts), what each of its transactions begins with (the fence, then the role's PostgreSQL
 * name and the Db's claims), and the session pool of its login. Every program a Db runs that neither its layer (the
 * login's workloads) nor its caller (db.compile) compiled ahead is compiled for the call against those artifacts.
 *
 * A role value, parsed (program/schema.ts parseSchemaInput).
 */
export type RoleInput = Extract<SchemaInput, { readonly kind: "role" }>

/**
 * What compiling a program for one role reads, before any Db of it: the role, its artifacts and its compilation. The
 * layer compiles the login's workloads against it, once, when it is built; a Db's context extends it.
 */
export interface RoleContext {
	/**
	 * The role value, parsed once when the layer was built: every program of its Dbs is checked against it, and a
	 * program over the base runs on a full role, whose levels hold its base.
	 */
	readonly schema: RoleInput
	/** The base's declared name, from which the PostgreSQL schema and the roles derive. */
	readonly declared: string
	/** The role's Description. */
	readonly role: RoleDesc
	readonly artifacts: SchemaArtifacts
	/**
	 * How a query is compiled for one request: against the role and its artifacts (program/template.ts templateFor).
	 * Every read, page and explain a Db runs that no one compiled ahead compiles through it, every call.
	 */
	readonly compile: (
		query: QueryInput,
		request: ExecutionRequest
	) => Engine.Result<CompiledTemplate, CompileError>
	/** The installation's witness decoding for the role, the layer's (witness/index.ts). */
	readonly witness: InstallationWitness
	/**
	 * What every decoder of the role's programs binds under besides its layout, the layer's: the shell's Option
	 * vocabulary, and each roster's names in code order from the installation's codes, which a closed id's or a set's
	 * cell is read by.
	 */
	readonly bind: BindContext
}

export interface DbContext extends RoleContext, DbCapabilities {
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

/** The frame of every read of the Db, and of every write and refresh. */
export const dbReadFrame = (ctx: Pick<DbContext, "prologue">): Frame => readFrame(ctx.prologue)
export const dbWriteFrame = (ctx: Pick<DbContext, "prologue">): Frame => writeFrame(ctx.prologue)

/**
 * The internals of an opened Db, for the operations other packages implement over it (apply, refresh, explain,
 * page) and for the tests that inspect which template a read selected. Never part of the public API.
 */
const contexts = new WeakMap<object, DbContext>()

export const registerContext = (db: object, context: DbContext): void => {
	contexts.set(db, context)
}

export const dbContext = (db: object): DbContext | undefined => contexts.get(db)
