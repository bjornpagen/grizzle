import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import {
	type CheckedSchema,
	type DerivedAnalysis,
	derivedAnalysis,
	type RoleWorld
} from "#compiler/analysis/schema.ts"
import { catchCompileError, settled } from "#compiler/core/canonical.ts"
import { CompileError } from "#compiler/core/errors.ts"
import { type HeldName, identifierOf } from "#compiler/core/identity.ts"
import type { LawId, SchemaFingerprint } from "#compiler/core/ids.ts"
import { Lazy } from "#compiler/core/lazy.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	derivedEvidence,
	evidenceCatalog,
	type ViewEvidence
} from "#compiler/laws/model/catalog.ts"
import {
	changedBy,
	compileLaws,
	type ConstraintLaw,
	type LawModel
} from "#compiler/laws/model/model.ts"
import { servedCatalog } from "#compiler/physical/access/catalog.ts"
import { roleWorldViews, type WorldView } from "#compiler/physical/access/world-views.ts"
import { structuralRegex } from "#compiler/physical/ddl/domains.ts"
import {
	type InstallNames,
	roleReadNames,
	type WorldNames,
	type NamedRole,
	namedRole,
	worldNames
} from "#compiler/physical/ddl/names.ts"
import { checkedRole } from "#compiler/physical/ddl/roles.ts"
import {
	basisOf,
	contractChain,
	freshPlanSettings,
	type InstallPlan,
	unserved,
	type ParamSource,
	type PlanBasis,
	planInstallation
} from "#compiler/physical/install/plan.ts"
import {
	type BuiltSchema,
	levelSchema,
	type Over,
	type SchemaInput
} from "#compiler/program/input.ts"
import type { SchemaLaws } from "#compiler/program/laws.ts"
import type { FamilyInserts } from "#compiler/program/preview.ts"
import type { DeclaredEntries } from "#compiler/schema/declared-entries.ts"
import { type Owned, type OwnedRole, own } from "#compiler/schema/own.ts"
import type { ReadCatalog } from "#compiler/sql/bind.ts"
import type { RecordedLaw } from "#compiler/types/changeset/changeset.ts"
import { type UnmatchedQuery, unmatchedQueryOf } from "#compiler/write/unmatched.ts"

/**
 * What a schema contributes to compiling its queries: the owned schema and its fingerprint, the physical names of its
 * installed objects, its law model, its views' unique indexes, and the evidence catalog of both (program).
 *
 * The names are the installation's own (physical/ddl/names.ts InstallNames): relations, columns, roster domains and
 * codes, closed constants, contract domains and the structural `__text_` domains, under the PostgreSQL schema the
 * installation targets, so the queries address exactly the objects a migration installs. They are read from the
 * fresh installation's plan (physical/install/plan.ts planInstallation), which is pure, given the installation's codes,
 * and builds no DDL. The evidence catalog resolves every declared key and containment to its
 * installed constraint (catalog.ts).
 *
 * A schema is reality, a schema(...) value, or a role, a role(...) value: a role's artifacts are its base's, read through
 * the role's views (physical/ddl/names.ts roleReadNames), with its world relations keyed as their definitions prove
 * (analysis/derived/world.ts). A program over a role's base runs on the role when the role holds every relation of its
 * base whole (a full role), by the level rule (levelSchema).
 */
export interface SchemaArtifacts<S extends ParamSource = ParamSource> {
	/**
	 * Where the types its programs cast their parameters to come from (physical/install/plan.ts ParamSource), the plan's
	 * own: only artifacts an installation stands behind (InstalledArtifacts) compile a program that runs.
	 */
	readonly params: S
	/** Reality's owned schema, a role's base's for a role, and its fingerprint, the snapshot's (theory.schema). */
	readonly owned: Owned
	readonly fingerprint: SchemaFingerprint
	/** The installed names of reality: the tables a write's statements write. */
	readonly names: InstallNames
	/** The names a query reads its relations under: reality's own, or a role's views (roleReadNames). */
	readonly reads: PhysicalNames
	/** What the artifacts read as: reality, or a role with its checked schema and its installed names. */
	readonly world: ArtifactsWorld
	readonly laws: LawModel
	/** The schema's derived analysis, which its checked schema computed when it was built (`derived.schema`). */
	readonly derived: DerivedAnalysis
	/**
	 * What its derived relations prove: each one's inherited keys with the unique index its view is installed with,
	 * which the evidence catalog resolves a view's key to, and the containments each definition draws.
	 */
	readonly views: ViewEvidence
	/** Every installed constraint with its owner and the law a violation reports, described (physical/install
	 * InstallPlan). */
	readonly constraintLaws: ReadonlyArray<ConstraintLaw>
	/** Every law of the theory with its description (physical/install InstallPlan). */
	readonly theoryLaws: InstallPlan["theoryLaws"]
	/** Every law a violation can report, by its LawId, as an outcome names it (physical/install InstallPlan). */
	readonly described: ReadonlyMap<LawId, RecordedLaw>
}

