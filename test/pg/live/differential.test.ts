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
 * from the file generate wrote, over its DbLayer and its live source.
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
 * Plant: none of its own; a codec that respells a value on the wire (LIVE-OPENAPI's) turns it red.
 *
 * Features: a set read, an ordered read, an attachment, a relation parameter, a read of no row, a read of several rows,
 * a column the reference declines.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { agree } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Option, Record as Rec, Result } from "effect"
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
import { ordinarySession } from "#test/support/ambient.ts"
import { defined } from "#test/support/assert.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { liveSurfaces } from "#test/support/live/calls.ts"
import type { LiveValue } from "#test/support/live/system.ts"
import { printKeyed, sameKeyed } from "#test/support/live/values.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import {
	type Answer,
	answerEquivalence,
	publicRows,
	shapeOf
} from "#test/support/oracle/public/answer.ts"
import { buildRoot, buildSchema, factRecord, hostValue } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { expectedQuery } from "#test/support/oracle/public/meaning.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	deliveredOrder,
	type ProgramCase,
	type ProgramRead
} from "#test/support/oracle/public/program.ts"
import { unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { storedInput } from "#test/support/oracle/runner.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify, tokenOf } from "#test/support/worlds.ts"

class Differs extends Data.TaggedError("Differs")<{ readonly report: string }> {}

type Feature =
	| "a set read"
	| "an ordered read"
	| "an attachment"
	| "a relation parameter"
	| "a read of no row"
	| "a read of several rows"
	| "a column the reference declines"

const cases = 40

type QueryRead = Extract<ProgramRead, { readonly kind: "query" }>

/** The member a query read is served as, by its place among the case's reads. */
const readMember = (place: number): string => `read${place}`

/** A read's parameters as a call takes them: each scalar's host value, each relation parameter's facts. */
const paramsOf = (read: QueryRead): Readonly<Record<string, unknown>> =>
	Rec.fromEntries([
		...Arr.map(read.params, (p): readonly [string, unknown] => [
			p.name,
			hostValue(p.value, p.type)
		]),
		...Arr.map(read.relations, (r): readonly [string, unknown] => [
			r.name,
			Arr.map(r.rows, (fact) => factRecord(r.relation, fact))
		])
	])

/** The case's facts as the oracle loader's records, each value in the spelling its fact drew. */
const directFacts = (c: ProgramCase) =>
	Rec.fromEntries(
		Arr.map(c.schema.relations, (r) => [
			r.name,
			Arr.map(c.facts.get(r.name) ?? [], (fact) =>
				Rec.fromEntries(
					Arr.flatMap(r.fields, (f, i): ReadonlyArray<readonly [string, unknown]> => {
						const value = fact[i]
						return value === undefined ? [] : [[f.name, storedInput(value, f.type)]]
					})
				)
			)
		])
	)

/** A value's rows as the public answer reads delivered rows. */
const answerOf = (read: QueryRead, value: LiveValue): Answer =>
	publicRows(shapeOf(read.query), [...value])

layer(Substrate.layer)("a generated program", (it) => {
	it.effect(
		`holds at an HTTP call's ready the in-process once's value, which is the reference's answer, over ${cases} generated programs`,
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the reference evaluator's answer, and the two surfaces held to each other exactly"
						},
						suite: "pg/live/differential",
						draw: drawn(caseSketchGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a set read",
								"an ordered read",
								"an attachment",
								"a relation parameter",
								"a read of no row",
								"a read of several rows"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: cases,
						shrink: { kind: "bounded", candidates: 60 },
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					(sketch, notes) =>
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
							const generated = yield* installGenerated(
								(name) => {
									const world = servedWorld(name)
									return { schema: world.value, logins: [world.server] }
								},
								{ label: "live differential", ambient: ordinarySession }
							)
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
								}
							}).pipe(withLayer(fixtureLayer))
						}).pipe(
							Effect.scoped,
							Effect.mapError((e) =>
								e instanceof Differs ? e : new Differs({ report: Formatter.format(e) })
							)
						)
				)
			)
	)
})
