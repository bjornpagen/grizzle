import { utf8Text } from "@bjornpagen/grizzle-text/utf8"
import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, Path, String as Str } from "effect"
import { hostInputs, type InputFailure, valuesFailure } from "#adapter/apply/run.ts"
import { fromEngine } from "#adapter/engine.ts"
import type { CallInputRefused } from "#adapter/errors/failures.ts"
import {
	type LoadedChange,
	type LoadedLogin,
	type LoadedRead,
	loadServed
} from "#adapter/served/load.ts"
import { builtLogin, loginChangesOver } from "#adapter/served/login.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, servedFiles } from "#cli/generate.ts"
import type { RoleIsolation } from "#compiler/core/certificate.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import type { Param } from "#compiler/core/wire.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { transactionClock } from "#compiler/ir/clock.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { servedWorkloadExtension } from "#compiler/physical/access/extension.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import { servableRole } from "#compiler/program/workload/change.ts"
import type { AnyLogin, AnyRole, AnySchema } from "#compiler/public/schema.ts"
import { standUpTexts } from "#compiler/runtime/write/flight.ts"
import { reachOf } from "#compiler/runtime/write/steps.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { servedFile } from "#compiler/served/json.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { templateNeedBudget } from "#test/support/budgets.ts"
import { jsonOf } from "#test/support/chunked.ts"
import { compiledInstallation } from "#test/support/compiled-served.ts"
import { paths, repoRoot } from "#test/support/files.ts"
import {
	appliedHistory,
	draftedHistory,
	type Installed,
	noPlaceholders,
	noVersionWorkload,
	templateInstalled
} from "#test/support/install-migrate.ts"
import { type Names, namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { installTemplate, type SubstrateTemplate } from "#test/support/substrate/substrate.ts"

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
 * of a write at each level, as the served file states them.
 */
export interface InstalledShape {
	readonly installed: Installed
	readonly names: Names
	readonly shape: Shape
	readonly generated: ReadonlyMap<string, Isolation>
	readonly changes: ReadonlyMap<string, ReadonlyMap<string, LoadedChange>>
	readonly reads: ReadonlyMap<string, ReadonlyMap<string, LoadedRead>>
	readonly levels: ReadonlyMap<string, Isolation>
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
 * parameters, whose one statement the oracle sends in the read's own transaction, SERIALIZABLE READ ONLY; or a
 * transaction of the installation's owner, its statements as written, at the harness session's default level,
 * SERIALIZABLE (test/support/pg.ts harnessSessionOptions), as an operator runs what no role holds.
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
					rolePrefixBytes: 0,
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
 * The installer extension `grizzle generate` installs a shape with, the served workload's (physical/access/extension.ts
 * servedWorkloadExtension), its certificates `roles`: the one installation path, so a race's installation holds what
 * generate's does, the contracts a served program's parameters alone name and its carriers' grants among them, and only
 * each table's guard follows the stated certificates. The plan is the shape's under its installed name, compiled as
 * generate drafts it (test/support/compiled-served.ts compiledInstallation), since a workload is compiled against its
 * installed schema.
 */
const certifying = (shape: Shape, roles: ReadonlyArray<RoleIsolation>) =>
	Effect.gen(function* () {
		const built = defined(builtLogin(shape.login), "a shape's login, built by login(...)")
		const base = yield* fromEngine(built.base.content.owned())
		const { plan } = yield* compiledInstallation(built, base, firstCodebook(rostersOf(base)))
		return { ...servedWorkloadExtension(plan), certifies: roles } satisfies InstallExtension
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
			extensions: [yield* certifying(build(name), certified)],
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
											servableRole(defined(changes.get(role), `the change compile of role ${role}`))
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
		const file = yield* fromEngine(servedFile(jsonOf(entry.text)))
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
			shapeOf(plan, templateInstalled(names, plan.history, ordinarySession, new Map(), binding))
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

/**
 * The statements a session sends before a race's first call of `member` of `role`: the write's stand-ups
 * (runtime/write/flight.ts StandUp), each text in order, the carriers' as the role and the judged tables' as the judge's
 * definer, as a served write's session does before its first call (adapter/apply/stand-up.ts). Each commits alone,
 * outside every race's transaction, so the interleaved statements meet every session object they read standing.
 */
export const callStandUps = (
	s: InstalledShape,
	call: { readonly role: string; readonly member: string }
): ReadonlyArray<string> =>
	Arr.flatMap(
		defined(
			s.changes.get(call.role)?.get(call.member),
			`member ${call.member} of role ${call.role}`
		).entry.program.standUps,
		(standUp) => Arr.map(standUpTexts(standUp), (text) => text.sql)
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
): Effect.Effect<Arr.NonEmptyReadonlyArray<string>, InputFailure | CallInputRefused> =>
	Effect.gen(function* () {
		const change = defined(
			s.changes.get(call.role)?.get(call.member),
			`member ${call.member} of role ${call.role}`
		)
		const host =
			change.call.kind === "params" && call.input.kind === "params"
				? yield* Effect.fromResult(change.call.call(call.input.params))
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
