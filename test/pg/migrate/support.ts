import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Formatter,
	Option,
	Order,
	pipe,
	Record as Rec,
	Redacted,
	Result,
	type Scope,
	String as Str
} from "effect"
import type { DriftMismatch } from "#adapter/admission/drift.ts"
import { applyOnSession, type SchemaApplyReport } from "#adapter/migrate/apply.ts"
import {
	Drifted,
	DriftUnchecked,
	type MigrateError,
	type StatementFailure,
	stopped
} from "#adapter/migrate/errors.ts"
import type { FolderSource, MigrationTarget } from "#adapter/migrate/input.ts"
import {
	type MigrationConnection,
	type MigrationSession,
	openMigrationSession
} from "#adapter/migrate/session.ts"
import { sentAnswer } from "#adapter/wire/batch.ts"
import { identity } from "#compiler/core/identity.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import type { MigrationFolder } from "#compiler/deploy/render/folder.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { ownLogin } from "#compiler/schema/own.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import {
	aliasRenames,
	bothRenames,
	chosenRenames,
	codedFacts,
	declaredOf,
	extensionsOf,
	noRenames,
	type Origins,
	planOf,
	type Renames,
	rowsSql,
	serialField,
	typedValue,
	type Version,
	versionLogins
} from "#test/pg/migrate-gen/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { checkInstalled, installedScope } from "#test/support/catalog/installed.ts"
import { type Catalog, readCatalog, readCatalogWith } from "#test/support/catalog/read.ts"
import { isLedgerObject, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	draftCodes,
	fromEmpty,
	fromSnapshot,
	generate,
	type Previous,
	draftedAt
} from "#test/support/migrate/kit.ts"
import { type Decisions, review } from "#test/support/migrate/review.ts"
import { typedLiteralDesc } from "#test/support/oracle/gen/domain.ts"
import type { ValueFacts } from "#test/support/oracle/gen/facts.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import type { RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { PropertyFailed } from "#test/support/oracle/runner.ts"
import {
	clusterConnection,
	parsedConnection,
	type PgConnection,
	type SqlError
} from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { testSql } from "#test/support/sql.ts"
import type { Credentials, RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate, type SubstrateShape } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
import type { Uuid } from "#compiler/public/fields.ts"
import { paramText } from "#test/support/wire.ts"
/** The migration identity's connection to the substrate's database.
 *
 * Driving the real apply runner from the migrate tests.
 *
 * A test drafts its folders with `generateMigration` (through), has each reviewed by the one
 * reviewer as a Reviewer decides it, and applies them as `grizzle migrate` would: the
 * migration identity, the database owner, connects over verify-full TLS through the adapter's own connection path, and
 * the runner checks, runs, records and admits. A migrated catalog compares with a fresh install's through
 * `sameCatalog`: PostgreSQL's catalog of both as the test kernel reads it, never grizzle's own
 * snapshot. */
const migrationConnection = (
	substrate: SubstrateShape,
	credentials: Credentials
): MigrationConnection =>
	parsedConnection(
		clusterConnection(
			substrate.cluster,
			substrate.database,
			Redacted.make(Redacted.value(credentials.password))
		),
		credentials.role
	)

/** A migration session as `credentials` in the substrate's database, verify-full against the substrate's cluster. */
export const openMigrator = (
	substrate: SubstrateShape,
	credentials: Credentials
): Effect.Effect<MigrationSession, MigrateError, Scope.Scope> =>
	openMigrationSession(migrationConnection(substrate, credentials))

