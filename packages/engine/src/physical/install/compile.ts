import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { appendAll } from "#compiler/core/array.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import {
	censusOf,
	DeclaredNamespace,
	type Identity,
	identifierOf,
	maxIdentifierBytes
} from "#compiler/core/identity.ts"
import type { IdentityKind } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { type Codebook, firstCodebook } from "#compiler/ir/codes.ts"
import type { IndexRequest, InstallationManifest } from "#compiler/ir/products.ts"
import type { LivePlan } from "#compiler/live/notify.ts"
import { addAdvanceFunctions } from "#compiler/physical/ddl/advance.ts"
import { addClosedRelations, addRosters } from "#compiler/physical/ddl/constants.ts"
import { InstallBuilder, type InstallSettings } from "#compiler/physical/ddl/context.ts"
import {
	addContractDomains,
	addOutsideContractDomains,
	addParamDomains,
	addTextDomains,
	type ParamContract,
	type ParamDomainUse,
	type TextDomain
} from "#compiler/physical/ddl/domains.ts"
import { readCommittedRelations } from "#compiler/physical/ddl/isolation.ts"
import { addLiveSource } from "#compiler/physical/ddl/live.ts"
import { addUnitFunctions } from "#compiler/physical/ddl/retire.ts"
import { addWorlds, grantedPrivileges, type InstalledLogin } from "#compiler/physical/ddl/roles.ts"
import { addRules } from "#compiler/physical/ddl/rules.ts"
import { addTables } from "#compiler/physical/ddl/tables.ts"
import {
	type PlannedIndex,
	planIndexes,
	reverseRequests
} from "#compiler/physical/indexes/engine.ts"
import { commentsOf } from "#compiler/physical/install/comments.ts"
import type {
	InstallExtension,
	LoginFence,
	RoleOfLogin
} from "#compiler/physical/install/extension.ts"
import {
	freshPlanSettings,
	type InstallBasis,
	conservativeBasis,
	installBasis,
	type InstallPlan,
	type ParamSource,
	planInstallation
} from "#compiler/physical/install/plan.ts"
import { refinedConstantsExtension } from "#compiler/physical/refined/constants.ts"
import { addSpanStorage } from "#compiler/physical/span/storage.ts"
import { planStatistics, type StatisticsRequest } from "#compiler/physical/statistics/statistics.ts"
import { type Owned, ownedIdentities, rostersOf } from "#compiler/schema/own.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"

/** The settings the installation runs under (`InstallSettings`: the owner a fresh-install script names, undefined for
 * a migration; the PostgreSQL schema; the vector extension's and btree_gist's schemas; the logins over the schema), the
 * extensions it runs, in order, and the codes of the installation it compiles for. Index requests beyond the
 * law-maintenance ones come from an extension's contribution, as the workload's do (`workloadExtension`). */
export interface InstallOptions extends InstallSettings {
	readonly extensions: ReadonlyArray<InstallExtension>
	/** The installation's codes: every code a literal, a constant or a domain's CHECK holds, and every bit(n) width. */
	readonly codes: Codebook
}

/** The options of a fresh installation of `owned` under its declared name's identity, owned.installation, with the
 * vector extension in vector_ext and btree_gist in public (the local cluster's), no login, no extension beyond the
 * built-in ones, and the first codebook, each roster's handles numbered from 0 with no hole, as `owner` names it. A
 * caller that targets another schema, installs logins, adds extensions or compiles for an installation with a history
 * of codes states them over these. */
export const installOptions = (owned: Owned, owner: string | undefined): InstallOptions => {
	const fresh = freshPlanSettings(owned)
	return {
		owner,
		levels: fresh.levels,
		vectorSchema: fresh.vectorSchema,
		extensionSchema: "public",
		logins: fresh.logins,
		extensions: [],
		codes: firstCodebook(rostersOf(owned))
	}
}

/** An installation: its plan (physical/install/plan.ts InstallPlan), under the settings it was admitted with, and the
 * objects built from it. */