/**
 * A ParamSource an installation stands behind: `planned` from the programs it serves, or `recorded` by its snapshot.
 * Every type a statement compiled under it casts a parameter to is one that installation installs, which `unserved`
 * never promises: it names a pattern parameter's own domain freely and installs nothing.
 */
export type InstalledSource = Exclude<ParamSource, { readonly kind: "unserved" }>

/**
 * The artifacts of an installation that stands behind them (InstalledSource): what every program that runs is compiled
 * over (adapter/served/role.ts RoleContext), so PostgreSQL never meets a cast to a type its installation lacks.
 */
export type InstalledArtifacts = SchemaArtifacts<InstalledSource>

/**
 * What a compilation reads as: reality, or a role over its base, with its world views (physical/access/world-views.ts
 * roleWorldViews), computed once with the role's artifacts, which every statement of the role reads them by and the
 * installation creates them from.
 */
export type ArtifactsWorld =
	| { readonly kind: "reality" }
	| {
			readonly kind: "role"
			readonly role: OwnedRole
			readonly checked: CheckedSchema<RoleWorld>
			readonly names: WorldNames
			readonly views: ReadonlyArray<WorldView>
	  }

/**
 * The catalog the statements compiled over `artifacts` are bound over (sql/bind.ts ReadCatalog): the installation's
 * tables and whole views, and a role's world views.
 */
export const artifactsCatalog = (
	artifacts: Pick<SchemaArtifacts, "laws" | "names" | "world">
): ReadCatalog =>
	servedCatalog(
		artifacts.laws,
		artifacts.names,
		artifacts.world.kind === "role" ? artifacts.world.views.map((v) => v.binding) : []
	)

interface SchemaArtifactOptions {
	/**
	 * The installation's codes (ir/codes.ts): the snapshot's for a layer, the drafted ones for generate, the first
	 * codebook for a fresh installation. Codes are history, so the schema alone never determines them, and every code
	 * literal and bit(n) width the artifacts hold reads them.
	 */
	readonly codes: Codebook
}

/**
 * The schema a program over the schema or fragment `carried` compiles against when the caller names `named`
 * (levelSchema): on a role, a program over a level of its base means its evaluation over the role's world
 * (schema/scope.ts), each member of a unit the role's claims bind read at its owner's keys alone.
 */
export const programSchema = (
	carried: Over,
	named: SchemaInput,
	loc: SourceLoc
): Result.Result<SchemaInput, CompileError> => levelSchema(carried, named, loc)

/**
 * The law model of an owned schema that every installation of it plans over, planned. The program
 * layer's compile ends here, so every unrepresentable key the model met is refused here, all at once
 * (core/canonical.ts settled).
 */
const plannedModel = (owned: Owned): Result.Result<LawModel, CompileError> =>
	Result.flatMap(compileLaws(owned, { kind: "planned" }), (model) =>
		settled(model.unrepresentable, Result.ok(model))
	)

/**
 * What the program layer holds of a built schema value whose law model compiles: the model (plannedModel), and the
 * family inserts every preview and facts decoder of the value reads (program/preview.ts FamilyInserts) and its laws as
 * lawsOf and its siblings read them (program/laws.ts SchemaLaws), each computed where it is first read (core/lazy.ts).
 */
export interface CompiledSchema {
	readonly model: LawModel
	readonly inserts: Lazy<FamilyInserts>
	readonly laws: Lazy<SchemaLaws>
}

/**
 * The one place program state attaches to a schema value: each built schema value's CompiledSchema, or its CompileError,
 * by the value, made where the value is first read, a built schema being immutable, so every reader of one schema value
 * in a process (insertPreview, factsDecoder, rowEvaluator, lawsOf and its siblings, the schema's artifacts) reads one
 * model, one set of family inserts and one set of laws. A schema value is made in schema/, which names no law model,
 * so the program layer holds its state by the value, as schema/protocol.ts `owned` holds every built value's entry: a
 * WeakMap holds nothing alive and is never enumerated.
 */
const built = new WeakMap<object, Result.Result<CompiledSchema, CompileError>>()

