import {
	generatedRules,
	type OptimizedFeature,
	rewriteFamilies
} from "#test/pg/oracle/optimized/suite.ts"

/**
 * The features the optimizer's population must reach, beyond the rules: pipelined attachments and heading groups run
 * (no attachment over exact parents fuses; the one that fuses, over approximate parents, is variants.test.ts's),
 * relation parameters also travel by VALUES, computed terms are evaluated, a fold is attached by a key the attachment
 * pairs with two parent columns, and cases deliver rows.
 */
export const optimizerSituations = [
	...generatedRules,
	...rewriteFamilies,
	"pipelined attachment",
	"heading groups",
	"computed term",
	"nested attachment",
	"per-parent take over an attachment",
	"a fold key correlated with two parent columns",
	"nonempty"
] as const satisfies ReadonlyArray<OptimizedFeature>
