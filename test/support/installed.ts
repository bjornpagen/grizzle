import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, Record as Rec, type Scope, String as Str } from "effect"
import type { SchemaApplyReport } from "#adapter/migrate/apply.ts"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import type { FolderTexts } from "#adapter/migrate/input.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import {
	type AnyClosed,
	type AnyRelation,
	type AnySchema,
	type Declared,
	type Schema,
	type Statement,
	type StatementsByName,
	type StatementsReadBack,
	type StatementsWithin
} from "#compiler/public/schema.ts"
import { builtArgumentsOf, schemaBuilder as builtSchema } from "#compiler/schema/schema.ts"
import { apply, noFurther, openMigrator } from "#test/pg/migrate/support.ts"
import { type AmbientSession, ambientOwner, ordinarySession } from "#test/support/ambient.ts"
import { templateNeedBudget } from "#test/support/budgets.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import {
	draftVersion,
	type Generated,
	generatedDraft,
	generatedTemplate,
	type Installed,
	installedOf,
	installGenerated,
	loginCredentials,
	type Review,
	templateInstalledOf,
	type Version
} from "#test/support/install-migrate.ts"
import { standUpSnapshot } from "#test/support/judge.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { fromEmpty, fromSnapshot, type Previous } from "#test/support/migrate/kit.ts"
import type { RealInstallPlan } from "#test/support/oracle/install/real.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import {
	dropRole,
	installTemplate,
	ownerSession,
	Substrate,
	type SubstrateTemplate
} from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A version of a schema's descriptor, where a test draws the schema's shape, built under the allocated name: it serves
 * no login, a description being no schema value a login is over.
 */
interface DescribedVersion {
	readonly described: SchemaDesc
}

/** A version of either form, as a history migrates it. */
type AnyVersion = Version | DescribedVersion

/**
 * A schema migrated through a history of versions: the installation its last version reached (Installed, its folders
 * the history), with the migration identity's session and the history's apply again.
 */
interface Migrated extends Installed {
	/** A raw session of the migration identity, which owns the schema, for SQL a test runs as the owner. */
	readonly owner: RawSession
	/** Applies the folders applied so far again, nothing pending: the runner's drift check of the catalog alone. */
	readonly reapply: Effect.Effect<SchemaApplyReport, MigrateError>
	/** `$S` replaced by the quoted schema, run as the owner. */
	readonly sql: (text: string) => Effect.Effect<void, SqlError>
}

/**
 * A schema value `rebuild` rebuilds: one whose statements name only its relations and read back from their names as
 * themselves, as schema(...) checked when it was built.
 */
export type Rebuildable<
	N extends string,
	R extends Record<string, AnyRelation | AnyClosed>,
	St extends ReadonlyArray<Statement>
> = Schema<N, R, StatementsByName<St, R>> & {
	readonly statements: St &
		StatementsWithin<St, R> &
		StatementsReadBack<St, Declared<ReadonlyArray<R[keyof R]>>>
}

/**
 * A Rebuildable rebuilt under a name known only at run time: its relations, functions and statements, under that name.
 */
export type Rebuilt<
	R extends Record<string, AnyRelation | AnyClosed>,
	St extends ReadonlyArray<Statement>
> = Schema<
	string,
	Declared<ReadonlyArray<R[keyof R]>>,
	StatementsByName<St, Declared<ReadonlyArray<R[keyof R]>>>
>

/**
 * `fixture` built again under the allocated name `name` from the arguments each of its levels' builders was called
 * with (schema.ts builtArgumentsOf), every relation, closed and derived relation, fragment and function of each list its
 * own again: its root by schema(...) under `name`, and each level above it by schema.extend over the one rebuilt below
 * it under `<name>_<depth>`, as the migrate path allocates a level's name (compile.ts allocatedLevels). The one rebuild
 * of a schema value under an allocated name: an installation's identity, and the cluster-wide role names minted from
 * it, are its root's declared name (cli/config.ts), so a fixture installs under its allocation as a value whose root
 * is of that name alone. A level's derived relations and statements written over the fixture's own levels hold over
 * the rebuilt ones, a level being its content, not its name (levels.ts isLevelOf).
 */
export const renamed = (fixture: AnySchema, name: string): AnySchema =>
	renamedLevel(fixture, name).value

