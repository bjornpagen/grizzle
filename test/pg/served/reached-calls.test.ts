/**
 * A role is granted EXECUTE on exactly the declared functions its programs reach: each one a program's own Description
 * calls, and each one the definition of a relation it reads calls, at any depth through the relations each definition
 * reads, whether a derived relation is stored or live and whether the relation is a derived relation of its base or a
 * query entry of its own (program/workload/compile.ts servedCalls). PostgreSQL checks EXECUTE against the role that runs a
 * statement on every function the statement evaluates, a view's among them, and every declared function is SECURITY
 * DEFINER: a live derived relation's definition spliced into a program's statement calls its function as the role, as
 * a stored one's does in a write of one of its holders, and as a query entry's view does. edullm's answerTestItem
 * failed so, "permission denied for function credit", reading ledger.credit through a derived relation's definition
 * once queries named derived relations rather than inlining them.
 *
 * - **Property:** a case draws one to three roles of one login, each the readings it runs a program of (the rows of
 *   Item with ownFn of each value, of the derived Derived over derivedFn, of Nested over Under over nestedFn, of its
 *   query entry Entry over entryFn, or of Item alone), whether its programs write, and whether it holds Entry; each of
 *   the five functions immutable or stable, so Derived, Under and Nested stored or live; and Item's rows. It installs
 *   the login as `grizzle generate` drafts and serves it, and asks the catalog whether each role may execute each
 *   function (has_function_privilege); then it runs every program of every role as that role, a writer's at a place
 *   that may hold a row.
 * - **Oracle:** the reachability restated over the case: a role may execute a function exactly when one of its
 *   readings reaches that function's caller, idleFn, which only Idle no program reads calls, never; and every program
 *   runs as its role, a write's refusal by Item's key an answer like any other.
 * - **Features:** a call reached through a program's own Description, a live derived relation's definition, a stored
 *   one's, a derived relation two levels down and a query entry's definition, each granted; a call only another role
 *   reaches, withheld; a role reading only a live derived relation over its call, and a writer of a holder reading a
 *   stored relation through its definition, each run as its role.
 *
 * Its budget: 8 runs, each case an installation of its own (about 3 s on cassowary under load), and a steered cap of
 * one case a situation: its floor's two cases and its steered phase's one window, each case aimed at a situation of its
 * own (`aims`), reach every situation, and its witnesses go red under each kill (TEST_SEED=2219874524, run2.log and
 * kills.log in ~/.cache/grizzle/STORECLOSED2-GR-logs, 2026-11-24).
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import type { AnyLogin } from "#compiler/types/schema/world.ts"
import {
	aims,
	buildOf,
	callers,
	caseGen,
	factsOf,
	functionNames,
	type ReachedFeature,
	reachedOf,
	worldOf,
	writeParams
} from "#test/pg/served/reached-calls.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { readOnce, writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import { installGenerated, loadMigrated } from "#test/support/install-migrate.ts"
import { openServedDbOf, servedGenerated } from "#test/support/served-db.ts"
import { baseSubstrate, Substrate } from "#test/support/substrate/substrate.ts"

const features = [
	"a call in a program's own Description, granted",
	"a call in a live derived relation's definition, granted",
	"a call in a stored derived relation's definition, granted",
	"a call two derived relations down, granted",
	"a call in a query entry's definition, granted",
	"a call only another role's programs reach, withheld",
	"a role reading only a live derived relation over its call, run as the role",
	"a writer of a holder reading a stored relation through its definition, run as the role"
] as const satisfies ReadonlyArray<Reached<ReachedFeature>>

/** A role may execute exactly the declared functions its programs reach, through every definition they read, and runs
 * each of them. */
