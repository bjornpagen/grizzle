import { defect } from "#text/base/invariant.ts"

/**
 * The entry of a table of the regex automata at an index its algorithm keeps below the table's length. The one site of
 * the fact that the automaton algorithms (nfa.ts, dfa.ts) index a table only by the dense numbers their
 * construction minted for it, every table sized by that count (graph edges name their targets, Hopcroft's partition its
 * blocks and positions, the subset construction its states), and that a set's binary search (charset.ts) probes only
 * between its bounds. These are runtime lengths, which no TypeScript type of an array carries.
 */
export const entry = <T>(table: ArrayLike<T>, index: number): T => {
	const found = table[index]
	if (found === undefined) {
		throw defect(`an automaton table entry at ${index} of ${table.length}`)
	}
	return found
}

/**
 * entry over an Int32Array, the automata's dense tables of numbers (dfa.ts, subset.ts, partition.ts): one kind of table
 * at its one load, where entry's load meets every kind the automata index, arrays of objects and of numbers and typed
 * arrays, and V8 reads a load that meets many kinds through its slowest path. The inner loops of the subset
 * construction and minimization read their Int32Arrays here.
 */
export const cell = (table: Int32Array, index: number): number => {
	const found = table[index]
	if (found === undefined) {
		throw defect(`an automaton table entry at ${index} of ${table.length}`)
	}
	return found
}
