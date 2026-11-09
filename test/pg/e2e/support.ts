import { installed } from "#test/pg/reads/support.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { workFacts } from "#test/support/fixtures/golden/work.ts"

/**
 * Shared helpers for the end-to-end suites: the worked example's Work installed under a fresh schema and
 * opened through Db.open and a DbLayer, as test/pg/reads/support.ts does for every read and write suite.
 *
 * The worked example's Work with its facts and its alternatives, every law native, under a fresh schema name.
 */
export const openWork = installed(W.Work, workFacts, {
	label: "real",
	extensions: [],
	programs: {}
})
