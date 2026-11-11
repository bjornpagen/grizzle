import * as Arr from "effect/Array"
import * as Result from "effect/Result"
import type { WriteEntry } from "#adapter/apply/compile.ts"
import { readBacks } from "#adapter/apply/readback.ts"
import type { BoundReads, HostCall } from "#adapter/apply/run.ts"
import { contextOver, type TypedContext } from "#adapter/db/claims.ts"
import { rowOptions, toResult } from "#adapter/engine.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import { ServedLoginRefused } from "#adapter/errors/failures.ts"
import { type PageRuntime, pageRuntimeOf } from "#adapter/page/template.ts"
import { type ParamCodecs, paramCodecs } from "#adapter/reader/relations.ts"
import { type ReadProgram, readProgram } from "#adapter/reader/run.ts"
import type { DecodedRow } from "#adapter/reader/stream.ts"
import type { PrologueStatements } from "#adapter/wire/batch.ts"
import { servedWitness } from "#adapter/witness/index.ts"
import type { ArrayMember, ClosedTable } from "#compiler/plan/change.ts"
import type {
	BindContext,
	Codebook,
	CompileError,
	EncodingFailure,
	Isolation,
	ParamDecl,
	ParamValue,
	PatternReads,
	Row,
	SchemaFingerprint
} from "#compiler/plan/common.ts"
import type { PageVariant } from "#compiler/plan/read.ts"
import {
	codeNames,
	loadWrite,
	memberFactsOf,
	recordsReader,
	rosterCodebook,
	ServedPatterns,
	servedRunnable
} from "#compiler/plan/runtime.ts"
import type {
	ServedChange,
	ServedFile,
	ServedFootprint,
	ServedKey,
	ServedMember,
	ServedPage,
	ServedRead,
	ServedRefresh,
	ServedRoleForm,
	ServedSession,
	ServedTables,
	ServedVariants
} from "#compiler/plan/serve.ts"

/**
 * A served login's workload loaded: the one thing a layer reads of its login, rebuilt once per layer from the committed
 * file (served/forms.ts ServedFile), and never again per request. Every closure a program runs is rebuilt here by the
 * constructors the compile path runs it through: each declared parameter's codec, each read's program and its decoder
 * bound to the program's layouts, each page's runtime template and its decoder bound to every request variant's
 * layouts, each ChangeSet's read-backs, codecs and read-backs decoder, and each role's refusal classifier and claims'
 * codecs, all under the codebook of the file's own rosters. Nothing is compiled and no schema is evaluated.
 *
 * A read of a role's workload, loaded: its declared parameters and their codecs, its program, its rows' reader (its
 * decoder bound to the program's layouts), its key, the shape of its answer and the head fields its rows are keyed by
 * (served/forms.ts ServedKey), and its footprint, the tables a change of which its subscriptions route by.
 */
export interface LoadedRead {
	readonly params: ReadonlyArray<ParamDecl>
	readonly codecs: ParamCodecs
	readonly program: ReadProgram
	readonly read: (row: Row) => DecodedRow
	readonly key: ServedKey
	readonly footprint: ServedFootprint
}

/** A paged member's page, loaded: its runtime template, and its decoder bound to each template's layouts. */
export interface LoadedPage {
	readonly runtime: PageRuntime
	readonly reads: { readonly [V in PageVariant]: (row: Row) => DecodedRow }
}

/**
 * How one call of a loaded ChangeSet reads its write's host inputs (apply/run.ts HostCall), decided once at load by its
 * array members: a ChangeSet that holds some takes each call's facts beside its parameters (types/db FactsApply), a
 * record holding under each member's op a record holding under its relation an array of its facts, read once at the
 * boundary
 * (runtime/write/members.ts memberFactsOf, the one checker of a call's facts), a value of any other shape the
 * EncodingFailure that names it; one that holds none takes its parameters alone. Each call holds the values the
 * declaration bound.
 */
export type ChangeCall =
	| { readonly kind: "params"; readonly call: (params: unknown) => HostCall }
	| {
			readonly kind: "facts"
			readonly call: (facts: unknown, params: unknown) => Result.Result<HostCall, EncodingFailure>
	  }

/**
 * A ChangeSet compiled for one set of its fill contexts, loaded: its write entry, its read-backs' decoder bound, and how
 * each call reads its host inputs (ChangeCall).
 */
export interface LoadedChange {
	readonly entry: WriteEntry
	readonly reads: BoundReads<unknown>
	readonly call: ChangeCall
}

/** The member facts of a call of a ChangeSet that holds no array member. */
const noMemberFacts: ReadonlyMap<string, ReadonlyArray<unknown>> = new Map()

/** How each call of a ChangeSet that binds `bound` and holds array members `members` reads its host inputs. */
const changeCall = (
	bound: ReadonlyMap<string, ParamValue>,
	members: ReadonlyArray<ArrayMember>
): ChangeCall =>
	Arr.isReadonlyArrayNonEmpty(members)
		? {
				kind: "facts",
				call: (facts, params) =>
					Result.map(toResult(memberFactsOf(facts, members)), (read) => ({
						params,
						bound,
						members: read
					}))
			}
		: { kind: "params", call: (params) => ({ params, bound, members: noMemberFacts }) }

