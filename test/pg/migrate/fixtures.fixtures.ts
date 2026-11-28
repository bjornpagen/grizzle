/** What the properties of fixtures.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, type Gen, int, type Steered } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Layer, Option, Record as Rec } from "effect"
import { readLedger } from "#adapter/migrate/apply.ts"
import type { FolderTexts } from "#adapter/migrate/input.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import { compileServed } from "#adapter/public/compile.ts"
import { Db } from "#adapter/public/db.ts"
import { served } from "#adapter/public/layer.ts"
import type { Named } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { completedFiles } from "#compiler/deploy/ledger/ledger.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { writeRuntimeSnapshot } from "#compiler/deploy/snapshot/build.ts"
import type { AnyLogin, AnySchema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import * as graphApi from "#test/support/fixtures/api/graph.ts"
import * as ledgerApi from "#test/support/fixtures/api/ledger.ts"
import * as payrollApi from "#test/support/fixtures/api/payroll.ts"
import * as queueApi from "#test/support/fixtures/api/queue.ts"
import * as searchApi from "#test/support/fixtures/api/search.ts"
import * as spansApi from "#test/support/fixtures/api/spans.ts"
import * as workApi from "#test/support/fixtures/api/work.ts"
import {
	type GeneratedDraft,
	generatedDrafting,
	installGenerated,
	runsInstallScript
} from "#test/support/install-migrate.ts"
import { rebuild, renamed as renamedSchema } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { decodersIn, servedSourcedLayer } from "#test/support/live-layer.ts"
import { fromEmpty, fromSnapshot, type Previous } from "#test/support/migrate/kit.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import {
	apply,
	checkedAdmission,
	kept,
	noFurther,
	openMigrator,
	reviewedSource,
	sameCatalog
} from "#test/support/pg/migrate/support.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { testVerify, tokenOf } from "#test/support/worlds.ts"

/** One version of a history: a schema or an extension, its value, every level renamed with it, and the logins of its
 * worlds over the version declared under a name (none for a fixture that declares no worlds). */
interface Version {
	readonly fixture: AnySchema
	readonly logins: (name: string) => ReadonlyArray<AnyLogin>
}

const versionOf = (
	fixture: AnySchema,
	logins: (name: string) => ReadonlyArray<AnyLogin>
): Version => ({ fixture, logins })

const noLogins = (): ReadonlyArray<AnyLogin> => []

/** The fixture families, by name. */
type HistoryLabel =
	| "work"
	| "payroll"
	| "plans"
	| "queue"
	| "ledger"
	| "network"
	| "search"
	| "schedule"
	| "calendars"

/** A fixture family: a base schema and the extensions of it its fixture declares, each a level a history stands at. */
interface Family {
	readonly label: HistoryLabel
	readonly levels: Arr.NonEmptyReadonlyArray<Version>
}

const work = versionOf(workApi.Work, (name) => [
	workApi.workWorlds(rebuild(workApi.Work, name)).server
])

const payroll = versionOf(payrollApi.Payroll, noLogins)

const reporting = versionOf(payrollApi.Reporting, (name) => [
	payrollApi.reportingWorlds(rebuild(payrollApi.Payroll, name)).server
])

/** The dictionary of fixture families: realistic schemas whose features the generated paths do not reach. */
export const families: Arr.NonEmptyReadonlyArray<Family> = [
	{ label: "work", levels: [work, versionOf(workApi.Reports, noLogins)] },
	{ label: "payroll", levels: [payroll, reporting] },
	{
		label: "plans",
		levels: [
			versionOf(workApi.Plans, (name) => [workApi.plansWorlds(rebuild(workApi.Plans, name)).server])
		]
	},
	{
		label: "queue",
		levels: [
			versionOf(queueApi.Queue, (name) => [
				queueApi.queueWorlds(rebuild(queueApi.Queue, name)).server
			])
		]
	},
	{ label: "ledger", levels: [versionOf(ledgerApi.Ledger, noLogins)] },
	{ label: "network", levels: [versionOf(graphApi.Network, noLogins)] },
	{
		label: "search",
		levels: [
			versionOf(searchApi.Search, (name) => [
				searchApi.searchWorlds(rebuild(searchApi.Search, name)).server
			])
		]
	},
	{ label: "schedule", levels: [versionOf(spansApi.Schedule, noLogins)] },
	{ label: "calendars", levels: [versionOf(spansApi.Calendars, noLogins)] }
]

/** A history: a family, and the level of each of its versions, in order. */
interface History {
	readonly family: Family
	readonly levels: Arr.NonEmptyReadonlyArray<number>
}

