import { Array as Arr, Effect, Layer, Option, Record as Rec, Result, type Scope } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { changeApplication, onceCalls, type OnceCalls, variantOf } from "#adapter/db/handles.ts"
import { openServed } from "#adapter/db/served.ts"
import { fromEngine, toResult } from "#adapter/engine.ts"
import type { ApplyError, OpenError } from "#adapter/errors/execution.ts"
import { compileServed, compileServedOnce, type ServedRefusal } from "#adapter/public/compile.ts"
import { served } from "#adapter/public/layer.ts"
import { compiledWrite } from "#adapter/served/forms.ts"
import { type LoadedMember, loadServed } from "#adapter/served/load.ts"
import type { RoleContext } from "#adapter/served/role.ts"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import type { ServedLogin, ServedRole } from "#adapter/types/layer.ts"
import type { Json } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { servedWrite } from "#compiler/plan/change.ts"
import { servedReadBacks } from "#compiler/plan/read.ts"
import { defect } from "#compiler/plan/runtime.ts"
import type { ServedTables } from "#compiler/plan/serve.ts"
import { programsOn } from "#compiler/program/workload/roles.ts"
import { workload } from "#compiler/program/workload/value.ts"
import type { AnyLogin, AnyLoginRole, AnyRole } from "#compiler/public/schema.ts"
import type { ServedMember, ServedRoleForm, ServedVariants } from "#compiler/served/forms.ts"
import { servedFile, servedText } from "#compiler/served/json.ts"
import type { UnservedMember } from "#compiler/served/unserved.ts"
import type { AnyWorkload } from "#compiler/types/db/workload.ts"
import { defined } from "#test/support/assert.ts"
import { conservativeChange } from "#test/support/conservative.ts"
import type { Generated, Installed } from "#test/support/install-migrate.ts"
import { type SourcedLayer, sourcedDbLayer } from "#test/support/live-layer.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { type RoleSetupError, servedRoleContext } from "#test/support/served-role.ts"
import { snapshotValue } from "#test/support/snapshot-json.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify, tokenOf } from "#test/support/worlds.ts"

/**
 * Served programs for the tests: every program a test runs on PostgreSQL is a member of a login's served workload, compiled
 * in process by the one compile `grizzle generate` and `grizzle check` run, through the public compile entry an
 * application's tests use (adapter/public/compile.ts compileServed), its file's text parsed as an application's import of
 * the committed file yields it, and loaded by the layer's own loader (adapter/served/load.ts loadServed). Nothing here compiles a program at a call: a test that draws its programs at run
 * time compiles them into a served file of its own first, as a deployment's generate would.
 *
 * - servedFixture: a login serving its own workloads, typed by its login's type, through the public served(...) and
 *   DbLayer.make, as an application serves it: `Db.open(fixture.login.roles.<role>, { token })` and
 *   `db.workload.<member>`.
 * - withServedDb: one Db of a role per installation, opened through its login's served layer, whose `serve` compiles a
 *   test's drawn programs into members of the role's workload, each loaded and run on that Db's context: the same pool,
 *   prologue and claims, each by its once alone (adapter/db/handles.ts onceCalls): the programs are drawn after the
 *   installation, which installed no live source for them, so a watch through `serve` does not compile.
 * - servedOn: the same `load` and `serve` over a served Db's context a test opened itself.
 *
 * The served file of `login` with `workloads` in place of its own, compiled under the snapshot the installation reached
 * and parsed: what an application imports. A program the compile refuses is its ServedRefusal, naming the role and the
 * program.
 */
export const servedJson = (
	installed: Installed,
	login: AnyLogin,
	workloads: ReadonlyArray<AnyWorkload>
): Effect.Effect<unknown, ServedRefusal> =>
	Effect.suspend(() =>
		compileServed(login, snapshotValue(installed.snapshot, installed.installation), workloads)
	)

/**
 * `login`'s served file over `installed` with `workloads` (servedJson), each change member's program its conservative
 * realization (test/support/conservative.ts conservativeChange) in place of the optimized one generate serves, each
 * variant compiled for the contexts its path holds (adapter/served/load.ts LoadedVariants), for its role as generate
 * reads it (test/support/served-role.ts servedRoleContext): a file a suite serves beside the optimized one, so a write's
 * two artifacts run through two served Dbs of one installation and are held to each other.
 */
export const conservativeServedJson = (
	installed: Installed,
	login: AnyLogin,
	workloads: ReadonlyArray<AnyWorkload>
): Effect.Effect<unknown, ServedRefusal | CompileError | UnservedMember | RoleSetupError> =>
	Effect.gen(function* () {
		const json = yield* servedJson(installed, login, workloads)
		const file = servedFile(json)
		const roles: Array<ServedRoleForm> = []
		for (const form of file.roles) {
			const reached = defined(
				Option.getOrUndefined(
					Arr.findFirst(Rec.values(login.roles), (r) => r.role.name === form.name)
				),
				`role ${form.name} of login ${login.name}`
			)
			const role = yield* servedRoleContext(installed, reached)
			const programs = yield* fromEngine(programsOn(role.schema, workloads))
			const members: Array<ServedMember> = []
			for (const member of form.members) {
				if (member.kind !== "change") {
					members.push(member)
					continue
				}
				const changes = defined(
					Option.getOrUndefined(
						Arr.findFirst(programs, (program) =>
							program.kind === "changeSet" && program.name === member.name
								? Option.some(program.value)
								: Option.none()
						)
					),
					`the ChangeSet of member ${member.name}`
				)
				members.push({
					...member,
					variants: yield* Effect.fromResult(
						conservativeVariants(role, changes, member.variants, new Set())
					)
				})
			}
			roles.push({ ...form, members })
		}
		const text = yield* fromEngine(servedText({ ...file, roles }))
		return trustedJson<unknown>(text)
	})

