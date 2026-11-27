/**
 * A served statement is planned once a session and is one statement in every session, on PostgreSQL 19: a session
 * stands a write up once, in a transaction of its own before its first call (adapter/apply/stand-up.ts), the rule
 * judge's session tables of the tables it writes (physical/ddl/rules.ts addStandUps), so no call's transaction makes a
 * relation, a catalog change the session would read at its next transaction, which made every plan over the relation
 * again: metis's assign planned 28 statements and 70 in functions again at its second call. A write's carriers are no
 * session object: they travel in its transaction's settings (write/carriers/carriers.ts), so no statement names an
 * object of its session, and a statement's text and its query id are its program's alone: the statement a second
 * session sends is the first's (edullm Q14, assign's slot read a new statement in every session; contract C5), where a
 * carrier, a temporary table, made each a statement of its own in each session, its OID the session's. Every call after
 * the first plans nothing either, deltas filled past a page at every call among them: their emptying gives the file back
 * only past the pages it keeps (sql/print.ts sessionTableKeptPages), where at one page it truncated at every call,
 * three invalidations each, and replanned what read the table (edullm's PERF-COMMIT grade at c1 bound 2.7 s at every
 * call).
 *
 * Each case: a put of a candidate-keyed relation a rule over a query reads (second-call.fixtures.ts), its facts staged
 * in a carrier of the program's own, served by two Dbs of the full world's login on a fresh clone whose backends count
 * every statement's plans (pg_stat_statements, turned on for the clone alone), one after the other, each on a brand-new
 * backend; one key, sixteen, four hundred, past a page, four calls on each backend.
 *
 * And each call after a backend's first sends exactly its frame (BEGIN, the prologue, COMMIT) and the statements its
 * compiler states (runtime/write/flight.ts ServedWrite `sends`): no stand-up, emptying, carrier statement or delta
 * bookkeeping besides (contract C6: start sent 130 statements a call against a shape of 18, the excess stand-ups,
 * carriers and deltas).
 *
 * Oracle: PostgreSQL's pg_stat_statements, track all, its plans and calls of the clone's statements before and after
 * each call after a backend's first, the query ids the second backend's calls add, none, the client's statements each
 * call runs, and the catalog rows of the session's own relations and functions.
 *
 * And a session stands up every table its write writes that the installation's judge captures, though the rule that
 * reads it is a level above its login's (write/program/stand-up.ts writeStandUps over deploy/snapshot/types.ts
 * CompileFacts `judged`): metis's assignment level's login wrote BoundLineItem, which only a rule of its xp level reads,
 * and the capture refused its first assign (55Z03). Each case: Fixed's insert by a login over Fixed's level alone, below
 * Bounded's, served under the installation's snapshot, two calls on one brand-new backend, each a fact under the bound
 * or past it (second-call.fixtures.ts runBelow). Oracle: the specification, Bounded over the facts: a lawful call
 * accepted, an unlawful one refused by Bounded as the level above states it.
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
 * A brand-new backend's calls of a write after its first plan nothing, change no catalog row of its session's own and
 * send the statements their compiler states alone, and a second backend's send no statement the first's did not.
 */
export const aServedStatementIsPlannedOnceASessionAndIsOneStatementInEverySession =
	property.exhaust(finite(callsGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["one key", "sixteen keys", "deltas past a page at every call"],
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
			name: "pg_stat_statements' plans and calls of the clone's statements around each call after a backend's first, none planned, the client's its frame and its stated statements, the query ids a second backend's calls add, none, and the catalog rows of the session's temporary relations and functions, unchanged"
		},
		box: "a put of one key, sixteen and four hundred of a candidate-keyed relation a rule over a query reads, four calls on each of two brand-new backends of two served Dbs",
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/apply/stand-up.ts",
				original: "\t\tif (!Arr.isReadonlyArrayNonEmpty(missing)) {\n",
				replacement: "\t\tif (Arr.isReadonlyArrayNonEmpty(missing)) {\n",
				why: "The session's stand-up is skipped: no judge's table stands at the first call, which the capture refuses (55Z03)."
			},
			{
				file: "packages/grizzle/src/adapter/apply/stand-up.ts",
				original: "\t\t\t\tsession.stoodUp.add(Arr.map(missing, standUpName))\n",
				replacement: "\t\t\t\tvoid missing\n",
				why: "A session forgets the stand-ups it ran, so every call stands its write up again in a transaction of its own: each call sends a stand-up's BEGIN, prologue, calls and COMMIT beside its own, past the statements its compiler states."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: "const sessionTableKeptPages = 100\n",
				replacement: "const sessionTableKeptPages = 1\n",
				why: "The emptying keeps one page: deltas filled past a page at every call are truncated at every call, a new file of each and three invalidations a TRUNCATE, and every reader's SELECT is planned again."
			}
		]
	})

/** A login below a rule's level stands up the tables it writes that the rule reads, so each of its writes is judged. */
export const aLoginBelowARulesLevelStandsUpTheTablesItWritesThatTheRuleReadsSoEachWriteIsJudged =
	property.exhaust(finite(belowGen), {
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
				file: "packages/engine/src/laws/model/model.ts",
				original:
					'\t\t\t\tthis.cycles.kind === "planned" ? judgedOf(rules, this.theory.upkeeps) : this.cycles.judged,\n',
				replacement: "\t\t\t\tjudgedOf(rules, this.theory.upkeeps),\n",
				why: "A login's write stands up the tables its own level's rules read: Bounded is a level above the login's, so Fixed's tables stand nowhere and the capture refuses every call (55Z03), metis's assign at 395838066."
			},
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: "\tjudged: model.judged,\n",
				replacement: "\tjudged: [],\n",
				why: "The snapshot records no relation the installation's judge captures: a login below the top stands up none of its tables, and the capture refuses its write of Fixed (55Z03)."
			}
		]
	})