/** A ChangeSet's variants by its fill contexts, each leaf loaded. */
export type LoadedVariants =
	| { readonly kind: "change"; readonly change: LoadedChange }
	| {
			readonly kind: "split"
			readonly context: string
			readonly holding: LoadedVariants
			readonly lacking: LoadedVariants
	  }

/** One member of a role's workload, loaded (served/forms.ts ServedMember). */
export type LoadedMember = { readonly name: string } & (
	| { readonly kind: "read"; readonly read: LoadedRead }
	| { readonly kind: "paged"; readonly read: LoadedRead; readonly page: LoadedPage }
	| { readonly kind: "key"; readonly fields: ReadonlyArray<string>; readonly read: LoadedRead }
	| { readonly kind: "change"; readonly variants: LoadedVariants }
	| { readonly kind: "refresh"; readonly refresh: ServedRefresh }
)

/**
 * One role of the login, loaded: its name in the login, the PostgreSQL role each of its Dbs' transactions enters, the
 * contexts its relations read, typed, which a token's claims decode through, and its workload's members in order.
 */
export interface LoadedRole {
	readonly name: string
	readonly installed: string
	readonly contexts: ReadonlyArray<TypedContext>
	readonly members: ReadonlyArray<LoadedMember>
	/** The level its changes begin at (served/forms.ts ServedRoleForm isolation). */
	readonly isolation: Isolation
}

/**
 * A served login, loaded: its declared name and its base's, the PostgreSQL role every session of its pool logs in as,
 * the fingerprint every Db's prologue guards the ledger with, the prologue's two texts, its sessions' startup options and
 * control texts, its roles in the login's order, and its installed tables (`tables`).
 */
export interface LoadedLogin {
	readonly login: string
	readonly base: string
	readonly role: string
	readonly fingerprint: SchemaFingerprint
	readonly prologue: PrologueStatements
	/** What every session of the login's pool sends that no program states (wire/session.ts makePool). */
	readonly session: ServedSession
	readonly roles: Arr.NonEmptyReadonlyArray<LoadedRole>
	/** The installed tables its statements read and write, with their indexes, which its explains name plans by. */
	readonly tables: ServedTables
}

/** A read's decoder bound to `layouts` under `bind`, its refusal a defect of the compile that wrote the file. */
const boundReader = (
	read: Pick<ServedRead, "decoder">,
	layouts: Arr.NonEmptyReadonlyArray<ReadProgram["layouts"][number]>,
	bind: BindContext
): Result.Result<(row: Row) => DecodedRow, CompileError> =>
	toResult(recordsReader(read.decoder, layouts, bind))

/**
 * A ChangeSet's read-backs as a served file holds them, and its reads decoder bound to their Row's layout, once: a
 * layout the decoder cannot bind is a defect of the compile that wrote the file, its CompileError.
 */
const servedReads = (
	entry: WriteEntry,
	decoder: ServedChange["decoder"]
): Result.Result<BoundReads<unknown>, CompileError> => {
	const runs = entry.readBacks
	return Result.map(toResult(recordsReader(decoder, [runs.layout], entry.bind)), (read) => ({
		runs,
		read
	}))
}

/** A read, loaded under the codes `codes`, the bind context `bind` and the file's pattern table `patterns`. */
const loadRead = (
	read: ServedRead,
	codes: Codebook,
	bind: BindContext,
	patterns: PatternReads
): Result.Result<LoadedRead, CompileError> => {
	const program = readProgram(read.source, read.spine, codes)
	return Result.map(boundReader(read, program.layouts, bind), (reader) => ({
		params: read.params,
		codecs: paramCodecs(read.params, codes, patterns),
		program,
		read: reader,
		key: read.key,
		footprint: read.footprint
	}))
}

/** A paged member's page, loaded over its read's parameters and spine. */
const loadPage = (
	page: ServedPage,
	read: ServedRead,
	codes: Codebook,
	bind: BindContext
): Result.Result<LoadedPage, CompileError> =>
	Result.gen(function* () {
		const runtime = pageRuntimeOf({ page, params: read.params, spine: read.spine, codes })
		const variant = (v: PageVariant) =>
			boundReader(read, runtime.artifact.requests[v].layouts, bind)
		return {
			runtime,
			reads: {
				first: yield* variant("first"),
				after: yield* variant("after"),
				last: yield* variant("last"),
				before: yield* variant("before")
			}
		}
	})

/** A ChangeSet compiled for one set of its fill contexts, loaded: its entry, read by its role's `witness`, its write
 * prepared against the file's closed relations. */
