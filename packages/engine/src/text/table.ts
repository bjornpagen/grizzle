import { defect } from "#compiler/core/invariant.ts"

/**
 * The entry of a table of the text package at an index its algorithm keeps below the table's length. The one site of
 * the fact that the automaton algorithms (nfa.ts, dfa.ts) index a table only by the dense numbers their construction
 * minted for it, every table sized by that count (graph edges name their targets, Hopcroft's partition its blocks and
 * positions, the subset construction its states), and that a set's binary search (charset.ts) probes only between its
 * bounds. These are runtime lengths, which no TypeScript type of an array carries.
 */
export const entry = <T>(table: ArrayLike<T>, index: number): T => {
	const found = table[index]
	if (found === undefined) {
		throw defect(`an automaton table entry at ${index} of ${table.length}`)
	}
	return found
}
