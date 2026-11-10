import { installed } from "#test/pg/reads/support.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { workFacts } from "#test/support/fixtures/golden/work.ts"

/**
 * Shared helpers for the end-to-end suites: the worked example's Work installed under a fresh schema and
 * opened through Db.open and its login's served layer, as test/pg/reads/support.ts does for every read and write suite.
 *
 * The worked example's Work with its facts and its alternatives, every law native, under a fresh schema name, its
 * login's workload holding `programs`.
 */
export const openWork = <const P extends Readonly<Record<string, unknown>>>(programs: P) =>
	installed(W.Work, workFacts, {
		label: "real",
		extensions: [],
		programs
	})
