/**
 * The optimized lowering never reproduces the counterexamples of the invalid mutants I1-I8 (counterexamples.ts): one
 * family, a member per mutant's population, keyed by the mutant, in place of the two shards that split the populations
 * between two files.
 *
 * Oracle: the conservative lowering's raw text sets, the invalid mutant beside the optimized artifact on the same
 * installation and facts (counterexamples.ts).
 *
 * Features: a case the mutant rewrote, and one on which it was told apart.
 */
import { nonReproductions } from "#test/pg/oracle/optimized/counterexamples.ts"

/** Each invalid mutant's population: the optimized lowering never reproduces its counterexample. */
export const nonReproduction = nonReproductions()
