/**
 * The differential: for every generated program and input, the value an HTTP call's stream holds at its `ready`,
 * through the client's fold, is the value the same program's in-process once answers, and both are the reference
 * evaluator's answer over the same data.
 *
 * Each case is the public-boundary differential's (test/support/oracle/public): a schema, its facts and its reads,
 * generated as calls to grizzle's public builders. Every query read is a member of its full role's workload (an ordered
 * root as an ordered read, delivered as a list), installed and served as `grizzle generate` drafts it, its parameters'
 * domains and its live source among its objects (test/support/install-migrate.ts installGenerated); its facts are
 * stored by a direct SQL writer of the role at SERIALIZABLE, each value in its drawn spelling, and the login is served
 * from the file generate wrote, over its DbLayer and its live source, which is made to stand before the first read, as
 * a fresh installation's caller does: an HTTP once is its watch's first value, refused until the leader makes the slot
 * (test/support/live/standing.ts standingOn).
 *
 * Properties, for every query read with its drawn parameters:
 *
 * - the HTTP value and the in-process value are one value (test/support/live/values.ts sameKeyed): the same rows, keyed
 *   by the same fields, a list's in the same order with the same keys;
 * - both deliver the reference's rows (oracle/public/answer.ts answerEquivalence): as a set, or in the order the root
 *   delivers them in, every column exactly but those the reference declines.
 *
 * The oracle is the reference evaluator (oracle/public/meaning.ts expectedQuery), a second implementation over the
 * case's own facts; the two surfaces are held to each other exactly.
 *
 * The generator draws prose, text with no byte bound (oracle/public/build.ts prose), compared and joined as any other
 * field, so a read may need an access index over a prose field, which the compile refuses: an index entry over text
 * that proves no byte bound is unrepresentable (schema/representability.ts keyDatums). Such a case expects that
 * refusal, read by its typed fields: UnrepresentableKey, its fault unboundedText of a prose field, every field of its
 * key one relation's. Any other refusal of a generated program is red, so the oracle holds over every program the
 * compile admits and holds the compile to admitting every other.
 *
 * Features: a set read, an ordered read, an attachment, a relation parameter, a read of no row, a read of several rows,
 * a column the reference declines, a read refused for a key over prose, and, required and aimed, an admitted program
 * whose live answers match the reference over an index read: a read looked up by a scalar parameter, which the compile
 * serves by the index its lookup plans or a key, agreeing on both surfaces with the reference. A case whose turn aims
 * at it draws its sketch from those the compile admits by construction (oracle/public/generate.ts admittedSketchGen,
 * `aims`), the sketch it runs, prints and keeps, so a run that draws mostly refused programs still compares served ones.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { agree } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, Result } from "effect"
import { served } from "#adapter/public/layer.ts"
import type { ServedLogin } from "#adapter/types/layer.ts"
import { workload } from "#compiler/program/workload/value.ts"
import {
	type AnyLogin,
	login,
	role,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import {
	aims,
	answerOf,
	cases,
	Differs,
	directFacts,
	type Feature,
	paramsOf,
	readMember,
	refusesProseKey
} from "#test/pg/live/differential.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { defined } from "#test/support/assert.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { liveSurfaces } from "#test/support/live/calls.ts"
import { standingOn } from "#test/support/live/standing.ts"
import { printKeyed, sameKeyed } from "#test/support/live/values.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { answerEquivalence, shapeOf } from "#test/support/oracle/public/answer.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { expectedQuery } from "#test/support/oracle/public/meaning.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import { deliveredOrder } from "#test/support/oracle/public/program.ts"
import { unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify, tokenOf } from "#test/support/worlds.ts"

/**
 * A generated program holds at an HTTP call's ready the in-process once's value, which is the reference's answer, over ${cases} generated programs.
 *
 * Its pre-conversion budget: runs cases, coverage cases 60 (test/pg/live/differential.test.ts at d8eed1786).
 */
