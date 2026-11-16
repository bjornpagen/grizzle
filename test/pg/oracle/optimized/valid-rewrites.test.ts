/**
 * The mutant suite's five valid transformations are performed by the optimized lowering, which its certificates
 * assert.
 *
 * Each runs on the generated population rooted at the construct its rule is about (test/support/oracle/mutants
 * cases.ts, the valid-mutant populations, dense facts) through the optimized differential, so every case also agrees
 * with the conservative lowering in raw sets with no repeated row. On some cases, which the suite's feature
 * registry requires, the optimized artifact performs the transformation, and wherever its certificate is recorded the
 * emitted SQL shows it, read from the statements' ASTs, never from the text:
 *
 * | V  | Certificate       | What the optimized statements show against the conservative ones     |
 * | V1 | R17.elide.retainedPrimaryKey    | fewer DISTINCT cores                                                  |
 * | V2 | R17.elide.combinedJoinKeys      | fewer DISTINCT cores                                                  |
 * | V3 | R02.existence                   | an EXISTS whose query has no DISTINCT core, which the conservative lowering never emits |
 * | V5 | R17.unionAll                    | a UNION ALL, which the conservative lowering never emits              |
 * | V6 | R17.recursiveTerms              | a WITH RECURSIVE whose seed and step cores, and the derived tables they read directly, carry no DISTINCT, which the conservative lowering never emits |
 *
 * Oracle: the conservative lowering's raw text sets, and each rule's certificate read from the statements' ASTs.
 *
 * Features: each valid rule's certificate recorded.
 */
import { family } from "@bjornpagen/testing/property"
import { validRewriteRules } from "#test/pg/oracle/optimized/suite.ts"
import { performed } from "#test/pg/oracle/optimized/valid-rewrites.fixtures.ts"
import { defaultGenConfig } from "#test/support/oracle/gen/case.ts"
import {
	closureRoot,
	keyedJoinRoot,
	projectRoot,
	rootedCaseGen,
	taggedUnionRoot,
	witnessRoot
} from "#test/support/oracle/mutants/cases.ts"

/** Each valid transformation, performed and certified on its mutant's population: a member of a family each. */
export const validRewrites = family({
	V1: performed("V1", rootedCaseGen(projectRoot, defaultGenConfig), validRewriteRules[0], [
		{
			file: "packages/engine/src/lower/optimize/dedup/place.ts",
			original: "\t\tconst outstanding = a.obligations.flatMap((o) => (o.discharged ? [] : [o]))",
			replacement: "\t\tconst outstanding = a.obligations.flatMap(() => [])",
			why: "The dedup placement discharges no obligation (lower/optimize/dedup/place.ts), so a DISTINCT owed is never placed and the optimized artifact repeats rows."
		}
	]),
	V2: performed("V2", rootedCaseGen(keyedJoinRoot, defaultGenConfig), validRewriteRules[1], []),
	V3: performed("V3", rootedCaseGen(witnessRoot, defaultGenConfig), validRewriteRules[2], []),
	V5: performed("V5", rootedCaseGen(taggedUnionRoot, defaultGenConfig), validRewriteRules[3], []),
	V6: performed("V6", rootedCaseGen(closureRoot(false), defaultGenConfig), validRewriteRules[4], [])
})
