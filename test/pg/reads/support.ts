import { Array as Arr, Effect, Record as Rec, type Scope, String as Str } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { AnyClosed, AnyRelation, Statement } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import {
	type Generated,
	type GeneratedSpec,
	generatedTemplate,
	type Installed,
	installGenerated,
	loadMigrated as load
} from "#test/support/install-migrate.ts"
import { fullVersion, type Rebuildable, type Rebuilt, rebuild } from "#test/support/installed.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import type { SqlError } from "#test/support/pg.ts"
import { type ServedFixture, servedGenerated } from "#test/support/served-db.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import {
	Substrate,
	type SubstrateCase,
	type SubstrateTemplate
} from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** A schema a full world can be built over: what fullWorld takes. */
type Reality = Parameters<typeof fullWorld>[0]

/** The full world built over `S` itself, its role typed by S's own relations, its login's workload holding P. */
type WorldOver<S extends Reality, P extends Readonly<Record<string, unknown>>> = ReturnType<
	typeof fullWorld<S, P>
>

export interface Opened<S extends Reality, P extends Readonly<Record<string, unknown>>> {
	readonly installed: Installed
	/**
	 * The fixture rebuilt under the installed schema name (installed.ts rebuild): its relations, functions and
	 * statements, under a name known only at run time, which places the installation. A query or ChangeSet built over
	 * the fixture runs against it too: a level is its content, not its name (program/schema.ts levelSchema).
	 */
	readonly schema: S
	/**
	 * The full world's role over the rebuilt schema, which every program over the fixture runs on, and its login, whose
	 * workload holds the fixture's programs.
	 */
	readonly app: WorldOver<S, P>["app"]
	readonly server: WorldOver<S, P>["server"]
	/**
	 * The login served as an application serves it, from the file generate wrote (test/support/served-db.ts
	 * servedGenerated): a Db opens through
	 * `served.login.roles.app` on `served.layer`, in the substrate's database, and runs the programs as
	 * `db.workload.<name>`.
	 */
	readonly served: ServedFixture<WorldOver<S, P>["server"]>
}

/**
 * What an installation of a read fixture states: the label of its allocated schema name, and the programs its login's
 * workload holds, each a member a Db of its full world runs by its name. Its one world is its full world.
 */
export interface FixtureInstall<P extends Readonly<Record<string, unknown>>> {
	readonly label: string
	readonly programs: P
}

/**
 * Installs `fixture` under a fresh schema as `grizzle generate` drafts and serves it (test/support/install-migrate.ts
 * installGenerated), with its full world's login, whose workload holds `options.programs`, so the installation holds
 * the live source of every read the programs serve; loads `facts`, rebuilds the fixture under the installed name, and
 * serves that login from the file generate wrote: a program of its own the compile refuses is a defect of the test.
 * The fixture is a schema value whose relations sit under their own names and whose statements name only its
 * relations and read back from their names as themselves, as schema(...) checked when it was built.
 */
export const installed = <
	const N extends string,
	R extends Record<string, AnyRelation | AnyClosed>,
	const St extends ReadonlyArray<Statement>,
	const P extends Readonly<Record<string, unknown>>
>(
	fixture: Rebuildable<N, R, St>,
	facts: FactSet,
	options: FixtureInstall<P>
): Effect.Effect<
	Opened<Rebuilt<R, St>, P>,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const generated = yield* installGenerated(
			(name) => fullVersion(fixture, options.programs, name),
			{ label: options.label, ambient: ordinarySession }
		)
		return yield* openedOver(fixture, facts, options, generated)
	})

/**
 * The installation `generated`, opened as a read fixture's: `facts` loaded as the owner, the fixture rebuilt under the
 * installed name, its full world over it, and that world's login served from the file generate wrote.
 */
const openedOver = <
	N extends string,
	R extends Record<string, AnyRelation | AnyClosed>,
	St extends ReadonlyArray<Statement>,
	P extends Readonly<Record<string, unknown>>
>(
	fixture: Rebuildable<N, R, St>,
	facts: FactSet,
	options: FixtureInstall<P>,
	generated: Generated
): Effect.Effect<
	Opened<Rebuilt<R, St>, P>,
	CompileError | SqlError | TransactionRolledBack,
	Substrate
> =>
	Effect.gen(function* () {
		const done = generated.installed
		yield* load(done, facts)
		const rebuilt = rebuild(fixture, done.declared)
		const world = fullWorld(rebuilt, options.programs)
		return {
			installed: done,
			schema: rebuilt,
			app: world.app,
			server: world.server,
			served: servedGenerated(generated, world.server)
		}
	})

/**
 * A read fixture's installation as a template (install-migrate.ts generatedTemplate), what `installed` makes per test
 * made once per member: `fixture` drafted and served as `grizzle generate` drafts it under the template's name, with its
 * full world's login, whose workload holds `options.programs`. Its content is the fixture's name, the label and the
 * programs' names, which tell it from another template of its declaring module; the module's import closure covers
 * their code.
 */
export const fixtureTemplate = <
	const N extends string,
	R extends Record<string, AnyRelation | AnyClosed>,
	const St extends ReadonlyArray<Statement>,
	const P extends Readonly<Record<string, unknown>>
>(
	declaredIn: ImportMeta,
	fixture: Rebuildable<N, R, St>,
	options: FixtureInstall<P>
): SubstrateTemplate<Generated> => generatedTemplate(fixtureSpec(declaredIn, fixture, options))

/**
 * A read fixture's generated template's spec (fixtureTemplate): its full world's login, whose workload holds
 * `options.programs`, its content the fixture's name, the label and the programs' names.
 */
export const fixtureSpec = <
	const N extends string,
	R extends Record<string, AnyRelation | AnyClosed>,
	const St extends ReadonlyArray<Statement>,
	const P extends Readonly<Record<string, unknown>>
>(
	declaredIn: ImportMeta,
	fixture: Rebuildable<N, R, St>,
	options: FixtureInstall<P>
): GeneratedSpec => ({
	declaredIn,
	name: options.label,
	content: {
		fixture: fixture.name,
		label: options.label,
		programs: Arr.sort(Rec.keys(options.programs), Str.Order)
	},
	build: (name) => fullVersion(fixture, options.programs, name),
	ambient: ordinarySession
})

/**
 * A case of `fixtureTemplate(_, fixture, options)` opened as `installed` opens one (Opened): `facts` loaded into the
 * case's clone as its owner, the fixture rebuilt under the template's installed name and its login served over the
 * clone. The case's substrate is the Substrate the load runs on.
 */
export const openedIn = <
	const N extends string,
	R extends Record<string, AnyRelation | AnyClosed>,
	const St extends ReadonlyArray<Statement>,
	const P extends Readonly<Record<string, unknown>>
>(
	fixture: Rebuildable<N, R, St>,
	facts: FactSet,
	options: FixtureInstall<P>,
	taken: SubstrateCase<Generated>
): Effect.Effect<Opened<Rebuilt<R, St>, P>, CompileError | SqlError | TransactionRolledBack> =>
	Effect.provideService(
		openedOver(fixture, facts, options, taken.value),
		Substrate,
		taken.substrate
	)