export interface Installation extends InstallPlan {
	readonly settings: InstallSettings
	readonly manifest: InstallationManifest<SqlStatement>
	/** The install script: every object's DDL in install order, then the PUBLIC revokes, the logins' defaults and every
	 * installed object's COMMENT. */
	readonly statements: ReadonlyArray<SqlStatement>
	readonly textDomains: ReadonlyArray<TextDomain>
	readonly indexes: ReadonlyArray<PlannedIndex>
	/** The logins and their roles, in name order. */
	readonly worlds: ReadonlyArray<InstalledLogin>
	/** Every identity the installation named an object by, ownership's, the law model's and the installer's, each as
	 * often as it was minted: the census its comments passed. */
	readonly identities: ReadonlyArray<Identity<IdentityKind>>
	/** What this installation leaves to other packages' extensions: its materialized derived relations no extension
	 * installs. */
	readonly deferred: {
		readonly derivedRelations: ReadonlyArray<string>
	}
	/** Each role of each login with its certificate, in login then role order: the level its writes begin at, and what
	 * each table's guard trigger is installed by (physical/ddl/isolation.ts readCommittedRelations). */
	readonly certification: ReadonlyArray<CertifiedRole>
	/** The live plan its extensions state, one (liveOf), whose footprint tables its live source publishes. */
	readonly live: LivePlan
}

/** A role's certificate as an installation holds it: its login, its name, and its level, the one fact of a certificate
 * (analysis/isolation/certify.ts RoleIsolation) the installation and its readers read. */
export interface CertifiedRole {
	readonly login: string
	readonly role: string
	readonly certificate: { readonly level: Isolation }
}

/** Each role of the plan's logins, in login then role order. */
const installedRoles = (plan: InstallPlan): ReadonlyArray<RoleOfLogin> =>
	plan.logins.flatMap(({ login, roles }) =>
		roles.map(({ checked }) => ({ login: login.name, role: checked.world.role.name }))
	)

/**
 * `stated`, what the extensions state of roles, `what` each, once each of a role `installed` holds: one stated twice,
 * or of a role the plan does not install, is a defect of the caller that compiled the workload over other logins than
 * the installation's.
 */
const statedOnce = <R extends RoleOfLogin>(
	installed: ReadonlyArray<RoleOfLogin>,
	stated: ReadonlyArray<R>,
	what: string
): ReadonlyArray<R> => {
	for (const c of stated) {
		const same = stated.filter((d) => d.login === c.login && d.role === c.role)
		if (same.length > 1 || !installed.some((r) => r.login === c.login && r.role === c.role)) {
			throw defect(`one ${what} of role ${c.role} of login ${c.login}, a role it installs`)
		}
	}
	return stated
}

/**
 * The fences the extensions state, each login's once, of a login the plan installs: one stated twice, or of a login the
 * plan does not install, is a defect of the caller that compiled the workload over other logins than the
 * installation's.
 */
const fencedOnce = (
	plan: InstallPlan,
	stated: ReadonlyArray<LoginFence>
): ReadonlyArray<LoginFence> => {
	for (const f of stated) {
		if (
			stated.filter((g) => g.login === f.login).length > 1 ||
			!plan.logins.some(({ login }) => login.name === f.login)
		) {
			throw defect(`one fence statement of login ${f.login}, a login it installs`)
		}
	}
	return stated
}

/**
 * Each role of the plan's logins at the level its certificate states, in login then role order: the certificate the
 * served workload's extension states for it (physical/access/extension.ts servedWorkloadExtension), which certified it
 * over every login's change members (program/isolation/certification.ts), or SERIALIZABLE where no extension states
 * one, as an installation with no served workload holds its roles, so their tables keep their guards. Each is stated
 * once, of a role the plan installs (statedOnce).
 */
const certificationOf = (
	plan: InstallPlan,
	extensions: ReadonlyArray<InstallExtension>
): ReadonlyArray<CertifiedRole> => {
	const installed = installedRoles(plan)
	const stated = statedOnce(
		installed,
		extensions.flatMap((e) => e.certifies),
		"certificate"
	)
	return installed.map((r): CertifiedRole => ({
		...r,
		certificate: {
			level:
				stated.find((c) => c.login === r.login && c.role === r.role)?.certificate.level ??
				"serializable"
		}
	}))
}

/**
 * The one live plan of `extensions`: none where none of them serves a read; otherwise each footprint table any of them
 * states, once, by relation in code point order, with every field any of them routes it by, once, in code point order,
 * and each materialized view any of them reads, once, in code point order.
 */