/** The rows of one statement the test reads on the migration session, in a step of its own; the server's refusal fails. */
export const statementRows = (
	session: MigrationSession,
	sql: string,
	params: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<ReadonlyArray<string>>, StatementFailure> =>
	Effect.flatMap(
		session.apart([{ sql: testSql(sql), params: Arr.map(params, paramText) }]),
		(answers) => Effect.fromResult(Result.map(sentAnswer(answers, 0), (outcome) => outcome.rows))
	)

/** What a reviewer decides for a drafted folder (`Decisions`), and an edit of each reviewed file's text
 * afterwards, the file given by its name and text: a data step, or a review a test means to be wrong. `unedited`
 * edits nothing. */
export interface Reviewer {
	readonly decisions: (g: GenerateResult) => Decisions
	readonly edit: (file: { readonly name: string; readonly text: string }) => string
}

const unedited: Reviewer["edit"] = (file) => file.text

/** Every loss written, every placeholder given `value`, an SQL literal each of the folder's placeholders accepts. */
export const keeping = (value: string): Decisions => ({
	losses: "written",
	value: () => value
})

/** Every loss written, '0' for every placeholder: an untyped literal every numeric and text type accepts. */
export const kept: Reviewer = { decisions: () => keeping("'0'"), edit: unedited }

/** A drafted folder reviewed as the command line reads it. */
export const reviewedSource = (g: GenerateResult, reviewer: Reviewer): FolderSource => {
	const reviewed = review(g, reviewer.decisions(g))
	return {
		name: g.folder.name,
		metaText: g.folder.metaText,
		files: Arr.map(reviewed.files, (f) => ({
			name: f.name,
			text: reviewer.edit(f)
		}))
	}
}

/** A folder as written: a custom migration, or a draft applied with its markers. */
export const folderSource = (folder: MigrationFolder): FolderSource => ({
	name: folder.name,
	metaText: folder.metaText,
	files: folder.files
})

/** A further admission of the applied catalog, such as the installed-catalog checker, run on the migration session
 * after the runner's own drift check: what it finds the snapshot does not account for. */
export type FurtherAdmission = (
	session: MigrationSession,
	snapshot: DeploySnapshot
) => Effect.Effect<ReadonlyArray<DriftMismatch>, StatementFailure>

/** No further admission: the runner's own alone. */
export const noFurther: Option.Option<FurtherAdmission> = Option.none()

/** Applies one schema's folders on the session, then the further admission, whose mismatches fail the apply as the
 * runner's own admission's would. */
export const apply = (
	session: MigrationSession,
	t: MigrationTarget,
	further: Option.Option<FurtherAdmission>
): Effect.Effect<SchemaApplyReport, MigrateError> =>
	Effect.gen(function* () {
		const [report] = yield* applyOnSession(session, [t])
		assert.ok(report !== undefined, "the apply reports its one schema")
		const schema = t.snapshot.schema
		const mismatches: ReadonlyArray<DriftMismatch> = Option.isNone(further)
			? []
			: yield* Effect.mapError(further.value(session, t.snapshot), (failure) =>
					stopped(new DriftUnchecked({ schema, failure }))
				)
		if (Arr.isReadonlyArrayNonEmpty(mismatches)) {
			return yield* stopped(new Drifted({ schema, snapshot: t.snapshot.fingerprint, mismatches }))
		}
		return report
	})

/** The installed-catalog checker over the catalog the apply reached, against the
 * scope of `installation` at the target snapshot: every apply a suite makes leaves the posture every installation
 * holds. The checker reads on the harness's connection `harness`, never on the migration session: the apply has
 * committed, so any session sees the catalog it reached, and the oracle's SQL never runs under the session settings
 * the subject runs under, nor through grizzle's wire. A harness that cannot read fails the test. */
export const checkedAdmission = (
	installation: Installation,
	harness: PgConnection
): Option.Option<FurtherAdmission> =>
	Option.some((_session: MigrationSession, snapshot: DeploySnapshot) =>
		Effect.gen(function* () {
			const installed = yield* Effect.orDie(
				readCatalogWith(
					(sql, params) => harness.queryValues(sql, params),
					[
						snapshot.schema,
						...Arr.filter(
							Arr.map(snapshot.levels, (l) => l.schema),
							(s) => s !== snapshot.schema
						)
					]
				)
			)
			assert.ok(installed.kind === "present", `the applied schema ${snapshot.schema} is absent`)
			return Arr.map(
				checkInstalled(installed.catalog, installedScope(installation, snapshot)),
				(problem): DriftMismatch => ({
					kind: "unexpected",
					fact: `installed-catalog checker: ${Formatter.format(problem)}`
				})
			)
		})
	)

/** The MigrateError an apply fails with; a success or a defect fails the test. */
export const refusal = <A>(effect: Effect.Effect<A, MigrateError>): Effect.Effect<MigrateError> =>
	Effect.map(Effect.exit(effect), (exit) => {
		if (Exit.isSuccess(exit)) {
			assert.fail("expected the apply to fail with MigrateError, but it succeeded")
		}
		const error = Cause.findError(exit.cause)
		if (Result.isFailure(error)) {
			assert.fail(`expected a MigrateError failure, got ${Cause.pretty(exit.cause)}`)
		}
		return error.success
	})

export const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** The definitions readCatalog does not record, with the schema name replaced by `S`: every function's
 * pg_get_functiondef, every non-internal trigger's pg_get_triggerdef (its events and UPDATE OF columns) and every
 * materialized view's pg_get_viewdef, by kind and name; the migrations ledger's guard trigger, which only a migrated
 * installation holds, left out. */
const definitions = (s: RawSession, schema: string, abstract: (text: string) => string) =>
	Effect.map(
		s.values(
			`SELECT d.kind, d.name, d.def, d.relation FROM (
	SELECT 'function' AS kind, p.proname::text AS name, pg_catalog.pg_get_functiondef(p.oid) AS def, '' AS relation
	FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
	WHERE n.nspname = $1::text
	UNION ALL
	SELECT 'trigger', c.relname::text || '.' || t.tgname::text, pg_catalog.pg_get_triggerdef(t.oid), c.relname::text
	FROM pg_catalog.pg_trigger AS t JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
	JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
	WHERE n.nspname = $1::text AND NOT t.tgisinternal
	UNION ALL
	SELECT 'view', c.relname::text, pg_catalog.pg_get_viewdef(c.oid), c.relname::text
	FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
	WHERE n.nspname = $1::text AND c.relkind = 'm'
) AS d ORDER BY d.kind COLLATE "C", d.name COLLATE "C"`,
			[schema]
		),
		(rows) =>
			Arr.sort(
				Arr.map(
					Arr.filter(
						rows,
						([kind, , , relation]) =>
							kind !== "trigger" || !isLedgerObject(schema, String(relation))
					),
					([kind, name, def]) => Arr.map([kind, name, def], (v) => abstract(String(v)))
				),
				byKindAndName
			)
	)

/** Definitions by their kind, then by their name: a definition's first two texts. */
const byKindAndName: Order.Order<ReadonlyArray<string>> = Order.combine(
	Order.mapInput(Order.String, (d: ReadonlyArray<string>) => d[0] ?? ""),
	Order.mapInput(Order.String, (d: ReadonlyArray<string>) => d[1] ?? "")
)

/** A grant of an ACL: its grantee and its privilege. */
interface Grant {
	readonly grantee: string
	readonly privilege: string
}

/** Grants by grantee, then by privilege. */
const byGrantee: Order.Order<Grant> = Order.combine(
	Order.mapInput(Order.String, (g: Grant) => g.grantee),
	Order.mapInput(Order.String, (g: Grant) => g.privilege)
)

/** A grant of an ACL list, which holds nothing else. */
const isGrant = (x: unknown): x is Grant =>
	typeof x === "object" &&
	x !== null &&
	"grantee" in x &&
	typeof x.grantee === "string" &&
	"privilege" in x &&
	typeof x.privilege === "string" &&
	Rec.keys(x).length === 2

/** One side of a role's membership, which a list holds per other role. */
interface Membership {
	readonly role: string
	readonly inherit: boolean
	readonly set: boolean
	readonly admin: boolean
}

const isMembership = (x: unknown): x is Membership =>
	typeof x === "object" &&
	x !== null &&
	"role" in x &&
	typeof x.role === "string" &&
	"inherit" in x &&
	typeof x.inherit === "boolean" &&
	"set" in x &&
	typeof x.set === "boolean" &&
	"admin" in x &&
	typeof x.admin === "boolean"

/** An object of the catalog with every field it holds beside `F`. */
type WithRest<F> = F & Readonly<Record<string, unknown>>

/** An object readCatalog orders by name. */
type Named = WithRest<{ readonly name: string }>

/** The parts of a catalog comparable reads: every object keeps all of its fields. */
type ComparableCatalog = WithRest<{
	readonly tables: ReadonlyArray<
		WithRest<{ readonly name: string; readonly columns: ReadonlyArray<Named> }>
	>
	readonly indexes: ReadonlyArray<WithRest<{ readonly name: string; readonly table: string }>>
	readonly enums: ReadonlyArray<Named>
	readonly domains: ReadonlyArray<Named>
	readonly sequences: ReadonlyArray<Named>
	readonly functions: ReadonlyArray<WithRest<{ readonly name: string; readonly args: string }>>
	readonly triggers: ReadonlyArray<
		WithRest<{ readonly name: string; readonly table: string; readonly definition: string }>
	>
	readonly statistics: ReadonlyArray<Named>
	readonly policies: ReadonlyArray<WithRest<{ readonly name: string; readonly table: string }>>
	readonly roles: ReadonlyArray<Named>
	readonly worlds: ReadonlyArray<Named>
	readonly foreignGrants: ReadonlyArray<
		WithRest<{ readonly schema: string; readonly grantee: string; readonly privilege: string }>
	>
}>

/**
 * Every name an installation minted under its own schema's identity whose spelling depends on it, as the text that
 * names it under any schema. A hashed name (a filter function's or a key probe's, whose stem and digest both carry the
 * installation) names one object of the whole installation (core/identity.ts censusOf), so it maps through the identity
 * it was minted from, to that identity's canonical encoding without the installation's, read off the naming door's
 * identities, never off its spelling. A readable name is its own label: it spells its identity, and one spelling may
 * name several objects (a role, its schema and its policies are all `<schema>__<role>`), so the schema's identifier it
 * starts with is the one placeholder, as is the installation's own display, which its hashed objects' comments hold. A
 * role's view is named by its relation's declared name alone, the same under any schema, so it is no such name.
 */
export const installationAbstraction = (installation: Installation): ((text: string) => string) => {
	const at = installation.names.installation
	const hashed = new Map<string, string>()
	for (const i of installation.identities) {
		if (i.form === "hashed" && Str.includes(at.canonical)(i.canonical)) {
			hashed.set(i.identifier, `\u0000${Str.replaceAll(at.canonical, "")(i.canonical)}`)
		}
	}
	const entries: ReadonlyArray<readonly [string, string]> = [...hashed, [at.identifier, "\u0000"]]
	/** Longest first: a hashed name spells the schema's identifier in its stem. */
	const names = Arr.sort(
		entries,
		Order.flip(Order.mapInput(Order.Number, (entry: readonly [string, string]) => entry[0].length))
	)
	return (text) =>
		Str.replaceAll(
			at.display,
			"\u0000"
		)(Arr.reduce(names, text, (t, [from, to]) => Str.replaceAll(from, to)(t)))
}

/**
 * `items` in the order of `keys`, compared in turn: a list readCatalog orders by its objects' names, ordered again once
 * the names are abstracted. An installation-scoped hashed name's stem and digest differ from one installation to the
 * next, so the order of the installed names is no order between two installations (core/identity.ts
 * compareIdentities).
 */
const ordered = <A>(
	items: ReadonlyArray<A>,
	keys: ReadonlyArray<(item: A) => string>
): ReadonlyArray<A> =>
	Arr.sort(items, Order.combineAll(Arr.map(keys, (key) => Order.mapInput(Order.String, key))))

/** A catalog with its installation abstracted (installationAbstraction), so two installations under different names
 * compare, without the migrations ledger and its guard trigger, which only a migrated installation holds, with each
 * table's columns by name: a column a migration adds comes after the others, where a fresh install declares it in its
 * place, and grizzle states no column order (`keys` columns by name too), and with every list readCatalog orders by
 * name ordered by the abstracted names (`ordered`). Every other name is compared as it is, since no name has a
 * history. */
const comparable = (
	catalog: Catalog,
	schema: string,
	abstract: (text: string) => string
): Readonly<Record<string, unknown>> => {
	/** Every name and text of the catalog with the schema's name replaced, and PostgreSQL's internal foreign-key triggers
	 * without the OID it names them by. An ACL lists its grantees in the order they were granted, which a migration that
	 * revokes and grants a role's privileges again changes; readCatalog orders its grant lists by privilege alone, so
	 * they compare as sets, ordered by grantee and privilege. A role's memberships, which readCatalog orders by the
	 * other role's name, are ordered again once the names are replaced, since that order depends on the schema's name,
	 * and so is every list of the catalog readCatalog orders by its objects' names (`ordered`). */
	const text = (value: string): string =>
		pipe(
			abstract(value),
			Str.replace(regex("RI_ConstraintTrigger_([ac])_[0-9]+", "g"), "RI_ConstraintTrigger_$1")
		)
	const normal = (value: unknown): unknown => {
		if (typeof value === "string") {
			return text(value)
		}
		if (Arr.isArray(value)) {
			const items = Arr.map(value, normal)
			const grantList = Arr.filter(items, isGrant)
			if (items.length > 0 && grantList.length === items.length) {
				return Arr.sort(grantList, byGrantee)
			}
			const memberships = Arr.filter(items, isMembership)
			if (items.length > 0 && memberships.length === items.length) {
				return Arr.sort(
					memberships,
					Order.mapInput(Order.String, (m: Membership) => m.role)
				)
			}
			return items
		}
		if (typeof value !== "object" || value === null) {
			return value
		}
		return Rec.fromEntries(Arr.map(Rec.toEntries(value), ([k, v]) => [text(k), normal(v)]))
	}
	const c = trusted<ComparableCatalog>(normal(catalog))
	return {
		...c,
		tables: ordered(
			Arr.map(
				Arr.filter(c.tables, (t) => !isLedgerObject(schema, t.name)),
				(t) => ({ ...t, columns: ordered(t.columns, [(x) => x.name]) })
			),
			[(t) => t.name]
		),
		indexes: ordered(
			Arr.filter(c.indexes, (x) => !isLedgerObject(schema, x.name)),
			[(x) => x.name]
		),
		enumLabels: c["enumLabels"],
		domains: ordered(c.domains, [(x) => x.name]),
		sequences: ordered(c.sequences, [(x) => x.name]),
		/** By name, then by arguments, which tell overloads of one name apart. */
		functions: ordered(c.functions, [(f) => f.name, (f) => f.args]),
		/** By table and name, then by definition: PostgreSQL's internal foreign-key triggers on one table share a name
		 * once their OIDs are left out, and differ by the table their foreign key is on. */
		triggers: ordered(
			Arr.filter(c.triggers, (t) => !isLedgerObject(schema, t.table)),
			[(t) => t.table, (t) => t.name, (t) => t.definition]
		),
		statistics: ordered(c.statistics, [(x) => x.name]),
		policies: ordered(c.policies, [(p) => p.table, (p) => p.name]),
		roles: ordered(c.roles, [(r) => r.name]),
		worlds: ordered(c.worlds, [(w) => w.name]),
		foreignGrants: ordered(c.foreignGrants, [(g) => g.schema, (g) => g.grantee, (g) => g.privilege])
	}
}

/** The catalog of a schema an installation reached: its absence is a defect of the test. */
const presentCatalog = (schema: string) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const installed = yield* readCatalog(substrate.admin, [schema])
		if (installed.kind === "absent") {
			return yield* Effect.die(new Error(`the schema ${installed.schema} is absent`))
		}
		return installed.catalog
	})

