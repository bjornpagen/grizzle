import { dictionary } from "@bjornpagen/testing/dictionary"

/**
 * The ways a data step a person writes runs: a custom migration's transactional file that commits, one whose later
 * statement fails, and a no-transaction one, whose statements run alone (adapter/migrate/apply.ts runFile), and a step
 * written at a draft's data-step slot (deploy/diff/diff.ts unguard), and a custom one before a roster shrink whose
 * VALIDATE it clears the way for. The migration's own kinds of step, never cases a person chose.
 */
export const dataSteps = dictionary([
	"commits",
	"fails",
	"alone",
	"at a draft's slot",
	"before a roster shrink"
] as const)
