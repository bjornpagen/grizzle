import {
	Array as Arr,
	Effect,
	Option,
	Path,
	Record as Rec,
	type Scope,
	String as Str
} from "effect"
import { hostInputs, type InputFailure, valuesFailure } from "#adapter/apply/run.ts"
import { fromEngine } from "#adapter/engine.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import { type LoadedChange, type LoadedLogin, loadServed } from "#adapter/served/load.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import type { CliError } from "#cli/errors.ts"
import { draftSchema, servedFiles } from "#cli/generate.ts"
import type { RoleIsolation } from "#compiler/analysis/isolation/certify.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import * as Result from "#compiler/core/result.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import type { Param } from "#compiler/core/wire.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { noLive } from "#compiler/live/notify.ts"
import { noTextDomainUses } from "#compiler/physical/ddl/domains.ts"
import {
	type InstallExtension,
	noCarriers,
	noContribution
} from "#compiler/physical/install/extension.ts"
import { changesAt } from "#compiler/program/workload/change.ts"
import type { AnyLogin, AnyRole, AnySchema } from "#compiler/public/schema.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { servedFile } from "#compiler/served/json.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { defined } from "#test/support/assert.ts"
import { paths, repoRoot } from "#test/support/files.ts"
import {
	type Installed,
	installGenerated,
	installMigrated,
	replaceMigrated
} from "#test/support/install-migrate.ts"
import { type Names, namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import type { SqlError } from "#test/support/pg.ts"
import { openActors, textOfValue } from "#test/support/schedules/actors.ts"
import {
	everyRelation,
	exploreEnv,
	relationsFootprint,
	type Strategy
} from "#test/support/schedules/interleave.ts"
import {
	type Explained,
	type RaceStatement,
	type RaceTxn,
	runSerialRace,
	type SerialRaceFailed
} from "#test/support/schedules/serial.ts"
import type { PsqlProcessError, TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A shape as the oracle installs it (shapes.ts, drawn.ts): its schema, its roles by name, and the login over them, whose
 * workloads hold the members a race calls.
 */
export interface Shape {
	readonly schema: AnySchema
	readonly roles: Readonly<Record<string, AnyRole>>
	readonly login: AnyLogin
}

/**
 * Whose certificates an installation holds: generate's, the ones its draft's workload plan certifies; a flawed
 * certifier's, stated by hand with the flaw it stands for; generate's with some roles forced READ COMMITTED; or every
 * role at a level a race states, to run one shape's calls at each level (`stated`). The
 * installation holds any of them as it holds generate's, so every table its READ COMMITTED roles alone write keeps no
 * guard and their served writes begin at READ COMMITTED.
 */
export type Certifier =
	| { readonly kind: "generate" }
	| { readonly kind: "flawed"; readonly flaw: string; readonly roles: ReadonlyArray<RoleIsolation> }
	| { readonly kind: "forced"; readonly flaw: string; readonly roles: ReadonlyArray<string> }
	| { readonly kind: "stated"; readonly roles: ReadonlyArray<RoleIsolation> }

/**
 * A shape installed: the installation, its names, the level generate certifies each role at, each role's ChangeSets as
 * its served file loads them, and the level each role's served writes begin at, the installation's.
 */
export interface InstalledShape {
	readonly installed: Installed
	readonly names: Names
	readonly shape: Shape
	readonly generated: ReadonlyMap<string, Isolation>
	readonly changes: ReadonlyMap<string, ReadonlyMap<string, LoadedChange>>
	readonly levels: ReadonlyMap<string, Isolation>
}

/**
 * What a call passes its member, as the loaded member takes it (adapter/served/load.ts ChangeCall): its parameters, or
 * each call's facts beside them where the member's ChangeSet holds array members.
 */
export type CallInput =
	| { readonly kind: "params"; readonly params: ParamMap }
	| { readonly kind: "facts"; readonly facts: unknown; readonly params: ParamMap }

/**
 * A call a race makes in a session of its own: a ChangeSet member of a role with its input, which the oracle binds and
 * sends statement by statement as the served write's one flight states them.
 */
export interface RaceCall {
	readonly session: string
	readonly role: string
	readonly member: string
	readonly input: CallInput
}

/** A race: its calls, each in a session of its own, from the stored facts `initial`. */
export interface IsolationRace {
	readonly initial: FactSet
	readonly calls: Arr.NonEmptyReadonlyArray<RaceCall>
}

/** The draft `grizzle generate` makes of `shape` from the empty snapshot, and its schema as the CLI compiles it. */
const draftOf = (shape: Shape) =>
	Effect.provideService(
		Effect.gen(function* () {
			const config = yield* resolveConfig(
				defineConfig({
					schemas: [shape.schema],
					logins: [shape.login],
					migrations: "migrations",
					connection: () => offlineOwner
				}),
				`${repoRoot}app/grizzle.config.ts`
			)
			const configured = defined(config.schemas[0], "the configured schema")
			const compiled = yield* Effect.fromResult(compileSchema(configured))
			const draft = yield* draftSchema(
				compiled,
				emptySnapshot({ schemaName: configured.declared, schema: configured.ident }),
				[],
				noDeclarations
			)
			if (draft.served.kind === "noLogin") {
				return yield* Effect.die(new Error("a shape's login is its draft's"))
			}
			return { compiled, draft, served: draft.served }
		}),
		Path.Path,
		paths
	)

/**
 * The installer extension that states `roles`' certificates and contributes nothing else, which the installation reads
 * as it reads the served workload's (physical/access/extension.ts servedWorkloadExtension): each table's guard follows
 * them. The workload's access paths, the rest of that extension, are indexes, which decide no outcome a race compares;
 * its carrier roles are TEMPORARY grants, which the test cluster's PUBLIC already holds.
 */
const certifying = (roles: ReadonlyArray<RoleIsolation>): InstallExtension => ({
	contribute: () => Result.ok(noContribution),
	textDomainUses: noTextDomainUses,
	certifies: roles,
	carriers: noCarriers,
	live: noLive
})

/** Each role's level among `roles`, by its name. */
const levelsOf = (roles: ReadonlyArray<RoleIsolation>): ReadonlyMap<string, Isolation> =>
	new Map(Arr.map(roles, (r) => [r.role, r.certificate.level] as const))

/** Each role's ChangeSets in `loaded`, by role and member, and each role's served level. */
const servedOf = (loaded: LoadedLogin) => ({
	changes: new Map(
		Arr.map(loaded.roles, (r) => [
			r.name,
			new Map(
				Arr.flatMap(r.members, (member) =>
					member.kind === "change" && member.variants.kind === "change"
						? [[member.name, member.variants.change] as const]
						: []
				)
			)
		])
	),
	levels: new Map(Arr.map(loaded.roles, (r) => [r.name, r.isolation] as const))
})

/**
 * Installs `build(name)` under a fresh schema name with its login, holding `certifier`'s certificates, and loads every
 * role's ChangeSets from the login's served file.
 *
 * - generate's: installed as `grizzle generate` drafts and serves it (test/support/install-migrate.ts installGenerated),
 *   each role at the level its served file records;
 * - a flawed certifier's or generate's with roles forced: generate's draft of the shape certifies it first
 *   (cli/generate.ts draftSchema); the installation holds the stated certificates through an installer extension, as
 *   it holds the served workload's; and the served file is the draft's of the installed name (servedFiles), each role
 *   at its stated level. A draft under the installed name that certifies otherwise than under the first is a defect: a
 *   certificate is a function of the shape, never of its name.
 */
export const installShape = (
	build: (name: string) => Shape,
	certifier: Certifier
): Effect.Effect<
	InstalledShape,
	CompileError | SqlError | TransactionRolledBack | CliError | OpenError,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		if (certifier.kind === "generate") {
			const generated = yield* installGenerated(
				(name) => {
					const shape = build(name)
					return { schema: shape.schema, logins: [shape.login] }
				},
				{ label: "iso", ambient: ordinarySession }
			)
			const shape = build(generated.installed.declared)
			const json = defined(
				generated.served.get(shape.login.name),
				`the served file of login ${shape.login.name}`
			)
			const loaded = yield* Effect.fromResult(loadServed(servedFile(json), shape.login.name))
			const served = servedOf(loaded)
			return {
				installed: generated.installed,
				names: namesOf(generated.installed),
				shape,
				generated: served.levels,
				...served
			}
		}
		const declared = build("Iso")
		const first = yield* draftOf(declared)
		const generated = first.served.certification
		const certified =
			certifier.kind === "flawed" || certifier.kind === "stated"
				? certifier.roles
				: Arr.map(generated, (r): RoleIsolation =>
						certifier.roles.includes(r.role) ? { ...r, certificate: { level: "readCommitted" } } : r
					)
		const installed = yield* installMigrated(declared.schema, {
			ambient: ordinarySession,
			label: "iso",
			logins: [declared.login],
			extensions: [certifying(certified)]
		})
		const shape = build(installed.declared)
		const { compiled, draft, served } = yield* draftOf(shape)
		const named = levelsOf(served.certification)
		for (const [role, level] of levelsOf(generated)) {
			if (named.get(role) !== level) {
				return yield* Effect.die(
					new Error(
						`role ${role}: certified ${level} under one name and ${String(named.get(role))} under another`
					)
				)
			}
		}
		const levels = levelsOf(certified)
		const stated = yield* Effect.forEach([...served.logins], ([login, planned]) =>
			Effect.map(
				Effect.forEach([...planned.roles], ([name, role]) => {
					const level = defined(levels.get(name), `the stated level of role ${name}`)
					return level === role.level
						? Effect.succeed([name, role] as const)
						: Effect.map(fromEngine(changesAt(role, level)), (at) => [name, at] as const)
				}),
				(roles) => [login, { ...planned, roles: new Map(roles) }] as const
			)
		)
		const entries = yield* servedFiles(compiled, draft.snapshotFiles, {
			kind: "logins",
			certification: certified,
			logins: new Map(stated)
		})
		const entry = defined(
			Option.getOrUndefined(Arr.findFirst(entries, (e) => e.login === shape.login.name)),
			`the served file of login ${shape.login.name}`
		)
		const login = yield* Effect.fromResult(
			loadServed(servedFile(trustedJson<unknown>(entry.text)), shape.login.name)
		)
		return {
			installed,
			names: namesOf(installed),
			shape,
			generated: levelsOf(generated),
			...servedOf(login)
		}
	})