/** The compiled state of a built schema (`built`): the law model, planned, of the Owned the schema's
 * value holds (levels.ts BuiltSchemaContent). */
export const compiledSchema = (
	schema: BuiltSchema
): Result.Result<CompiledSchema, CompileError> => {
	const known = built.get(schema.value)
	if (known !== undefined) {
		return known
	}
	const made = Result.map(
		Result.flatMap(schema.content.owned(), plannedModel),
		(model): CompiledSchema =>
			Object.freeze({ model, inserts: new Lazy<FamilyInserts>(), laws: new Lazy<SchemaLaws>() })
	)
	built.set(schema.value, made)
	return made
}

/** The law model of a built schema, the one its compiled state holds (compiledSchema). */
export const builtLawModel = (schema: BuiltSchema): Result.Result<LawModel, CompileError> =>
	Result.map(compiledSchema(schema), (c) => c.model)

/**
 * The artifacts of a schema under the target identifiers: those of the Owned the schema owns to, over its law model, a
 * built schema's the one its value holds (builtLawModel), and for a role its base's read through its views
 * (roleArtifacts). Each call plans them: their holder (the layer, generate, describe) computes them once and hands them
 * to every compilation over the schema.
 */
export const schemaArtifacts = (
	schema: SchemaInput,
	options: SchemaArtifactOptions
): Result.Result<SchemaArtifacts, CompileError> => {
	const over = (model: LawModel) =>
		Result.flatMap(basisOf(model, options.codes), (basis) => baseArtifacts(basis, unserved))
	switch (schema.kind) {
		case "built":
			return Result.flatMap(builtLawModel(schema), over)
		case "role":
			return Result.flatMap(schema.level.owned(), (role) =>
				Result.flatMap(Result.flatMap(plannedModel(role.base), over), (base) =>
					Result.flatMap(namedRole(role, base.names.levels), (named) => roleArtifacts(named, base))
				)
			)
		case "owned":
			return Result.flatMap(plannedModel(schema.owned), over)
		case "desc":
			return Result.flatMap(Result.flatMap(own(schema.desc), plannedModel), over)
	}
}

/**
 * The artifacts of an owned schema under the target identifiers, read from the plan of its fresh installation over its
 * basis (the law model and the closed constants' names under the installation's codes, physical/install/plan.ts
 * PlanBasis: a Db's from its snapshot, planBasis, everyone else's planned, installBasis), which builds no DDL and packs
 * no cell, its programs' parameters cast to the types `params` gives (ParamSource): planned from the programs it serves,
 * or recorded by its snapshot. What the artifacts of every role over it read through their views (roleArtifacts).
 * Their holder (the layer, generate) computes them once for a schema and hands them to every role and every
 * compilation over the schema; generate installs its draft over the same basis.
 */
export const baseArtifacts = <S extends ParamSource>(
	basis: PlanBasis,
	params: S
): Result.Result<SchemaArtifacts<S>, CompileError> =>
	Result.map(
		planInstallation(basis, freshPlanSettings(basis.owned), params),
		(plan): SchemaArtifacts<S> => {
			const derived = derivedAnalysis(plan.checked)
			return {
				params,
				owned: plan.owned,
				fingerprint: plan.owned.fingerprint,
				names: plan.names,
				reads: plan.names,
				world: reality,
				laws: basis.model,
				derived,
				views: derivedEvidence(derived, plan.laws.existence),
				constraintLaws: plan.constraintLaws,
				theoryLaws: plan.theoryLaws,
				described: plan.described
			}
		}
	)

const reality: ArtifactsWorld = Object.freeze({ kind: "reality" })

/**
 * A role's artifacts, the role named under its base's installation (names.ts namedRole): its base's (baseArtifacts),
 * which compile nothing again, read through the role's views, its world relations keyed by their definitions.
 */
export const roleArtifacts = <S extends ParamSource>(
	named: NamedRole,
	base: SchemaArtifacts<S>
): Result.Result<SchemaArtifacts<S>, CompileError> => {
	const role = named.owned
	const read = checkedRole(base.derived.schema, named)
	if (!read.ok) {
		return read
	}
	const names = worldNames(named, base.names)
	const reads = catchCompileError(() => roleReadNames(base.names, names, role))
	if (!reads.ok) {
		return reads
	}
	const views = catchCompileError(() =>
		roleWorldViews({
			names: base.names,
			evidence: evidenceCatalog({ laws: base.laws, views: base.views }),
			checked: read.value.checked,
			views: named.views,
			catalog: servedCatalog(base.laws, base.names, [])
		})
	)
	if (!views.ok) {
		return views
	}
	const artifacts: SchemaArtifacts<S> = {
		...base,
		reads: reads.value,
		world: { kind: "role", role, checked: read.value.checked, names, views: views.value }
	}
	return Result.ok(artifacts)
}

