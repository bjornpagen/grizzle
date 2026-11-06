import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Layer, Option, Record as Rec } from "effect"
import type { FolderSource } from "#adapter/migrate/input.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import { Db } from "#adapter/public/db.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import { indices } from "#compiler/core/array.ts"
import { identity } from "#compiler/core/identity.ts"
import type { Declarations, Named } from "#compiler/deploy/diff/plan.ts"
import { completedFiles } from "#compiler/deploy/ledger/ledger.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { codebookOf } from "#compiler/deploy/snapshot/build.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { SchemaDesc } from "#compiler/ir/desc.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import type { AnyLogin } from "#compiler/public/schema.ts"
import { ownLogin } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import {
	apply,
	checkedAdmission,
	kept,
	noFurther,
	openMigrator,
	reviewedSource,
	sameCatalog
} from "#test/pg/migrate/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import * as graphApi from "#test/support/fixtures/api/graph.ts"
import * as ledgerApi from "#test/support/fixtures/api/ledger.ts"
import * as payrollApi from "#test/support/fixtures/api/payroll.ts"
import * as queueApi from "#test/support/fixtures/api/queue.ts"
import * as searchApi from "#test/support/fixtures/api/search.ts"
import * as spansApi from "#test/support/fixtures/api/spans.ts"
import * as workApi from "#test/support/fixtures/api/work.ts"
import { installMigrated, runsInstallScript } from "#test/support/install-migrate.ts"
import { rebuild } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	draftCodes,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate
} from "#test/support/migrate/kit.ts"
import { readLedger } from "#test/support/migrate/ledger.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { testVerify, tokenOf } from "#test/support/worlds.ts"

/** One version of a history: a schema or an extension, every level renamed with it, and the logins of its worlds over
 * the version declared under a name (none for a fixture that declares no worlds).
 *
 * The worked examples, migrated version by version through the real apply runner, on PostgreSQL 19.
 *
 * The examples are a dictionary of schema histories over the public-API fixtures: Work,
 * then its Reports extension, then Work again, which drops the derived relation, then Work once more, which changes
 * nothing; the same for Payroll and its Reporting; and every other example (Plans, the queue, the ledger, the graph,
 * vector search, spans and calendars) installed and drafted again, which changes nothing. Each history is drafted from the empty
 * snapshot on, as `grizzle generate` drafts it, and applied as `grizzle migrate` applies it: the real runner on the
 * migration identity's own connection path (verify-full TLS), every folder up to the step with that step's snapshot.
 * Every fixture is installed under the allocated name, every level of it renamed, so the declared name is the
 * installed one. Properties, for every history:
 *
 * - every apply is admitted by the runner's post-apply drift check and by the installed-catalog checker against the
 *   version's installation (`checkedAdmission`);
 * - a version drafted again after itself changes nothing;
 * - three installations of the last version agree, the ledger aside: the history the runner migrated, the
 *   fresh-install script, and the test installer every other pg suite installs through,
 *   their catalogs, function bodies, trigger events and view queries included; the installer's statement certificate
 *   (runsInstallScript) holds, so its later installations of a process may skip the full comparison;
 * - the ledger records every folder complete with each of its files once, its latest target the last snapshot and no
 *   folder partial, and applying the directory again runs nothing;
 * - Db.open of every role of the last version's logins, over the schema rebuilt under the installed name, admits the
 *   database.
 *
 * A version carries the logins its fixture's worlds declare, so the histories add, drop
 * and keep logins and roles as they move between levels, each login a step drops declared (`--drop @<login>`), and every
 * apply's checker judges the worlds' posture: the
 * grants, the memberships, and each login's defaults, the search policy's among them (Search reads vectors). The
 * fixtures' roles hold their relations whole, so no table has row security; the worlds suite migrates worlds whose written query entries have policies. */
interface Version {
	readonly desc: SchemaDesc
	readonly logins: (name: string) => ReadonlyArray<AnyLogin>
}

const descOf = (fixture: unknown): SchemaDesc => {
	const desc = schemaDescOf(fixture)
	if (desc === undefined) {
		throw new Error("a fixture is a schema value")
	}
	return desc
}

const versionOf = (
	fixture: unknown,
	logins: (name: string) => ReadonlyArray<AnyLogin>
): Version => ({
	desc: descOf(fixture),
	logins
})

const noLogins = (): ReadonlyArray<AnyLogin> => []

/** The description with every level declared under `name`, so the declared schema is the installed one. */
const renamed = (desc: SchemaDesc, name: string): SchemaDesc => ({
	...desc,
	name,
	...(desc.extends === undefined ? {} : { extends: renamed(desc.extends, name) })
})

/** The worked examples' histories, by name. */
const historyLabels = [
	"work",
	"payroll",
	"plans",
	"queue",
	"ledger",
	"network",
	"search",
	"schedule",
	"calendars"
] as const
type HistoryLabel = (typeof historyLabels)[number]

interface History {
	readonly label: HistoryLabel
	readonly versions: Arr.NonEmptyReadonlyArray<Version>
}

const work = versionOf(workApi.Work, (name) => [
	workApi.workWorlds(rebuild(workApi.Work, name)).server
])
const payroll = versionOf(payrollApi.Payroll, noLogins)
const reporting = versionOf(payrollApi.Reporting, (name) => [
	payrollApi.reportingWorlds(rebuild(payrollApi.Payroll, name)).server
])