/** A SQL text literal of `text`: in quotes, its quotes doubled. */
const quoted = (text: string): string => `'${Str.replaceAll("'", "''")(text)}'`

/** The element types of the binary arrays grizzle sends (codec/bytea.ts): a text column's and a bytes column's. */
const binaryElements: ReadonlyMap<number, "text" | "bytea"> = new Map([
	[25, "text"],
	[17, "bytea"]
])

/**
 * A binary array placeholder as a SQL array literal: PostgreSQL's array send format (its dimensions, its element type's
 * oid, each dimension's size and lower bound, then each element's length, -1 for NULL, and bytes), of one dimension of
 * text or bytes, which is every one grizzle sends (codec/bytea.ts).
 */
const binaryLiteral = (bytes: Uint8Array): Option.Option<string> => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const dimensions = view.getInt32(0)
	const type = binaryElements.get(view.getInt32(8))
	if (type === undefined || dimensions > 1) {
		return Option.none()
	}
	if (dimensions === 0) {
		return Option.some(`('{}'::${type}[])`)
	}
	const elements: Array<string> = []
	let at = 20
	for (let i = 0; i < view.getInt32(12); i += 1) {
		const length = view.getInt32(at)
		at += 4
		if (length < 0) {
			elements.push("NULL")
			continue
		}
		const element = bytes.subarray(at, at + length)
		at += length
		elements.push(
			type === "text"
				? quoted(new TextDecoder("utf-8", { fatal: true }).decode(element))
				: `'\\x${Buffer.from(element).toString("hex")}'::bytea`
		)
	}
	return Option.some(`(ARRAY[${Arr.join(elements, ", ")}]::${type}[])`)
}