const liveOf = (extensions: ReadonlyArray<InstallExtension>): LivePlan => {
	const plans = extensions.flatMap((e) => (e.live.kind === "reads" ? [e.live] : []))
	if (plans.length === 0) {
		return { kind: "none" }
	}
	const routes = new Map<string, Set<string>>()
	for (const table of plans.flatMap((plan) => plan.tables)) {
		const held = routes.get(table.relation) ?? new Set<string>()
		for (const field of table.routes) {
			held.add(field)
		}
		routes.set(table.relation, held)
	}
	return {
		kind: "reads",
		tables: [...routes]
			.toSorted(([a], [b]) => compareStrings(a, b))
			.map(([relation, fields]) => ({ relation, routes: [...fields].toSorted(compareStrings) })),
		views: [...new Set(plans.flatMap((plan) => plan.views))].toSorted(compareStrings)
	}
}

/**
 * A schema identifier the installation may create: a plain lowercase identifier, at most maxIdentifierBytes, outside
 * pg_.
 */
const admittedSchema = (name: string): boolean => {
	if (name.length === 0 || name.length > maxIdentifierBytes.value || name.startsWith("pg_")) {
		return false
	}
	for (let i = 0; i < name.length; i++) {
		const ch = name.charAt(i)
		const lower = ch >= "a" && ch <= "z"
		if (!(lower || ch === "_" || (i > 0 && ch >= "0" && ch <= "9"))) {
			return false
		}
	}
	return true
}

/** The installation of an owned schema, under the policy it was owned under, for the installation that holds
 * `options.codes`: the obligation graph of every native object, each with its DDL, its reasons and its phase, in a
 * deterministic install order; the manifest; the planned indexes with their merged provenance; and the install script,
 * its statements as SQL trees, printed only where they are sent or drafted. It is pure: no database, no clock, no file.
 *
 * The steps follow the dependency order: the namespace and the refusal function every write statement that can refuse
 * raises through; the isolation default and guard; each roster's names constant and domains and each closed
 * relation's constants (physical/ddl/constants.ts), the structural text domains and the contract domains;
 * the tables with their identities; the tags, keys, CHECKs and references the law model specialized; the shape, width
 * and contract-endpoint CHECKs of every span column (`addSpanStorage`), which every installation carries because a span's
 * storage is never optional; the validation of every closed payload with a nontrivial refinement
 * (`refinedConstantsExtension`), which every installation carries because the compiler relies on a closed fact's
 * membership only once PostgreSQL has validated it; then the caller's extensions; then the law-maintenance and workload
 * indexes, deduplicated against the key indexes; then, in Publish, the worlds: the logins, their roles with their
 * schemas, views, grants and policies, the logins' defaults, and the PUBLIC revokes. An extension of btree_gist precedes
 * any span key or GiST index with a scalar component.
 *
 * Every constraint it installs, with the law a violation reports, is its plan's (InstallPlan.constraintLaws), which no
 * extension adds to. A derived relation that no extension claims is
 * reported in `deferred`: the natives are installed, and the caller decides whether the installation is complete
 * enough for its purpose.
 *
 * The script is one transaction run as the migration identity, the owner; on a fresh schema every table is empty, so
 * ordinary CREATE INDEX serves. */
export const compileInstallation = (
	owned: Owned,
	options: InstallOptions
): Result.Result<Installation, CompileError> =>
	Result.flatMap(installBasis(owned, options.codes, everySlice(owned)), (basis) =>
		installationOver(basis, options)
	)

/**
 * The law oracle's conservative installation of `owned`: compileInstallation's under `options`, over the law model that
 * discharges every rule over a query by its deferred constraint triggers (laws/model/model.ts conservativeLaws), a rule
 * that lowers to foreign keys among them, as the write oracle's conservative realization keeps every boundary the
 * optimized artifact elides. Its laws are the installation's laws under the same identities, so a write each
 * installation refuses names one law through its own constraint map. No generate, snapshot or served artifact reads it.
 */
export const conservativeInstallation = (
	owned: Owned,
	options: InstallOptions
): Result.Result<Installation, CompileError> =>
	Result.flatMap(conservativeBasis(owned, options.codes, everySlice(owned)), (basis) =>
		installationOver(basis, options)
	)