/** A walk over one of `among`'s families: two to four versions, each at any of its levels. */
const historyFrom =
	(among: Arr.NonEmptyReadonlyArray<Family>): Gen<History> =>
	(source) => {
		const family = source.draw(element(among))
		const level = int(0, family.levels.length - 1)
		return {
			family,
			levels: nonEmptyList(
				upTo(source.draw(int(2, 4)), () => source.draw(level)),
				"a history's versions"
			)
		}
	}

/** A history's versions, in order. */
const versionsOf = (h: History): Arr.NonEmptyReadonlyArray<Version> =>
	Arr.map(h.levels, (at) => defined(h.family.levels[at], "a level of the family"))

export type FixtureFeature =
	| HistoryLabel
	| "an extension added"
	| "an extension dropped"
	| "a version drafted again"

/** What a history reaches: its family, and each step's move between levels. */
export const featuresOf = (h: History): ReadonlyArray<FixtureFeature> => [
	h.family.label,
	...Arr.flatMap(Arr.drop(h.levels, 1), (to, i): ReadonlyArray<FixtureFeature> => {
		const from = defined(h.levels[i], "the level before")
		return [
			to > from
				? "an extension added"
				: to < from
					? "an extension dropped"
					: "a version drafted again"
		]
	})
]

/** Whether `family` reaches a situation `holds` names: its own label, or, where it has more than one level, an
 * extension added or dropped. */
const reachesBy =
	(holds: (situation: Reached<FixtureFeature>) => boolean) =>
	(family: Family): boolean =>
		holds(family.label) ||
		(family.levels.length > 1 && (holds("an extension added") || holds("an extension dropped")))

/** A history under its steering: drawn from every family, or, where the case steers, from the families that reach the
 * situation its turn aims at, else from those that reach any pending one, so the cases of one window aim at distinct
 * pending families. The history holds its family, so it runs the same unsteered. */
export const historySteered: Steered<History, FixtureFeature>["under"] = (steering) => {
	const aimed = Option.match(steering, {
		onNone: (): ReadonlyArray<Family> => [],
		onSome: (pending) => {
			const turn = Arr.filter(families, reachesBy(pending.aimed))
			return Arr.isReadonlyArrayNonEmpty(turn) ? turn : Arr.filter(families, reachesBy(pending.has))
		}
	})
	return historyFrom(Arr.isReadonlyArrayNonEmpty(aimed) ? aimed : families)
}

/**
 * Each version of `history` under `name` as `grizzle generate` drafts and serves it (install-migrate.ts
 * generatedDrafting), the first from the empty snapshot, each later one from the snapshot the one before it reached,
 * declaring what it drops (declaredFrom): its schema renamed, its logins serving their workloads, so its installation
 * holds every index their programs read through, and its draft before any review. A history drafted under two names
 * holds the same codes at every version, as both draft each version from the one before.
 */
const draftsAt = (
	history: { readonly versions: Arr.NonEmptyReadonlyArray<Version> },
	name: string
) =>
	Effect.gen(function* () {
		const installation = identity.schema(parsedSchemaName(name))
		const drafts: Array<Omit<GeneratedDraft, "folder" | "snapshot">> = []
		let previous: Previous = fromEmpty
		for (const [i, version] of history.versions.entries()) {
			const drafted = yield* Effect.orDie(
				generatedDrafting(
					{
						schema: renamedSchema(version.fixture, name),
						logins: version.logins(name),
						declarations: declaredFrom(i === 0 ? undefined : history.versions[i - 1], version, name)
					},
					{ installation, previous, step: i + 1 }
				)
			)
			drafts.push(drafted)
			previous = fromSnapshot(drafted.generated.snapshot)
		}
		return nonEmpty(drafts, "a history has its first version")
	})

/**
 * What a step from `before` to `version` declares (`--drop`): each login `before` holds that `version` no longer does,
 * whose PostgreSQL role holds what its operator gave it, so its drop is stored state a draft refuses undeclared. A
 * history drops nothing else of stored state: the derived relation it drops is recomputed from its definition, and a
 * role is created and granted whole. A history's first step continues the empty snapshot and drops nothing.
 */
const declaredFrom = (
	before: Version | undefined,
	version: Version,
	name: string
): Declarations => {
	const kept = new Set(Arr.map(version.logins(name), (l) => l.name))
	return {
		renames: [],
		drops: Arr.flatMap(before === undefined ? [] : before.logins(name), (l): ReadonlyArray<Named> =>
			kept.has(l.name) ? [] : [{ kind: "login", login: parsedName(l.name) }]
		)
	}
}

