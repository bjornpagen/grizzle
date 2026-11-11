import { Array as Arr } from "effect"
import { type InstallationWitness, servedWitness } from "#adapter/witness/index.ts"
import type { LawsAbove } from "#adapter/witness/keylaw.ts"
import { type InstallNames, paramDomainsOf } from "#compiler/plan/catalog.ts"
import { generatedFieldLaws, type TableRelation } from "#compiler/plan/change.ts"
import {
	type CheckedEntry,
	type DeclaredName,
	identifierOf,
	type ParamDecl,
	type Raisable,
	type SchemaArtifacts,
	type StoredRelationName
} from "#compiler/plan/common.ts"
import type { ServedEntryKey, ServedKeyLaws, ServedRefusals } from "#compiler/plan/serve.ts"

/**
 * The refusals of a role's installation as data, what a served file holds of them, drawn from the role's artifacts at
 * compile time: a layer rebuilds its classifier from them through the one constructor the compile's runs through
 * (witness/index.ts servedWitness), over the cut its role's writes can raise. Compile time only.
 *
 * What the key-law tables are drawn from: the installation's names (its schemas, each relation's table, each roster's
 * two domains, with the codes the installation holds), the installed constraints with their owners and laws, the laws
 * of the theory, the stored relations, whose generated fields a NOT NULL violation names, and the rosters whose
 * domains a violation can report.
 */
interface KeyLawInput {
	readonly names: Pick<
		InstallNames,
		"levels" | "relation" | "codes" | "rosterDomain" | "bitsDomain"
	>
	readonly constraintLaws: SchemaArtifacts["constraintLaws"]
	readonly theoryLaws: SchemaArtifacts["theoryLaws"]
	readonly relations: ReadonlyArray<TableRelation>
	readonly rosters: ReadonlySet<DeclaredName>
}

/**
 * The key-law tables of an installation (served/forms.ts ServedKeyLaws, which witness/keylaw.ts keyLawsOf reads), drawn
 * from its compile: each of `rosters` with its two domains, in the codebook's order.
 */
export const keyLawsData = (input: KeyLawInput): ServedKeyLaws => ({
	schemas: Arr.map(input.names.levels, identifierOf),
	constraintLaws: input.constraintLaws,
	theoryLaws: input.theoryLaws,
	tables: new Map(
		Arr.map(input.relations, (r) => [r.name, input.names.relation(r.name).name] as const)
	),
	rosterDomains: Arr.flatMap([...input.names.codes.rosters.values()], (codec) =>
		input.rosters.has(codec.roster)
			? [
					{
						roster: codec.roster,
						code: input.names.rosterDomain(codec.roster).name,
						bits: input.names.bitsDomain(codec.roster).name
					}
				]
			: []
	),
	generated: Arr.flatMap(input.relations, (r) =>
		Arr.map(generatedFieldLaws([r]), (g) => ({
			table: r.ident,
			column: g.field.column,
			law: g.law,
			id: g.id
		}))
	)
})

/** The query entries a role's artifacts write through whose targets are among `written`, by their targets: none for
 * reality. */
const writtenEntries = (
	artifacts: Pick<SchemaArtifacts, "world">,
	written: ReadonlySet<string>
): ReadonlyMap<StoredRelationName, CheckedEntry> => {
	const world = artifacts.world
	if (world.kind !== "role") {
		return new Map()
	}
	return new Map(
		Arr.flatMap([...world.checked.world.writes.values()], (e) =>
			e.kind === "rows" && written.has(e.writable.target.name)
				? [[e.writable.target.name, e.writable] as const]
				: []
		)
	)
}

/** A query entry's key mapping as data: its name, and each head field to the target field it writes. */
const entryKeyOf = (entry: CheckedEntry): ServedEntryKey => ({
	entry: entry.entry,
	head: new Map(Arr.map([...entry.head], ([head, { field }]) => [head, field.name] as const))
})

/**
 * The refusals of a role's artifacts as data (served ServedRefusals), cut to `raisable`, what its writes can raise
 * (program/schema.ts raisableOf): the key-law tables of those constraints, laws and rosters, each of those stored
 * relations' heading, which a refusal's key text decodes through, the query entries the role writes through into
 * them, and the pattern domains its members' parameters `params` are cast to (physical/ddl/domains.ts paramDomainsOf).
 */
export const refusalsOf = (
	artifacts: Pick<SchemaArtifacts, "names" | "world">,
	raisable: Raisable,
	params: ReadonlyArray<ParamDecl>
): ServedRefusals => {
	const relations = raisable.relations
	return {
		laws: keyLawsData({
			names: artifacts.names,
			constraintLaws: raisable.constraintLaws,
			theoryLaws: raisable.theoryLaws,
			relations,
			rosters: raisable.rosters
		}),
		relations: new Map(Arr.map(relations, (r) => [r.name, r.heading] as const)),
		entries: new Map(
			Arr.map(
				[...writtenEntries(artifacts, new Set(Arr.map(relations, (r) => r.name)))],
				([target, entry]) => [target, entryKeyOf(entry)] as const
			)
		),
		params: paramDomainsOf(params)
	}
}

/**
 * Every refusal a compiled installation's artifacts state, drawn as data (refusalsOf), cut to none: every roster of its
 * codebook among them.
 */
export const installationRefusals = (
	artifacts: Pick<SchemaArtifacts, "names" | "constraintLaws" | "theoryLaws" | "world" | "derived">
): ServedRefusals =>
	refusalsOf(
		artifacts,
		{
			constraintLaws: artifacts.constraintLaws,
			theoryLaws: artifacts.theoryLaws,
			relations: [...artifacts.derived.schema.relations.values()],
			rosters: new Set(artifacts.names.codes.rosters.keys())
		},
		[]
	)

/**
 * The witness decoding of a compiled installation: its every refusal drawn as data (installationRefusals), rebuilt as a
 * layer rebuilds a served file's (witness/index.ts servedWitness), under the laws of the levels above `above`.
 */
export const installationWitness = (
	artifacts: Pick<SchemaArtifacts, "names" | "constraintLaws" | "theoryLaws" | "world" | "derived">,
	above: LawsAbove
): InstallationWitness =>
	servedWitness(installationRefusals(artifacts), above, artifacts.names.codes)