/** The settings of `options`, refused unless every schema identifier it names is one the installation may create, the
 * installed schema's being the naming door's, the extension schema lies outside the installed schema, which it outlives,
 * every login is over the installed schema, and the logins' and their roles' names convert apart: each one's
 * PostgreSQL role is `<schema>__<name>`, so they are one namespace of declared names (IdentifierCollision). */
const admittedSettings = (
	owned: Owned,
	options: InstallSettings
): Result.Result<InstallSettings, CompileError> => {
	const at = SourceLoc(`installation of schema ${owned.name}`, [])
	const settings: InstallSettings = {
		owner: options.owner,
		levels: options.levels,
		vectorSchema: options.vectorSchema,
		extensionSchema: options.extensionSchema,
		logins: options.logins
	}
	for (const [what, name] of [
		...(settings.owner === undefined ? [] : [["owner", settings.owner] as const]),
		["vector schema", settings.vectorSchema],
		["extension schema", settings.extensionSchema]
	] as const) {
		if (!admittedSchema(name)) {
			return Result.err(
				malformedDescription(
					at,
					`an admitted ${what} identifier; ${JSON.stringify(name)} is not one`
				)
			)
		}
	}
	if (settings.levels.length !== owned.levels.length) {
		return Result.err(
			malformedDescription(
				at,
				`a PostgreSQL schema for each of the ${owned.levels.length} levels of ${owned.name}; ${settings.levels.length} are given`
			)
		)
	}
	if (settings.levels.some((l) => identifierOf(l) === settings.extensionSchema)) {
		return Result.err(
			malformedDescription(
				at,
				"an extension schema outside the installed schemas, which outlives them"
			)
		)
	}
	const roles = new DeclaredNamespace(`the installation ${owned.name}'s login and role`)
	for (const login of settings.logins) {
		const level = owned.levels[login.base.levels.length - 1]
		if (
			level === undefined ||
			level.fingerprint !== login.base.fingerprint ||
			level.name !== login.base.name
		) {
			return Result.err(
				malformedDescription(
					login.loc,
					`a login over a level of the installed schema ${owned.name}; login ${login.name} is over ${login.base.name}`
				)
			)
		}
		const named = [
			roles.declare(login.name, "login", login.loc),
			...login.roles.map((r) => roles.declare(r.name, "role", r.loc))
		]
		for (const n of named) {
			if (!n.ok) {
				return n
			}
		}
	}
	return Result.ok(settings)
}

/**
 * The types the programs `extensions` serve cast their parameters to over the installation's checked schema `checked`
 * (InstallExtension.params), every extension's once: what an installation plans from its served programs' declarations
 * (physical/install/plan.ts ParamSource `planned`).
 */
const servedParams = (
	extensions: ReadonlyArray<InstallExtension>,
	checked: CheckedSchema
): Result.Result<ParamSource, CompileError> =>
	catchRefusal((): ParamSource => {
		const domains: Array<ParamDomainUse> = []
		const contracts: Array<ParamContract> = []
		for (const extension of new Set(extensions)) {
			const types = extension.params(checked)
			if (!types.ok) {
				throw new Refusal(types.error)
			}
			appendAll(domains, types.value.domains)
			appendAll(contracts, types.value.contracts)
		}
		return { kind: "planned", types: { domains, contracts } }
	})

/** The plan of the installation over `basis` under `settings` with `extensions`, the types their served programs cast
 * their parameters to among it (servedParams). */
const servedPlan = (
	basis: InstallBasis,
	settings: InstallSettings,
	extensions: ReadonlyArray<InstallExtension>
): Result.Result<InstallPlan, CompileError> =>
	Result.flatMap(servedParams(extensions, basis.model.checked), (params) =>
		planInstallation(basis, settings, extensions, params)
	)

/**
 * The installation over a basis (installBasis) under the settings and extensions of `options`, whose codes are the
 * basis's (compileInstallation): its settings admitted, its plan (planInstallation) with the types its extensions'
 * served programs cast their parameters to (servedParams), then its objects built from the plan, those parameters'
 * pattern domains and contracts' domains among them. The span CHECKs (`addSpanStorage`) and the closed facts'
 * validation (`refinedConstantsExtension`) precede the caller's extensions, each once: a caller that lists one
 * extension twice adds nothing twice.
 */