export const aGeneratedProgramHoldsAtAnHTTPCallsReadyTheInProcessOncesValueWhichIsTheReferencesAnswerOverCasesGeneratedPrograms =
	property.explore(aimed(caseSketchGen, aims), {
		needs: { substrate2: Substrate.installing },
		situations: [
			"a set read",
			"an ordered read",
			"an attachment",
			"a relation parameter",
			"a read of no row",
			"a read of several rows",
			"an admitted program whose live answers match the reference over an index read"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate2 }, notes: Case<Feature>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const c = notes.draw(resolveCase(sketch))
						const reads = Arr.flatMap(c.reads, (read, place) =>
							read.kind === "query" ? [{ read, place }] : []
						)
						if (!Arr.isReadonlyArrayNonEmpty(reads)) {
							return
						}
						const built = buildSchema(c.schema)
						/**
						 * The case's world under the installed name `name`: a full role, which serves every query read of
						 * the case as a member of its workload, in the login `server`, as generate drafts and serves it.
						 */
						const servedWorld = (name: string) => {
							const value = built.installedAs(name)
							const app = role(value, "app", wholeEntriesOf(value), {
								write: writableNamesOf(value)
							})
							const programs = Rec.fromEntries(
								Arr.map(reads, ({ read, place }) => [
									readMember(place),
									buildRoot(built, value, read.query)
								])
							)
							return {
								value,
								app,
								server: login(value, "server", [app], { workload: [workload(app, programs)] })
							}
						}
						const installedCase = yield* Effect.result(
							installGenerated(
								(name) => {
									const world = servedWorld(name)
									return { schema: world.value, logins: [world.server] }
								},
								{ label: "live_differential", ambient: ordinarySession }
							)
						)
						if (Result.isFailure(installedCase)) {
							const failure = installedCase.failure
							if (failure._tag === "CompileError" && refusesProseKey(c.schema, failure)) {
								notes.note("a read refused for a key over prose")
								return
							}
							return yield* Effect.fail(failure)
						}
						const generated = installedCase.success
						const done = generated.installed
						const world = servedWorld(done.declared)
						const statements = factStatements(done.plan, directFacts(c))
						if (!statements.ok) {
							return yield* new Differs({
								report: `the facts do not load: ${statements.error.message}\n${printCase(c)}`
							})
						}
						const substrate = yield* Substrate
						const writer = yield* substrate.session(worldSession(done.world(world.app)))
						yield* writer.begin
						for (const sql of statements.value) {
							yield* writer.query(sql, [])
						}
						yield* writer.commit
						const file: ServedLogin<AnyLogin> = served(
							defined(generated.served.get("server"), "the served file of login server"),
							"server"
						)
						const fixtureLayer = sourcedDbLayer(done, {
							...clusterConnection(done.cluster, done.database, done.as(world.server).password),
							pool: clusterPool,
							login: file,
							verify: testVerify
						})
						yield* Effect.gen(function* () {
							const surfaces = yield* liveSurfaces(file, "app", tokenOf({}))
							for (const { read, place } of Arr.take(reads, 1)) {
								yield* standingOn(surfaces.inProcess, readMember(place), {
									params: paramsOf(read),
									facts: {}
								})
							}
							for (const { read, place } of reads) {
								const label = `read ${place}`
								const input = { params: paramsOf(read), facts: {} }
								const inProcess = yield* surfaces.inProcess.once(readMember(place), input)
								const overHttp = yield* surfaces.http.once(readMember(place), input)
								if (!sameKeyed(inProcess, overHttp)) {
									return yield* new Differs({
										report: `${label}: over HTTP ${printKeyed(overHttp)}, in process ${printKeyed(inProcess)}\n${printCase(c)}`
									})
								}
								const inOrder = Option.isSome(deliveredOrder(read.query))
								notes.note(inOrder ? "an ordered read" : "a set read")
								notes.note(
									inProcess.size === 0
										? "a read of no row"
										: inProcess.size > 1
											? "a read of several rows"
											: "a set read"
								)
								if (Arr.isReadonlyArrayNonEmpty(read.query.attachments)) {
									notes.note("an attachment")
								}
								if (Arr.isReadonlyArrayNonEmpty(read.relations)) {
									notes.note("a relation parameter")
								}
								const expected = expectedQuery(c, read, unobserved)
								if (Result.isFailure(expected)) {
									notes.note("a column the reference declines")
								}
								yield* Effect.mapError(
									agree(
										[
											["the reference", expected],
											["in process", answerOf(read, inProcess)],
											["over HTTP", answerOf(read, overHttp)]
										],
										answerEquivalence(shapeOf(read.query), inOrder)
									),
									(disagreement) =>
										new Differs({
											report: `${label}: ${disagreement.message}\n${printCase(c)}`
										})
								)
								if (Arr.isReadonlyArrayNonEmpty(read.params)) {
									notes.note(
										"an admitted program whose live answers match the reference over an index read"
									)
								}
							}
						}).pipe(withLayer(fixtureLayer))
					}).pipe(
						Effect.scoped,
						Effect.mapError((e) =>
							e instanceof Differs ? e : new Differs({ report: Formatter.format(e) })
						)
					),
					Substrate,
					substrate2
				),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator's answer, and the two surfaces held to each other exactly"
		},
		budget: { runs: cases, steered: 60 },
		kept: [],
		kills: []
	})
