/**
 * The forms a grizzle case's database takes (test/support/substrate/substrate.ts): a clone of an installed template a
 * case (Substrate.freshOf), the worker's own clone of it held across cases and reset after each (Substrate.seat), and
 * one owner transaction a case on the worker's own clone (Substrate.rolledBack). Each case writes into what it was given
 * and requires to find what its form promises: the template's installation and no row an earlier case wrote, every
 * login of the installation logging in with the credentials the case derives from the member's owner password.
 */
import { assert } from "@bjornpagen/testing/assert"
import { int } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	loggedIn,
	secondWorkTemplate,
	servedTemplate,
	servedWorld,
	oneOfCase,
	workTemplate,
	writtenAccounts
} from "#test/pg/substrate/forms.fixtures.ts"
import { Work } from "#test/support/fixtures/api/work.ts"
import { Served } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A case's own clone of an installed template holds its installation, no earlier case's rows, and its logins. */
export const freshInstalled = property.explore(int(1, 4), {
	needs: { work: Substrate.freshOf(workTemplate) },
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
	kills: [
		{
			file: "packages/engine/src/physical/install/compile.ts",
			original: "\t\tconst level = owned.levels[login.base.levels.length - 1]",
			replacement: "\t\tconst level = owned.levels[login.base.levels.length - 2]",
			why: "Operator mutant (bound) at packages/engine/src/physical/install/compile.ts:341 in admittedSettings: `1` becomes `2`; the property fails (lane CATCH, grizzle 0baff5d6)."
		}
	]
})

/** The worker's own clone of an installed template, held across cases, is its template again before every case. */
export const seated = property.explore(int(1, 4), {
	needs: { work: Substrate.seat(workTemplate) },
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
	kills: [
		{
			file: "packages/engine/src/physical/install/compile.ts",
			original: "\t\tconst level = owned.levels[login.base.levels.length - 1]",
			replacement: "\t\tconst level = owned.levels[login.base.levels.length - 2]",
			why: "Operator mutant (bound) at packages/engine/src/physical/install/compile.ts:341 in admittedSettings: `1` becomes `2`; the property fails (lane CATCH, grizzle 0baff5d6)."
		}
	]
})

/**
 * One owner transaction a case on the worker's own clone, rolled back after it, so the next finds no row of it, and
 * holding no transaction id until the case writes: a logical slot's making waits for every transaction holding one
 * (substrate.ts transactionBegan), so a case's transaction holds one only once its own write assigns it.
 */
export const rolledBack = property.explore(int(1, 4), {
	needs: { work: Substrate.rolledBack(workTemplate) },
	situations: [],
	check:
		({ work }) =>
		(rows) =>
			Effect.gen(function* () {
				const { connection, value } = yield* work
				const assigned = yield* connection.queryValues(
					"SELECT pg_catalog.pg_current_xact_id_if_assigned()::text",
					[]
				)
				assert.deepEqual(
					assigned,
					[[null]],
					"a case's transaction holds no transaction id before the case writes"
				)
				yield* writtenAccounts(connection, value, rows)
			}),
	oracle: {
		kind: "specification",
		name: "a rolled-back case leaves its clone as its template, and holds no transaction id it did not write for"
	},
	kept: [],
	kills: [
		{
			file: "test/support/substrate/substrate.ts",
			original:
				"\t\"SELECT pg_catalog.extract('epoch', pg_catalog.transaction_timestamp())::text\"",
			replacement: '\t"SELECT pg_catalog.pg_current_xact_id()::text"',
			why: "A case's transaction is named by its transaction id, read as it begins, as before: every rolled-back case holds one for its whole length, and a logical slot's making waits for it (EVALCOMPILE2's decoder-derivation: the slot's making held up behind rolled-back cases); this property fails."
		},
		{
			file: "packages/engine/src/physical/install/compile.ts",
			original: "\t\tconst level = owned.levels[login.base.levels.length - 1]",
			replacement: "\t\tconst level = owned.levels[login.base.levels.length - 2]",
			why: "Operator mutant (bound) at packages/engine/src/physical/install/compile.ts:341 in admittedSettings: `1` becomes `2`; the property fails (lane CATCH, grizzle 0baff5d6)."
		}
	]
})

/**
 * A login served over a case's own clone of a generated template (Served.of): its served layer connects to the clone
 * with the password its template derives, and its workload reads what the case wrote.
 */
export const served = property.explore(int(1, 4), {
	needs: { work: Served.of(servedWorld(Work).server, Substrate.freshOf(servedTemplate)) },
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
	kills: [
		{
			file: "packages/engine/src/physical/install/compile.ts",
			original:
				"\t\t\t\tconst domains = [\n\t\t\t\t\tb.names.digestDomain,\n\t\t\t\t\t...rosters.flatMap((r) =>\n\t\t\t\t\t\tr.bits === undefined ? [r.domain.name] : [r.domain.name, r.bits.domain.name]\n\t\t\t\t\t),\n\t\t\t\t\t...addTextDomains(b, plan.textPlans),\n\t\t\t\t\t...addContractDomains(b),\n\t\t\t\t\t...addOutsideContractDomains(b, plan.outsideContracts)\n\t\t\t\t]",
			replacement:
				"\t\t\t\tconst domains = [b.names.digestDomain, ...addTextDomains(b, plan.textPlans), ...addContractDomains(b), ...addOutsideContractDomains(b, plan.outsideContracts)]",
			why: "Operator mutant (element) at packages/engine/src/physical/install/compile.ts:440 in installationOver: `[\n\t\t\t\t\t...rosters.flatMap((r) =>\n\t\t\t\t\t\tr.bits === undefined ? [r.domain.name] : ` becomes `[...addTextDomains(b, plan.textPlans), ...addContractDomains(b), ...addOutsideCo`; the property fails (lane CATCH, grizzle 0baff5d6)."
		}
	]
})

/**
 * A case's choice among a closed set of templates (Substrate.oneOf): each key a need of its own, of which a case takes
 * only the one it draws, holding that template's installation and no row of another case's.
 */
export const oneOfTemplates = property.explore(oneOfCase, {
	needs: Substrate.oneOf({ first: workTemplate, second: secondWorkTemplate }, Substrate.freshOf),
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
	kills: [
		{
			file: "packages/engine/src/physical/install/compile.ts",
			original: "\t\tconst level = owned.levels[login.base.levels.length - 1]",
			replacement: "\t\tconst level = owned.levels[login.base.levels.length - 2]",
			why: "Operator mutant (bound) at packages/engine/src/physical/install/compile.ts:341 in admittedSettings: `1` becomes `2`; the property fails (lane CATCH, grizzle 0baff5d6)."
		}
	]
})
