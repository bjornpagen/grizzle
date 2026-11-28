/**
 * A served statement is planned once a session and is one statement in every session, on PostgreSQL 19, and no call
 * makes a relation, its session's first among them: the rule judge's log stands since the installation (physical/ddl/
 * rules.ts addRules), so no call's transaction writes a catalog row, which every backend of the database would read and
 * which made every plan over a session's relation again (metis's assign planned 28 statements and 70 in functions again
 * at its second call, when each session stood its write's deltas up as temporary tables; under connection churn,
 * METIS-PERFBAR's start read 12,659 pages where it reads about 2,000). A write's carriers are no session object: they
 * travel in its transaction's settings (write/carriers/carriers.ts), so no statement names an object of its session,
 * and a statement's text and its query id are its program's alone: the statement a second session sends is the
 * first's (edullm Q14, assign's slot read a new statement in every session; contract C5), where a carrier, a temporary
 * table, made each a statement of its own in each session, its OID the session's. Every call after the first plans
 * nothing either, rows filled past a page at every call among them.
 *
 * Each case: a put of a candidate-keyed relation a rule over a query reads (second-call.fixtures.ts), its facts staged
 * in a carrier of the program's own, served by two Dbs of the full world's login on a fresh clone whose backends count
 * every statement's plans (pg_stat_statements, turned on for the clone alone), one after the other, each on a brand-new
 * backend; one key, sixteen, four hundred, past a page, four calls on each backend.
 *
 * And each call after a backend's first sends exactly its frame (BEGIN, the prologue, COMMIT) and the statements its
 * compiler states (runtime/write/flight.ts ServedWrite `sends`): no carrier statement or delta bookkeeping besides
 * (contract C6: start sent 130 statements a call against a shape of 18, the excess stand-ups, carriers and deltas).
 *
 * Oracle: PostgreSQL's pg_stat_statements, track all, its plans and calls of the clone's statements before and after
 * each call after a backend's first, the query ids the second backend's calls add, none, the client's statements each
 * call runs, and the catalog rows of the sessions' own relations and functions around every call. Every plan counted is
 * grizzle's: each permanent table the calls write stands counted large before them (test/support/advice.ts statsStood),
 * so autovacuum, whose vacuum or analyze would rewrite its counts in place and make every plan over it again, has
 * nothing to do with it while they run, as its own decision over the server's settings, the table's reloptions,
 * pg_stat's counts and every call's writes says (advice.ts autovacuumIdle), where under load it analyzed Fixed between
 * two calls and a judge statement planned again (CARRIERS).
 *
 * And a login below a rule's level has each write of a table the rule reads judged: the judge captures the table
 * whichever login writes it, so metis's assignment level's login, which wrote BoundLineItem, which only a rule of its xp
 * level reads, is judged by that rule. Each case: Fixed's insert by a login over Fixed's level alone, below Bounded's,
 * served under the installation's snapshot, two calls on one brand-new backend, each a fact under the bound or past it
 * (second-call.fixtures.ts runBelow). Oracle: the specification, Bounded over the facts: a lawful call accepted, an
 * unlawful one refused by Bounded as the level above states it.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type BelowFeature,
	belowGen,
	callsGen,
	runBelow,
	runCalls
} from "#test/pg/adapter/second-call.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * A brand-new backend's calls of a write change no catalog row of its session's own, its first among them, and after its
 * first plan nothing and send the statements their compiler states alone, and a second backend's send no statement the
 * first's did not.
 */
export const aServedStatementIsPlannedOnceASessionAndIsOneStatementInEverySession =
	property.exhaust(finite(callsGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["one key", "sixteen keys", "a call's log row past a page"],
		check:
			({ substrate }, c) =>
			(calls) =>
				Effect.provideServiceEffect(
					Effect.scoped(runCalls(calls, c)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "pg_stat_statements' plans and calls of the clone's statements around each call after a backend's first, none planned, the client's its frame and its stated statements, the query ids a second backend's calls add, none, and the catalog rows of the sessions' temporary relations and functions, unchanged around every call"
		},
		box: "a put of one key, sixteen and four hundred of a candidate-keyed relation a rule over a query reads, four calls on each of two brand-new backends of two served Dbs",
		kept: [],
		kills: [
			{
				file: "test/pg/adapter/second-call.fixtures.ts",
				original: '\t\tyield* statsStood(admin, stored, "large")\n',
				replacement: "",
				why: "Fixed stands at the counts its rows' insert left: sixteen keys' calls modify 512 rows past autovacuum's analyze threshold of 50 and some, so it may analyze Fixed between two calls, which plans every statement over it again, and the harness refuses the window."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: '\tout.line("BEGIN")\n\tconst statements = out.nested()',
				replacement:
					'\tout.line("BEGIN CREATE TEMPORARY TABLE IF NOT EXISTS __stood (c1 pg_catalog.int4) ON COMMIT PRESERVE ROWS;")\n\tconst statements = out.nested()',
				why: "One stand-up put back: every function of the installation stands a session table up at its session's first call, as each capture stood its deltas up before, so a brand-new backend's first call makes a relation of its temporary schema; the property fails."
			}
		]
	})

/** A login below a rule's level has each write of a table the rule reads judged by it. */
export const aLoginBelowARulesLevelHasEachWriteOfATableTheRuleReadsJudgedByIt = property.exhaust(
	finite(belowGen),
	{
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a lawful write accepted",
			"an unlawful write refused by the rule above",
			"a call after a refusal"
		] satisfies ReadonlyArray<Reached<BelowFeature>>,
		check:
			({ substrate }, c) =>
			(below) =>
				Effect.provideServiceEffect(
					Effect.scoped(runBelow(below, c)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "Bounded over the facts each call puts: a fact under the bound accepted, one past it refused by Bounded, named as the level above Fixed's states it"
		},
		box: "two calls of an insert of Fixed on one brand-new backend of a served Db of a login over Fixed's level, below Bounded's, each a fact under the bound or past it",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					'\t\t\t\t\t{\n\t\t\t\t\t\tkind: "createConstraintTrigger",\n\t\t\t\t\t\tname: identifierOf(identity.ruleJudge()),\n\t\t\t\t\t\ttable: log.arm,\n\t\t\t\t\t\tevents: [{ kind: "insert" }],\n\t\t\t\t\t\tfunction: judge\n\t\t\t\t\t}\n',
				replacement: "",
				why: "The arm stands without its trigger: no judge fires for the login's write, so a fact past Bounded's bound is accepted; the property fails."
			}
		]
	}
)
