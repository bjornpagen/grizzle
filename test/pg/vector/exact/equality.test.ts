/**
 * Vector equality on PostgreSQL 19 and the pinned pgvector: a vector's value is its binary32 components, -0 equal to 0,
 * everywhere grizzle compares one.
 *
 * - Queries: a vector binding, a vector variable two matches share, an r.not and attachments correlated on a vector,
 *   over drawn facts of vectors that collide by value and differ by spelling, deliver in both artifacts exactly what
 *   the host's evaluation of the query under vector equality delivers; every statement names the extension's operator
 *   by its schema, since the writer's search_path never holds it.
 * - Writes: ChangeSet inserts, repeats, conflicts, deletes and puts over vector fields run through the protocol, and
 *   each outcome and the stored facts are a host model's of each relation under vector equality.
 *
 * Oracle: a second implementation, the host's evaluation of each query and a host model of each relation's facts, both
 * under vector equality.
 *
 * Features: each query form and each write outcome the searches name.
 *
 * A vector's identity text, the codec's and fact identity's (values/vector.ts componentText), is
 * test/pg/vector/exact/storage.test.ts's: these properties compare vectors where PostgreSQL and the host's model compare
 * them, by value.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	A,
	aId,
	apply,
	B,
	bId,
	changeSet,
	childIds,
	columnsOf,
	compiled,
	Edge,
	edgeId,
	type EqualityFeature,
	equalityFeatures,
	expectedOf,
	featuresOf,
	firstId,
	hostFact,
	idOf,
	idsOf,
	markers,
	Pairs,
	type PairsCase,
	pairsCaseGen,
	pairsOf,
	pairsWorld,
	rowOf,
	run,
	sameFact,
	servedPairs,
	spelledLit,
	statements,
	stored,
	tableOf,
	vec,
	type WriteFact,
	type WriteFeature,
	writeOps,
	writeProgramGen,
	writeRelations,
	type EqualityWrittenRelation,
	writtenRelations
} from "#test/pg/vector/exact/equality.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, lacksText } from "#test/support/assert.ts"
import { answered, rowsOf } from "#test/support/calls.ts"
import { installMigrated as install, installGenerated } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { servedGenerated } from "#test/support/served-db.ts"
import { clearRows, installationGroup } from "#test/support/substrate/replace.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * Vector equality as a world role a vector binding, a shared vector variable, an r.not and attachments correlated on a vector agree with vector equality in both artifacts.
 *
 * Its pre-conversion budget: runs 30, coverage cases 60 (test/pg/vector/exact/equality.test.ts at d8eed1786).
 */
