import type { CatalogKey } from "#compiler/analysis/physical/evidence.ts"
import {
	checkedDesc,
	checkedRoleDesc,
	type CheckedSchema,
	type DerivedAnalysis,
	derivedAnalysis,
	type RoleWorld
} from "#compiler/analysis/schema.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { type Identity, identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawId, SchemaFingerprint } from "#compiler/core/ids.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { decodeDesc, descText, type RoleDesc, type SchemaDesc } from "#compiler/ir/desc.ts"
import type { EvidenceCatalog } from "#compiler/ir/evidence.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { ConstraintLaws } from "#compiler/ir/products.ts"
import { derivedKeyConstraints, evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import type { ConstraintLaw, LawModel } from "#compiler/laws/model/model.ts"
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
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { hostArguments } from "#compiler/query/build/host.ts"
import { isLevelOf } from "#compiler/schema/levels.ts"
import { type Owned, type OwnedRole, own, ownedOf, ownRole } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { roleDescOf } from "#compiler/schema/world.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"

/**
 * What a schema contributes to compiling its queries: the owned schema and its fingerprint, the physical names of its
 * installed objects, its law model, its views' unique indexes, and the evidence catalog of both (program).
 *
 * The names are the installation's own (physical/ddl/names.ts InstallNames): relations, columns, enums, contract
 * domains and the structural `__text_` domains, under the PostgreSQL schema the installation targets, so the queries
 * address exactly the objects a migration installs. They are derived from the fresh-install compiler, which is pure; the
 * owner it names never appears in query SQL. The evidence catalog resolves every declared key and containment to its
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
	 * Installation). */
	readonly constraintLaws: ReadonlyArray<ConstraintLaw>
	/** Each owner's installed constraint names to the law a violation reports. */
	readonly constraintToLaw: ConstraintLaws
	/** Every law of the theory with its description (physical/install Installation). */
	readonly theoryLaws: Installation["theoryLaws"]
	/** Every law a violation can report, by its LawId, as an outcome names it (physical/install Installation). */
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
	/** The identity of the PostgreSQL schema the installation targets, or undefined for the declared schema's own
	 * (Owned.installation). */
	readonly installation: Identity<"schema"> | undefined
	/** The schema the vector extension lives in, or undefined for the installer's. */
	readonly vectorSchema: string | undefined
}

/**
 * The schema a compilation is given, parsed once: a value schema(...) or schema.extend built, with the description its
 * builder recorded; an Owned own() returned, with its description; a SchemaDesc decoded from any other value; or a role
 * role(...) built, with its description.
 */
export type SchemaInput =
	| { readonly kind: "built"; readonly value: object; readonly desc: SchemaDesc }
	| { readonly kind: "owned"; readonly owned: Owned; readonly desc: SchemaDesc }
	| { readonly kind: "desc"; readonly desc: SchemaDesc }
	| { readonly kind: "role"; readonly value: object; readonly desc: RoleDesc }

/** The checked schema an input's queries are checked against: a role's, over its base, or reality's. */
export const checkedInput = (input: SchemaInput): Result.Result<CheckedSchema, CompileError> =>
	input.kind === "role" ? checkedRoleDesc(input.desc) : checkedDesc(input.desc)

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
		return Result.ok(parsed({ kind: "owned", owned, desc: owned.desc }))
	}
	const role = roleDescOf(value)
	if (role !== undefined && typeof value === "object" && value !== null) {
		return Result.ok(parsed({ kind: "role", value, desc: role }))
	}
	const built = schemaDescOf(value)
	if (built !== undefined && typeof value === "object" && value !== null) {
		return Result.ok(parsed({ kind: "built", value, desc: built }))
	}
	return Result.flatMap(
		catchCompileError(() => hostArguments("schema", [value])),
		() => Result.map(decodeDesc("schema", value), (desc) => parsed({ kind: "desc", desc }))
	)
}

/** A schema value schema(...) or schema.extend built, parsed: what Db.open is given, read once there. */
export type BuiltSchema = Extract<SchemaInput, { readonly kind: "built" }>

/**
 * The built schema a value is, or the refusal of any other value at `loc`: a value no schema builder made, an
 * Owned or a bare SchemaDesc among them. Parsing its result again with parseSchemaInput is the result itself.
 */
export const parseBuiltSchema = (
	value: unknown,
	loc: SourceLoc
): Result.Result<BuiltSchema, CompileError> => {
	const desc = schemaDescOf(value)
	if (desc === undefined || typeof value !== "object" || value === null) {
		return Result.err(
			malformedDescription(loc, "a schema built by schema(...) or schema.extend(...)")
		)
	}
	const built: BuiltSchema = { kind: "built", value, desc }
	parsedInputs.add(built)
	return Result.ok(Object.freeze(built))
}

