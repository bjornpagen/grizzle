import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Result } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	type Answer,
	caseGen,
	docsWorld,
	edited,
	loginOf,
	readIdentifier,
	type RoleFeature,
	type Start
} from "#test/pg/direct-writers/missing-role.fixtures.ts"
import { assert, defined } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { templateWorld } from "#test/support/worlds/execute/template.ts"

/**
 * A direct writer's SET ROLE and SET SESSION AUTHORIZATION a name no role holds is 22023, a role the login may not take on 42501, whatever the name.
 *
 * Its pre-conversion budget: runs 120, coverage cases 400 (test/pg/direct-writers/missing-role.test.ts at d8eed1786).
 */
export const aDirectWritersSETROLEAndSETSESSIONAUTHORIZATIONANameNoRoleHoldsIs22023ARoleTheLoginMayNotTakeOn42501WhateverTheName =
	property.explore(caseGen, {
		needs: { docs: Substrate.seat(docsWorld) },
		situations: [
			"SET ROLE: 22023",
			"SET SESSION AUTHORIZATION: 22023",
			"SET ROLE: 42501",
			"SET SESSION AUTHORIZATION: 42501",
			"SET ROLE: taken",
			"SET SESSION AUTHORIZATION: taken",
			"22023 one edit from an installed name",
			"22023 past 63 bytes",
			"22023 by case alone"
		] satisfies ReadonlyArray<Reached<RoleFeature>>,
		check:
			({ docs }, c: Case<RoleFeature>) =>
			(drawnCase) =>
				Effect.flatMap(docs, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const substrate = yield* Substrate
							const world = yield* templateWorld(taken, Option.none())
							const names = world.names
							const writers = { web: yield* world.psql("web"), ops: yield* world.psql("ops") }
							const installedRole = (role: string): string =>
								defined(names.roles[role], `the installed role ${role}`)
							const installedLogin = (login: string): string =>
								defined(names.logins[login], `the installed login ${login}`)
							/** Whether the catalog holds a role of the name, as the owner sees every role. */
							const holds = (read: string) =>
								Effect.map(
									substrate.admin.queryValues(
										"SELECT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = $1)",
										[read]
									),
									(rows) => rows[0]?.[0] === true
								)

							const login = loginOf(drawnCase.login)
							const other = loginOf(drawnCase.login === "web" ? "ops" : "web")
							const own = Arr.map(login.roles, installedRole)
							const loginName = installedLogin(login.name)
							const startsOf = (start: Start): Arr.NonEmptyReadonlyArray<string> => {
								switch (start) {
									case "its own role":
										return own
									case "another login's role":
										return Arr.map(other.roles, installedRole)
									case "its login":
										return [loginName]
									case "the other login":
										return [installedLogin(other.name)]
									case "the owner":
										return [substrate.owner.role]
								}
							}
							const sketch = drawnCase.name
							const name = ((): string => {
								switch (sketch.kind) {
									case "installed": {
										const candidates = startsOf(sketch.start)
										const start = defined(
											candidates[sketch.pick % candidates.length],
											"an installed name"
										)
										return edited(start, sketch.edit)
									}
									case "dictionary":
									case "printable":
										return sketch.name
								}
							})()
							const read = readIdentifier(name)
							const expected: Answer = !(yield* holds(read))
								? drawnCase.statement === "SET ROLE" && read === "none"
									? { kind: "taken" }
									: { kind: "refused", sqlstate: "22023" }
								: read === loginName ||
									  (drawnCase.statement === "SET ROLE" && Arr.contains(own, read))
									? { kind: "taken" }
									: { kind: "refused", sqlstate: "42501" }
							const writer = writers[drawnCase.login]
							yield* writer.begin
							const sent = yield* Effect.result(
								writer.run(`${drawnCase.statement} ${quoteIdent(name)}`)
							)
							yield* writer.rollback
							const answer: Answer = Result.isSuccess(sent)
								? { kind: "taken" }
								: sent.failure._tag === "PsqlStatementError"
									? { kind: "refused", sqlstate: sent.failure.fields.code }
									: yield* Effect.die(sent.failure)
							assert.deepEqual(answer, expected, `${drawnCase.statement} ${quoteIdent(name)}`)
							c.note(
								answer.kind === "taken"
									? `${drawnCase.statement}: taken`
									: answer.sqlstate === "22023"
										? `${drawnCase.statement}: 22023`
										: `${drawnCase.statement}: 42501`
							)
							if (
								answer.kind !== "refused" ||
								answer.sqlstate !== "22023" ||
								sketch.kind !== "installed" ||
								sketch.edit.kind === "none"
							) {
								return
							}
							c.note("22023 one edit from an installed name")
							if (sketch.edit.kind === "padded past 63 bytes") {
								c.note("22023 past 63 bytes")
							}
							if (sketch.edit.kind === "case flipped") {
								c.note("22023 by case alone")
							}
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "postgresql",
			name: "README's SQLSTATEs over pg_roles, each name read as PostgreSQL reads an identifier"
		},
		budget: { runs: 120, steered: 400 },
		kept: [],
		kills: []
	})