export const vectorEqualityAsAWorldRoleAVectorBindingASharedVectorVariableAnRNotAndAttachmentsCorrelatedOnAVectorAgreeWithVectorEqualityInBothArtifacts =
	property.explore(pairsCaseGen, {
		needs: { substrate: Substrate.installing },
		situations: equalityFeatures satisfies ReadonlyArray<Reached<EqualityFeature>>,
		check:
			({ substrate }, k: Case<EqualityFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const generated = yield* installGenerated(
							(name) => {
								const world = servedPairs(name)
								return { schema: world.value, logins: [world.server] }
							},
							{ label: "vpairs", ambient: ordinarySession }
						)
						const installed = generated.installed
						const names = namesOf(installed)
						const writer = yield* s.session({
							...worldSession(installed.world(pairsWorld.app)),
							label: "writer"
						})
						const [searchPath] = yield* writer.values(
							"SELECT pg_catalog.current_setting('search_path')",
							[]
						)
						lacksText(String(searchPath?.[0]), "vector_ext")
						/** A parameter binding of a vector column. */
						const byValue = compiled(
							query(Pairs).rule((r) => {
								const { id: key } = v(A, "a")
								return r
									.match(A, { id: key, value: r.param("probe", A.fields.value) })
									.find({ id: key })
							}),
							installed
						)
						/** A vector variable shared by two relations: a join on native equality. */
						const join = compiled(
							query(Pairs).rule((r) => {
								const { id: a, value } = v(A, "a")
								const { id: b } = v(B, "b")
								return r.match(A, { id: a, value }).match(B, { id: b, value }).find({ a, b })
							}),
							installed
						)
						/** One variable bound to two columns of one relation: the loops. */
						const loops = compiled(
							query(Pairs).rule((r) => {
								const { id: key, from } = v(Edge, "edge")
								return r.match(Edge, { id: key, from, to: from }).find({ id: key })
							}),
							installed
						)
						/** An anti-join correlated on a vector: the A facts whose value no B fact has. */
						const unmatched = compiled(
							query(Pairs).rule((r) => {
								const { id: key, value } = v(A, "a")
								return r.match(A, { id: key, value }).where(r.not(B, { value })).find({ id: key })
							}),
							installed
						)
						/** Writes the case's facts in place of the last case's, each vector in its drawn spelling. */
						const load = (c: PairsCase) =>
							Effect.gen(function* () {
								const values = (rows: ReadonlyArray<string>) => Arr.join(rows, ", ")
								yield* clearRows(s.admin, installationGroup(names))
								yield* s.admin.query(
									`INSERT INTO ${names.table(A)} (${names.column(A, "id")}, ${names.column(A, "value")}) VALUES ${values(
										Arr.map(c.a, (x, i) => `('${aId(i)}'::uuid, ${spelledLit(x)})`)
									)}`,
									[]
								)
								if (Arr.isReadonlyArrayNonEmpty(c.b)) {
									yield* s.admin.query(
										`INSERT INTO ${names.table(B)} (${names.column(B, "id")}, ${names.column(B, "value")}) VALUES ${values(
											Arr.map(c.b, (x, i) => `('${bId(i)}'::uuid, ${spelledLit(x)})`)
										)}`,
										[]
									)
								}
								yield* s.admin.query(
									`INSERT INTO ${names.table(Edge)} (${names.column(Edge, "id")}, ${names.column(Edge, "from")}, ${names.column(Edge, "to")}) VALUES ${values(
										Arr.map(
											c.edges,
											([from, to], i) =>
												`('${edgeId(i)}'::uuid, ${spelledLit(from)}, ${spelledLit(to)})`
										)
									)}`,
									[]
								)
							})
						const served = servedGenerated(generated, servedPairs(installed.declared).server)
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(served.login.roles.app, {})

							yield* load(c)
							const probe = vec(c.probe[0], c.probe[1])
							const expected = expectedOf(c)
							for (const spec of statements(byValue)) {
								const matched = yield* run(writer, spec, { probe })
								assert.deepEqual(idsOf(matched), expected.byValue, "the probe's facts")
							}
							for (const spec of statements(join)) {
								const joined = yield* run(writer, spec, {})
								assert.deepEqual(pairsOf(joined), expected.join, "the join")
							}
							for (const spec of statements(loops)) {
								const found = yield* run(writer, spec, {})
								assert.deepEqual(idsOf(found), expected.loops, "the loops")
							}
							for (const spec of statements(unmatched)) {
								const found = yield* run(writer, spec, {})
								assert.deepEqual(idsOf(found), expected.unmatched, "the unmatched")
							}
							const read: ReadonlyArray<unknown> = yield* rowsOf(
								db.workload.twins.once({ params: {}, facts: {} })
							)
							const outcome = yield* answered(db.workload.readBack.once({ params: {}, facts: {} }))
							if (outcome.kind !== "accepted" && outcome.kind !== "unchanged") {
								return assert.fail(`the read-back's apply was ${outcome.kind}`)
							}
							const readBack = hasProperties(outcome.reads) ? outcome.reads.readBack : undefined
							if (!isList(readBack)) {
								return assert.fail("an outcome without its read-back")
							}
							for (const delivered of [read, readBack]) {
								const byId = new Map(Arr.map(delivered, (f) => [idOf(f), f]))
								for (const [i, twinsOf] of expected.twins.entries()) {
									const fact = byId.get(aId(i))
									assert.deepEqual(childIds(fact, "twins"), twinsOf, `${aId(i)}'s twins`)
									assert.deepEqual(firstId(fact), Arr.head(twinsOf), `${aId(i)}'s first twin`)
								}
							}
							k.noteAll(featuresOf(c, expected))
						}).pipe(Effect.scoped, withLayer(served.layer))
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the host's evaluation of each query under vector equality, binary32 components with -0 equal to 0"
		},
		budget: { runs: 30, steered: 60 },
		kept: [],
		kills: []
	})

/**
 * Vector equality as a world role ChangeSet inserts, repeats, conflicts, deletes and puts over vector fields run through the protocol.
 *
 * Its pre-conversion budget: runs 24, coverage cases 60 (test/pg/vector/exact/equality.test.ts at d8eed1786).
 */