/**
 * A change member's variants with each leaf's program its conservative realization, compiled for `claims`, the contexts
 * the leaf's path holds, as the served compile compiles a leaf for them.
 */
const conservativeVariants = (
	role: RoleContext,
	changes: unknown,
	variants: ServedVariants,
	claims: ReadonlySet<string>
): Result.Result<ServedVariants, CompileError | UnservedMember> => {
	switch (variants.kind) {
		case "change":
			return Result.flatMap(compiledWrite(role, changes, claims), (entry) =>
				Result.flatMap(toResult(conservativeChange(entry, role)), (conservative) =>
					Result.map(toResult(servedWrite(conservative.compiled)), (program) => ({
						kind: "change",
						change: {
							...variants.change,
							program,
							readBacks: servedReadBacks(conservative.compiled.artifact.readBacks)
						}
					}))
				)
			)
		case "split":
			return Result.flatMap(
				conservativeVariants(
					role,
					changes,
					variants.holding,
					new Set([...claims, variants.context])
				),
				(holding) =>
					Result.map(
						conservativeVariants(role, changes, variants.lacking, claims),
						(lacking): ServedVariants => ({
							kind: "split",
							context: variants.context,
							holding,
							lacking
						})
					)
			)
	}
}

/** A login served as an application serves it: its served login, typed by L, and its DbLayer over the installation. */
export interface ServedFixture<L> {
	readonly login: ServedLogin<L>
	readonly layer: SourcedLayer<L>
}

/**
 * `login` serving the served file `json` over `installed`: the file served under L's type, and the DbLayer of it on the
 * cluster's connection with the login's password, the test pool and testVerify, in the database the installation was
 * migrated in, given the installation's live source (test/support/live-layer.ts).
 */
export const servedFixtureOf = <L extends AnyLogin>(
	installed: Installed,
	login: L,
	json: unknown
): ServedFixture<L> => {
	const file = served<L>(json, login.name)
	return {
		login: file,
		layer: sourcedDbLayer(installed, {
			...clusterConnection(installed.cluster, installed.database, installed.as(login).password),
			pool: clusterPool,
			login: file,
			verify: testVerify
		})
	}
}

/**
 * `login` serving the file `grizzle generate` wrote for it over a generated installation (test/support/install-migrate.ts
 * Generated, servedFixtureOf): a login generate served no file for is a defect of the test.
 */
export const servedGenerated = <L extends AnyLogin>(
	generated: Generated,
	login: L
): ServedFixture<L> =>
	servedFixtureOf(
		generated.installed,
		login,
		defined(generated.served.get(login.name), `the served file of login ${login.name}`)
	)

/** `login` serving its own workloads over `installed` (servedFixtureOf), its served file compiled by servedJson. */
export const servedFixture = <L extends AnyLogin>(
	installed: Installed,
	login: L
): Effect.Effect<ServedFixture<L>, ServedRefusal> =>
	Effect.map(servedJson(installed, login, login.workload), (json) =>
		servedFixtureOf(installed, login, json)
	)

/**
 * One Db of a role over an installation: its context, which every member it serves runs over; `load`, which compiles
 * `programs`, each a program workload(...) admits (a query, an ordered query, paged(...) of one, a ChangeSet, a
 * relation's key or refresh(relations)), into members of the role's workload under their names, and gives each one loaded, by
 * name, for a test that runs it over a context of its own (adapter/db/handles.ts onceCalls) or reads its loaded
 * program; and `serve`, which gives each one's once over the context, by name, by its answer's shape (OnceCalls).
 */
export interface ServedDb {
	readonly ctx: ServedDbContext
	readonly load: (
		programs: Readonly<Record<string, unknown>>
	) => Effect.Effect<ReadonlyMap<string, LoadedMember>, ServedRefusal | OpenError>
	/** `load`'s members, beside the installed tables the login's file names them by, which its explains read. */
	readonly loadWithTables: (programs: Readonly<Record<string, unknown>>) => Effect.Effect<
		{
			readonly members: ReadonlyMap<string, LoadedMember>
			readonly tables: ServedTables
		},
		ServedRefusal | OpenError
	>
	readonly serve: (
		programs: Readonly<Record<string, unknown>>
	) => Effect.Effect<ReadonlyMap<string, OnceCalls>, ServedRefusal | OpenError>
}

