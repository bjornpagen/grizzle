import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { schema, type Statement } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import {
	answer,
	caseGen,
	copiesOf,
	expected,
	type Fact,
	primaryLabel,
	type Situation,
	situationList,
	situationsOf,
	sortedRows,
	statedRoles,
	statedUnder
} from "#test/pg/write/renamed-keys/renamed-keys.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, deepEquals, defined } from "#test/support/assert.ts"
import { answered, writeOnce } from "#test/support/calls.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { oneFlight } from "#test/support/one-flight.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A generated addition into a relation of several plain keys answers alike under every renaming of its fields, as the README's rule says.
 *
 * Its pre-conversion budget: runs 16, coverage cases 64 (test/pg/write/renamed-keys/renamed-keys.test.ts at d8eed1786).
 */
export const aGeneratedAdditionIntoARelationOfSeveralPlainKeysAnswersAlikeUnderEveryRenamingOfItsFieldsAsTheREADMEsRuleSays =
	property.explore(caseGen, {
		needs: { substrate: Substrate.installing },
		situations: situationList satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ substrate }, note: Case<Situation>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const copies = copiesOf(c)
						const statements: ReadonlyArray<Statement> = Arr.flatMap(copies, (copy) =>
							Arr.map(copy.keys, ([, statement]) => statement)
						)
						const schemaNamed = (name: string) =>
							schema(
								name,
								Arr.map(copies, (copy) => copy.value),
								statements
							)
						const declared = schemaNamed("Renamed")
						const done = yield* installMigrated(declared, {
							ambient: ordinarySession,
							label: "renamed",
							logins: [fullWorld(declared, {}).server],
							extensions: []
						})
						const value = schemaNamed(done.schema)
						const world = fullWorld(value, {})
						const names = namesOf(done)
						const lawNames = lawNamesOf(value)
						const label = Formatter.format(c)
						const answers = yield* Effect.gen(function* () {
							const db = yield* openServedDb(done, world.server.roles.app, {})
							const flight = yield* oneFlight(db.ctx, done.as(world.server))
							const answerOf = (copy: (typeof copies)[number]) =>
								Effect.gen(function* () {
									const loaded = yield* Effect.result(
										db.load({ insert: ChangeSet.empty(value).insert(copy.value, []) })
									)
									if (Result.isFailure(loaded)) {
										const refusal = loaded.failure
										const reason =
											"place" in refusal && refusal.error._tag === "CompileError"
												? refusal.error.reason
												: undefined
										if (reason?._tag !== "MalformedDescription") {
											return assert.fail(
												`${label}: ${copy.name}'s insert refused by ${Formatter.format(refusal)}, not its arbiter's rule`
											)
										}
										assert.ok(
											Str.includes(`a generated addition into ${copy.name}`)(reason.what),
											`${label}: ${copy.name}'s load refusal names its generated addition: ${reason.what}`
										)
										return answer({ kind: "load refused" })
									}
									const call = (facts: ReadonlyArray<Fact>) =>
										answered(
											writeOnce(memberCalls(flight.context, member(loaded.success, "insert")))({
												params: {},
												facts: { insert: { [copy.name]: statedUnder(facts, copy.renaming) } }
											})
										)
									const first = yield* flight.judged(`${copy.name}'s stored facts`, call(c.stored))
									assert.equal(
										first.kind,
										Arr.isReadonlyArrayNonEmpty(c.stored) ? "accepted" : "unchanged",
										`${label}: ${copy.name} stores its lawful facts`
									)
									const outcome = yield* flight.judged(`${copy.name}'s request`, call([c.request]))
									const stored = yield* tableState(done, copy.value)
									const rows = sortedRows(
										Arr.map(stored, (row) =>
											Arr.map(statedRoles, (role) => {
												const cell = row[copy.renaming[role]]
												return typeof cell === "number" ? cell : Number.NaN
											})
										)
									)
									const lawLabels: ReadonlyArray<readonly [LawId, string]> = [
										[lawNames.primaryKeyLaw({ name: copy.name }), primaryLabel],
										...Arr.map(
											copy.keys,
											([k, statement]) => [lawNames.lawOf(statement), k] as const
										)
									]
									const roleOf = Rec.fromEntries(
										Arr.map(statedRoles, (role) => [copy.renaming[role], role] as const)
									)
									switch (outcome.kind) {
										case "accepted":
										case "unchanged":
											return answer({ kind: outcome.kind, rows })
										case "refused": {
											const laws = Arr.map(outcome.refused.laws, (l) => {
												const id = names.reported(l)
												return defined(
													Option.getOrUndefined(
														Arr.findFirst(lawLabels, ([law]) => law === id)
													)?.[1],
													`${label}: ${copy.name}'s law ${id}`
												)
											})
											const witness = outcome.witness
											return answer({
												kind: "refused",
												laws,
												witness:
													witness.kind === "unreported"
														? "unreported"
														: Rec.fromEntries(
																Arr.map(Rec.toEntries(witness.values), ([field, v]) => [
																	defined(roleOf[field], `${label}: the witness field ${field}`),
																	typeof v === "number" ? v : Number.NaN
																])
															),
												rows
											})
										}
										case "outsideWorld":
										case "refreshed":
											return assert.fail(
												`${label}: ${copy.name}'s request answered ${outcome.kind}, which no insert of its world answers`
											)
									}
								})
							return yield* Effect.forEach(copies, answerOf)
						}).pipe(Effect.scoped)
						const [first, ...rest] = answers
						for (const [i, other] of rest.entries()) {
							assert.ok(
								deepEquals(other, first),
								`${label}: T${i + 1} answers ${Formatter.format(other)}, T0 ${Formatter.format(first)}: an outcome that depends on a key's name`
							)
						}
						const want = expected(c)
						assert.ok(
							deepEquals(first, want),
							`${label}: every copy answers ${Formatter.format(first)}, the rule ${Formatter.format(want)}`
						)
						note.noteAll(situationsOf(c, want))
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "the README's arbiter rule over the shape's roles (expected), and every renamed copy answering alike"
		},
		budget: { runs: 16, steered: 64 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/renamed-keys/renamed-keys.test.ts#aGeneratedAdditionIntoARelationOfSeveralPlainKeysAnswersAlikeUnderEveryRenamingOfItsFieldsAsTheREADMEsRuleSays:-:2.3.0.0.0.0.0.0.0.0.1.1.1.1.0.0.0.0.0.1.0.2.0.2.0.0.0.0.1.0.0.0.0.0.0.0"
				),
				reason:
					"a drawn primary key beside the keys p and q, whose names sort p first under one renaming and q first under another, the request at one stored fact's p and another's q: the load is refused under each, where arbitrating at the key whose name sorts first would refuse the request by p's law under one renaming and by q's under the other",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/renamed-keys/renamed-keys.test.ts#aGeneratedAdditionIntoARelationOfSeveralPlainKeysAnswersAlikeUnderEveryRenamingOfItsFieldsAsTheREADMEsRuleSays:-:6.3.0.0.0.0.0.0.0.0.1.1.1.1.0.4.1.0.1.1.0.2.0.2.0.0.0.0.1.0.0.0.6.0.0.0"
				),
				reason:
					"a plain primary key p beside the key q, the request at a stored fact's p and another's q: the primary key's law, under every renaming",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/renamed-keys/renamed-keys.test.ts#aGeneratedAdditionIntoARelationOfSeveralPlainKeysAnswersAlikeUnderEveryRenamingOfItsFieldsAsTheREADMEsRuleSays:-:6.1.0.0.0.0.4.0.1.0.0.0.0.0.0.0.0.0.0.1.0.0.0.6.0.0.0"
				),
				reason:
					"the same shape, the request at a stored fact's q alone, an exact repeat, and a fresh fact",
				since: "2026-11-19"
			}
		],
		kills: []
	})