/** Asserts that two installations hold one catalog, its definitions included, the ledger aside (comparable): `actual`,
 * such as a migrated schema, against `expected`, such as a fresh install of the same version. */
/** The catalogs of two installations of one schema, `actual` and `expected`, are equal under each one's installation
 * abstraction (installationAbstraction). */
export const sameCatalog = (
	actual: Installation,
	expected: Installation,
	what: string
): Effect.Effect<void, SqlError, Substrate> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const ofExpected = installationAbstraction(expected)
		const ofActual = installationAbstraction(actual)
		const expectedCatalog = yield* presentCatalog(expected.names.schema)
		const a = comparable(expectedCatalog, expected.names.schema, ofExpected)
		const actualCatalog = yield* presentCatalog(actual.names.schema)
		const b = comparable(actualCatalog, actual.names.schema, ofActual)
		for (const part of Rec.keys(a)) {
			assert.deepEqual(b[part], a[part], `${what}: catalog ${part}`)
		}
		const s = yield* substrate.session({ ...ownerSession(), label: `definitions ${what}` })
		const actualDefinitions = yield* definitions(s, actual.names.schema, ofActual)
		const expectedDefinitions = yield* definitions(s, expected.names.schema, ofExpected)
		assert.deepEqual(actualDefinitions, expectedDefinitions, `${what}: definitions`)
	}).pipe(Effect.scoped)