/**
 * `sql` with each placeholder replaced by its value's literal, the highest number first so $12 is never read as $1: a
 * text as itself, quoted, and a binary array as its array literal.
 */
const inlined = (sql: string, params: ReadonlyArray<Param>): Effect.Effect<string> =>
	Option.match(
		Option.all(
			Arr.map(params, (p) => (typeof p === "string" ? Option.some(quoted(p)) : binaryLiteral(p)))
		),
		{
			onNone: () =>
				Effect.die(new Error(`a placeholder of no text and no one-dimensional array: ${sql}`)),
			onSome: (literals) =>
				Effect.succeed(
					Arr.reduce(
						Arr.reverse(Arr.map(literals, (literal, i) => [i + 1, literal] as const)),
						sql,
						(text, [n, literal]) => Str.replaceAll(`$${n}`, literal)(text)
					)
				)
		}
	)

/**
 * The statements `call` sends, in the order its served write's one flight sends them: each statement its binding does
 * not skip, each execution its own, every placeholder inlined. A write the host refuses before any SQL sends one
 * constant SELECT naming the refusal, which a serial run of it shows alike.
 */
/** The one statement a call the host refuses before any SQL sends: a constant SELECT naming the refusal. */
export const hostRefused = `SELECT 'host refused'::text AS refused`