/**
 * What a role's write statements judge a value by, the one input of what they can raise (raisableOf): `written`, every
 * relation they change (schema/reach.ts writesOf), whose column types judge each value written there; and `cast`, the
 * type of every other value a statement casts to its type wherever it runs, which judges it whole: each claim of a
 * context the role reads (sql/print.ts contextClaims) and each scalar parameter its writes declare (lower/conservative
 * paramTypeRef).
 */
export interface Judged {
	readonly written: ReadonlySet<string>
	readonly cast: ReadonlyArray<ScalarType>
}

/**
 * What the writes of a role can raise of its artifacts, by what they judge (Judged): each table constraint and rule
 * trigger on a written relation, which a write there breaks, each stored derived relation the judge keeps from a written
 * one at COMMIT written with it (laws/model/model.ts changedBy); each foreign key or PERIOD foreign key into one, which a
 * delete or a key's update there meets; each domain constraint whole whose domain a cast value's type meets (its
 * contract chain's domains and its pattern's), and otherwise with its uses narrowed to the written relations' columns,
 * which a value written there breaks, kept while one stays, its laws theirs; each law of the theory reading a written
 * relation, which a write statement's refusal raises; the written relations, whose generated fields a NOT NULL names
 * and whose keys a refusal's DETAIL decodes; and the rosters typing a column
 * of them or a cast value, by declared name, whose code or bits domain such a value meets. A write meets no other constraint and raises no other law: no foreign
 * key cascades beyond what writesOf closes over, a rule's trigger fires only on its own table, and every literal is
 * judged by its type before it is served.
 */
export interface Raisable {
	readonly constraintLaws: ReadonlyArray<ConstraintLaw>
	readonly theoryLaws: SchemaArtifacts["theoryLaws"]
	readonly relations: ReadonlyArray<RelationInfo>
	/**
	 * The witness query of each deferred foreign key it can raise at COMMIT (write/unmatched.ts) whose table and target
	 * the role reads whole (`readsWhole`), whose relation is among `relations`, so the key it names decodes.
	 */
	readonly unmatched: ReadonlyArray<UnmatchedQuery>
	readonly rosters: ReadonlySet<HeldName>
	/** The catalog entries the schema's authors declare for its generated fields' laws (Owned declared `generated`). */
	readonly generatedEntries: DeclaredEntries["generated"]
}

/**
 * Of the constraint law `c`, what a write of `tables` can raise: a table's constraint whose owner is one of them or that
 * is a foreign key `into` names under its table; a rule's trigger under every table it names it on wherever its law is
 * `raised`, a law that reads a written table, since its judge names one table of the rule, a whole rule its unit's
 * holder (physical/ddl/rules.ts raiseOf), which need not be one the write wrote; a domain's CHECK whole where its domain
 * is one of `cast`, and otherwise with its uses narrowed to `tables`, kept while one stays.
 */
const raisableConstraint = (
	c: ConstraintLaw,
	tables: ReadonlySet<string>,
	into: ReadonlyMap<string, ReadonlySet<string>>,
	cast: ReadonlySet<string>,
	raised: ReadonlySet<LawId>
): ReadonlyArray<ConstraintLaw> => {
	switch (c.kind) {
		case "constraint":
			return tables.has(c.owner) || into.get(c.owner)?.has(c.name) === true ? [c] : []
		case "trigger":
			return c.laws.some((l) => raised.has(l.law)) ? [c] : []
		case "domainConstraint": {
			if (cast.has(c.owner)) {
				return [c]
			}
			const uses = c.uses.filter((u) => tables.has(u.table))
			return isNonEmpty(uses) ? [{ ...c, uses }] : []
		}
		case "unstoredDomainConstraint":
			return cast.has(c.owner) ? [c] : []
	}
}

/**
 * The domains a value cast to `t` meets under `names`: each contract's of its chain, outermost first, and the text
 * domain of its pattern where it is a refined text outside any contract (structuralRegex); a contract over a refined
 * text carries the pattern in its own domain's CHECK, which names no text domain.
 */
const castDomains = (names: InstallNames, t: ScalarType): ReadonlyArray<string> => {
	const text = structuralRegex(t)
	return [
		...contractChain(t).map((contract) => names.contractDomain(contract).name),
		...(text === undefined ? [] : [names.textDomain(text).name])
	]
}

