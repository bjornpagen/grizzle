/**
 * The forms a grizzle case's database takes (test/support/substrate/substrate.ts): a clone of an installed template a
 * case (Substrate.fresh), and one owner transaction a case on the worker's own clone (Substrate.rolledBack). Each case
 * writes into what it was given and requires to find what its form promises: the template's installation and no row an
 * earlier case wrote, every login of the installation logging in with the credentials the case derives from the
 * member's owner password. A case that holds several fresh clones at once and a full pool's sessions beside them holds
 * every connection within its worker's budget, which each substrate widens by its own sessions.
 */
import { assert } from "@bjornpagen/testing/assert"
import { finite, int } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { quoteString } from "#compiler/core/text.ts"
import {
	immutableTriggerName,
	immutableTruncateTriggerName
} from "#compiler/physical/ddl/immutable.ts"
import {
	loggedIn,
	secondWorkTemplate,
	servedTemplate,
	servedWorld,
	heldWorkTemplates,
	oneOfCase,
	workTemplate,
	writtenAccounts
} from "#test/pg/substrate/forms.fixtures.ts"
import { Account, Work } from "#test/support/fixtures/api/work.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { Served } from "#test/support/served-db.ts"
import { testPoolMax } from "#test/support/substrate/connections.ts"
import { connect } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A case's own clone of an installed template holds its installation, no earlier case's rows, and its logins. */
export const freshInstalled = property.exhaust(finite(int(1, 4)), {
	needs: { work: Substrate.fresh(workTemplate) },
	situations: [],
	check:
		({ work }) =>
		(rows) =>
			Effect.gen(function* () {
				const { substrate, value } = yield* work
				yield* writtenAccounts(substrate.admin, value.installed, rows)
				yield* loggedIn(substrate, value.installed)
			}),
	oracle: { kind: "specification", name: "a case's clone holds its template's installation alone" },
	box: "every count of rows a case writes, one to four",
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
/**
 * A case that holds `count` fresh clones at once, each of a template of its own and so a need of its own (a case's
 * need is one value however often it takes it), each its own substrate, and a full pool's sessions on one of them
 * (testPoolMax, one for each CPU of the run's allowance) holds every connection within its worker's budget: each
 * substrate widens the budget by its own sessions for its life (substrate.ts substrateHeld), so the budget is the
 * case's demand, its substrates' sessions and one pool, at any count and any width, where one pool and one substrate's
 * sessions were the whole budget and a case of five fresh databases under a 16-CPU allowance asked past it (lowering
 * and rule-seeding under grizzle.slice's quota, 2026-11-24).
 */
export const aCaseOfFreshSubstratesAndAFullPoolStaysWithinItsBudget = property.exhaust(
	finite(int(1, 4)),
	{
		needs: {
			first: Substrate.fresh(heldWorkTemplates.first),
			second: Substrate.fresh(heldWorkTemplates.second),
			third: Substrate.fresh(heldWorkTemplates.third),
			fourth: Substrate.fresh(heldWorkTemplates.fourth)
		},
		situations: [],
		check:
			({ first, second, third, fourth }) =>
			(count) =>
				Effect.gen(function* () {
					const held = yield* Effect.forEach(
						Arr.take([second, third, fourth], count - 1),
						(need) => need
					)
					const taken = yield* first
					const { substrate } = Arr.lastNonEmpty(Arr.prepend(held, taken))
					const pool = yield* Effect.forEach(
						Array.from({ length: testPoolMax }, (_, at) => at),
						(at) =>
							connect(substrate.cluster, {
								database: substrate.database,
								credentials: substrate.owner,
								label: `pool ${at}`
							}),
						{ concurrency: "unbounded" }
					)
					const answered = yield* Effect.forEach(
						pool,
						(session) => session.queryValues("SELECT 1", []),
						{ concurrency: "unbounded" }
					)
					assert.deepEqual(answered.length, testPoolMax)
				}),
		oracle: {
			kind: "specification",
			name: "a case holding any count of fresh substrates at once and a full pool beside them opens every connection it asks for, its worker's budget granting each substrate's sessions and one pool"
		},
		box: "every count of fresh clones a case holds at once beside a full pool, one to four, each of a template of its own",
		kept: [],
		kills: [
			{
				file: "test/support/substrate/substrate.ts",
				original: "\tcluster.budget.widened(substrateConnections)\n",
				replacement: "\tEffect.void\n",
				why: "A worker's budget is one pool and a few sessions whatever its case holds, sized by the CPUs alone, so a case of several fresh substrates asks past it under a narrow allowance (lowering and rule-seeding under grizzle.slice's 16-CPU quota, 2026-11-24: ConnectionBudgetExhausted at 18); the property fails, its pool's sessions refused."
			}
		]
	}
)

export const rolledBack = property.exhaust(finite(int(1, 4)), {
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
				const visited = yield* connection.queryValues(
					"SELECT c.relname::text FROM pg_catalog.pg_class AS c WHERE c.relkind = 'r' AND c.relnamespace IN (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema') AND NOT coalesce('autovacuum_enabled=false' = ANY (c.reloptions), false) ORDER BY 1",
					[]
				)
				assert.deepEqual(
					visited,
					[],
					"every table of a case's clone keeps autovacuum out (substrate.ts autovacuumOff), its sizes the case's alone"
				)
				const guards = yield* connection.queryValues(
					`SELECT g.tgname::text FROM pg_catalog.pg_trigger AS g WHERE g.tgrelid = ${quoteString(namesOf(value.installed).table(Account))}::pg_catalog.regclass AND g.tgname IN (${quoteString(immutableTriggerName)}, ${quoteString(immutableTruncateTriggerName)}) ORDER BY 1`,
					[]
				)
				assert.deepEqual(
					guards,
					Arr.map(
						Arr.sort([immutableTriggerName, immutableTruncateTriggerName], Order.String),
						(name) => [name]
					),
					"the closed table every case writes and the seat empties carries both its guards, the bracket around the seat's TRUNCATE (substrate.ts madeFresh) creating each again"
				)
				yield* writtenAccounts(connection, value.installed, rows)
			}),
	oracle: {
		kind: "specification",
		name: "a rolled-back case leaves its clone as its template, holds no transaction id it did not write for, finds every table of its clone kept from autovacuum, and finds the closed table it writes, which the seat empties after each case, guarded"
	},
	box: "every count of rows a case writes, one to four",
	kept: [],
	kills: [
		{
			file: "test/support/substrate/substrate.ts",
			original: "\t\t\t\t\t\t\t{ sql: autovacuumOff(cloneTables), params: [] },\n",
			replacement: "",
			why: "A clone's tables are left to autovacuum, as before: a VACUUM it starts on a table past its thresholds, every earlier case's rows dead and counted, writes the table's sizes into pg_class in place mid-case, and probe-share's judge read 384 rows at two shares against 192 at one under a 16-worker gate; the property fails, the clone's tables visited."
		},
		{
			file: "test/support/substrate/replace.ts",
			original: "\t\tbracket.before,\n",
			replacement: "",
			why: "The seat's reset TRUNCATEs outside the guard bracket: a closed relation's TRUNCATE guard refuses it (Account, which every case writes), so the clone cannot be reset and the property fails."
		},
		{
			file: "test/support/substrate/replace.ts",
			original: "\t\tbracket.after,\n",
			replacement: "",
			why: "The seat's reset lifts the guards of the closed tables it empties and never creates them again: the next case finds Account unguarded, its rows open to UPDATE, DELETE and TRUNCATE; the property fails."
		},
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
export const served = property.exhaust(finite(int(1, 4)), {
	needs: { work: Served.of(servedWorld(Work).server, Substrate.fresh(servedTemplate)) },
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
	box: "every count of rows a case writes, one to four",
	kept: [],
	kills: [
		{
			file: "packages/engine/src/physical/install/compile.ts",
			original:
				"\t\tconst domains = [\n\t\t\tb.names.digestDomain,\n\t\t\t...rosters.flatMap((r) =>\n\t\t\t\tr.bits === undefined ? [r.domain.name] : [r.domain.name, r.bits.domain.name]\n\t\t\t),\n\t\t\t...addTextDomains(b, plan.textPlans),\n\t\t\t...addContractDomains(b),\n\t\t\t...addOutsideContractDomains(b, plan.outsideContracts),\n\t\t\t...variants.map((v) => v.domain)\n\t\t]",
			replacement:
				"\t\tconst domains = [b.names.digestDomain, ...addTextDomains(b, plan.textPlans), ...addContractDomains(b), ...addOutsideContractDomains(b, plan.outsideContracts), ...variants.map((v) => v.domain)]",
			why: "Operator mutant (element) at packages/engine/src/physical/install/compile.ts:440 in installationOver: `[\n\t\t\t\t\t...rosters.flatMap((r) =>\n\t\t\t\t\t\tr.bits === undefined ? [r.domain.name] : ` becomes `[...addTextDomains(b, plan.textPlans), ...addContractDomains(b), ...addOutsideCo`; the property fails (lane CATCH, grizzle 0baff5d6)."
		}
	]
})

/**
 * A case's choice among a closed set of templates (Substrate.oneOf): each key a need of its own, of which a case takes
 * only the one it draws, holding that template's installation and no row of another case's.
 */
export const oneOfTemplates = property.exhaust(finite(oneOfCase), {
	needs: Substrate.oneOf({ first: workTemplate, second: secondWorkTemplate }, Substrate.fresh),
	situations: [],
	check:
		(work) =>
		([key, rows]) =>
			Effect.gen(function* () {
				const { substrate, value } = yield* work[key]
				yield* writtenAccounts(substrate.admin, value.installed, rows)
			}),
	oracle: {
		kind: "specification",
		name: "a case takes the one template it draws, as its own clone"
	},
	box: "each of the two templates, with every count of rows a case writes, one to four",
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