export const callStatements = (
	s: InstalledShape,
	call: RaceCall
): Effect.Effect<Arr.NonEmptyReadonlyArray<string>, InputFailure> =>
	Effect.gen(function* () {
		const change = defined(
			s.changes.get(call.role)?.get(call.member),
			`member ${call.member} of role ${call.role}`
		)
		const host =
			change.call.kind === "params" && call.input.kind === "params"
				? change.call.call(call.input.params)
				: change.call.kind === "facts" && call.input.kind === "facts"
					? yield* Effect.fromResult(change.call.call(call.input.facts, call.input.params))
					: yield* Effect.die(
							new Error(
								`${call.member} takes ${change.call.kind}, and the race passes ${call.input.kind}`
							)
						)
		const inputs = yield* hostInputs(change.entry, host)
		if (inputs.kind !== "bound") {
			return [hostRefused] as const
		}
		const flights = inputs.bound.flights
		if (flights.kind !== "write") {
			return yield* Effect.die(
				new Error(`the isolation shapes read no family before writing: ${call.member}`)
			)
		}
		const statements: Array<string> = []
		for (const statement of change.entry.program.flight.statements) {
			if (inputs.bound.skip.has(statement.index)) {
				continue
			}
			const executions = flights.chunks(statement, inForce(bindFrame))
			if (!executions.ok) {
				return yield* Effect.fail(valuesFailure(executions.error))
			}
			for (const execution of executions.value) {
				const sent = yield* inlined(execution.text.sql, execution.params)
				statements.push(sent)
			}
		}
		const [first, ...rest] = statements
		return first === undefined
			? ([`SELECT 'no statement'::text AS sent`] as const)
			: [first, ...rest]
	})

/** The level a role's served writes begin at, as its served file records it. */
const levelOf = (s: InstalledShape, role: string): Isolation =>
	defined(s.levels.get(role), `the served level of role ${role}`)

/**
 * A transaction's first statement, stating its level: SET TRANSACTION reads and writes no relation and takes no
 * snapshot, so it commutes with every other session's move, and a schedule may open a session with it and hold it
 * there.
 */
const setLevel = (level: Isolation): RaceStatement => ({
	sql: `SET TRANSACTION ISOLATION LEVEL ${level === "readCommitted" ? "READ COMMITTED" : "SERIALIZABLE"}`,
	footprint: relationsFootprint([])
})

/**
 * A call's direct transaction: its first statement setting the level its role's served file records, then the call's
 * statements, the served file's, compiled for that level (program/workload/change.ts RoleChanges `level`).
 */
const txnOf = (s: InstalledShape, call: RaceCall): Effect.Effect<RaceTxn<never>, InputFailure> =>
	Effect.map(callStatements(s, call), (statements) => {
		const sent = Arr.map(statements, (sql): RaceStatement => ({ sql, footprint: everyRelation }))
		return {
			kind: "direct",
			session: call.session,
			statements: [setLevel(levelOf(s, call.role)), ...sent],
			end: "commit"
		}
	})

/** How many moves a race's transactions make when each runs to its COMMIT: PCT's k. */
export const raceMoves = (txns: ReadonlyArray<RaceTxn<never>>): number =>
	Arr.reduce(txns, 0, (sum, t) => sum + (t.kind === "direct" ? t.statements.length + 1 : 1))

/** Every stored table's rows as text: its name and each row's JSON, one row each. */
export const stateSql = (names: Names): string =>
	Arr.join(
		Arr.map(
			names.storedTables,
			(table) =>
				`SELECT ${quoted(table)}::text AS "table", to_jsonb(t)::text AS "row" FROM ${table} AS t`
		),
		" UNION ALL "
	)

/**
 * Runs `race` over `s` at the levels its roles' served files record, every order `strategy` chooses, each run judged by the serial
 * reference (test/support/schedules/serial.ts): some order of the calls that respects real time, each run alone from
 * the race's initial state, shows every statement's rows or SQLSTATE the run showed and leaves its state.
 */
export const runIsolationRace = (
	s: InstalledShape,
	race: IsolationRace,
	strategy: (txns: ReadonlyArray<RaceTxn<never>>) => Strategy,
	noteRun: (explained: Explained<never>) => void
): Effect.Effect<
	void,
	| SerialRaceFailed
	| SqlError
	| PsqlProcessError
	| CompileError
	| TransactionRolledBack
	| InputFailure,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const env = yield* exploreEnv(substrate)
		const specs = Rec.fromEntries(
			Arr.map(race.calls, (call) => {
				const role = defined(s.shape.roles[call.role], `role ${call.role} of the shape`)
				return [call.session, { kind: "psql" as const, as: s.installed.world(role) }] as const
			})
		)
		const direct = yield* openActors(substrate, specs)
		const [first, ...rest] = yield* Effect.forEach(race.calls, (call) => txnOf(s, call))
		const txns: Arr.NonEmptyReadonlyArray<RaceTxn<never>> = [defined(first, "a call"), ...rest]
		yield* runSerialRace(
			env,
			{ direct, grizzle: {} },
			{
				name: Arr.join(
					Arr.map(race.calls, (c) => `${c.session}:${c.role}.${c.member}`),
					" "
				),
				txns,
				reset: Effect.provideService(
					replaceMigrated(s.installed, race.initial),
					Substrate,
					substrate
				),
				state: Effect.map(env.observer.queryValues(stateSql(s.names), []), (rows) =>
					Arr.map(rows, (row) => Arr.map(row, textOfValue))
				)
			},
			strategy(txns),
			noteRun
		)
	})