/** A version of a generated path with where its names came from. */
export interface Traced {
	readonly version: Version
	readonly origins: Origins
}

/** The renames the carry model carries: every alias, and the path's renames when the draft declares them. */
export const carried = (from: Traced, to: Traced, choose: boolean): Renames =>
	bothRenames(aliasRenames(from, to), choose ? chosenRenames(from, to) : noRenames)

/** One drafted step: its snapshot, and its folder as the reviewer left it, none when the step changes nothing. */
interface Step {
	readonly generated: GenerateResult
	readonly files: ReadonlyArray<{ readonly name: string; readonly text: string }>
}

/** The complete installation of a version under `schema`, owned by `owner`, with its worlds: as `grizzle generate`
 * compiles it (`completeInstallOptions`). */
const installationOf = (
	version: Version,
	schema: string,
	owner: string,
	previous: Previous,
	declared: Declarations
): Installation => {
	const owned = owning(version.desc)
	const logins = Arr.map(versionLogins(version), (l) => succeeded(ownLogin(l)))
	return succeeded(
		compileInstallation(owned, {
			...completeInstallOptions(
				owned,
				[identity.schema(parsedSchemaName(schema))],
				logins,
				extensionsOf(version),
				succeeded(draftCodes(version.desc, previous, declared))
			),
			owner
		})
	)
}

