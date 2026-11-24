import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import type { SchemaApplyReport } from "#adapter/migrate/apply.ts"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import type { FolderTexts } from "#adapter/migrate/input.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { type DraftWorkload, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import { parseSchemaInput } from "#compiler/program/input.ts"
import { compileWorkload } from "#compiler/program/workload/compile.ts"
import {
	type AnyClosed,
	type AnyLogin,
	type AnyRelation,
	type AnySchema,
	type Declared,
	type Schema,
	type Statement,
	type StatementsByName,
	type StatementsReadBack,
	type StatementsWithin
} from "#compiler/public/schema.ts"
import { ownLogin } from "#compiler/schema/own.ts"
import { schemaBuilder as builtSchema } from "#compiler/schema/schema.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import { apply, noFurther, openMigrator } from "#test/pg/migrate/support.ts"
import { ambientOwner, ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { templateNeedBudget } from "#test/support/budgets.ts"
import { deployedWorkloadOver, inputArtifacts, testCompile } from "#test/support/compile.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import {
	type DraftedVersion,
	draftedHistory,
	type Installed,
	installedOf,
	loginCredentials,
	type Review,
	templateInstalledOf
} from "#test/support/install-migrate.ts"
import { standUpSnapshot } from "#test/support/judge.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import {
	dropRole,
	installTemplate,
	ownerSession,
	Substrate,
	type SubstrateTemplate
} from "#test/support/substrate/substrate.ts"

/**
 * One version of a migrated schema: its schema value, or its descriptor where a test draws the schema's shape, built
 * under the allocated name, and the logins over it whose worlds its migration installs.
 */
export interface Version<S extends AnySchema | SchemaDesc = AnySchema> {
	readonly schema: S
	readonly logins: ReadonlyArray<AnyLogin>
}

/** A version of either form, as a history migrates it. */
type AnyVersion = Version<AnySchema | SchemaDesc>

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
 * Rebuilds `fixture` under `name` from its own relations and statements: a schema value whose statements name only its
 * relations and read back from their names as themselves, as schema(...) checked when it was built.
 */
export const rebuild = <
	const N extends string,
	R extends Record<string, AnyRelation | AnyClosed>,
	const St extends ReadonlyArray<Statement>
>(
	fixture: Schema<N, R, StatementsByName<St, R>> & {
		readonly statements: St &
			StatementsWithin<St, R> &
			StatementsReadBack<St, Declared<ReadonlyArray<R[keyof R]>>>
	},
	name: string
): Schema<
	string,
	Declared<ReadonlyArray<R[keyof R]>>,
	StatementsByName<St, Declared<ReadonlyArray<R[keyof R]>>>
> =>
	builtSchema<string, ReadonlyArray<R[keyof R]>, St>(
		name,
		listed(fixture.relations),
		fixture.statements,
		[]
	)

/** A schema's relations as the list it was built from: its record's members, in the record's order. */
const listed = <R extends Record<string, AnyRelation | AnyClosed>>(
	relations: R
): ReadonlyArray<R[keyof R]> => {
	const out: Array<R[keyof R]> = []
	for (const name in relations) {
		out.push(relations[name])
	}
	return out
}

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
 * What a version's logins' workloads add, planned as `grizzle generate` plans them with their roles' write filters
 * (cli/generate.ts draftInput): the installer extension of the plan, compiled against the schema the installation
 * installs (compile.ts deployedWorkloadOver), with the plan's live plan, and the draft's workload, with the same live
 * plan, so the installation publishes what its logins' served files read and the snapshot's live source serves them.
 * A version without a login plans nothing.
 */
export const workloadOf = (
	version: AnyVersion
): { readonly extensions: ReadonlyArray<InstallExtension>; readonly draft: DraftWorkload } => {
	if (version.logins.length === 0) {
		return { extensions: [], draft: noWorkload }
	}
	const owned = Arr.map(version.logins, (l) =>
		succeeded(ownLogin(defined(loginDescOf(l), `login ${l.name}, built by login(...)`)))
	)
	const input = succeeded(parseSchemaInput(version.schema))
	const plan = succeeded(
		compileWorkload(
			Arr.map(version.logins, (l) => ({ login: l.name, workloads: l.workload })),
			input,
			{
				artifacts: succeeded(inputArtifacts(input, testCompile)),
				roles: Arr.flatMap(owned, (l) => l.roles)
			}
		)
	)
	return {
		extensions: [
			deployedWorkloadOver(
				Arr.map(version.logins, (l) => ({ login: l.name, workloads: l.workload })),
				plan.live
			)
		],
		draft: { access: plan.access, accessPaths: plan.requests, live: plan.live }
	}
}

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
		const { plan, snapshot } = Arr.lastNonEmpty(steps)
		const history = Arr.map(steps, (step) => step.folder)
		const installed = yield* installedOf({
			plan,
			declared: name,
			folders: history,
			snapshot,
			ambientOwner: ownerLogin,
			files: new Map(),
			credentials: yield* loginCredentials(plan, new Map(), new Map())
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
 * Every version of `options` drafted under `name` by the one drafting of a history (install-migrate.ts
 * draftedHistory), each from the snapshot the one before reached, with its logins' workloads planned as a deployment
 * plans them (workloadOf), its declarations, and its folder reviewed as the caller says: what migrated applies in turn.
 * A version the compile refuses is the test's defect.
 */
const migratedHistory = (
	options: MigratedDraft,
	name: string
): Effect.Effect<Arr.NonEmptyReadonlyArray<DraftedVersion>> => {
	const versions: Arr.NonEmptyReadonlyArray<AnyVersion> = [
		options.first(name),
		...Arr.map(options.later, (f) => f(name))
	]
	return Effect.orDie(
		draftedHistory(
			Arr.map(versions, (v, i) => ({
				version: { schema: v.schema, logins: v.logins, declarations: options.declared(i) },
				workload: workloadOf(v)
			})),
			{ extensions: [], compile: compileInstallation, review: options.apply },
			name
		)
	)
}

/** The folders of `steps` through the one at `at`: what a migration has applied once that version's migration ran. */
const foldersThrough = (
	steps: Arr.NonEmptyReadonlyArray<DraftedVersion>,
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
				yield* loginCredentials(Arr.lastNonEmpty(steps).plan, new Map(), new Map())
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
				new Map(),
				binding
			)
		}
	})
