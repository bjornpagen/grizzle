import { defined } from "#compiler/core/invariant.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { type KeyAlternative, type KeyProof, keyWith } from "#compiler/ir/keys.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"

/**
 * A key a derived or world relation inherits from its definition: its columns, columns of its heading in heading order,
 * the proof that they are a key, and the other minimal keys of its factors its definition proves, which a Base over the
 * view states beside it (ir/keys.ts ViewKey alternatives): none but on the first key of a proof.
 */
export interface InheritedKey<C extends HeadingColumn> {
	readonly columns: NonEmptyReadonlyArray<C>
	readonly proof: KeyProof
	readonly alternatives: ReadonlyArray<KeyAlternative>
}

/**
 * A definition's proved keys as a derived relation's keys, over its heading's columns: of each of the root's proofs
 * (logical/props.ts), its key with its factors' alternatives, then each key one alternative away from it, each proved
 * by its own derivation (`prove`), each in heading order, narrowest first, then by the heading positions of their
 * columns. Every other minimal key of the definition chooses among their factors, which the first key's alternatives
 * state, so a definition of k independent factors of two keys each is k + 1 keys, each with its unique index, never
 * 2^k. A key is over classes of equal columns and states each class by its first column in heading order, so a view
 * has one unique index per key of its classes; another column of a class stands for its first (ViewKey members).
 * When the root has the empty key, at most one fact, the one key is the first heading column `representable` admits as
 * a one-column key, or the whole heading when it admits none (whose own check then refuses it), its proof the empty
 * key's.
 *
 * The keys a derived relation inherits from its definition.
 *
 * A derived relation is a Base over its materialized view, and its keys are the ones its definition proves. The checker
 * types the Base by the definition's head, keys it by the whole heading under its own evidence, and stamps it with the
 * inherited keys (ir/rel.ts ViewBase view), which annotate (logical/annotate.ts) rewrites the Base to under evidence
 * that admits them. The checked schema computes them once, when it is built (analysis/derived/analyze.ts
 * analyzeDerivedRelation): it checks each definition, analyzes it with the lower levels' inherited keys, and reads the
 * root's keys, so the keys every compilation reads are the ones the view's unique indexes state. A root of one heading
 * group always proves its whole heading, so it has a minimal key; a definition proved to hold at most one fact proves
 * the empty key, which no unique index over plain columns states: every single column of it is then a key, and its
 * first column in heading order whose unique index entry is representable is the one key, so the index a query relies
 * on is the one the view has.
 */
export const inheritedKeys = <C extends HeadingColumn>(
	heading: NonEmptyReadonlyArray<C>,
	proved: ReadonlyArray<KeyProof>,
	prove: (columns: ReadonlyArray<string>) => KeyProof | undefined,
	representable: (column: C) => boolean
): ReadonlyArray<InheritedKey<C>> => {
	const empty = proved.find((k) => k.key.length === 0)
	if (empty !== undefined) {
		const single = heading.find((c) => representable(c))
		return [{ columns: single === undefined ? heading : [single], proof: empty, alternatives: [] }]
	}
	const position = new Map(heading.map((c, i) => [c.name, i]))
	const at = (c: C) => defined(position.get(c.name), "a key's column is a column of its heading")
	const listed = proved.flatMap((proof) => [
		{ proof, alternatives: proof.alternatives },
		...proof.alternatives.flatMap((a) => {
			const swapped = prove(keyWith(proof, a))
			return swapped === undefined ? [] : [{ proof: swapped, alternatives: [] }]
		})
	])
	return listed
		.flatMap((k): ReadonlyArray<InheritedKey<C>> => {
			const columns = heading.filter((c) => k.proof.key.includes(c.name))
			return isNonEmpty(columns) ? [{ columns, proof: k.proof, alternatives: k.alternatives }] : []
		})
		.toSorted((a, b) => {
			if (a.columns.length !== b.columns.length) {
				return a.columns.length - b.columns.length
			}
			for (const [i, c] of a.columns.entries()) {
				const d = at(c) - at(defined(b.columns[i], "two keys of one width"))
				if (d !== 0) {
					return d
				}
			}
			return 0
		})
}