/** (d) Every identity of a migrated schema is past its column's stored maximum: the value its sequence generates next
 * exceeds every value the column holds, so no generated value repeats a stored one, whether the migration kept the
 * serial, converted it in place (its target identity advanced past the converted values) or declared it over a column
 * holding rows. Read as the substrate's admin from the sequence and the table, never through grizzle. */
export const identitiesPast = (
	plan: RealInstallPlan,
	what: string
): Effect.Effect<void, PropertyFailed | SqlError, Substrate> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		for (const t of Rec.values(plan.tables)) {
			for (const c of t.columns) {
				if (c.sequence.kind !== "identity") {
					continue
				}
				const read = yield* substrate.admin.query(
					`SELECT (SELECT max(${quoteIdent(c.column)}) FROM ${printObjectName(t.name)})::text AS max, (SELECT CASE WHEN s.is_called THEN s.last_value + 1 ELSE s.last_value END FROM ${printObjectName(c.sequence.name)} AS s)::text AS next`,
					[]
				)
				const [row] = read.rows
				const max = row?.["max"]
				const next = row?.["next"]
				if (typeof next !== "string") {
					return yield* new PropertyFailed({
						report: `${what}: the identity of ${t.relation}.${c.field} reads no next value`
					})
				}
				if (typeof max === "string" && BigInt(next) <= BigInt(max)) {
					return yield* new PropertyFailed({
						report: `${what}: the identity of ${t.relation}.${c.field} generates ${next} next, which its stored maximum ${max} reaches`
					})
				}
			}
		}
	})