/** The operations `load` and `serve` give over one served Db's context (ServedDb). */
export type ServedOn = Pick<ServedDb, "load" | "loadWithTables" | "serve">

/** The members of the role `role` of a loaded login, by its name in the login. */
const roleMembers = (
	members: ReadonlyArray<{ readonly name: string; readonly members: ReadonlyArray<LoadedMember> }>,
	role: string
): ReadonlyArray<LoadedMember> =>
	defined(
		Option.getOrUndefined(Arr.findFirst(members, (r) => r.name === role)),
		`role ${role} of the served login`
	).members

/** The token of `role`, reached through its login, of the login's served file. */
const servedRoleOf = (
	file: ServedLogin<AnyLogin>,
	role: AnyLoginRole
): ServedRole<AnyRole, unknown> =>
	defined(file.roles[role.role.name], `role ${role.role.name} of login ${file.name}'s served file`)

/**
 * Opens `role`, a role reached through its login, over `installed`, with a token whose payload is `payload`, through a
 * served layer of its login of its own, built in the caller's scope, so each open is a Db with a pool of its own. Each
 * `serve` compiles its programs into one served file of the login (servedJson), the role's workload holding exactly
 * them, loads it, and runs its members on the opened Db's context, so a case's programs share its Db's pool and claims.
 */
export const openServedDb = (
	installed: Installed,
	role: AnyLoginRole,
	payload: Json
): Effect.Effect<ServedDb, ServedRefusal | OpenError, Scope.Scope> =>
	Effect.gen(function* () {
		const fixture = yield* servedFixture(installed, role.login)
		const context = yield* Layer.build(fixture.layer)
		const { ctx } = yield* Effect.provideContext(
			openServed(servedRoleOf(fixture.login, role), { token: tokenOf(payload) }),
			context
		)
		return {
			ctx,
			...servedOn(snapshotValue(installed.snapshot, installed.installation), role, ctx)
		}
	})

/**
 * `body` run with a Db of `role` opened over `installed` as openServedDb opens one, its login's served layer built for
 * `body` alone and released when it ends.
 */
export const withServedDb = <A, E, R>(
	installed: Installed,
	role: AnyLoginRole,
	payload: Json,
	body: (db: ServedDb) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | ServedRefusal | OpenError, R | Scope.Scope> =>
	Effect.gen(function* () {
		const fixture = yield* servedFixture(installed, role.login)
		return yield* Effect.gen(function* () {
			const { ctx } = yield* openServed(servedRoleOf(fixture.login, role), {
				token: tokenOf(payload)
			})
			return yield* body({
				ctx,
				...servedOn(snapshotValue(installed.snapshot, installed.installation), role, ctx)
			})
		}).pipe(withLayer(fixture.layer))
	})

/**
 * `load` and `serve` over `ctx`, a Db of `role` a test opened through its login's served layer, whose file was compiled
 * under `snapshot`, the JSON value of a snapshot.json: each call compiles its programs into one served file of the login
 * under that snapshot for once calls alone (adapter/public/compile.ts compileServedOnce, whose file's live is none), the
 * role's workload holding exactly them, loads it, and gives each member loaded, or its once on `ctx`, by name.
 */
const servedOn = (snapshot: unknown, role: AnyLoginRole, ctx: ServedDbContext): ServedOn => {
	const login = role.login
	const loadWithTables: ServedDb["loadWithTables"] = (programs) =>
		Effect.gen(function* () {
			const json = yield* Effect.suspend(() =>
				compileServedOnce(login, snapshot, [workload(role.role, programs)])
			)
			const loaded = yield* Effect.fromResult(loadServed(servedFile(json), login.name))
			return {
				members: new Map(
					Arr.map(
						roleMembers(loaded.roles, role.role.name),
						(m): readonly [string, LoadedMember] => [m.name, m]
					)
				),
				tables: loaded.tables
			}
		})
	const load: ServedDb["load"] = (programs) =>
		Effect.map(loadWithTables(programs), (loaded) => loaded.members)
	const serve: ServedDb["serve"] = (programs) =>
		Effect.map(
			load(programs),
			(loaded) =>
				new Map(
					Arr.map([...loaded], ([name, m]): readonly [string, OnceCalls] => [
						name,
						onceCalls(ctx, m)
					])
				)
		)
	return { load, loadWithTables, serve }
}

/**
 * A change member's one application on `ctx` for a caller's input, its outcome and failure as the write runtime meets
 * them (adapter/db/handles.ts changeApplication), for a suite of that runtime; a member that is no change is a defect of
 * the test.
 */
export const applicationOf =
	(ctx: ServedDbContext, loaded: LoadedMember) =>
	(input: unknown): Effect.Effect<ApplyOutcome<unknown>, ApplyError> =>
		loaded.kind === "change"
			? changeApplication(ctx, variantOf(ctx, loaded.variants))(input)
			: Effect.die(defect(`a write of the ${loaded.kind} member ${loaded.name}`))

/** The member under `name` of those `load` or `serve` gave: a name it did not give is a defect of the test. */
export const member = <M>(served: ReadonlyMap<string, M>, name: string): M =>
	defined(served.get(name), `the served member ${name}`)
