import { Array as Arr } from "effect"
import { type ViolationClassifier, violationClassifier } from "#adapter/witness/classify.ts"
import { type KeyLaws, keyLaws } from "#adapter/witness/keylaw.ts"
import type { CheckedEntry } from "#compiler/analysis/schema.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { entryKey } from "#compiler/write/frontend/entry.ts"
import { type KeyDecoder, keyWitness, witnessDecoder } from "#compiler/write/program/outcome.ts"

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

/**
 * Witness decoding in the adapter.
 *
 * An `invariant-rejected` outcome carries the law it broke, as the schema states it (types/changeset Law), and its
 * witness: a key, or why it names none, assembled from fields grizzle controls and never from PostgreSQL's message or
 * DETAIL prose. This module decodes the violations a statement or a COMMIT raises into that pair, for one opened
 * installation:
 *
 * - keylaw.ts: the key-law tables, installed constraint and unique index names to laws under their owners, a domain
 *   constraint's under the domain PostgreSQL reports as the data type, every law of the theory under its identity,
 *   each law carrying its description, and each roster's domain, which is no law's;
 * - classify.ts: the classifier, a write statement's raised refusal through its DETAIL into the refused key or the
 *   concurrent change it met, a native violation through its constraint identity into the laws it breaks with an
 *   unreported key, a roster domain's violation into grizzle's own defect, anything else not a law outcome.
 *
 * The classifier is the hook the outcome mapping of packages/grizzle/src/adapter/outcomes consumes after the aborts are decided:
 * db.apply, a prepared apply and the COMMIT of each classify through it (packages/grizzle/src/adapter/apply WriteEntry).
 * A DbLayer builds it once per role, beside the role's artifacts, when the layer is built (pool/registry.ts).
 *
 * One installation's witness decoding.
 */
export interface InstallationWitness {
	readonly laws: KeyLaws
	readonly classify: ViolationClassifier
}

/**
 * The witness decoding of a compiled installation (see the header). An opened Db's artifacts are compiled from the
 * schema whose snapshot the database holds (adapter/db/open.ts), so their key-law map names the installed constraints.
 */
export const installationWitness = (
	artifacts: Pick<SchemaArtifacts, "names" | "constraintLaws" | "theoryLaws" | "world" | "derived">
): InstallationWitness => {
	const checked = artifacts.derived.schema
	const laws = keyLaws({
		names: artifacts.names,
		constraintLaws: artifacts.constraintLaws,
		theoryLaws: artifacts.theoryLaws
	})
	/**
	 * The WriteProgram's decoder over the whole schema: a refusal's key text decodes through its column's result
	 * codec, exactly as a compiled program reads it. A role names a key of a relation it writes through a query entry
	 * in the entry's vocabulary (write/frontend/entry.ts entryKey).
	 */
	const base = witnessDecoder({
		written: [],
		relations: checked.relations,
		codes: artifacts.names.codes
	})
	const entries = writtenEntries(artifacts)
	const decoder: KeyDecoder = {
		fromRefusal: (relation, key) => {
			const found = base.fromRefusal(relation, key)
			if (found === undefined) {
				return undefined
			}
			const entry = entries.get(found.relation)
			return entry === undefined ? found : keyWitness(entry.entry, entryKey(entry, found.values))
		}
	}
	return { laws, classify: violationClassifier(laws, decoder, new Set(checked.relations.keys())) }
}