export const installationOver = (
	basis: InstallBasis,
	options: Omit<InstallOptions, "codes">
): Result.Result<Installation, CompileError> =>
	Result.flatMap(admittedSettings(basis.owned, options), (settings) =>
		Result.flatMap(servedPlan(basis, settings, options.extensions), (plan) =>
			catchRefusal((): Installation => {
				const { owned, model, planned } = basis
				const certification = certificationOf(plan, options.extensions)
				const levelOf = (login: string, role: string) =>
					defined(
						certification.find((c) => c.login === login && c.role === role),
						`the certificate of role ${role} of login ${login}`
					).certificate.level
				const b = new InstallBuilder({
					owned,
					checked: plan.checked,
					model,
					names: plan.names,
					settings,
					readCommitted: readCommittedRelations(
						plan.logins.flatMap(({ login, roles }) =>
							roles.map(({ checked }) => ({
								level: levelOf(login.name, checked.world.role.name),
								privileges: grantedPrivileges(model, checked)
							}))
						)
					)
				})
				const rosters = addRosters(b)
				addClosedRelations(b, planned)
				const domains = [
					...rosters.flatMap((r) =>
						r.bits === undefined ? [r.domain.name] : [r.domain.name, r.bits.domain.name]
					),
					...addTextDomains(b, plan.textPlans),
					...addContractDomains(b),
					...addOutsideContractDomains(b, plan.outsideContracts)
				]
				const { keyIndexes, tables, sequences } = addTables(b)
				const advance = addAdvanceFunctions(b)
				const units = addUnitFunctions(b)
				const ruleRequests = addRules(b)
				addSpanStorage(b, plan.spans)

				const claimedDerived = new Set<string>()
				const extensionRequests: Array<IndexRequest> = []
				const statisticsRequests: Array<StatisticsRequest> = []
				for (const extension of new Set([refinedConstantsExtension, ...options.extensions])) {
					const contribution = extension.contribute(b)
					if (!contribution.ok) {
						throw new Refusal(contribution.error)
					}
					const c = contribution.value
					appendAll(extensionRequests, c.indexRequests)
					appendAll(statisticsRequests, c.statisticsRequests)
					for (const d of c.derivedRelations) {
						claimedDerived.add(d)
					}
				}
				const paramDomains = addParamDomains(b, plan.paramDomains)

				const requests = [...reverseRequests(b), ...ruleRequests, ...extensionRequests]
				const indexes = planIndexes(b, keyIndexes, requests)
				if (!indexes.ok) {
					throw new Refusal(indexes.error)
				}
				planStatistics(b, statisticsRequests)

				const live = liveOf(options.extensions)
				const worlds = addWorlds(
					b,
					advance,
					units,
					{ tables, sequences, domains: [...domains, ...paramDomains] },
					plan.logins,
					statedOnce(
						installedRoles(plan),
						options.extensions.flatMap((e) => e.carriers),
						"carrier statement"
					),
					options.extensions.flatMap((e) => e.holds),
					fencedOnce(
						plan,
						options.extensions.flatMap((e) => e.fences)
					)
				)
				addLiveSource(b, live)
				const identities = [...ownedIdentities(owned), ...model.identities, ...b.named()]
				const census = censusOf(identities)
				if (!census.ok) {
					throw new Refusal(census.error)
				}
				const ordered = b.graph.manifest({
					roleDefaults: worlds.roleDefaults,
					publicRevokes: worlds.publicRevokes
				})
				const created = ordered.objects.flatMap((o) => o.ddl)
				const comments = commentsOf(created, census.value)
				const manifest = { ...ordered, comments }
				const statements = [
					...created,
					...worlds.publicRevokes,
					...worlds.roleDefaults,
					...comments
				]
				const derived = Object.values(owned.relations)
					.filter((r) => r.kind === "derived" && r.view.kind === "materialized")
					.map((r) => r.name)
				return {
					...plan,
					settings,
					manifest,
					statements,
					textDomains: plan.textPlans.map((p) => p.domain),
					indexes: indexes.value,
					worlds: worlds.worlds,
					identities,
					deferred: {
						derivedRelations: derived.filter((d) => !claimedDerived.has(d)).toSorted(compareStrings)
					},
					certification,
					live
				}
			})
		)
	)