/** `fixture` rebuilt under `name` (renamed), with its depth above its root. */
const renamedLevel = (
	fixture: AnySchema,
	name: string
): { readonly value: AnySchema; readonly depth: number } => {
	const called = defined(builtArgumentsOf(fixture), `the arguments of the schema ${fixture.name}`)
	if (called.kind === "root") {
		return { value: builtSchema(name, called.relations, called.statements, []), depth: 0 }
	}
	const below = renamedLevel(called.base, name)
	const depth = below.depth + 1
	return {
		value: builtSchema.extend(
			[below.value],
			`${name}_${String(depth)}`,
			called.relations,
			called.statements,
			[]
		),
		depth
	}
}

/**
 * `fixture`, a root, rebuilt under `name` (renamed), typed by its own relations and statements, which the rebuilt
 * value holds as the fixture does.
 */
export const rebuild = <
	const N extends string,
	R extends Record<string, AnyRelation | AnyClosed>,
	const St extends ReadonlyArray<Statement>
>(
	fixture: Rebuildable<N, R, St>,
	name: string
): Rebuilt<R, St> => trusted<Rebuilt<R, St>>(renamed(fixture, name))

/**
 * `fixture` rebuilt under the allocated name `name` (renamed) with its full world's login, whose workload holds
 * `programs` (worlds.ts fullWorld): the version of an installation a test serves programs of, or only installs with a
 * login, as `grizzle generate` drafts it (install-migrate.ts generatedDraft).
 */
export const fullVersion = (
	fixture: AnySchema,
	programs: Readonly<Record<string, unknown>>,
	name: string
): Version => {
	const schema = renamed(fixture, name)
	return { schema, logins: [fullWorld(schema, programs).server] }
}

/**
 * `fixture` installed under a unique schema name in the scope as `grizzle generate` drafts and serves it
 * (install-migrate.ts installGenerated), with its full world's login, whose workload holds `programs` (fullVersion).
 */
export const installFullWorld = (
	fixture: AnySchema,
	programs: Readonly<Record<string, unknown>>,
	options: { readonly label: string; readonly ambient: AmbientSession }
): Effect.Effect<Installed, CompileError | SqlError, Substrate | Scope.Scope> =>
	Effect.map(
		installGenerated((name) => fullVersion(fixture, programs, name), options),
		(generated) => generated.installed
	)

/**
 * installFullWorld's installation as a template (install-migrate.ts generatedTemplate): `fixture` with its full world's
 * login, whose workload holds `programs`, drafted and served as `grizzle generate` drafts it once per member, each
 * case's Generated the installation in its clone. Its content is the label and the programs' names, which tell it from
 * another template of its declaring module; the module's import closure covers the fixture and the programs' code.
 */
export const fullWorldTemplate = (spec: {
	readonly declaredIn: ImportMeta
	readonly name: string
	readonly fixture: AnySchema
	readonly programs: Readonly<Record<string, unknown>>
	readonly label: string
	readonly ambient: AmbientSession
}): SubstrateTemplate<Generated> =>
	generatedTemplate({
		declaredIn: spec.declaredIn,
		name: spec.name,
		content: { label: spec.label, programs: Arr.sort(Rec.keys(spec.programs), Str.Order) },
		build: (name) => fullVersion(spec.fixture, spec.programs, name),
		ambient: spec.ambient
	})

/**
 * The declared name a fixture is rebuilt under: a unique one, or a word PostgreSQL reserves (one installation of it at
 * a time in the database).
 */
type SchemaName = { readonly kind: "unique" } | { readonly kind: "reserved"; readonly word: string }

interface MigrateOptions {
	readonly label: string
	readonly schemaName: SchemaName
	/**
	 * The first version, built under the allocated name: a fixture rebuilt (`rebuild`), or a schema whose queries must
	 * be over the installed schema value built there, with its logins, whose workloads its migration plans.
	 */
	readonly first: (name: string) => AnyVersion
	/** Later versions of the schema, each a migration after the first, built over the same name. */
	readonly later: ReadonlyArray<(name: string) => AnyVersion>
	/**
	 * The placeholder values of every generated folder's review. A folder with a placeholder under `noPlaceholders` is a
	 * defect of the test. A `reviewed` folder also takes the reviewer's data steps: each reviewed file of a version's
	 * folder as `edit` writes it, given the version's index, as a person adds an UPDATE before a placeholder's DROP
	 * DEFAULT.
	 */
	readonly apply: Review
	/**
	 * The renames and drops each version's migration declares (`--rename`, `--drop`), by the version's index, 0 the
	 * first: every drop of stored data is declared, a roster's removed handle among them, and a renamed handle keeps its
	 * code (deploy/diff/plan.ts Declarations).
	 */
	readonly declared: (version: number) => Declarations
	/**
	 * What runs as the owner after each version's migration applies, given the version's index: what a test reads
	 * between versions, such as a role's OID that a later rename keeps; none for a test that reads nothing there.
	 */
	readonly observe: Option.Option<Observe>
}

