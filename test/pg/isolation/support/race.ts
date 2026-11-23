import * as Result from "@bjornpagen/grizzle-text/base/result"
import { utf8Text } from "@bjornpagen/grizzle-text/utf8"
import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, Path, String as Str } from "effect"
import { hostInputs, type InputFailure, valuesFailure } from "#adapter/apply/run.ts"
import { fromEngine } from "#adapter/engine.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import {
	type LoadedChange,
	type LoadedLogin,
	type LoadedRead,
	loadServed
} from "#adapter/served/load.ts"
import { loginChangesOver } from "#adapter/served/login.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, servedFiles } from "#cli/generate.ts"
import type { RoleIsolation } from "#compiler/analysis/isolation/certify.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import type { Param } from "#compiler/core/wire.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { transactionClock } from "#compiler/ir/clock.ts"
import { noLive } from "#compiler/live/notify.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import {
	type InstallExtension,
	noCalls,
	noCarriers,
	noContribution,
	noFences,
	type RoleHold,
	servesNoParams
} from "#compiler/physical/install/extension.ts"
import { servedHolds } from "#compiler/program/workload/compile.ts"
import type { AnyLogin, AnyRole, AnySchema } from "#compiler/public/schema.ts"
import { reachOf } from "#compiler/runtime/write/steps.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { servedFile } from "#compiler/served/json.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { templateNeedBudget } from "#test/support/budgets.ts"
import { paths, repoRoot } from "#test/support/files.ts"
import {
	appliedHistory,
	draftedHistory,
	type Generated,
	generatedTemplate,
	type Installed,
	noPlaceholders,
	noVersionWorkload,
	templateInstalled
} from "#test/support/install-migrate.ts"
import { type Names, namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { everyRelation } from "#test/support/schedules/interleave.ts"
import { type RaceStatement, type RaceTxn } from "#test/support/schedules/serial.ts"
import { installationGroup } from "#test/support/substrate/replace.ts"
import {
	installTemplate,
	type SubstrateCase,
	type SubstrateShape,
	type SubstrateTemplate
} from "#test/support/substrate/substrate.ts"

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
 * A shape installed: the installation, its names, the level generate certifies each role at, each role's ChangeSets and
 * reads as its served file loads them, the level each role's served writes begin at, the installation's, and the BEGIN
 * of a write at each level and of a read, immediate and deferrable, as the served file states them.
 */
export interface InstalledShape {
	readonly installed: Installed
	readonly names: Names
	readonly shape: Shape
	readonly generated: ReadonlyMap<string, Isolation>
	readonly changes: ReadonlyMap<string, ReadonlyMap<string, LoadedChange>>
	readonly reads: ReadonlyMap<string, ReadonlyMap<string, LoadedRead>>
	readonly levels: ReadonlyMap<string, Isolation>
	readonly readBegins: LoadedLogin["session"]["begin"]["read"]
	readonly writeBegins: LoadedLogin["session"]["begin"]["write"]
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
 * sends statement by statement as the served write's one flight states them; a read member of a role with its
 * parameters, whose one statement the oracle sends in the read's own transaction, DEFERRABLE where its member is
 * deferrable(...); or a transaction of the installation's owner, its statements as written, at the database's default
 * level, as an operator runs what no role holds, a retirable unit's retirement function among them.
 */
type RaceCall =
	| {
			readonly kind: "change"
			readonly session: string
			readonly role: string
			readonly member: string
			readonly input: CallInput
	  }
	| {
			readonly kind: "read"
			readonly session: string
			readonly role: string
			readonly member: string
			readonly params: ParamMap
	  }
	| {
			readonly kind: "owner"
			readonly session: string
			readonly statements: (s: InstalledShape) => Arr.NonEmptyReadonlyArray<string>
	  }

/** A race's ChangeSet call (RaceCall). */
type ChangeCall = Extract<RaceCall, { readonly kind: "change" }>

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
				noDeclarations,
				silentPhases
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
 * The installer extension that states `roles`' certificates and the roles whose served ChangeSets hold a retirable
 * unit, `holds`, and contributes nothing else, which the installation reads as it reads the served workload's
 * (physical/access/extension.ts servedWorkloadExtension): each table's guard follows the certificates, and each holding
 * role holds EXECUTE on its unit's hold. The workload's access paths, the rest of that extension, are indexes, which
 * decide no outcome a race compares; its carrier roles are TEMPORARY grants, which the test cluster's PUBLIC already
 * holds.
 */
const certifying = (
	roles: ReadonlyArray<RoleIsolation>,
	holds: ReadonlyArray<RoleHold>
): InstallExtension => ({
	contribute: () => Result.ok(noContribution),
	params: servesNoParams,
	certifies: roles,
	carriers: noCarriers,
	fences: noFences,
	holds,
	calls: noCalls,
	live: noLive
})

/** Each role's level among `roles`, by its name. */
const levelsOf = (roles: ReadonlyArray<RoleIsolation>): ReadonlyMap<string, Isolation> =>
	new Map(Arr.map(roles, (r) => [r.role, r.certificate.level] as const))

/**
 * Each role's ChangeSets and reads in `loaded`, by role and member, each role's served level, and a read's BEGIN texts.
 */
const servedOf = (loaded: LoadedLogin) => ({
	reads: new Map(
		Arr.map(loaded.roles, (r) => [
			r.name,
			new Map(
				Arr.flatMap(r.members, (member) =>
					member.kind === "read" || member.kind === "key"
						? [[member.name, member.read] as const]
						: []
				)
			)
		])
	),
	readBegins: loaded.session.begin.read,
	writeBegins: loaded.session.begin.write,
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

/** A shape's schema and the one login its installation carries. */
const shapeLogins = (shape: Shape) => ({ schema: shape.schema, logins: [shape.login] })

/** A generated installation of `build(name)` as a race reads it: every role at the level its served file records. */
const generatedShape = (
	generated: Generated,
	build: (name: string) => Shape
): Effect.Effect<InstalledShape, CompileError | OpenError> =>
	Effect.gen(function* () {
		const shape = build(generated.installed.declared)
		const json = defined(
			generated.served.get(shape.login.name),
			`the served file of login ${shape.login.name}`
		)
		const file = yield* fromEngine(servedFile(json))
		const loaded = yield* Effect.fromResult(loadServed(file, shape.login.name))
		const served = servedOf(loaded)
		return {
			installed: generated.installed,
			names: namesOf(generated.installed),
			shape,
			generated: served.levels,
			...served
		}
	})

/**
 * A certified installation of `build(name)` planned under `name`, all but its install: the history
 * that installs the shape's schema with its login, holding the certificates `certifier` states (certifying), its
 * options, the shape rebuilt under `name`, the levels generate certifies, and the login's served file of the installed
 * name, each role at its stated level, loaded.
 */
const certifiedPlan = (
	build: (name: string) => Shape,
	certifier: Exclude<Certifier, { readonly kind: "generate" }>,
	name: string
) =>
	Effect.gen(function* () {
		const declared = build("Iso")
		const first = yield* draftOf(declared)
		const generated = first.served.certification
		const certified =
			certifier.kind === "flawed" || certifier.kind === "stated"
				? certifier.roles
				: Arr.map(generated, (r): RoleIsolation =>
						certifier.roles.includes(r.role) ? { ...r, certificate: { level: "readCommitted" } } : r
					)
		const options = {
			label: "iso",
			extensions: [
				certifying(
					certified,
					servedHolds(new Map(Arr.map([...first.served.logins], ([l, p]) => [l, p.roles] as const)))
				)
			],
			ambient: ordinarySession,
			compile: compileInstallation,
			review: noPlaceholders
		}
		const history = yield* draftedHistory(
			[
				{
					version: {
						schema: declared.schema,
						logins: [declared.login],
						declarations: noDeclarations
					},
					workload: noVersionWorkload
				}
			],
			options,
			name
		)
		const shape = build(name)
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
		const stated = yield* Effect.forEach([...served.logins], ([login, planned]) => {
			const at = defined(
				Option.getOrUndefined(Arr.findFirst(compiled.logins, (l) => l.owned.name === login)),
				`the configured login ${login}`
			)
			return Effect.map(
				Effect.forEach([...planned.roles], ([role, held]) => {
					const level = defined(levels.get(role), `the stated level of role ${role}`)
					return level === held.level
						? Effect.succeed([role, held] as const)
						: Effect.mapBoth(
								loginChangesOver(at.login, at.owned, planned.artifacts, level, transactionClock),
								{
									onFailure: (refused) => refused.error,
									onSuccess: (changes) =>
										[
											role,
											defined(changes.get(role), `the change compile of role ${role}`)
										] as const
								}
							)
				}),
				(roles) => [login, { ...planned, roles: new Map(roles) }] as const
			)
		})
		const entries = yield* servedFiles(
			compiled,
			draft,
			{
				kind: "logins",
				certification: certified,
				fences: [],
				logins: new Map(stated)
			},
			silentPhases
		)
		const entry = defined(
			Option.getOrUndefined(Arr.findFirst(entries, (e) => e.login === shape.login.name)),
			`the served file of login ${shape.login.name}`
		)
		const file = yield* fromEngine(servedFile(trustedJson<unknown>(entry.text)))
		const login = yield* Effect.fromResult(loadServed(file, shape.login.name))
		return { history, options, shape, generated: levelsOf(generated), served: servedOf(login) }
	})

/** What a certified plan (certifiedPlan) reads once its history is installed as `installed`. */
const shapeOf = (
	plan: Effect.Success<ReturnType<typeof certifiedPlan>>,
	installed: Installed
): InstalledShape => ({
	installed,
	names: namesOf(installed),
	shape: plan.shape,
	generated: plan.generated,
	...plan.served
})

/**
 * installShape's generated installation as a template (install-migrate.ts generatedTemplate): `build(name)` drafted and
 * served once per member under the template's name. A case reads its shape over its clone (generatedShapeIn).
 */
export const generatedShapeTemplate = (
	declaredIn: ImportMeta,
	name: string,
	build: (name: string) => Shape
): SubstrateTemplate<Generated> =>
	generatedTemplate({
		declaredIn,
		name,
		content: { shape: name },
		build: (installed) => shapeLogins(build(installed)),
		ambient: ordinarySession
	})

/** The shape of a case over a clone of a generated shape's template (generatedShapeTemplate), as installShape reads it. */
const generatedShapeIn = (
	taken: SubstrateCase<Generated>,
	build: (name: string) => Shape
): Effect.Effect<InstalledShape, CompileError | OpenError> => generatedShape(taken.value, build)

/**
 * installShape's certified installation as a template (substrate.ts installTemplate): `build(name)` holding
 * `certifier`'s certificates, every draft, certificate and served file of it planned once per worker under the
 * template's name (certifiedPlan), and installed once per member; each case's InstalledShape the installation in its
 * clone, every login logging in with the password its template derived. `name` tells it from the other templates its
 * declaring module states.
 */
export const certifiedShapeTemplate = (
	declaredIn: ImportMeta,
	name: string,
	build: (name: string) => Shape,
	certifier: Exclude<Certifier, { readonly kind: "generate" }>
): SubstrateTemplate<InstalledShape> =>
	installTemplate({
		budget: templateNeedBudget,
		declaredIn,
		name,
		content: { shape: name, certifier: certifier.kind },
		plan: (names) =>
			Effect.map(certifiedPlan(build, certifier, names.schema), (plan) => ({
				names,
				plan
			})),
		install: ({ names, plan }) =>
			Effect.asVoid(appliedHistory(plan.history, names.schema, plan.options, new Map())),
		bind: ({ names, plan }, binding) =>
			shapeOf(plan, templateInstalled(names, plan.history, ordinarySession, new Map(), binding)),
		reset: (shape) => installationGroup(shape.names)
	})

/** A shape a case races, and the substrate of the seat it is installed in, where its race runs (raceOn). */
export interface SeatedShape {
	readonly shape: InstalledShape
	readonly seat: SubstrateShape
}

/** A case's seat of a generated shape's template (generatedShapeTemplate) as the shape it races. */
export const seatedGenerated =
	(build: (name: string) => Shape) =>
	(taken: SubstrateCase<Generated>): Effect.Effect<SeatedShape, CompileError | OpenError> =>
		Effect.map(generatedShapeIn(taken, build), (shape) => ({ shape, seat: taken.substrate }))

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
				? quoted(defined(utf8Text(element), "a text element of a bound array is UTF-8"))
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

/** The one statement a call the host refuses before any SQL sends: a constant SELECT naming the refusal. */
const hostRefused = `SELECT 'host refused'::text AS refused`

/**
 * The statements of `call` a race interleaves, in the order its served write's one flight sends them: each statement
 * that reaches stored state (runtime/write/steps.ts reachOf, the fact the certifier reads too) and its binding does
 * not skip, each execution its own, every placeholder inlined. The admission reaches only the call's parameters, so it
 * commutes with every other call's statements and is no step of a race; the call's parameters are the race's own, so
 * it admits them. A write the host refuses before any SQL sends one constant SELECT naming the refusal, which a serial
 * run of it shows alike.
 */
export const callStatements = (
	s: InstalledShape,
	call: ChangeCall
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
		const statements: Array<string> = []
		for (const statement of change.entry.program.statements) {
			if (inputs.bound.skip.has(statement.index) || reachOf(statement.step) === "parameters") {
				continue
			}
			const executions = inputs.bound.chunks(statement, inForce(bindFrame))
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
 * The lock a change call's served write takes before its snapshot (runtime/write/flight.ts WriteExclusion), none where
 * its login fences nothing it writes. The call's session is its role's, which holds DELETE on every relation it fences,
 * a privilege that permits the lock as the login's MAINTAIN does.
 */
const exclusionOf = (s: InstalledShape, call: ChangeCall): ReadonlyArray<RaceStatement> => {
	const exclusion = defined(
		s.changes.get(call.role)?.get(call.member),
		`member ${call.member} of role ${call.role}`
	).entry.program.exclusion
	return exclusion.kind === "lock" ? [{ sql: exclusion.text.sql, footprint: everyRelation }] : []
}

/**
 * A change call's direct transaction: begun as its served write begins, its BEGIN stating the level its role's served
 * file records (schedules/types.ts DirectAction BeginAs), then the lock its served write takes before its snapshot, as a
 * Db's prologue sends it before the statement that takes the snapshot, then the call's statements, the served file's,
 * compiled for that level (program/workload/change.ts RoleChanges `level`).
 */
export const changeTxnOf = (
	s: InstalledShape,
	call: ChangeCall
): Effect.Effect<RaceTxn<never>, InputFailure> =>
	Effect.map(callStatements(s, call), (statements) => {
		const sent = Arr.map(statements, (sql): RaceStatement => ({ sql, footprint: everyRelation }))
		const [first, ...rest] = [...exclusionOf(s, call), ...sent]
		return {
			kind: "direct",
			session: call.session,
			begin: { _tag: "BeginAs", sql: s.writeBegins[levelOf(s, call.role)] },
			statements: [defined(first, "a call's statement"), ...rest],
			end: "commit"
		}
	})