const loadChange = (
	change: ServedChange,
	witness: WriteEntry["witness"],
	closed: ClosedTable,
	codes: Codebook,
	bind: BindContext,
	patterns: PatternReads
): Result.Result<LoadedChange, CompileError> => {
	const program = change.program
	const entry: WriteEntry = {
		program: servedRunnable(loadWrite(program, codes, closed, patterns)),
		witness,
		readBacks: readBacks(change.readBacks, codes),
		codecs: paramCodecs(program.params, codes, patterns),
		bind
	}
	return Result.map(servedReads(entry, change.decoder), (reads) => ({
		entry,
		reads,
		call: changeCall(change.bound, change.members)
	}))
}

/** A ChangeSet's variants, each leaf loaded. */
const loadVariants = (
	variants: ServedVariants,
	witness: WriteEntry["witness"],
	closed: ClosedTable,
	codes: Codebook,
	bind: BindContext,
	patterns: PatternReads
): Result.Result<LoadedVariants, CompileError> => {
	switch (variants.kind) {
		case "change":
			return Result.map(
				loadChange(variants.change, witness, closed, codes, bind, patterns),
				(change): LoadedVariants => ({ kind: "change", change })
			)
		case "split":
			return Result.gen(function* () {
				const holding = yield* loadVariants(
					variants.holding,
					witness,
					closed,
					codes,
					bind,
					patterns
				)
				const lacking = yield* loadVariants(
					variants.lacking,
					witness,
					closed,
					codes,
					bind,
					patterns
				)
				return { kind: "split", context: variants.context, holding, lacking }
			})
	}
}

/** One member of a role's workload, loaded. */
const loadMember = (
	member: ServedMember,
	witness: WriteEntry["witness"],
	closed: ClosedTable,
	codes: Codebook,
	bind: BindContext,
	patterns: PatternReads
): Result.Result<LoadedMember, CompileError> => {
	switch (member.kind) {
		case "read":
			return Result.map(loadRead(member.read, codes, bind, patterns), (read): LoadedMember => ({
				name: member.name,
				kind: "read",
				read
			}))
		case "key":
			return Result.map(loadRead(member.read, codes, bind, patterns), (read): LoadedMember => ({
				name: member.name,
				kind: "key",
				fields: member.fields,
				read
			}))
		case "paged":
			return Result.gen(function* () {
				const read = yield* loadRead(member.read, codes, bind, patterns)
				const page = yield* loadPage(member.page, member.read, codes, bind)
				return { name: member.name, kind: "paged", read, page }
			})
		case "change":
			return Result.map(
				loadVariants(member.variants, witness, closed, codes, bind, patterns),
				(variants): LoadedMember => ({ name: member.name, kind: "change", variants })
			)
		case "refresh":
			return Result.succeed({ name: member.name, kind: "refresh", refresh: member.refresh })
	}
}

/** One role of the login, loaded under the file's above laws. */
const loadRole = (
	role: ServedRoleForm,
	file: ServedFile,
	codes: Codebook,
	bind: BindContext,
	patterns: PatternReads
): Result.Result<LoadedRole, CompileError> =>
	Result.gen(function* () {
		const witness = servedWitness(role.refusals, file.above, codes)
		const members: Array<LoadedMember> = []
		for (const member of role.members) {
			members.push(yield* loadMember(member, witness, file.closed, codes, bind, patterns))
		}
		return {
			name: role.name,
			installed: role.installed,
			contexts: Arr.map(role.contexts, (context) => contextOver(context, context.fields, codes)),
			members,
			isolation: role.isolation
		}
	})

/** A refusal of the served file at stage config. */
const refusedFile = (reason: ServedLoginRefused): OpenError => new OpenError({ reason })

/**
 * The served login a layer serves, loaded from its file as served(...) read it (served/json.ts servedFile), for the
 * login named `name`: refused at stage config when the file is another login's; then everything its programs run,
 * rebuilt under the codebook of its own rosters (see the header). A form the file holds that its own compile would not
 * bind is a refusal at stage schema, which `grizzle check` keeps from any committed file.
 */
export const loadServed = (file: ServedFile, name: string): Result.Result<LoadedLogin, OpenError> =>
	Result.gen(function* () {
		if (file.login !== name) {
			return yield* new ServedLoginRefused({ login: name, file: file.login }).pipe(
				refusedFile,
				Result.fail
			)
		}
		const codes = rosterCodebook(file.rosters)
		const bind: BindContext = { options: rowOptions, names: codeNames(codes) }
		const patterns = ServedPatterns.of(file.matchers)
		const roles: Array<LoadedRole> = []
		for (const role of file.roles) {
			roles.push(
				yield* Result.mapError(
					loadRole(role, file, codes, bind, patterns),
					(reason) => new OpenError({ reason })
				)
			)
		}
		if (!Arr.isReadonlyArrayNonEmpty(roles)) {
			return yield* new ServedLoginRefused({ login: name, file: file.login }).pipe(
				refusedFile,
				Result.fail
			)
		}
		return {
			login: file.login,
			base: file.base,
			role: file.role,
			fingerprint: file.fingerprint,
			prologue: file.prologue,
			session: file.session,
			roles,
			tables: file.tables
		}
	})