/**
 * The steps of `versions` into `schema`, each drafted from the snapshot before under the renames and drops it declares
 * (`--rename`, `--drop`: migrate-gen declaredOf), the path's renames declared when `choose` and every removal declared
 * a drop otherwise, and reviewed with every loss written. Nothing is guessed, so every review is expressible; a draft
 * refused is a failure of the property.
 */
export const drafted = (
	versions: ReadonlyArray<Traced>,
	schema: string,
	owner: string,
	choose: boolean
): Result.Result<ReadonlyArray<Step>, PropertyFailed> => {
	const steps: Array<Step> = []
	let previous: Previous = fromEmpty
	for (const [i, step] of versions.entries()) {
		const prior = versions[i - 1] ?? step
		const declared = declaredOf(prior, step, choose && i > 0)
		const installation = installationOf(step.version, schema, owner, previous, declared)
		const g = generate({
			previous,
			installation,
			name: `step_${i + 1}`,
			timestamp: draftedAt(i + 1),
			workload: noWorkload,
			declared
		})
		if (!g.ok) {
			return Result.fail(
				new PropertyFailed({ report: `step ${i + 1} is refused: ${g.error.message}` })
			)
		}
		previous = fromSnapshot(g.value.snapshot)
		const after = planOf(step.version, schema, owner)
		const reviewed = review(g.value, {
			losses: "written",
			value: typedValue({ plan: after, version: step.version })
		})
		steps.push({ generated: g.value, files: reviewed.files })
	}
	return Result.succeed(steps)
}

