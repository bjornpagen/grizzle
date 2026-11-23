import { Array as Arr, Effect, Record as Rec, type Scope, String as Str } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	type AnyClosed,
	type AnyRelation,
	type Declared,
	type Schema,
	type Statement,
	type StatementsByName,
	type StatementsReadBack,
	type StatementsWithin
} from "#compiler/public/schema.ts"
import { schemaBuilder as builtSchema } from "#compiler/schema/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import {
	alteredGeneratedTemplate,
	type Generated,
	type GeneratedSpec,
	generatedTemplate,
	type Installed,
	installGenerated,
	loadMigrated as load
} from "#test/support/install-migrate.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import type { SqlError } from "#test/support/pg.ts"
import { judgedSettings, unanalyzed } from "#test/support/plans.ts"
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
	 * The fixture rebuilt under the installed schema name: its relations and statements, under a name known only at
	 * run time, which places the installation. A query or ChangeSet built over the fixture runs against it too: a level
	 * is its content, not its name (program/schema.ts levelSchema).
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
	fixture: ReadFixture<N, R, St>,
	facts: FactSet,
	options: FixtureInstall<P>
): Effect.Effect<
	Opened<FixtureSchema<R, St>, P>,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const named = namedFixture(fixture)
		const generated = yield* installGenerated(
			(name) => ({
				schema: named(name),
				logins: [fullWorld(named(name), options.programs).server]
			}),
			{ label: options.label, ambient: ordinarySession }
		)
		return yield* openedOver(fixture, facts, options, generated)
	})

/**
 * A read fixture: a schema value whose relations sit under their own names and whose statements name only its
 * relations and read back from their names as themselves, as schema(...) checked when it was built.
 */
type ReadFixture<
	N extends string,
	R extends Record<string, AnyRelation | AnyClosed>,
	St extends ReadonlyArray<Statement>
> = Schema<N, R, StatementsByName<St, R>> & {
	readonly statements: St &
		StatementsWithin<St, R> &
		StatementsReadBack<St, Declared<ReadonlyArray<R[keyof R]>>>
}

/** A read fixture rebuilt under a name known only at run time: its relations and statements, under that name. */
type FixtureSchema<
	R extends Record<string, AnyRelation | AnyClosed>,
	St extends ReadonlyArray<Statement>
> = Schema<
	string,
	Declared<ReadonlyArray<R[keyof R]>>,
	StatementsByName<St, Declared<ReadonlyArray<R[keyof R]>>>
>

/** `fixture` built under a name: its relations and statements, as installed and as rebuilt over an installation. */
const namedFixture =
	<
		N extends string,
		R extends Record<string, AnyRelation | AnyClosed>,
		St extends ReadonlyArray<Statement>
	>(
		fixture: ReadFixture<N, R, St>
	) =>
	(name: string): FixtureSchema<R, St> => {
		const relations: Array<R[keyof R]> = []
		for (const relation in fixture.relations) {
			relations.push(fixture.relations[relation])
		}
		return builtSchema<string, ReadonlyArray<R[keyof R]>, St>(
			name,
			relations,
			fixture.statements,
			[]
		)
	}

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
	fixture: ReadFixture<N, R, St>,
	facts: FactSet,
	options: FixtureInstall<P>,
	generated: Generated
): Effect.Effect<
	Opened<FixtureSchema<R, St>, P>,
	CompileError | SqlError | TransactionRolledBack,
	Substrate
