import type { CatalogKey } from "#compiler/analysis/physical/evidence.ts"
import {
	type CheckedSchema,
	type DerivedAnalysis,
	derivedAnalysis,
	type RoleWorld
} from "#compiler/analysis/schema.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { type Identity, identifierOf } from "#compiler/core/identity.ts"
import type { LawId, SchemaFingerprint } from "#compiler/core/ids.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { RoleDesc, SchemaDesc } from "#compiler/ir/desc.ts"
import type { EvidenceCatalog } from "#compiler/ir/evidence.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { ConstraintLaws } from "#compiler/ir/products.ts"
import type { RegexRef } from "#compiler/ir/scalar.ts"
import { derivedKeyConstraints, evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import type { ConstraintLaw, LawModel } from "#compiler/laws/model/model.ts"
import { textDomainIdentity } from "#compiler/physical/ddl/domains.ts"
import {
	type InstallNames,
	roleReadNames,
	type WorldNames,
	worldNames
} from "#compiler/physical/ddl/names.ts"
import {
	type CheckedRole,
	checkedRole,
	contextFieldsOf,
	worldTextDomainUses
} from "#compiler/physical/ddl/roles.ts"
import {
	freshPlanSettings,
	installBasis,
	type InstallPlan,
	type PlanBasis,
	planInstallation
} from "#compiler/physical/install/plan.ts"
import { hostArguments } from "#compiler/query/build/host.ts"
import { admitSchemaDesc } from "#compiler/schema/admit.ts"
import {
	contentOfDesc,
	isLevelOf,
	type SchemaContent,
	sameRoleLevel
} from "#compiler/schema/levels.ts"
import { type Owned, type OwnedRole, own, ownedOf, ownRole } from "#compiler/schema/own.ts"
import { ownedEntry } from "#compiler/schema/protocol.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import type { RoleLevel } from "#compiler/schema/world.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"

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
export interface SchemaArtifacts {
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
	 * Each derived relation's inherited keys with the unique index its view is installed with, which the evidence
	 * catalog resolves a view's key to.
	 */
	readonly views: ReadonlyArray<CatalogKey>
	/** Every installed constraint with its owner and the law a violation reports, described (physical/install
	 * InstallPlan). */
	readonly constraintLaws: ReadonlyArray<ConstraintLaw>
	/** Each owner's installed constraint names to the law a violation reports. */
	readonly constraintToLaw: ConstraintLaws
	/** Every law of the theory with its description (physical/install InstallPlan). */
	readonly theoryLaws: InstallPlan["theoryLaws"]
	/** Every law a violation can report, by its LawId, as an outcome names it (physical/install InstallPlan). */
	readonly described: ReadonlyMap<LawId, Law>
}

/** What a compilation reads as: reality, or a role over its base. */
export type ArtifactsWorld =
	| { readonly kind: "reality" }
	| {
			readonly kind: "role"
			readonly role: OwnedRole
			readonly checked: CheckedSchema<RoleWorld>
			readonly names: WorldNames
	  }

interface SchemaArtifactOptions {
	/**
	 * The installation's codes (ir/codes.ts): the snapshot's for a layer, the drafted ones for generate, the first
	 * codebook for a fresh installation. Codes are history, so the schema alone never determines them, and every code
	 * literal and bit(n) width the artifacts hold reads them.
	 */
	readonly codes: Codebook
}

/**
 * The schema a compilation is given, parsed once: a value schema(...) or schema.extend built, with the description and
 * the content its builder recorded; an Owned own() returned, with its description; a SchemaDesc decoded from any other
 * value; or a role role(...) built, with its description and its level. An Owned's and a decoded description's content
 * is read where it is parsed, the one place such a value enters (levels.ts contentOfDesc).
 */
export type SchemaInput =
	| {
			readonly kind: "built"
			readonly value: object
			readonly desc: SchemaDesc
			readonly content: SchemaContent
	  }
	| {
			readonly kind: "owned"
			readonly owned: Owned
			readonly desc: SchemaDesc
			readonly content: SchemaContent
	  }
	| { readonly kind: "desc"; readonly desc: SchemaDesc; readonly content: SchemaContent }
	| {
			readonly kind: "role"
			readonly value: object
			readonly desc: RoleDesc
			readonly level: RoleLevel
	  }

/** Every SchemaInput parseSchemaInput produced, so parsing one again is the input itself. */
const parsedInputs = new WeakSet<object>()

const parsed = (input: SchemaInput): SchemaInput => {
	parsedInputs.add(input)
	return Object.freeze(input)
}

const isParsed = (value: unknown): value is SchemaInput =>
	typeof value === "object" && value !== null && parsedInputs.has(value)

/**
 * A schema input, or the decoder's own refusal of it, its path included. Idempotent: a SchemaInput this produced
 * parses to itself. A value no builder made is the caller's, read once at the builder's boundary (query/build/host.ts
 * hostArguments) before it is decoded, so one whose reading throws is refused as MalformedDescription, never a defect.
 */
export const parseSchemaInput = (value: unknown): Result.Result<SchemaInput, CompileError> => {
	if (isParsed(value)) {
		return Result.ok(value)
	}
	const owned = ownedOf(value)
	if (owned !== undefined) {
		return Result.ok(
			parsed({ kind: "owned", owned, desc: owned.desc, content: contentOfDesc(owned.desc) })
		)
	}
	const role = ownedEntry(value, "role")
	if (role !== undefined) {
		return Result.ok(
			parsed({ kind: "role", value: role.value, desc: role.desc, level: role.content })
		)
	}
	const built = ownedEntry(value, "schema")
	if (built !== undefined) {
		return Result.ok(
			parsed({ kind: "built", value: built.value, desc: built.desc, content: built.content })
		)
	}
	return Result.flatMap(
		catchCompileError(() => hostArguments("schema", [value])),
		() =>
			Result.map(admitSchemaDesc(value), (desc) =>
				parsed({ kind: "desc", desc, content: contentOfDesc(desc) })
			)
	)
}

/** A schema value schema(...) or schema.extend built, parsed: what Db.open is given, read once there. */
export type BuiltSchema = Extract<SchemaInput, { readonly kind: "built" }>

/** A role value parsed: what a role's programs compile against, and a login's compile reads of each of its roles. */
export type ParsedRole = Extract<SchemaInput, { readonly kind: "role" }>

/**
 * The built schema a value is, or the refusal of any other value at `loc`: a value no schema builder made, an
 * Owned or a bare SchemaDesc among them. Parsing its result again with parseSchemaInput is the result itself.
 */
export const parseBuiltSchema = (
	value: unknown,
	loc: SourceLoc
): Result.Result<BuiltSchema, CompileError> => {
	const entry = ownedEntry(value, "schema")
	if (entry === undefined) {
		return Result.err(
			malformedDescription(loc, "a schema built by schema(...) or schema.extend(...)")
		)
	}
	const built: BuiltSchema = {
		kind: "built",
		value: entry.value,
		desc: entry.desc,
		content: entry.content
	}
	parsedInputs.add(built)
	return Result.ok(Object.freeze(built))
}

/**
 * How a value built over `carried` relates to `named`, the schema it is compiled against: one of its levels (reality
 * over a level of itself by content, schema/levels.ts isLevelOf, the one level check; a role over itself; a full role
 * over a level of its base, whose every relation it holds whole); a level of the base of a role that holds not every
 * relation of it whole, whose program reads relations outside the role; or neither.
 */
type Level =
	| { readonly kind: "level" }
	| { readonly kind: "outsideRole"; readonly role: string; readonly base: string }
	| { readonly kind: "none" }

const level: Level = { kind: "level" }
const none: Level = { kind: "none" }

const levelOf = (carried: SchemaInput, named: SchemaInput): Level => {
	if (named.kind !== "role") {
		return carried.kind !== "role" && isLevelOf(carried.content, named.content) ? level : none
	}
	if (carried.kind === "role") {
		return sameRoleLevel(carried.level, named.level) ? level : none
	}
	if (!isLevelOf(carried.content, named.level.base)) {
		return none
	}
	const whole = named.level.whole
	return whole !== undefined && isLevelOf(carried.content, whole)
		? level
		: { kind: "outsideRole", role: named.desc.name, base: named.desc.base.name }
}

/**
 * The schema a value built over the schema `carried` describes compiles against when the caller names `named`: `named`
 * itself, when `carried` is one of its levels (levelOf); OutsideRole for a level of the base of a role that holds not
 * every relation of it whole, which only a JavaScript caller reaches (the types refuse it); otherwise a
 * MalformedDescription at `loc`, before any SQL.
 */
export const levelSchema = (
	carried: SchemaInput,
	named: SchemaInput,
	loc: SourceLoc
): Result.Result<SchemaInput, CompileError> => {
	const l = levelOf(carried, named)
	switch (l.kind) {
		case "level":
			return Result.ok(named)
		case "outsideRole":
			return Result.err(
				CompileError.make({
					_tag: "OutsideRole",
					at: loc,
					role: l.role,
					access: { kind: "wholeBase", base: l.base }
				})
			)
		case "none":
			return Result.err(
				malformedDescription(
					loc,
					"a value built over a level of the schema it is compiled against (the schema itself or one its extends chain reaches, or the base of a role that holds every relation of it whole); its schema is none of them"
				)
			)
	}
}

/**
 * The artifacts of a schema under the target identifiers: those of the Owned the schema owns to, and for a role its
 * base's read through its views (roleArtifacts). Each call computes them: their holder (the layer, generate,
 * describe) computes them once and hands them to every compilation over the schema.
 */
export const schemaArtifacts = (
	schema: SchemaInput,
	options: SchemaArtifactOptions
): Result.Result<SchemaArtifacts, CompileError> => {
	const over = (owned: Owned) =>
		Result.flatMap(installBasis(owned, options.codes, everySlice(owned)), baseArtifacts)
	return schema.kind === "role"
		? Result.flatMap(ownRole(schema.desc), (role) =>
				Result.flatMap(over(role.base), (base) => roleArtifacts(role, base))
			)
		: Result.flatMap(own(schema.desc), over)
}

/**
 * The artifacts of an owned schema under the target identifiers, read from the plan of its fresh installation over its
 * basis (the law model and the closed constants' names under the installation's codes, physical/install/plan.ts
 * PlanBasis: a Db's from its snapshot, planBasis, everyone else's planned, installBasis), which builds no DDL and packs
 * no cell: what the artifacts of every role over it read through their views
 * (roleArtifacts). Their holder (the layer, generate) computes them once for a schema and hands them to every role and
 * every compilation over the schema; generate installs its draft over the same basis.
 */
export const baseArtifacts = (basis: PlanBasis): Result.Result<SchemaArtifacts, CompileError> =>
	Result.map(
		planInstallation(basis, freshPlanSettings(basis.owned), []),
		(plan): SchemaArtifacts => {
			const derived = derivedAnalysis(plan.checked)
			return {
				owned: plan.owned,
				fingerprint: plan.owned.fingerprint,
				names: plan.names,
				reads: plan.names,
				world: reality,
				laws: plan.laws,
				derived,
				views: derivedKeyConstraints(derived),
				constraintLaws: plan.constraintLaws,
				constraintToLaw: plan.constraintToLaw,
				theoryLaws: plan.theoryLaws,
				described: plan.described
			}
		}
	)

const reality: ArtifactsWorld = Object.freeze({ kind: "reality" })

/**
 * The base's installed names with the role's own text patterns no stored column carries: its query entries' view
 * columns and the context fields it reads, each a domain named by its definition (textDomainIdentity), as the
 * installation names it whatever other roles the installation holds. A pattern of neither stays unnamed.
 */
const worldTextNames = (
	base: InstallNames,
	role: CheckedRole
): Result.Result<InstallNames, CompileError> =>
	Result.map(
		contextFieldsOf(role.checked.world.base, [role.checked.world.role]),
		(fields): InstallNames => {
			const patterns = new Set(worldTextDomainUses(fields, [role]).map((u) => u.regex.key))
			const textNamed = (regex: RegexRef): Identity<"textDomain"> | undefined =>
				base.textNamed(regex) ?? (patterns.has(regex.key) ? textDomainIdentity(regex) : undefined)
			return {
				...base,
				textDomain: (regex) => {
					const named = textNamed(regex)
					return named === undefined ? undefined : { schema: base.types, name: identifierOf(named) }
				},
				textNamed
			}
		}
	)

/**
 * A role's artifacts: its base's (baseArtifacts), which compile nothing again, read through the role's views, its world
 * relations keyed by their definitions.
 */
export const roleArtifacts = (
	role: OwnedRole,
	base: SchemaArtifacts
): Result.Result<SchemaArtifacts, CompileError> => {
	const read = checkedRole(base.derived.schema, base.names.levels, role)
	if (!read.ok) {
		return read
	}
	const names = catchCompileError(() => worldNames(role, base.names))
	if (!names.ok) {
		return names
	}
	const installed = worldTextNames(base.names, read.value)
	if (!installed.ok) {
		return installed
	}
	const reads = catchCompileError(() => roleReadNames(installed.value, names.value, role))
	if (!reads.ok) {
		return reads
	}
	const artifacts: SchemaArtifacts = {
		...base,
		names: installed.value,
		reads: reads.value,
		world: { kind: "role", role, checked: read.value.checked, names: names.value }
	}
	return Result.ok(artifacts)
}

/**
 * What the writes of a role can raise of its artifacts, `written` every relation they change (schema/reach.ts
 * writesOf): each table constraint and rule trigger on a written relation, which a write there breaks; each foreign
 * key or PERIOD foreign key into one, which a delete or a key's update there meets; each domain constraint with its uses
 * on the written relations' columns, which a value written there breaks, and each one no stored column uses, which a
 * context or a parameter of its type reads; each law of the theory reading a written relation, which a write
 * statement's refusal raises; and the written relations, whose generated fields a NOT NULL names and whose keys a
 * refusal's DETAIL decodes. A write of `written` meets no other constraint and raises no other law: no foreign key
 * cascades beyond what writesOf closes over, and a rule's trigger fires only on its own table.
 */
export interface Raisable {
	readonly constraintLaws: ReadonlyArray<ConstraintLaw>
	readonly theoryLaws: SchemaArtifacts["theoryLaws"]
	readonly relations: ReadonlyArray<RelationInfo>
}

/** The constraint `name` of `owner`, by both: one installed object. */
const constraintKey = (owner: string, name: string): string => `${owner}\u0000${name}`

/**
 * Of the constraint law `c`, what a write of `tables` can raise: a table's constraint or trigger whose owner is one of
 * them or that is a foreign key `into` names, and a domain's CHECK with its uses narrowed to them, kept while one stays
 * or while it had none.
 */
const raisableConstraint = (
	c: ConstraintLaw,
	tables: ReadonlySet<string>,
	into: ReadonlySet<string>
): ReadonlyArray<ConstraintLaw> => {
	switch (c.kind) {
		case "constraint":
		case "trigger":
			return tables.has(c.owner) || into.has(constraintKey(c.owner, c.name)) ? [c] : []
		case "domainConstraint": {
			const uses = c.uses.filter((u) => tables.has(u.table))
			return uses.length > 0 || c.uses.length === 0 ? [{ ...c, uses }] : []
		}
	}
}

/** What writes changing `written` can raise of `artifacts` (`Raisable`). */
export const raisableOf = (
	artifacts: Pick<SchemaArtifacts, "constraintLaws" | "theoryLaws" | "laws" | "derived">,
	written: ReadonlySet<string>
): Raisable => {
	const relations = [...artifacts.derived.schema.relations.values()].filter((r) =>
		written.has(r.name)
	)
	const tables = new Set<string>(relations.map((r) => r.ident))
	const into = new Set(
		artifacts.laws.natives.flatMap((n) =>
			n.namespace === "constraint" &&
			(n.object.kind === "ForeignKey" || n.object.kind === "PeriodForeignKey") &&
			written.has(n.object.target.name)
				? [constraintKey(n.owner, identifierOf(n.named))]
				: []
		)
	)
	const raised = new Set(
		artifacts.laws.theory.laws.flatMap((l) => (l.reads.some((r) => written.has(r)) ? [l.id] : []))
	)
	return {
		constraintLaws: artifacts.constraintLaws.flatMap((c) => raisableConstraint(c, tables, into)),
		theoryLaws: artifacts.theoryLaws.filter((l) => raised.has(l.law)),
		relations
	}
}

/** The evidence catalog of a schema: its laws' constraints and its views' unique indexes. */
export const schemaCatalog = (artifacts: SchemaArtifacts): EvidenceCatalog =>
	evidenceCatalog(artifacts)