/** The migrations directory as of step `i`: every folder up to it that changes something, as its reviewer left it. */
export const directory = (steps: ReadonlyArray<Step>, i: number): MigrationTarget => {
	const step = steps[i]
	if (step === undefined) {
		throw new Error(`no step ${i}`)
	}
	return {
		snapshot: step.generated.snapshot,
		folders: Arr.map(
			Arr.filter(steps.slice(0, i + 1), (s) => s.generated.change !== "none"),
			({ generated: { folder }, files }) => ({
				name: folder.name,
				metaText: folder.metaText,
				files
			})
		)
	}
}

/** A version's facts as the loader's records, with the coded pair's fixed rows when the path draws it; a relation with a
 * serial field numbers its rows from one, the values the row comparison leaves out. */
export const factSetOf = (v: Version, facts: ValueFacts): FactSet => {
	const serial = new Set(
		Arr.flatMap(v.desc.relations, (r) =>
			r.kind === "relation" && serialField in r.fields ? [r.name] : []
		)
	)
	const out: Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>> = {}
	for (const r of v.schema.relations) {
		out[r.name] = Arr.map(facts[r.name] ?? [], (row, i) => ({
			...Rec.fromEntries(
				Arr.map(r.columns, (c, k) => {
					const value = row[k]
					if (value === undefined) {
						throw new Error(`a fact of ${r.name} without its field ${c.name}`)
					}
					return [c.name, typedLiteralDesc(value, c.type)]
				})
			),
			...(serial.has(r.name) ? { [serialField]: BigInt(i + 1) } : {})
		}))
	}
	return v.extras.coded.kind === "present" ? { ...out, ...codedFacts } : out
}

/** The rows of a version's relations, by relation, each a multiset in a canonical order, a numbered field's values
 * apart from them, by field (`rowsSql`), as PostgreSQL reads them. */
export const rowsOf = (
	session: MigrationSession,
	plan: RealInstallPlan,
	v: Version,
	schema: string,
	numbered: ReadonlySet<string>
): Effect.Effect<
	Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>>,
	StatementFailure
> =>
	Effect.gen(function* () {
		const out: Record<string, ReadonlyArray<ReadonlyArray<string>>> = {}
		for (const [key, sql] of rowsSql(plan, v, schema, numbered)) {
			const rows = yield* statementRows(session, sql, [])
			out[key] = Arr.sort(rows, Arr.makeOrder(Order.String))
		}
		return out
	})
