/**
 * The forms a grizzle case's database takes (test/support/substrate/substrate.ts): a clone of the base template a case
 * (Substrate.fresh), a clone of an installed template a case (Substrate.freshOf), the worker's own clone of it held
 * across cases and reset after each (Substrate.seat), and one owner transaction a case on the worker's own clone
 * (Substrate.rolledBack). Each case writes into what it was given and requires to find what its form promises: a clean
 * test database, or the template's installation and no row an earlier case wrote, every login of the installation
 * logging in with the credentials the case derives from the member's owner password.
 */
import { int } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	firstCaseDeadline,
	loggedIn,
	secondWorkTemplate,
	servedTemplate,
	servedWorld,
	oneOfCase,
	workTemplate,
	writtenAccounts
} from "#test/pg/substrate/forms.fixtures.ts"
import { assert } from "#test/support/assert.ts"
import { Work } from "#test/support/fixtures/api/work.ts"
import { Served } from "#test/support/served-db.ts"
import { leftovers } from "#test/support/substrate/shared.ts"
import { roleSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A case's own clone of the base template is a clean test database (shared.ts leftovers: the test settings and
 * nothing else), whatever the cases before it left in theirs, and a role it allocates logs in.
 */
export const freshBase = property.explore(int(1, 4), {
	needs: { substrate: Substrate.fresh },
	caseDeadline: firstCaseDeadline,
	situations: [],
	check:
		({ substrate }) =>
		(rows) =>
			Effect.gen(function* () {
				const s = yield* substrate
				const left = yield* leftovers(s.admin)
				assert.deepEqual(left, [], "the clone is a clean test database")
				const schema = yield* s.schema({ create: true, label: "forms" })
				const role = yield* s.role(schema, "reader")
				yield* s.admin.query(
					"CREATE TABLE public.stray AS SELECT n FROM pg_catalog.generate_series(1, $1::int4) AS n",
					[rows]
				)
				const reader = yield* s.session(roleSession(role))
				yield* reader.query("SELECT 1", [])
			}).pipe(Effect.scoped),
	oracle: {
		kind: "specification",
		name: "a case's database is a clean clone of the base template"
	},
	kept: [],
	kills: []
})

/** A case's own clone of an installed template holds its installation, no earlier case's rows, and its logins. */
export const freshInstalled = property.explore(int(1, 4), {
	needs: { work: Substrate.freshOf(workTemplate) },
	caseDeadline: firstCaseDeadline,
	situations: [],
	check:
		({ work }) =>
		(rows) =>
			Effect.gen(function* () {
				const { substrate, value } = yield* work
				yield* writtenAccounts(substrate.admin, value, rows)
				yield* loggedIn(substrate, value)
			}),
	oracle: { kind: "specification", name: "a case's clone holds its template's installation alone" },
	kept: [],
	kills: []
})

/** The worker's own clone of an installed template, held across cases, is its template again before every case. */
export const seated = property.explore(int(1, 4), {
	needs: { work: Substrate.seat(workTemplate) },
	caseDeadline: firstCaseDeadline,
	situations: [],
	check:
		({ work }) =>
		(rows) =>
			Effect.gen(function* () {
				const { substrate, value } = yield* work
				yield* writtenAccounts(substrate.admin, value, rows)
				yield* loggedIn(substrate, value)
			}),
	oracle: { kind: "specification", name: "a seat is reset to its template after every case" },
	kept: [],
	kills: []
})

/** One owner transaction a case on the worker's own clone, rolled back after it, so the next finds no row of it. */
export const rolledBack = property.explore(int(1, 4), {
	needs: { work: Substrate.rolledBack(workTemplate) },
	caseDeadline: firstCaseDeadline,
	situations: [],
	check:
		({ work }) =>
		(rows) =>
			Effect.gen(function* () {
				const { connection, value } = yield* work
				yield* writtenAccounts(connection, value, rows)
			}),
	oracle: { kind: "specification", name: "a rolled-back case leaves its clone as its template" },
	kept: [],
	kills: []
})

/**
 * A login served over a case's own clone of a generated template (Served.of): its served layer connects to the clone
 * with the password its template derives, and its workload reads what the case wrote.
 */
export const served = property.explore(int(1, 4), {
	needs: { work: Served.of(servedWorld(Work).server, Substrate.freshOf(servedTemplate)) },
	caseDeadline: firstCaseDeadline,
	situations: [],
	check:
		({ work }) =>
		(rows) =>
			Effect.gen(function* () {
				const { substrate, installed, fixture } = yield* work
				yield* writtenAccounts(substrate.admin, installed, rows)
				const read = yield* Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Db.open(fixture.login.roles.app, {})
						return yield* db.workload.accounts.once({ params: {}, facts: {} })
					})
				).pipe(withLayer(fixture.layer))
				assert.equal(read.size, rows, "the served login reads the case's accounts")
			}),
	oracle: { kind: "specification", name: "a served login reads its case's own clone" },
	kept: [],
	kills: []
})

/**
 * A case's choice among a closed set of templates (Substrate.oneOf): each key a need of its own, of which a case takes
 * only the one it draws, holding that template's installation and no row of another case's.
 */
export const oneOfTemplates = property.explore(oneOfCase, {
	needs: Substrate.oneOf({ first: workTemplate, second: secondWorkTemplate }, Substrate.freshOf),
	caseDeadline: firstCaseDeadline,
	situations: [],
	check:
		(work) =>
		([key, rows]) =>
			Effect.gen(function* () {
				const { substrate, value } = yield* work[key]
				yield* writtenAccounts(substrate.admin, value, rows)
			}),
	oracle: {
		kind: "specification",
		name: "a case takes the one template it draws, as its own clone"
	},
	kept: [],
	kills: []
})
