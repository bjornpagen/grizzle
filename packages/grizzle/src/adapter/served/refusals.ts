import { Array as Arr } from "effect"
import { type InstallationWitness, servedWitness } from "#adapter/witness/index.ts"
import type { LawsAbove } from "#adapter/witness/keylaw.ts"
import type { InstallNames } from "#compiler/plan/catalog.ts"
import { generatedFieldLaws, type TableRelation } from "#compiler/plan/change.ts"
import { type CheckedEntry, identifierOf, type SchemaArtifacts } from "#compiler/plan/common.ts"
import type { ServedEntryKey, ServedKeyLaws, ServedRefusals } from "#compiler/plan/serve.ts"

/**
 * The refusals of a role's installation as data, what a served file holds of them, drawn from the role's artifacts at
 * compile time: the classifier a layer rebuilds from them (witness/index.ts servedWitness) is the one the compile runs.
 * Compile time only.
 *
 * What the key-law tables are drawn from: the installation's names (its schemas, each relation's table, each roster's
 * two domains, with the codes the installation holds), every installed constraint with its owner and law, every law of
 * the theory, and the stored relations, whose generated fields a NOT NULL violation names.
 */
interface KeyLawInput {
	readonly names: Pick<
		InstallNames,
		"levels" | "relation" | "codes" | "rosterDomain" | "bitsDomain"
	>
	readonly constraintLaws: SchemaArtifacts["constraintLaws"]
	readonly theoryLaws: SchemaArtifacts["theoryLaws"]
	readonly relations: ReadonlyArray<TableRelation>
}

/** The key-law tables of an installation (served/forms.ts ServedKeyLaws, which witness/keylaw.ts keyLawsOf reads), drawn from its compile. */
export const keyLawsData = (input: KeyLawInput): ServedKeyLaws => ({
	schemas: Arr.map(input.names.levels, identifierOf),
	constraintLaws: input.constraintLaws,
	theoryLaws: input.theoryLaws,
	tables: new Map(
		Arr.map(input.relations, (r) => [r.name, input.names.relation(r.name).name] as const)
	),
	rosterDomains: Arr.map([...input.names.codes.rosters.values()], (codec) => ({
		roster: codec.roster,
		code: input.names.rosterDomain(codec.roster).name,
		bits: input.names.bitsDomain(codec.roster).name
	})),
	generated: Arr.flatMap(input.relations, (r) =>
		Arr.map(generatedFieldLaws([r]), (g) => ({
			table: r.ident,
			column: g.field.column,
			law: g.law
		}))
	)
})

/** The query entries a role's artifacts write through, by their targets: none for reality. */
const writtenEntries = (
	artifacts: Pick<SchemaArtifacts, "world">
): ReadonlyMap<string, CheckedEntry> => {
	const world = artifacts.world
	if (world.kind !== "role") {
		return new Map()
	}
	return new Map(
		Arr.flatMap([...world.checked.world.writes.values()], (e) =>
			e.kind === "rows" ? [[e.writable.target.name, e.writable] as const] : []
		)
	)
}

/** A query entry's key mapping as data: its name, and each head field to the target field it writes. */
const entryKeyOf = (entry: CheckedEntry): ServedEntryKey => ({
	entry: entry.entry,
	head: new Map(Arr.map([...entry.head], ([head, { field }]) => [head, field.name] as const))
})

/**
 * The refusals of a role's artifacts as data (served ServedRefusals): the key-law tables of its installation, each
 * stored relation's heading, which a refusal's key text decodes through, and the query entries the role writes through.
 */
export const refusalsOf = (
	artifacts: Pick<SchemaArtifacts, "names" | "constraintLaws" | "theoryLaws" | "world" | "derived">
): ServedRefusals => {
	const checked = artifacts.derived.schema
	const relations = [...checked.relations.values()]
	return {
		laws: keyLawsData({
			names: artifacts.names,
			constraintLaws: artifacts.constraintLaws,
			theoryLaws: artifacts.theoryLaws,
			relations
		}),
		relations: new Map(Arr.map(relations, (r) => [r.name, r.heading] as const)),
		entries: new Map(
			Arr.map(
				[...writtenEntries(artifacts)],
				([target, entry]) => [target, entryKeyOf(entry)] as const
			)
		)
	}
}

/**
 * The witness decoding of a compiled installation: its refusals drawn as data (refusalsOf), rebuilt as a layer
 * rebuilds a served file's (witness/index.ts servedWitness), under the laws of the levels above `above`.
 */
export const installationWitness = (
	artifacts: Pick<SchemaArtifacts, "names" | "constraintLaws" | "theoryLaws" | "world" | "derived">,
	above: LawsAbove
): InstallationWitness => servedWitness(refusalsOf(artifacts), above, artifacts.names.codes)