export const aRoleMayExecuteExactlyTheDeclaredFunctionsItsProgramsReachThroughEveryDefinitionTheyReadAndRunsEachOfThem =
	property.explore(aimed(caseGen, aims), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: features,
		budget: { runs: 8, steered: features.length },
		check:
			({ substrate }, notes: Case<ReachedFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const generated = yield* installGenerated(buildOf(c), {
							label: "reached_calls",
							ambient: ordinarySession
						})
						const installed = generated.installed
						yield* loadMigrated(installed, factsOf(c))
						const world = worldOf(c, installed.declared)
						const s = yield* Substrate
						const stored = (relation: string) =>
							installed.installation.checked.holdings.get(relation)?.kind === "stored"
						for (const rc of c.roles) {
							const reached = reachedOf(rc)
							const elsewhere = new Set(
								Arr.flatMap(c.roles, (other) =>
									other.name === rc.name ? [] : [...reachedOf(other)]
								)
							)
							for (const reading of rc.readings) {
								switch (reading) {
									case "own":
										notes.note("a call in a program's own Description, granted")
										break
									case "derived":
										notes.note(
											stored("Derived")
												? "a call in a stored derived relation's definition, granted"
												: "a call in a live derived relation's definition, granted"
										)
										break
									case "nested":
										notes.note("a call two derived relations down, granted")
										break
									case "entry":
										notes.note("a call in a query entry's definition, granted")
										break
									case "plain":
										break
								}
							}
							if (Arr.some(callers, (caller) => elsewhere.has(caller) && !reached.has(caller))) {
								notes.note("a call only another role's programs reach, withheld")
							}
							const executes = yield* Effect.forEach(callers, (caller) =>
								Effect.map(
									s.admin.queryValues(
										"SELECT pg_catalog.has_function_privilege($1::text::name, p.oid, 'EXECUTE') FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = $2::text AND p.proname = $3::text",
										[
											installed.role(world.role(rc.name)),
											installed.names.declaredFunction(functionNames[caller]).ref.schema,
											installed.names.declaredFunction(functionNames[caller]).ref.name
										]
									),
									(rows) => {
										assert.equal(rows.length, 1, `one installed function ${functionNames[caller]}`)
										return { caller, granted: rows[0]?.[0] === true }
									}
								)
							)
							assert.deepEqual(
								Arr.flatMap(executes, (e) => (e.granted ? [functionNames[e.caller]] : [])),
								Arr.flatMap(callers, (caller) =>
									reached.has(caller) ? [functionNames[caller]] : []
								),
								`role ${rc.name} may execute exactly the functions its readings ${Formatter.format(rc.readings)} reach`
							)
						}
						const fixture = servedGenerated<AnyLogin>(generated, world.login)
						for (const rc of c.roles) {
							yield* Effect.scoped(
								Effect.gen(function* () {
									const db = yield* openServedDbOf(fixture, installed, world.loginRole(rc.name), {})
									const served = yield* db.serve(world.programs(rc.name))
									for (const [name, calls] of served) {
										const ran = yield* Effect.result(
											calls.shape === "write"
												? Effect.asVoid(
														writeAnswerOf(writeOnce(calls)({ params: writeParams, facts: {} }))
													)
												: Effect.asVoid(readOnce(calls)({ params: {}, facts: {} }))
										)
										if (Result.isFailure(ran)) {
											return assert.fail(
												`role ${rc.name}'s program ${name} runs as the role: ${Formatter.format(ran.failure)}`
											)
										}
									}
								})
							)
							if (
								rc.readings.length === 1 &&
								rc.readings[0] === "derived" &&
								!rc.writes &&
								!stored("Derived")
							) {
								notes.note(
									"a role reading only a live derived relation over its call, run as the role"
								)
							}
							if (rc.writes && Arr.contains(rc.readings, "derived") && stored("Derived")) {
								notes.note(
									"a writer of a holder reading a stored relation through its definition, run as the role"
								)
							}
						}
					}).pipe(Effect.scoped),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "a role executes exactly the functions its readings reach, and runs every program it serves"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/served/reached-calls.test.ts#aRoleMayExecuteExactlyTheDeclaredFunctionsItsProgramsReachThroughEveryDefinitionTheyReadAndRunsEachOfThem:ff.1:0.0.0.0.0.0.5.1.0.0.0.0"
				),
				reason:
					"a writer of Item from its query entry Entry at a document and a place: the insert's read of Entry's world view pushed its two equalities above the view body's pass-through projection, which the binding then kept as a level of its own, minting 2 names where the installation's binding minted 1, an internal compiler error at generate (lane REDS7's census of main 29a4d30c)",
				since: "2026-11-28"
			}
		],
		kills: [
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\t\t? { ...once, body: readCore(top, once.orderBy) }\n",
				replacement: "\t\t\t? once\n",
				why: "A world view's body is kept as its definition stands, its top core unfolded: a reader's quals pushed into it land above its pass-through projection, which the reader's binding keeps as a level of its own, and Entry's writer is an internal compiler error at generate, its view's body minting 2 names where its installation's minted 1."
			},
			{
				file: "packages/engine/src/program/workload/compile.ts",
				original: "\t\t\t\tdefinitionsOf(loginRole(role, login.named.owned))\n",
				replacement: "\t\t\t\t() => undefined\n",
				why: "A role's grants follow no relation its programs read into its definition, its programs' own calls alone, as before queries named derived relations: a program reading Derived, Nested or Entry is refused its function, permission denied as it runs, as edullm's answerTestItem was for credit."
			},
			{
				file: "packages/engine/src/program/workload/compile.ts",
				original: '\t\treturn entry?.kind === "world" ? entry.query : undefined\n',
				replacement: "\t\treturn undefined\n",
				why: "A role's grants follow its derived relations' definitions and not its query entries': a program reading Entry is refused entryFn, which Entry's view calls as the role."
			}
		]
	})
