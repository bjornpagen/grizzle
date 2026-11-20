import { dictionary } from "@bjornpagen/testing/dictionary"

/**
 * The ways a data step a person writes runs: a custom migration's transactional file that commits, one whose later
 * statement fails, and a no-transaction one, whose statements run alone (adapter/migrate/apply.ts runFile), and a step
 * written at a draft's data-step slot (deploy/diff/diff.ts unguard). The migration's own kinds of step, never cases a
 * person chose.
 */
export const dataSteps = dictionary(["commits", "fails", "alone", "at a draft's slot"] as const)