/**
 * Whether the artifacts' writes read every row and column of a relation's table: reality's all of them; a role's each
 * relation it writes by a whole entry, its table SELECT behind a policy that admits every row (physical/ddl/roles.ts
 * writePlan). A deferred foreign key's witness query (write/unmatched.ts) runs as the role on such tables alone: the
 * key it names is of a row the role selects itself, so it reveals nothing the role cannot read, and every target row
 * is in its sight, so a row it names unmatched is unmatched. A role that reads the table or the target narrowed, a
 * query entry's policy or columns, or not at all, is served no witness query, and its refusal at COMMIT is
 * `unreported`, as PostgreSQL's own DETAIL states no key to a role that cannot read it.
 */
const readsWhole = (world: ArtifactsWorld): ((relation: string) => boolean) => {
	if (world.kind === "reality") {
		return () => true
	}
	const whole = new Set<string>(
		[...world.role.writes.values()].flatMap((w) => (w.kind === "whole" ? [w.relation.name] : []))
	)
	return (relation) => whole.has(relation)
}

/**
 * The witness query (write/unmatched.ts) of each deferred foreign key of `artifacts` on a relation `written` holds of,
 * which COMMIT judges and a write there meets, whose table and target the artifacts read whole (`readsWhole`): the row
 * it names is of a relation the write changes. A key a write meets only by deleting from its target, which leaves a row
 * of a relation it does not change unmatched, has none.
 */
export const unmatchedOf = (
	artifacts: Pick<SchemaArtifacts, "laws" | "names" | "world">,
	written: (relation: string) => boolean
): ReadonlyArray<UnmatchedQuery> => {
	const whole = readsWhole(artifacts.world)
	return artifacts.laws.natives.flatMap((n) =>
		n.namespace === "constraint" &&
		(n.object.kind === "ForeignKey" || n.object.kind === "PeriodForeignKey") &&
		n.object.deferrable &&
		written(n.object.relation.name) &&
		whole(n.object.relation.name) &&
		whole(n.object.target.name)
			? [unmatchedQueryOf(artifacts.names, identifierOf(n.named), n.object)]
			: []
	)
}

/** What writes judging `judged` can raise of `artifacts` (`Raisable`). */
export const raisableOf = (
	artifacts: Pick<
		SchemaArtifacts,
		"constraintLaws" | "theoryLaws" | "laws" | "derived" | "names" | "world"
	>,
	judged: Judged
): Raisable => {
	/** The relations the writes change by their COMMIT: those their statements change, and each stored derived relation
	 * the judge's phase A keeps from them (laws/model/model.ts changedBy), whose UNIQUE and CHECK refuse there. */
	const written = changedBy(artifacts.laws.theory.upkeeps, judged.written)
	const relations = [...artifacts.derived.schema.relations.values()].filter((r) =>
		written.has(r.name)
	)
	/** The tables the writes change: each changed ordinary relation's and each changed stored derived relation's. */
	const tables = new Set<string>([
		...relations.map((r) => r.ident),
		...Object.values(artifacts.laws.theory.relations).flatMap((r) =>
			r.kind === "stored" && written.has(r.name) ? [r.ident] : []
		)
	])
	const into = new Map<string, Set<string>>()
	for (const n of artifacts.laws.natives) {
		if (
			n.namespace !== "constraint" ||
			(n.object.kind !== "ForeignKey" && n.object.kind !== "PeriodForeignKey") ||
			!written.has(n.object.target.name)
		) {
			continue
		}
		const named = into.getOrInsertComputed(n.owner, () => new Set<string>())
		named.add(identifierOf(n.named))
	}
	const unmatched = unmatchedOf(artifacts, (relation) => written.has(relation))
	const cast = new Set(judged.cast.flatMap((t) => castDomains(artifacts.names, t)))
	const raised = new Set(
		artifacts.laws.theory.laws.flatMap((l) => (l.reads.isDisjointFrom(written) ? [] : [l.id]))
	)
	const typed = [...relations.flatMap((r) => r.fields.map((f) => f.type)), ...judged.cast]
	return {
		constraintLaws: artifacts.constraintLaws.flatMap((c) =>
			raisableConstraint(c, tables, into, cast, raised)
		),
		theoryLaws: artifacts.theoryLaws.filter((l) => raised.has(l.law)),
		relations,
		unmatched,
		rosters: new Set(typed.flatMap((t) => rosterOf(t)?.closed ?? [])),
		generatedEntries: artifacts.laws.owned.declared.generated
	}
}