const histories: Arr.NonEmptyReadonlyArray<History> = [
	{ label: "work", versions: [work, versionOf(workApi.Reports, noLogins), work, work] },
	{ label: "payroll", versions: [payroll, reporting, payroll, payroll] },
	...Arr.map(
		[
			[
				"plans",
				versionOf(workApi.Plans, (name) => [
					workApi.plansWorlds(rebuild(workApi.Plans, name)).server
				])
			],
			[
				"queue",
				versionOf(queueApi.Queue, (name) => [
					queueApi.queueWorlds(rebuild(queueApi.Queue, name)).server
				])
			],
			["ledger", versionOf(ledgerApi.Ledger, noLogins)],
			["network", versionOf(graphApi.Network, noLogins)],
			[
				"search",
				versionOf(searchApi.Search, (name) => [
					searchApi.searchWorlds(rebuild(searchApi.Search, name)).server
				])
			],
			["schedule", versionOf(spansApi.Schedule, noLogins)],
			["calendars", versionOf(spansApi.Calendars, noLogins)]
		] as const,
		([label, version]): History => ({ label, versions: [version, version] })
	)
]

/** A version's installation under `name`, owned by `owner`, with its logins: the complete installation, its derived
 * relations included, as `grizzle generate` compiles it. */
const compiledAt = (
	version: Version,
	name: string,
	owner: string,
	codes: Codebook
): Installation => {
	const owned = owning(renamed(version.desc, name))
	const logins = Arr.map(version.logins(name), (l) =>
		succeeded(ownLogin(defined(loginDescOf(l), "a login value")))
	)
	return succeeded(
		compileInstallation(owned, {
			...completeInstallOptions(owned, identity.schema(parsedSchemaName(name)), logins, [], codes),
			owner
		})
	)
}

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
const migrates = (history: History) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const owner = substrate.owner.role
		const name = yield* substrate.schema({ create: false, label: history.label })
		const m = yield* openMigrator(substrate, substrate.owner)
		const folders: Array<FolderSource> = []
		const drafted: Array<GenerateResult> = []
		let previous = fromEmpty
		for (const [i, version] of history.versions.entries()) {
			const declared = declaredFrom(i === 0 ? undefined : history.versions[i - 1], version, name)
			const installation = compiledAt(
				version,
				name,
				owner,
				succeeded(draftCodes(renamed(version.desc, name), previous, declared))
			)
			const g: GenerateResult = succeeded(
				generate({
					previous,
					installation,
					name: `step_${i + 1}`,
					timestamp: draftedAt(i + 1),
					workload: noWorkload,
					declared
				})
			)
			if (i > 0 && history.versions[i - 1] === version) {
				assert.equal(g.change, "none", `step ${i + 1} drafts the version again`)
			}
			if (g.change !== "none") {
				folders.push(reviewedSource(g, kept))
				drafted.push(g)
				yield* apply(
					m,
					{ snapshot: g.snapshot, folders: [...folders] },
					checkedAdmission(installation, substrate.admin)
				)
			}
			previous = fromSnapshot(g.snapshot)
		}
		const last = history.versions[history.versions.length - 1]
		/** The committed snapshot.json: the last folder's, which a draft that changes nothing keeps. */
		const committed = drafted[drafted.length - 1]
		if (last === undefined || committed === undefined) {
			throw new Error(`the history of ${history.label} drafts a folder`)
		}
		const snapshot = committed.snapshot

		yield* Effect.scoped(
			Effect.gen(function* () {
				const schema = yield* substrate.schema({ create: false, label: `${history.label}_fresh` })
				const fresh = compiledAt(last, schema, owner, codebookOf(snapshot))
				yield* transaction(substrate.admin, installationSql(fresh))
				yield* sameCatalog(
					compiledAt(last, name, owner, codebookOf(snapshot)),
					fresh,
					`${history.label}: the migrated history against a fresh install`
				)
				const installed = yield* installMigrated(last.desc, {
					ambient: ordinarySession,
					label: `${history.label}_installer`,
					logins: last.logins(last.desc.name),
					extensions: []
				})
				assert.ok(
					runsInstallScript(installed.folders[0], installed.installation),
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

		/** Db.open of every role of the last version's logins, each login's layer given the committed snapshot. */
		const installation = compiledAt(last, name, owner, codebookOf(snapshot))
		for (const login of last.logins(name)) {
			const installedLogin = Option.getOrThrowWith(
				Arr.findFirst(installation.worlds, (l) => l.name === login.name),
				() => new Error(`the installation's login ${login.name}`)
			)
			const credentials = yield* substrate.login(installedLogin.role)
			const loginLayer = DbLayer.make({
				...clusterConnection(substrate.cluster, substrate.database, credentials.password),
				pool: clusterPool,
				login,
				snapshot: snapshotJson(committed.snapshotText),
				verify: testVerify
			})
			for (const role of Rec.values(login.roles)) {
				yield* Effect.scoped(
					Effect.flatMap(Layer.build(loginLayer), (context) =>
						Effect.provideContext(Effect.asVoid(Db.open(role, { token: tokenOf({}) })), context)
					)
				)
			}
		}
	}).pipe(Effect.scoped)

const historyGen: Gen<History> = element(histories)

layer(Substrate.layer)("the worked examples migrate version by version", (it) => {
	it.effect(
		"every history: every apply admitted and checked, the history the fresh install and the installer agree, the ledger complete and Db.open admits every role",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						/** Every history, each its own case: a history drafts, applies and compares at most four versions and opens every role
						 * of the last. */
						suite: "pg/migrate/fixtures",
						generator: historyGen,
						literal: (history: History) => history.label,
						limit: histories.length,
						coverage: requiredInSpace<HistoryLabel>(historyLabels),
						caseHang
					},
					(history, c) => {
						c.note(history.label)
						return migrates(history)
					}
				)
			)
	)
})