/** The three installations of the last version, the fresh one and the installer's dropped once compared.
 *
 * Db.open admits the database: a refusal fails the test. */
export const migrates = (h: History) =>
	Effect.gen(function* () {
		const history = { label: h.family.label, versions: versionsOf(h) }
		const substrate = yield* Substrate
		const name = yield* substrate.schema({ create: false, label: history.label })
		const m = yield* openMigrator(substrate, substrate.owner)
		const folders: Array<FolderTexts> = []
		const drafted: Array<GenerateResult> = []
		const drafts = yield* draftsAt(history, name)
		for (const [i, { generated: g, plan }] of drafts.entries()) {
			if (i > 0 && history.versions[i - 1] === history.versions[i]) {
				assert.equal(g.change, "none", `step ${i + 1} drafts the version again`)
			}
			if (g.change !== "none") {
				folders.push(reviewedSource(g, kept))
				drafted.push(g)
				yield* apply(
					m,
					{ snapshot: g.snapshot, folders: [...folders] },
					checkedAdmission(plan.installation, substrate.admin)
				)
			}
		}
		const last = Arr.lastNonEmpty(history.versions)
		/** The last version's installation, as the history drafted it. */
		const migrated = Arr.lastNonEmpty(drafts).plan.installation
		/** The committed snapshot.json: the last folder's, which a draft that changes nothing keeps. */
		const committed = drafted[drafted.length - 1]
		if (committed === undefined) {
			throw new Error(`the history of ${history.label} drafts a folder`)
		}
		const snapshot = committed.snapshot

		yield* Effect.scoped(
			Effect.gen(function* () {
				const schema = yield* substrate.schema({ create: false, label: `${history.label}_fresh` })
				/** The last version's installation as the same history drafts it under another name, so its codes are the
				 * history's. */
				const again = yield* draftsAt(history, schema)
				const fresh = Arr.lastNonEmpty(again).plan.installation
				yield* transaction(substrate.admin, installationSql(fresh, substrate.database))
				yield* sameCatalog(
					migrated,
					fresh,
					`${history.label}: the migrated history against a fresh install`
				)
				const { installed } = yield* installGenerated(
					(installer) => ({
						schema: renamedSchema(last.fixture, installer),
						logins: last.logins(installer)
					}),
					{ ambient: ordinarySession, label: `${history.label}_installer` }
				)
				assert.ok(
					runsInstallScript(installed.folders, installed.installation, substrate.database),
					`${history.label}: the installer's migration runs the fresh-install script`
				)
				yield* sameCatalog(
					installed.installation,
					fresh,
					`${history.label}: the test installer against a fresh install`
				)
			})
		)

		/** The ledger, and an apply with nothing pending. */
		const state = yield* readLedger(m, name, succeeded(statementsFor(name)))
		assert.equal(state.latest, snapshot.fingerprint)
		assert.equal(state.partial, undefined)
		assert.deepEqual(
			Arr.map(state.complete, (f) => [f.folder, completedFiles(f)]),
			Arr.map(folders, (f) => [f.name, Arr.map(indices(f.files.length), (k) => k + 1)])
		)
		const again = yield* apply(m, { snapshot, folders }, noFurther)
		assert.deepEqual(again.applied, [])

		/**
		 * Db.open of every role of the last version's logins, each login served from its file compiled under the committed
		 * snapshot.
		 */
		const scope = yield* Effect.scope
		const decoderOf = yield* decodersIn(substrate, scope)
		for (const login of last.logins(name)) {
			const installedLogin = Option.getOrThrowWith(
				Arr.findFirst(migrated.worlds, (l) => l.name === login.name),
				() => new Error(`the installation's login ${login.name}`)
			)
			const credentials = yield* substrate.login(installedLogin.role)
			const json = yield* compileServed(
				login,
				snapshotJson(
					succeeded(writeRuntimeSnapshot(committed.snapshot, committed.derived), "snapshot.json")
				),
				login.workload
			)
			const file = served<AnyLogin>(json, login.name)
			const loginLayer = servedSourcedLayer(decoderOf, {
				...clusterConnection(substrate.cluster, substrate.database, credentials.password),
				pool: clusterPool,
				login: file,
				verify: testVerify
			})
			for (const role of Rec.values(login.roles)) {
				const reached = defined(
					file.roles[role.role.name],
					`role ${role.role.name} of the served login`
				)
				yield* Effect.scoped(
					Effect.flatMap(Layer.build(loginLayer), (context) =>
						Effect.provideContext(Effect.asVoid(Db.open(reached, { token: tokenOf({}) })), context)
					)
				)
			}
		}
	}).pipe(Effect.scoped)
