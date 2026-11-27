/**
 * An installation's compile, the program layer's: what every caller compiles an installation by, over the physical
 * layer's steps (physical/install/compile.ts admittedSettings, servedPlan, installationOfPlan), so it can be compiled
 * over what only the program layer reads.
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { KeyLedger } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { compareIdentities, type Identity } from "#compiler/core/identity.ts"
import type { IdentityKind } from "#compiler/core/ids.ts"
import { type Phases, silentPhases } from "#compiler/core/phase.ts"
import { undischargedLaws } from "#compiler/laws/model/model.ts"
import {
	admittedSettings,
	type Installation,
	installationOfPlan,
	installOptions,
	type InstallOptions,
	servedPlan
} from "#compiler/physical/install/compile.ts"
import {
	basisOf,
	conservativeBasis,
	type InstallBasis,
	installBasis
} from "#compiler/physical/install/plan.ts"
import { lawModel } from "#compiler/program/laws.ts"
import { type Owned, type OwnedRelation, wholeViewOf } from "#compiler/schema/own.ts"
import { orThrow } from "#compiler/schema/protocol.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"

/**
 * The installation over a basis (physical/install/plan.ts installBasis) under the settings and extensions of
 * `options`, whose codes are the basis's (compileInstallation): every law of its theory discharged, its settings
 * admitted (physical/install/compile.ts admittedSettings), its plan (servedPlan: planInstallation with the types its
 * extensions' served programs cast their parameters to), then its objects built from the plan (installationOfPlan),
 * each index it judges refused settled in one key ledger at the end. Its plan, its rules' checks and its index plan
 * are phases reported to `phases` (`installPlan`, `judge`, `indexes`).
 */
export const installationOver = (
	basis: InstallBasis,
	options: Omit<InstallOptions, "codes">,
	phases: Phases
): Result.Result<Installation, CompileError> => {
	const undischarged = undischargedLaws(basis.model)
	if (isNonEmpty(undischarged)) {
		defect(
			`an installation discharges every law of its theory: no native object holds, no migration checks and no rule trigger judges ${undischarged.join(", ")}`
		)
	}
	const keys = new KeyLedger(basis.model.unrepresentable)
	return keys.settle(
		Result.flatMap(admittedSettings(basis.owned, options), (settings) =>
			Result.flatMap(servedPlan(basis, settings, options.extensions, phases), (plan) =>
				installationOfPlan(basis, options, settings, plan, keys, phases)
			)
		)
	)
}

/** The installation of an owned schema, under the policy it was owned under, for the installation that holds
 * `options.codes`: the obligation graph of every native object, each with its DDL, its reasons and its phase, in a
 * deterministic install order; the manifest; the planned indexes with their merged provenance; and the install script,
 * its statements as SQL trees, printed only where they are sent or drafted. It is pure: no database, no clock, no file.
 *
 * The steps follow the dependency order: the namespace and the refusal function every write statement that can refuse
 * raises through; the isolation default and guard; each roster's names constant and domains and each closed
 * relation's constants (physical/ddl/constants.ts), the structural text domains and the contract domains; the declared
 * functions, their row types and their owner (physical/ddl/functions.ts); the tables with their identities; the tags, keys, CHECKs and references the law model specialized; the shape, width
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
	Result.flatMap(installBasis(owned, options.codes, new Set()), (basis) =>
		installationOver(basis, options, silentPhases)
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
	Result.flatMap(conservativeBasis(owned, options.codes), (basis) =>
		installationOver(basis, options, silentPhases)
	)

/** A PostgreSQL identifier an installation names an object by, with the identity it spells out (core/identity.ts
 * Identity `display`). */
export interface InstalledIdentifier {
	readonly identifier: string
	readonly display: string
}

/** The whole view a role reads `relation` through where it holds it whole: a stored relation's, a roster's and a
 * derived relation's (schema/own.ts wholeViewOf), none for a closed relation, which no role holds. */
const wholeViewsOf = (relation: OwnedRelation): ReadonlyArray<Identity<"wholeView">> => {
	switch (relation.kind) {
		case "relation":
		case "closed":
		case "derived":
			return [wholeViewOf(relation)]
		case "closedRelation":
			return []
	}
}

/**
 * installedIdentifiersOf(schema): every PostgreSQL identifier the fresh installation of a schema built by schema(...)
 * or schema.extend names an object by (physical/install/compile.ts Installation `identities`, the census its COMMENTs
 * pass and `grizzle names` reads): its levels' schemas, tables and columns, keys, checks and constraints, indexes,
 * domains, constants and functions, readable or hashed; and the whole view each relation a role may hold whole is read
 * through, which an installation creates where a login's role holds it. Each identity once, in the naming door's order
 * of identities (compareIdentities), with what it spells out. A test of a library that derives names holds each to
 * PostgreSQL's identifier by it. It throws CompileError for a value lawsOf refuses and for a schema whose installation
 * does not compile.
 */
export const installedIdentifiersOf = (schema: AnySchema): ReadonlyArray<InstalledIdentifier> => {
	const installation = orThrow(
		Result.flatMap(lawModel(schema, "installedIdentifiersOf"), (model) => {
			const options = installOptions(model.owned)
			return Result.flatMap(basisOf(model, options.codes), (basis) =>
				installationOver(basis, options, silentPhases)
			)
		})
	)
	const identities: ReadonlyArray<Identity<IdentityKind>> = [
		...installation.identities,
		...Object.values(installation.owned.relations).flatMap(wholeViewsOf)
	]
	const distinct = new Map(identities.map((i) => [i.canonical, i] as const))
	return [...distinct.values()]
		.toSorted(compareIdentities)
		.map((i) => Object.freeze({ identifier: i.identifier, display: i.display }))
}
