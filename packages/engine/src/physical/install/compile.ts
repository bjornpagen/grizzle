import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { isAsciiDigit } from "@bjornpagen/grizzle-text/text"
import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { catchRefusal, KeyLedger, unwrap } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { maxIdentifierBytes } from "#compiler/core/identity.ts"
import {
	censusOf,
	DeclaredNamespace,
	type Identity,
	identifierOf
} from "#compiler/core/identity.ts"
import type { IdentityKind, LawId } from "#compiler/core/ids.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { type Phases, phased } from "#compiler/core/phase.ts"
import { type Codebook, firstCodebook } from "#compiler/ir/codes.ts"
import type { LibraryFn } from "#compiler/ir/physical.ts"
import type { AccessPath, IndexRequest, InstallationManifest } from "#compiler/ir/products.ts"
import type { RegexRef } from "#compiler/ir/scalar.ts"
import type { LivePlan } from "#compiler/live/notify.ts"
import { installCatalog } from "#compiler/physical/access/catalog.ts"
import { pathOf } from "#compiler/physical/access/paths.ts"
import { addClockGuards } from "#compiler/physical/ddl/clocked.ts"
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
import { addFunctions } from "#compiler/physical/ddl/functions.ts"
import { addImmutableGuards } from "#compiler/physical/ddl/immutable.ts"
import { readCommittedRelations } from "#compiler/physical/ddl/isolation.ts"
import { addLibrary } from "#compiler/physical/ddl/library.ts"
import { addLiveSource } from "#compiler/physical/ddl/live.ts"
import { addDataStepRecheck, type DataStepRecheck } from "#compiler/physical/ddl/recheck.ts"
import { addWorlds, grantedPrivileges, type InstalledLogin } from "#compiler/physical/ddl/roles.ts"
import { addRules, routineRequests } from "#compiler/physical/ddl/rules.ts"
import { addSeals } from "#compiler/physical/ddl/seal.ts"
import { addStamps } from "#compiler/physical/ddl/stamps.ts"
import { addTables } from "#compiler/physical/ddl/tables.ts"
import { addVariants } from "#compiler/physical/ddl/variants.ts"
import { wholeTables } from "#compiler/physical/ddl/whole.ts"
import { storedTablesExtension } from "#compiler/physical/derived/objects.ts"
import {
	type IndexSet,
	type PlannedIndex,
	planIndexes,
	reverseRequests
} from "#compiler/physical/indexes/engine.ts"
import type { IndexRef, IndexResolver, IndexServing } from "#compiler/physical/indexes/ref.ts"
import { commentsOf } from "#compiler/physical/install/comments.ts"
import type {
	InstallExtension,
	LoginFence,
	RoleOfLogin,
	ServedProgram
} from "#compiler/physical/install/extension.ts"
import {
	freshPlanSettings,
	type InstallBasis,
	type InstallPlan,
	type ParamSource,
	planInstallation
} from "#compiler/physical/install/plan.ts"
import { assertCreatesOwned } from "#compiler/physical/obligations/created.ts"
import { refinedConstantsExtension } from "#compiler/physical/refined/constants.ts"
import { addSpanStorage } from "#compiler/physical/span/storage.ts"
import { type Owned, ownedIdentities, rostersOf } from "#compiler/schema/own.ts"
import { printAdvice } from "#compiler/sql/advice.ts"
import type { ObjectName, OperandSelect, SqlStatement } from "#compiler/sql/ast.ts"
import { nameKey } from "#compiler/sql/ast.ts"
import { bindRoutine, type ReadCatalog } from "#compiler/sql/bind.ts"
import { AdviceScope } from "#compiler/sql/naming.ts"
import { planRequests, type ReadPlan, resolvePlan } from "#compiler/sql/plan.ts"

/** The settings the installation runs under (`InstallSettings`: the PostgreSQL schema; the vector extension's and
 * btree_gist's schemas; the logins over the schema), the
 * extensions it runs, in order, and the codes of the installation it compiles for. Index requests beyond the
 * law-maintenance ones come from an extension's contribution, as the workload's do (`workloadExtension`). */
export interface InstallOptions extends InstallSettings {
	readonly extensions: ReadonlyArray<InstallExtension>
	/** The installation's codes: every code a literal, a constant or a domain's CHECK holds, and every bit(n) width. */
	readonly codes: Codebook
}

/** The options of a fresh installation of `owned` under its declared name's identity, owned.installation, with the
 * vector extension in vector_ext and btree_gist in public (the local cluster's), no login, no extension beyond the
 * built-in ones, and the first codebook, each roster's handles numbered from 0 with no hole. A caller that targets
 * another schema, installs logins, adds extensions or compiles for an installation with a history of codes states them
 * over these. */
