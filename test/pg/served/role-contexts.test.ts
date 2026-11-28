/**
 * A full role's declared contexts are what its served Db decodes from the token: a program over the schema matching
 * them writes exactly as the token's claims say.
 *
 * Its budget: 24 runs and 24 steered cases, beside a space of 24 cases, every one of which the floor reaches.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	Account,
	ActedAs,
	accounts,
	type ContextsFeature,
	contextsCases,
	expected,
	featuresOf,
	payloadOf,
	Sitting,
	sittingNumber,
	sittingsAt,
	sittingsTemplate,
	Started
} from "#test/pg/served/role-contexts.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { servedFixture } from "#test/support/served-db.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { tokenOf } from "#test/support/worlds.ts"

/** A full role's declared contexts are what its served Db decodes from the token, so a program over the schema matching them writes exactly as the token's claims say. */
export const aFullRolesDeclaredContextsAreWhatItsServedDbDecodesFromTheTokenSoAProgramOverTheSchemaMatchingThemWritesExactlyAsTheTokensClaimsSay =
	property.explore(contextsCases, {
		needs: { sittings: Substrate.fresh(sittingsTemplate) },
		situations: [
			"the student's own sitting started",
			"another student's sitting unchanged",
			"a subject with no account unchanged",
			"an act recorded",
			"no act recorded nothing",
			"no subject refused at token",
			"an act that is no object refused at token"
		] satisfies ReadonlyArray<Reached<ContextsFeature>>,
		check:
			({ sittings }, cx: Case<ContextsFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(sittings, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const m = taken.value
								const { desk } = sittingsAt(m.declared)
								const s = yield* Substrate
								const owner = yield* s.session({ ...ownerSession(), label: "sittings owner" })
								const names = namesOf(m)
								yield* owner.query(
									`INSERT INTO ${names.table(Account)} (${names.column(Account, "clerk")}, ${names.column(Account, "person")}) VALUES ${Arr.join(
										Arr.map(accounts, (a) => `('${a.clerk}', '${a.person}')`),
										", "
									)}`,
									[]
								)
								yield* owner.query(
									`INSERT INTO ${names.table(Sitting)} (${names.column(Sitting, "number")}, ${names.column(Sitting, "student")}) VALUES (${sittingNumber}, '${c.student}')`,
									[]
								)
								for (const feature of featuresOf(c)) {
									cx.note(feature)
								}
								const answer = expected(c)
								const served = yield* servedFixture(m, desk)
								return yield* Effect.gen(function* () {
									const opened = yield* Effect.result(
										Db.open(served.login.roles.student, { token: tokenOf(payloadOf(c)) })
									)
									if (answer.kind === "refused") {
										assert.ok(
											Result.isFailure(opened),
											`a token of ${Formatter.format(payloadOf(c))} opens no Db`
										)
										assert.equal(opened.failure.stage, "token", "the stage the token is refused at")
										return
									}
									if (Result.isFailure(opened)) {
										return assert.fail(
											`a token of ${Formatter.format(payloadOf(c))} was refused: ${opened.failure.message}`
										)
									}
									const db = opened.success
									const params = { number: sittingNumber }
									const start = yield* writeAnswerOf(
										db.workload.startAsStudent.once({ params, facts: {} })
									)
									const act = yield* writeAnswerOf(db.workload.actedAs.once({ params, facts: {} }))
									assert.equal(
										start._tag,
										answer.started.length > 0 ? "accepted" : "unchanged",
										"the start's outcome"
									)
									assert.equal(
										act._tag,
										answer.acted.length > 0 ? "accepted" : "unchanged",
										"the act's outcome"
									)
									const started = yield* owner.values(
										`SELECT ${names.column(Started, "number")} FROM ${names.table(Started)}`,
										[]
									)
									const acted = yield* owner.values(
										`SELECT ${names.column(ActedAs, "number")}, ${names.column(ActedAs, "actor")} FROM ${names.table(ActedAs)}`,
										[]
									)
									assert.deepEqual(
										Arr.sort(
											Arr.map(started, (row) => Number(row[0])),
											Order.Number
										),
										[...answer.started],
										"the sittings started: the student's own alone"
									)
									assert.deepEqual(
										Arr.map(acted, (row) => [Number(row[0]), String(row[1])] as const),
										[...answer.acted],
										"the acts recorded: the act claim's staff member alone"
									)
								}).pipe(Effect.scoped, withLayer(served.layer))
							}).pipe(Effect.scoped),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the start and the act each write exactly as the token's sub and act claims say"
		},
		budget: { runs: 24, steered: 24 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/db/claims.ts",
				original: "\tconst claim = context.claim\n",
				replacement: "\tconst claim: string | undefined = undefined\n",
				why: "every context is read from the token's top level, so Acting reads the student's own sub: an act records the student, and a token without an act claim records one too."
			},
			{
				file: "packages/grizzle/src/adapter/served/login.ts",
				original:
					'\tconst contexts = world.kind === "role" ? Rec.values(world.role.contexts) : []\n',
				replacement:
					'\tconst contexts = world.kind === "role" ? Rec.values(world.role.contexts).slice(1) : []\n',
				why: "the served role drops its first declared context, Acting, from what its Db decodes: an act claim records nothing."
			}
		]
	})