export const vectorEqualityAsAWorldRoleChangeSetInsertsRepeatsConflictsDeletesAndPutsOverVectorFieldsRunThroughTheProtocol =
	property.explore(writeProgramGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"a fact inserted",
			"an exact repeat",
			"a twin spelling repeated",
			"a conflicting repeat refused",
			"a delete of the stored fact",
			"a delete of a differing fact",
			"a put displacing its occupant",
			"a put of the stored fact"
		] satisfies ReadonlyArray<Reached<WriteFeature>>,
		check:
			({ substrate }, k: Case<WriteFeature>) =>
			(steps) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const installed = yield* install(Pairs, {
							ambient: ordinarySession,
							label: "vwrite",
							logins: [pairsWorld.server],
							extensions: []
						})
						const writer = yield* s.session({
							...worldSession(installed.world(pairsWorld.app)),
							label: "writer"
						})
						const names = namesOf(installed)

						yield* clearRows(s.admin, installationGroup(names))
						const model = new Map<EqualityWrittenRelation, Map<string, WriteFact>>(
							Arr.map(writtenRelations, (relation) => [relation, new Map()])
						)
						for (const step of steps) {
							const R = writeRelations[step.relation]
							const facts = Arr.map(step.facts, hostFact)
							const held = defined(model.get(step.relation), step.relation)
							const occupants = Arr.map(step.facts, (f) => ({ f, stored: held.get(f.id) }))
							const out = yield* apply(
								writer,
								installed,
								writeOps[step.op](changeSet(), R, facts),
								{ [step.relation]: facts }
							)
							switch (step.op) {
								case "insert": {
									const clashing = Arr.filter(
										occupants,
										({ f, stored }) => stored !== undefined && !sameFact(stored, f)
									)
									if (Arr.isReadonlyArrayNonEmpty(clashing)) {
										k.note("a conflicting repeat refused")
										if (out.kind !== "refused") {
											return assert.fail("the conflicting write raised nothing")
										}
										assert.equal(out.refused.code, "23000")
										assert.equal(out.refused.constraint, names.primaryKeyLaw(R))
										break
									}
									assert.ok(Arr.every(out.out, (x) => x.result.kind === "insert"))
									const fresh = Arr.filter(occupants, ({ stored }) => stored === undefined)
									assert.deepEqual(
										Arr.sort(
											Arr.map(markers(out), (r) => defined(r[0], "an inserted marker's key")),
											Order.String
										),
										Arr.sort(
											Arr.map(fresh, ({ f }) => f.id),
											Order.String
										)
									)
									for (const { f, stored } of occupants) {
										if (stored === undefined) {
											k.note("a fact inserted")
											held.set(f.id, f)
										} else {
											k.note(
												spelledLit(stored.value) === spelledLit(f.value)
													? "an exact repeat"
													: "a twin spelling repeated"
											)
										}
									}
									break
								}
								case "delete": {
									const removed = Arr.filter(
										occupants,
										({ f, stored }) => stored !== undefined && sameFact(stored, f)
									)
									assert.equal(markers(out).length, removed.length, "the facts deleted")
									for (const { f, stored } of occupants) {
										if (stored !== undefined && sameFact(stored, f)) {
											k.note("a delete of the stored fact")
											held.delete(f.id)
										} else if (stored !== undefined) {
											k.note("a delete of a differing fact")
										}
									}
									break
								}
								case "put": {
									const displaced = Arr.filter(
										occupants,
										({ f, stored }) => stored !== undefined && !sameFact(stored, f)
									)
									assert.equal(out.kind, "committed", "a put raised")
									const [first] = out.out
									assert.equal(first?.result.kind, "delete")
									assert.equal(first?.rows.length, displaced.length, "the occupants displaced")
									for (const { f, stored } of occupants) {
										if (stored !== undefined) {
											k.note(
												sameFact(stored, f)
													? "a put of the stored fact"
													: "a put displacing its occupant"
											)
										}
										held.set(f.id, f)
									}
									break
								}
							}
							for (const relation of writtenRelations) {
								const facts = Arr.sort(
									[...defined(model.get(relation), relation).values()],
									Order.mapInput(Order.String, (f: WriteFact) => f.id)
								)
								const rows = yield* stored(installed, tableOf[relation], columnsOf[relation])
								assert.deepEqual(rows, Arr.map(facts, rowOf), `${relation} after ${step.op}`)
							}
						}
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "a host model of each relation's facts under vector equality, binary32 components with -0 equal to 0"
		},
		budget: { runs: 24, steered: 60 },
		kept: [],
		kills: []
	})