export const installOptions = (owned: Owned): InstallOptions => {
	const fresh = freshPlanSettings(owned)
	return {
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
	/** The install script: every object's DDL in install order, each table created whole (physical/ddl/whole.ts
	 * wholeTables), as a first migration creates it, then the PUBLIC revokes, the logins' defaults and every installed
	 * object's COMMENT. */
	readonly statements: ReadonlyArray<SqlStatement>
	readonly textDomains: ReadonlyArray<TextDomain>
	readonly indexes: ReadonlyArray<PlannedIndex>
	/** Its indexes as coverage reads them (physical/indexes/engine.ts IndexSet), which its snapshot records; their
	 * resolver (engine.ts resolverOf), the one every compile of a read against the installation resolves it by; and its
	 * partial form (engine.ts servingOf), what a migration's data step reads through, its requests planned no index. */
	readonly indexSet: IndexSet
	readonly resolve: IndexResolver
	readonly serving: IndexServing
	/**
	 * What a statement bound against the installation reads of it (sql/bind.ts ReadCatalog): each stored table, its keys
	 * and the columns a B-tree holds, each role's view; the one catalog its routines are bound over, and a migration's
	 * data steps.
	 */
	readonly catalog: ReadCatalog
	/**
	 * Every routine the installation installs, each bound under a scope of its own (sql/bind.ts bindRoutine): its name;
	 * the plan of its statements, every index it reads through resolved, which its advice is printed from (CreateFunction
	 * `advice`); and each query PL/pgSQL hands the planner, in body order, every PL/pgSQL name it reads a typed
	 * placeholder `$n::<type>` (BoundRoutine `planned`), what the plan laws plan the routine by.
	 */
	readonly routines: ReadonlyArray<{
		readonly fn: ObjectName
		readonly plan: ReadPlan<IndexRef>
		readonly planned: ReadonlyArray<string>
	}>
	/** The logins and their roles, in name order. */
	readonly worlds: ReadonlyArray<InstalledLogin>
	/** Every identity the installation named an object by, ownership's, the law model's and the installer's, each as
	 * often as it was minted: the census its comments passed. */
	readonly identities: ReadonlyArray<Identity<IdentityKind>>
	/** Each role of each login with its certificate, in login then role order: the level its writes begin at, and what
	 * each table's guard trigger is installed by (physical/ddl/isolation.ts readCommittedRelations). */
	readonly certification: ReadonlyArray<CertifiedRole>
	/** The live plan its extensions state, one (liveOf), whose footprint tables its live source publishes. */
	readonly live: LivePlan
	/**
	 * Each rule over a query's check over every row, by its law (physical/ddl/rules.ts addRules): the judge's statements
	 * over the transaction that writes every row, which the migration that adds the rule runs once (deploy/snapshot
	 * violation.ts lawChecks).
	 */
	readonly ruleChecks: ReadonlyMap<LawId, OperandSelect>
	/**
	 * Each served program's access paths, by its login and its name, every read its bound statements make
	 * (physical/access/paths.ts pathOf), which the installation asked an index for: what the snapshot records of a
	 * program (program/workload/compile.ts servedAccess), and `grizzle check` compares.
	 */
	readonly programAccess: ReadonlyArray<{
		readonly login: string
		readonly program: string
		readonly paths: ReadonlyArray<AccessPath>
	}>
	/**
	 * The re-check a data step runs after its statements (physical/ddl/recheck.ts), none where no rule and no stored
	 * relation reads a closed relation: what a draft's Structure runs after the reviewer's data step
	 * (deploy/diff/diff.ts structure.recheck), and the body of the function a custom migration's data step calls.
	 */
	readonly recheck: DataStepRecheck | undefined
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
			defect(`one ${what} of role ${c.role} of login ${c.login}, a role it installs`)
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
			defect(`one fence statement of login ${f.login}, a login it installs`)
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
 * states, once, by relation in code point order, with every field any of them routes it by, once, in code point order.
 */
const liveOf = (extensions: ReadonlyArray<InstallExtension>): LivePlan => {
	const plans = extensions.flatMap((e) => (e.live.kind === "reads" ? [e.live] : []))
	if (plans.length === 0) {
		return { kind: "none" }
	}
	const routes = new Map<string, Set<string>>()
	for (const table of plans.flatMap((plan) => plan.tables)) {
		const held = routes.getOrInsertComputed(table.relation, () => new Set<string>())
		for (const field of table.routes) {
			held.add(field)
		}
	}
	return {
		kind: "reads",
		tables: [...routes]
			.toSorted(([a], [b]) => compareStrings(a, b))
			.map(([relation, fields]) => ({ relation, routes: [...fields].toSorted(compareStrings) }))
	}
}

/**
 * A schema identifier the installation may create: a plain lowercase identifier, at most maxIdentifierBytes, outside
 * pg_.
 */
const admittedSchema = (name: string): boolean => {
	if (name.length === 0 || name.length > maxIdentifierBytes || name.startsWith("pg_")) {
		return false
	}
	for (let i = 0; i < name.length; i++) {
		const ch = name.charAt(i)
		const lower = ch >= "a" && ch <= "z"
		if (!(lower || ch === "_" || (i > 0 && isAsciiDigit(ch.charCodeAt(0))))) {
			return false
		}
	}
	return true
}

/** The settings of `options`, refused unless every schema identifier it names is one the installation may create, the
 * installed schema's being the naming door's, the extension schema lies outside the installed schema, which it outlives,
 * every login is over the installed schema, and the logins' and their roles' names convert apart: each one's
 * PostgreSQL role is `<schema>__<name>`, so they are one namespace of declared names (IdentifierCollision). */
export const admittedSettings = (
	owned: Owned,
	options: InstallSettings
): Result.Result<InstallSettings, CompileError> => {
	const at = SourceLoc(`installation of schema ${owned.name}`, [])
	const settings: InstallSettings = {
		levels: options.levels,
		vectorSchema: options.vectorSchema,
		extensionSchema: options.extensionSchema,
		logins: options.logins
	}
	for (const [what, name] of [
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
	const roles = DeclaredNamespace.of(`the installation ${owned.name}'s login and role`)
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
 * The types the programs `extensions` serve name over the installation's checked schema `checked`
 * (InstallExtension.params), every extension's once: what an installation plans from its served programs
 * (physical/install/plan.ts ParamSource `planned`).
 */
const servedParams = (
	extensions: ReadonlyArray<InstallExtension>,
	checked: CheckedSchema
): Result.Result<ParamSource, CompileError> =>
	catchRefusal((): ParamSource => {
		const domains: Array<ParamDomainUse> = []
		const contracts: Array<ParamContract> = []
		const typed: Array<ParamContract> = []
		const texts: Array<RegexRef> = []
		const library: Array<LibraryFn> = []
		for (const extension of new Set(extensions)) {
			const types = unwrap(extension.params(checked))
			appendAll(domains, types.domains)
			appendAll(contracts, types.contracts)
			appendAll(typed, types.typed)
			appendAll(texts, types.texts)
			appendAll(library, types.library)
		}
		return { kind: "planned", types: { domains, contracts, typed, texts, library } }
	})

/** The plan of the installation over `basis` under `settings` with `extensions`, the types their served programs cast
 * their parameters to among it (servedParams), a phase reported to `phases` (`installPlan`). */
export const servedPlan = (
	basis: InstallBasis,
	settings: InstallSettings,
	extensions: ReadonlyArray<InstallExtension>,
	phases: Phases
): Result.Result<InstallPlan, CompileError> =>
	phased(phases, { name: "installPlan", of: [] }, () =>
		Result.flatMap(servedParams(extensions, basis.model.checked), (params) =>
			planInstallation(basis, settings, params)
		)
	)

/**
 * The installation of `plan` (servedPlan) over `basis` under `options` and its admitted `settings`
 * (admittedSettings), the last step of an installation's compile (program/install.ts installationOver): its objects
 * built from the plan, those parameters' pattern domains and contracts' domains among them. The span CHECKs
 * (`addSpanStorage`) and the closed facts' validation (`refinedConstantsExtension`) precede the caller's extensions,
 * each once: a caller that lists one extension twice adds nothing twice. Each index it judges refused goes in `keys`;
 * its rules' checks and its index plan are phases reported to `phases` (`judge`, `indexes`).
 */
export const installationOfPlan = (
	basis: InstallBasis,
	options: Omit<InstallOptions, "codes">,
	settings: InstallSettings,
	plan: InstallPlan,
	keys: KeyLedger,
	phases: Phases
): Result.Result<Installation, CompileError> =>
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
			library: plan.library,
			keys,
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
		const variants = addVariants(b)
		addClosedRelations(b, planned)
		addLibrary(b)
		const domains = [
			b.names.digestDomain,
			...rosters.flatMap((r) =>
				r.bits === undefined ? [r.domain.name] : [r.domain.name, r.bits.domain.name]
			),
			...addTextDomains(b, plan.textPlans),
			...addContractDomains(b),
			...addOutsideContractDomains(b, plan.outsideContracts),
			...variants.map((v) => v.domain)
		]
		const declared = addFunctions(b)
		const { keyIndexes, tables } = addTables(b)
		const stamps = addStamps(b)
		addClockGuards(b)
		addImmutableGuards(b)
		addSeals(b)
		addSpanStorage(b, plan.spans)

		const extensionRequests: Array<IndexRequest> = []
		const programs: Array<ServedProgram> = []
		for (const extension of new Set([
			refinedConstantsExtension,
			...options.extensions,
			storedTablesExtension
		])) {
			const contribution = unwrap(extension.contribute(b))
			appendAll(extensionRequests, contribution.indexRequests)
			appendAll(programs, contribution.programs)
		}
		/** The judge after the extensions, whose stored derived relations' tables its upkeep writes and its captures
		 * stand on. */
		const rules = phased(phases, { name: "judge", of: [] }, () => addRules(b))
		const recheck = addDataStepRecheck(b, rules.checks)
		const paramDomains = addParamDomains(b, plan.paramDomains)

		const live = liveOf(options.extensions)
		const worlds = addWorlds(
			b,
			stamps,
			{ tables, domains: [...domains, ...paramDomains] },
			plan.logins,
			statedOnce(
				installedRoles(plan),
				options.extensions.flatMap((e) => e.carriers),
				"carrier statement"
			),
			{ calls: options.extensions.flatMap((e) => e.calls), declared },
			fencedOnce(
				plan,
				options.extensions.flatMap((e) => e.fences)
			),
			rules.standUps
		)
		addLiveSource(b, live)
		/**
		 * Every routine the installation installs, each bound under a scope of its own over the installation's catalog
		 * (sql/bind.ts bindRoutine): what each reads, the one derivation of the requests its reads make, a judge's
		 * function's asked as its requester asks them (physical/ddl/rules.ts routineRequests), every other's as the
		 * workload's, and of the advice it is planned under.
		 */
		const catalog = installCatalog(b)
		const routines = new Map(
			b.graph
				.statements()
				.flatMap((s) =>
					s.kind === "createFunction"
						? [[s, bindRoutine(s, new AdviceScope(), catalog)] as const]
						: []
				)
		)
		const routineAsks = [...routines].flatMap(([fn, bound]) => {
			const by = rules.requesters.get(nameKey(fn.name))
			const asked = planRequests(bound.plan)
			return by === undefined ? asked : routineRequests(b, by, asked)
		})
		/** Each served program's paths, every read its bound statements make (write/program/served.ts ServableWrite). */
		const stored = new Set(b.indexedViews().map((v) => v.relation))
		const programAccess = programs.map((p) => ({
			login: p.login,
			program: p.program,
			paths: p.plans.flatMap((read) =>
				planRequests(read).map((r) => pathOf(r, stored.has(r.relation)))
			)
		}))
		const requests = [
			...reverseRequests(b),
			...extensionRequests,
			...routineAsks,
			...programs.flatMap((p) => p.plans.flatMap(planRequests))
		]
		const {
			indexes,
			set: indexSet,
			resolve,
			serving
		} = phased(phases, { name: "indexes", of: [] }, () =>
			unwrap(planIndexes(b, keyIndexes, requests))
		)
		/**
		 * Each routine with its plan resolved, a judge's each read by the law's request its requester asked it as
		 * (`routineAsks`), and its advice printed of it (sql/advice.ts printAdvice).
		 */
		const advised = new Map(
			[...routines].map(([fn, bound]) => {
				const by = rules.requesters.get(nameKey(fn.name))
				const resolved = resolvePlan(
					bound.plan,
					by === undefined
						? resolve
						: (r) =>
								resolve(
									defined(
										routineRequests(b, by, [r])[0],
										`the request of ${fn.name.name}'s read of ${r.relation}, a relation an index serves`
									)
								)
				)
				return [
					fn,
					{
						fn: { ...bound.fn, advice: printAdvice(resolved) },
						plan: resolved,
						planned: bound.planned
					}
				] as const
			})
		)

		const identities = [...ownedIdentities(owned), ...model.identities, ...b.named()]
		const census = unwrap(censusOf(identities))
		const ordered = b.graph.manifest({
			roleDefaults: worlds.roleDefaults,
			publicRevokes: worlds.publicRevokes
		})
		assertCreatesOwned(ordered.objects)
		const objects = ordered.objects.map((o) => ({
			...o,
			ddl: o.ddl.map((s) =>
				s.kind === "createFunction"
					? defined(advised.get(s), `the routine ${s.name.name}, bound`).fn
					: s
			)
		}))
		const created = objects.flatMap((o) => o.ddl)
		const comments = commentsOf(created, census)
		const manifest = { ...ordered, objects, comments }
		const statements = [
			...wholeTables(created),
			...worlds.publicRevokes,
			...worlds.roleDefaults,
			...comments
		]
		return {
			...plan,
			settings,
			manifest,
			statements,
			textDomains: plan.textPlans.map((p) => p.domain),
			indexes,
			indexSet,
			resolve,
			serving,
			catalog,
			routines: [...advised.values()].map((r) => ({
				fn: r.fn.name,
				plan: r.plan,
				planned: r.planned
			})),
			worlds: worlds.worlds,
			identities,
			certification,
			live,
			ruleChecks: rules.checks,
			programAccess,
			recheck
		}
	})