/** The owner the pure installer is given to derive the names. Ownership never enters a query's SQL. */
const namingOwner = "grizzle_owner"

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
const levelIf = (r: Result.Result<boolean, CompileError>): Result.Result<Level, CompileError> =>
	Result.map(r, (is) => (is ? level : none))

const levelOf = (carried: SchemaInput, named: SchemaInput): Result.Result<Level, CompileError> => {
	if (named.kind !== "role") {
		return carried.kind === "role" ? Result.ok(none) : levelIf(isLevelOf(carried.desc, named.desc))
	}
	if (carried.kind === "role") {
		return levelIf(
			Result.flatMap(descText(carried.desc), (a) =>
				Result.map(descText(named.desc), (b) => a === b)
			)
		)
	}
	return Result.flatMap(ownRole(named.desc), (role) =>
		Result.map(isLevelOf(carried.desc, role.base.desc), (is): Level => {
			if (!is) {
				return none
			}
			return role.full ? level : { kind: "outsideRole", role: role.name, base: role.base.name }
		})
	)
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
): Result.Result<SchemaInput, CompileError> =>
	Result.flatMap(levelOf(carried, named), (l) => {
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
	})

/**
 * The artifacts of a schema under the target identifiers: those of the Owned the schema owns to, and for a role its
 * base's read through its views (roleArtifactsOf). Each call computes them: their holder (the layer, generate,
 * describe) computes them once and hands them to every compilation over the schema.
 */
export const schemaArtifacts = (
	schema: SchemaInput,
	options: SchemaArtifactOptions
): Result.Result<SchemaArtifacts, CompileError> =>
	schema.kind === "role"
		? Result.flatMap(ownRole(schema.desc), (role) => roleArtifactsOf(role, options))
		: realityArtifacts(schema.desc, options)

const realityArtifacts = (
	desc: SchemaDesc,
	options: SchemaArtifactOptions
): Result.Result<SchemaArtifacts, CompileError> =>
	Result.flatMap(own(desc), (owned) => artifactsOf(owned, options))

/** The artifacts of an owned schema under the target identifiers: computed once by their holder (the layer, generate),
 * which every compilation over the schema is given. */
const artifactsOf = (
	owned: Owned,
	options: SchemaArtifactOptions
): Result.Result<SchemaArtifacts, CompileError> =>
	Result.map(
		compileInstallation(owned, {
			...installOptions(owned, namingOwner),
			...(options.installation === undefined ? {} : { installation: options.installation }),
			...(options.vectorSchema === undefined ? {} : { vectorSchema: options.vectorSchema })
		}),
		(installation): SchemaArtifacts => {
			const derived = derivedAnalysis(installation.checked)
			return {
				owned: installation.owned,
				fingerprint: installation.owned.fingerprint,
				names: installation.names,
				reads: installation.names,
				world: reality,
				laws: installation.laws,
				derived,
				views: derivedKeyConstraints(derived),
				constraintLaws: installation.constraintLaws,
				constraintToLaw: installation.constraintToLaw,
				theoryLaws: installation.theoryLaws,
				described: installation.described
			}
		}
	)

const reality: ArtifactsWorld = Object.freeze({ kind: "reality" })

/**
 * The base's installed names with the role's own text patterns no stored column carries: its query entries' view
 * columns and the context fields it reads, each a domain named by its pattern (identity.textDomain), as the
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
			return {
				...base,
				textDomain: (regex) =>
					base.textDomain(regex) ??
					(patterns.has(regex.key)
						? { schema: base.types, name: identifierOf(identity.textDomain(regex.key)) }
						: undefined)
			}
		}
	)

/** A role's artifacts: its base's, read through the role's views, its world relations keyed by their definitions. */
const roleArtifactsOf = (
	role: OwnedRole,
	options: SchemaArtifactOptions
): Result.Result<SchemaArtifacts, CompileError> => {
	const base = artifactsOf(role.base, options)
	if (!base.ok) {
		return base
	}
	const read = checkedRole(base.value.derived.schema, base.value.names.installation, role)
	if (!read.ok) {
		return read
	}
	const names = catchCompileError(() => worldNames(role, base.value.names.installation))
	if (!names.ok) {
		return names
	}
	const installed = worldTextNames(base.value.names, read.value)
	if (!installed.ok) {
		return installed
	}
	const reads = catchCompileError(() => roleReadNames(installed.value, role))
	if (!reads.ok) {
		return reads
	}
	const artifacts: SchemaArtifacts = {
		...base.value,
		names: installed.value,
		reads: reads.value,
		world: { kind: "role", role, checked: read.value.checked, names: names.value }
	}
	return Result.ok(artifacts)
}

/** The evidence catalog of a schema: its laws' constraints and its views' unique indexes. */
export const schemaCatalog = (artifacts: SchemaArtifacts): EvidenceCatalog =>
	evidenceCatalog(artifacts)
