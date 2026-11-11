import { type ViolationClassifier, violationClassifier } from "#adapter/witness/classify.ts"
import { type KeyLaws, keyLawsOf, type LawsAbove } from "#adapter/witness/keylaw.ts"
import type { KeyHost, KeyWitness } from "#compiler/plan/change.ts"
import type { Codebook, EntryName, StoredRelationName } from "#compiler/plan/common.ts"
import { keyWitness, witnessDecoder } from "#compiler/plan/runtime.ts"
import type { ServedEntryKey, ServedRefusals } from "#compiler/plan/serve.ts"

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
 * A DbLayer loads it once per role from the login's served file (served/load.ts).
 *
 * One installation's witness decoding.
 */
export interface InstallationWitness {
	readonly laws: KeyLaws
	readonly classify: ViolationClassifier
}

/** A query entry's key, from the key values of its target `values`: each head field's, the target field's it writes. */
const entryKey = <V>(
	entry: ServedEntryKey,
	values: Readonly<Record<string, V>>
): Readonly<Record<string, V>> => {
	const out: Record<string, V> = {}
	for (const [head, field] of entry.head) {
		const value = values[field]
		if (value !== undefined) {
			out[head] = value
		}
	}
	return Object.freeze(out)
}

/**
 * The witness of a key of the stored relation `relation`, in the words its role states its facts in: the relation's
 * own, or `entry`'s, the query entry the role writes the relation through.
 */
const statedWitness = (
	relation: StoredRelationName,
	entry: ServedEntryKey | undefined
): ((values: Readonly<Record<string, KeyHost>>) => KeyWitness) =>
	entry === undefined
		? (values) => keyWitness(relation, values)
		: (values) => keyWitness(entry.entry, entryKey(entry, values))

/**
 * The witness decoding of an installation from its refusals as data `refusals` (see the header), the laws of the levels
 * above its own `above`, and the codes it holds `codes`: what a layer builds once per role from its served file, and
 * the compile from a role's artifacts (adapter/served/refusals.ts installationWitness).
 */
export const servedWitness = (
	refusals: ServedRefusals,
	above: LawsAbove,
	codes: Codebook
): InstallationWitness => {
	const laws = keyLawsOf(refusals.laws, above, codes)
	/**
	 * The WriteProgram's decoder over every stored relation, by the name a refusal's DETAIL spells it: a refusal's key
	 * text decodes through its column's result codec, exactly as a compiled program reads it, and its witness states the
	 * key as the role states its facts, in a query entry's vocabulary where the role writes the relation through one.
	 */
	const decoder = witnessDecoder({
		relations: new Map(
			Array.from(refusals.relations, ([name, heading]) => [
				name,
				{ heading, witness: statedWitness(name, refusals.entries.get(name)) }
			])
		),
		codes
	})
	return {
		laws,
		classify: violationClassifier(laws, decoder, {
			stored: new Set(refusals.relations.keys()),
			entries: new Map(
				Array.from(refusals.entries.values(), (e): readonly [string, EntryName] => [
					e.entry,
					e.entry
				])
			)
		})
	}
}