> =>
	Effect.gen(function* () {
		const done = generated.installed
		yield* load(done, facts)
		const rebuilt = namedFixture(fixture)(done.declared)
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
	fixture: ReadFixture<N, R, St>,
	options: FixtureInstall<P>
): SubstrateTemplate<Generated> => generatedTemplate(fixtureSpec(declaredIn, fixture, options))

/**
 * fixtureTemplate's installation with its catalog altered once per member right after the install (install-migrate.ts
 * alteredGeneratedTemplate): `alter` plants what every case reads, such as the constraints behind a read-back's
 * evidence dropped, where the search did it once before its cases. A case opens it as fixtureTemplate's (openedIn).
 */
const alteredFixtureTemplate = <
	const N extends string,
	R extends Record<string, AnyRelation | AnyClosed>,
	const St extends ReadonlyArray<Statement>,
	const P extends Readonly<Record<string, unknown>>,
	E
>(
	declaredIn: ImportMeta,
	fixture: ReadFixture<N, R, St>,
	options: FixtureInstall<P>,
	alter: (generated: Generated) => Effect.Effect<void, E, Substrate | Scope.Scope>
): SubstrateTemplate<Generated> =>
	alteredGeneratedTemplate({ ...fixtureSpec(declaredIn, fixture, options), alter })

/**
 * fixtureTemplate's installation as a suite that judges the plans of what its login sends reads it, made so once per
 * member right after the install (alteredFixtureTemplate): the login's sessions plan under the judged settings, the
 * login's defaults in the template's database (plans.ts judgedSettings), which the toolchain sets again on every clone
 * as a template's role settings, and every stored relation planned as one never analyzed (plans.ts unanalyzed). A case
 * over a seat of it sets nothing: what a case sets on the template's own login outlives the case, which no seat's reset
 * undoes (the seat refused fin/removal-plans' and write/keyed-target's next case, each case's ALTER ROLE ... IN
 * DATABASE ... SET left in pg_db_role_setting). A case opens it as fixtureTemplate's (openedIn).
 */
export const judgedFixtureTemplate = <
	const N extends string,
	R extends Record<string, AnyRelation | AnyClosed>,
	const St extends ReadonlyArray<Statement>,
	const P extends Readonly<Record<string, unknown>>
>(
	declaredIn: ImportMeta,
	fixture: ReadFixture<N, R, St>,
	options: FixtureInstall<P>
): SubstrateTemplate<Generated> =>
	alteredFixtureTemplate(declaredIn, fixture, options, (generated) =>
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const done = generated.installed
			const server = fullWorld(namedFixture(fixture)(done.declared), options.programs).server
			const login = quoteIdent(done.as(server).role)
			for (const setting of judgedSettings) {
				yield* substrate.superuser(
					`ALTER ROLE ${login} IN DATABASE ${quoteIdent(substrate.database)} SET ${setting.parameter} = ${setting.value}`
				)
			}
			yield* unanalyzed(
				substrate.admin,
				Arr.flatMap(Rec.values(done.installation.owned.relations), (r) =>
					r.kind === "relation" ? [done.names.relation(r.name)] : []
				)
			)
		})
	)

/**
 * A read fixture's generated template's spec (fixtureTemplate): its full world's login, whose workload holds
 * `options.programs`, its content the fixture's name, the label and the programs' names.
 */
const fixtureSpec = <
	const N extends string,
	R extends Record<string, AnyRelation | AnyClosed>,
	const St extends ReadonlyArray<Statement>,
	const P extends Readonly<Record<string, unknown>>
>(
	declaredIn: ImportMeta,
	fixture: ReadFixture<N, R, St>,
	options: FixtureInstall<P>
): GeneratedSpec => {
	const named = namedFixture(fixture)
	return {
		declaredIn,
		name: options.label,
		content: {
			fixture: fixture.name,
			label: options.label,
			programs: Arr.sort(Rec.keys(options.programs), Str.Order)
		},
		build: (name) => ({
			schema: named(name),
			logins: [fullWorld(named(name), options.programs).server]
		}),
		ambient: ordinarySession
	}
}

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
	fixture: ReadFixture<N, R, St>,
	facts: FactSet,
	options: FixtureInstall<P>,
	taken: SubstrateCase<Generated>
): Effect.Effect<
	Opened<FixtureSchema<R, St>, P>,
	CompileError | SqlError | TransactionRolledBack
> =>
	Effect.provideService(
		openedOver(fixture, facts, options, taken.value),
		Substrate,
		taken.substrate
	)