/** A reading between versions, given the version's index and the owner's session. */
type Observe = (version: number, owner: RawSession) => Effect.Effect<void, SqlError>

/** No reading between versions. */
export const noObservation: Option.Option<Observe> = Option.none()

/** The placeholder value of a migration whose options say it has none: a placeholder is a defect of the test. */
/**
 * A reserved word as the declared name: whatever an earlier installation of it left is dropped before and after, its
 * roles' schemas and its roles with it.
 */
const reservedSchema = (word: string) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const clear = Effect.gen(function* () {
			const worlds = yield* substrate.admin.queryValues(
				"SELECT nspname::text FROM pg_catalog.pg_namespace WHERE starts_with(nspname::text, $1::text) ORDER BY nspname",
				[`${word}__`]
			)
			for (const [world] of worlds) {
				yield* substrate.admin.query(
					`DROP SCHEMA IF EXISTS ${quoteIdent(String(world))} CASCADE`,
					[]
				)
			}
			const roles = yield* substrate.admin.queryValues(
				"SELECT rolname::text FROM pg_catalog.pg_roles WHERE starts_with(rolname::text, $1::text) ORDER BY rolname",
				[`${word}__`]
			)
			for (const [role] of roles) {
				yield* dropRole(substrate.cluster, substrate.admin, String(role))
			}
			yield* substrate.admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(word)} CASCADE`, [])
		})
		yield* clear
		yield* Effect.addFinalizer(() => Effect.orDie(clear))
		return word
	})

/** The declared name a fixture is rebuilt under. */
const schemaNameOf = (options: MigrateOptions) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		switch (options.schemaName.kind) {
			case "unique":
				return yield* substrate.schema({ create: false, label: options.label })
			case "reserved":
				return yield* reservedSchema(options.schemaName.word)
		}
	})

/**
 * Installing a fixture as a deployment does.
 *
 * A fixture is installed the way a deployment installs it: its schema value is rebuilt under a unique name (roles are
 * cluster-wide) or a reserved word, its first migration is generated from the
 * empty snapshot (with its logins' workloads) and applied by the real runner (packages/grizzle/src/adapter/migrate) as the migration
 * identity, which checks, runs, records and drift-checks each folder (test/pg/migrate/support.ts), and the generated
 * snapshot is the one the application knows. Every generated folder is reviewed first by the one reviewer
 * (test/support/migrate/review.ts), every candidate rename kept or chosen as the caller says and every placeholder
 * given the caller's value, so no later version runs a placeholder raw. Each version states its
 * logins, whose worlds its migration installs and whose workloads it plans. A Db of one of their roles opens through
 * its login's served file, compiled under the snapshot the history reached (test/support/served-db.ts withServedDb).
 *
 * Installs the schema through its generated migrations, as described in the header.
 */
export const migrated = (options: MigrateOptions) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const name = yield* schemaNameOf(options)
		const steps = yield* migratedHistory(options, name)
		const session = yield* substrate.session({ ...ownerSession(), label: `owner ${options.label}` })
		const ownerLogin = yield* ambientOwner(ordinarySession, [
			identifierOf(identity.schema(parsedSchemaName(name)))
		])
		const migrator = yield* openMigrator(substrate, ownerLogin.credentials)
		for (const [i, step] of steps.entries()) {
			yield* apply(
				migrator,
				{ snapshot: step.snapshot, folders: foldersThrough(steps, i) },
				noFurther
			)
			yield* standUpSnapshot(session, step.snapshot)
			yield* Option.match(options.observe, {
				onNone: () => Effect.void,
				onSome: (observe) => observe(i, session)
			})
		}
		const { plan, snapshot, served } = Arr.lastNonEmpty(steps)
		const history = Arr.map(steps, (step) => step.folder)
		const installed = yield* installedOf({
			plan,
			declared: name,
			folders: history,
			snapshot,
			ambientOwner: ownerLogin,
			files: served,
			credentials: yield* loginCredentials(plan, served, new Map())
		})
		const quoted = quoteIdent(installed.schema)
		const result: Migrated = {
			...installed,
			owner: session,
			reapply: Effect.suspend(() => apply(migrator, { snapshot, folders: history }, noFurther)),
			sql: (text) => Effect.asVoid(session.query(Str.replaceAll("$S", quoted)(text), []))
		}
		return result
	})

/** What migratedHistory drafts from: a migration's versions, their declarations and how their folders are reviewed. */
type MigratedDraft = Pick<MigrateOptions, "label" | "first" | "later" | "apply" | "declared">

/**
 * One version of a migration as migrated applies it: its plan, its reviewed folder, the snapshot it reaches, and each
 * login's served file of it, by declared name.
 */
interface MigratedStep {
	readonly plan: RealInstallPlan
	readonly folder: FolderTexts
	readonly snapshot: DeploySnapshot
	readonly served: ReadonlyMap<string, unknown>
}

/**
 * Every version of `options` drafted under `name`, each from the snapshot the one before reached, with its
 * declarations and its folder reviewed as the caller says: what migrated applies in turn. A version of a schema value
 * is drafted and served as `grizzle generate` drafts it (install-migrate.ts generatedDraft), its logins' served
 * workload certified and planned, so its installation grants each role what its served programs reach, EXECUTE on the
 * declared functions they call among it, and installs the guards and fences its certificates state, as a production
 * install does; a version of a description serves no login (DescribedVersion) and is drafted from it alone
 * (install-migrate.ts draftVersion). A version the compile refuses is the test's defect.
 */
const migratedHistory = (
	options: MigratedDraft,
	name: string
): Effect.Effect<Arr.NonEmptyReadonlyArray<MigratedStep>> =>
	Effect.orDie(
		Effect.gen(function* () {
			const versions: Arr.NonEmptyReadonlyArray<AnyVersion> = [
				options.first(name),
				...Arr.map(options.later, (f) => f(name))
			]
			const installation = identity.schema(parsedSchemaName(name))
			const steps: Array<MigratedStep> = []
			let previous: Previous = fromEmpty
			for (const [step, v] of versions.entries()) {
				const at = { installation, previous, step }
				const drafted: MigratedStep =
					"described" in v
						? {
								...(yield* draftVersion(
									{ schema: v.described, declarations: options.declared(step) },
									at,
									{ extensions: [], compile: compileInstallation, review: options.apply }
								)),
								served: new Map()
							}
						: yield* generatedDraft(
								{ schema: v.schema, logins: v.logins, declarations: options.declared(step) },
								at,
								options.apply
							)
				steps.push(drafted)
				previous = fromSnapshot(drafted.snapshot)
			}
			return nonEmpty(steps, "a history has its first version")
		})
	)

/** The folders of `steps` through the one at `at`: what a migration has applied once that version's migration ran. */
const foldersThrough = (
	steps: Arr.NonEmptyReadonlyArray<MigratedStep>,
	at: number
): Arr.NonEmptyReadonlyArray<FolderTexts> =>
	nonEmpty(
		Arr.map(steps.slice(0, at + 1), (step) => step.folder),
		"a migration through a version"
	)

/**
 * migrated's installation as a template (substrate.ts installTemplate): every version drafted under the template's name
 * by every worker as it plans (migratedHistory), applied once per member by the real runner as the template's owner
 * login, as migrated applies them, each login given its password; each case's Installed the last version's in its
 * clone, every login logging in with the password the template derived (install-migrate.ts templateInstalledOf).
 * `name` tells it from its module's other templates.
 */
export const migratedOnceTemplate = (spec: {
	readonly declaredIn: ImportMeta
	readonly name: string
	readonly options: MigratedDraft
}): SubstrateTemplate<Installed> =>
	installTemplate({
		budget: templateNeedBudget,
		declaredIn: spec.declaredIn,
		name: spec.name,
		content: { label: spec.options.label },
		plan: (names) =>
			Effect.map(migratedHistory(spec.options, names.schema), (steps) => ({ names, steps })),
		install: ({ names, steps }) =>
			Effect.gen(function* () {
				const substrate = yield* Substrate
				const ownerLogin = yield* ambientOwner(ordinarySession, [
					identifierOf(identity.schema(parsedSchemaName(names.schema)))
				])
				const migrator = yield* openMigrator(substrate, ownerLogin.credentials)
				for (const [i, step] of steps.entries()) {
					yield* apply(
						migrator,
						{ snapshot: step.snapshot, folders: foldersThrough(steps, i) },
						noFurther
					)
				}
				const last = Arr.lastNonEmpty(steps)
				yield* loginCredentials(last.plan, last.served, new Map())
			}),
		bind: ({ names, steps }, binding) => {
			const last = Arr.lastNonEmpty(steps)
			return templateInstalledOf(
				names,
				{
					plan: last.plan,
					folders: Arr.map(steps, (step) => step.folder),
					snapshot: last.snapshot
				},
				ordinarySession,
				last.served,
				binding
			)
		}
	})
