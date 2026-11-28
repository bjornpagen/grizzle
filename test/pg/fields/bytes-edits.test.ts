/**
 * Edits of stored bytes values on PostgreSQL 19, which the host knows only by their SHA-256 digests: a write returns
 * a bytes column's digest (write/insert/statement.ts returnedColumn), the outcome nets its rows by it, and a member's
 * facts are one fact exactly when every field, a bytes field's digest among them, is equal (scalar/values/identity.ts).
 * A case stores a few rows twice over, in Blob and in Held, and a staged value for some of them in Stage. One ChangeSet
 * puts some Blob rows again, some with the value they hold, some one byte off or of another length, some new, and
 * deletes some by their exact facts, one byte off or not; a fact may be stated twice, or a second fact one byte off
 * stated at its key. Another puts every staged value into Held through a query, a put of existing keys, whose UPDATE
 * returns each row's old fact beside its new one, so a value one byte off its old one is netted by its digest alone.
 *
 * Oracle: a model of the relations' rows, which counts each put whose value differs from the stored one and each exact
 * delete of a stored fact, refuses two facts at one key one byte apart, and holds every row each ChangeSet leaves.
 *
 * Each ChangeSet is a member of the full world's served workload, its call's facts keyed by op and relation.
 *
 * Features: the vocabulary Feature below, each kind of put and delete the model counts.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Layer, Option } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	bodyBytes,
	byId,
	cases,
	type Drawn,
	Edits,
	editsInstall,
	editsTemplate,
	type Feature,
	notes,
	oneOff,
	restated,
	sameBytes
} from "#test/pg/fields/bytes-edits.fixtures.ts"
import { writeAnswerOf, rowsOf } from "#test/support/calls.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Each put of another value and each exact delete is counted, two facts at one key one byte apart are refused, and the
 * relation holds the rows the model holds.
 */
export const countsEachPutOfAnotherValueAndEachExactDelete = property.explore(cases, {
	needs: { fixture: Substrate.fresh(editsTemplate) },
	situations: [
		"a put that keeps a value",
		"a put one byte off",
		"a put of another length",
		"a put of a new row",
		"an exact delete of a stored value",
		"an exact delete one byte off",
		"a fact stated twice",
		"two facts at one key one byte apart",
		"no change"
	] satisfies ReadonlyArray<Reached<Feature>>,
	/** Its pre-conversion budget: runs 24, coverage cases 24 (bytes-edits.test.ts at 4fbc3e95). */
	budget: { runs: 24, steered: 24 },
	check:
		({ fixture }, c: Case<Feature>) =>
		(d: Drawn) =>
			Effect.flatMap(fixture, (taken) =>
				Effect.provideService(
					Effect.scoped(
						Effect.gen(function* () {
							for (const feature of notes(d)) {
								c.note(feature)
							}
							const o = yield* openedIn(Edits, {}, editsInstall, taken)
							yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								if (d.stored.length > 0) {
									const rows = Arr.map(d.stored, (b, id) => ({ id, body: bodyBytes(b) }))
									const stage = Arr.flatMap(d.staged, (st, id) =>
										st.as === "unstaged" ? [] : [{ id, body: bodyBytes(st.body) }]
									)
									const stored = yield* writeAnswerOf(
										db.workload.store.once({
											params: {},
											facts: { insert: { Blob: rows, Held: rows, Stage: stage } }
										})
									)
									assert.equal(stored._tag, "accepted", "every stored row is written")
								}
								const staging = yield* writeAnswerOf(
									db.workload.stage.once({ params: {}, facts: {} })
								)
								const staged = Arr.filter(
									d.staged,
									(st) => st.as === "one byte off" || st.as === "resized"
								).length
								if (staged === 0) {
									assert.equal(staging._tag, "unchanged", "no staged value changes a row")
								} else {
									if (staging._tag !== "accepted") {
										return assert.fail(`the staged values are put, not ${staging._tag}`)
									}
									assert.equal(
										defined(
											Option.getOrUndefined(
												Arr.findFirst(staging.counts, (n) => n.relation === "Held")
											),
											"the held relation's counts"
										).put,
										BigInt(staged),
										"a described put counts each row whose value its digest says changed"
									)
								}
								const heldRows = yield* rowsOf(db.workload.heldRows.once({ params: {}, facts: {} }))
								const held = Arr.sort(heldRows, byId)
								assert.deepEqual(
									Arr.map(held, (row) => row.id),
									Arr.map(d.stored, (_, id) => id),
									"every held row stays"
								)
								assert.ok(
									Arr.every(Arr.zip(held, d.staged), ([row, st]) =>
										sameBytes(row.body, bodyBytes(st.body))
									),
									"each held row holds its staged value, or its own"
								)
								const puts = Arr.flatMap(d.edits, (e) =>
									e.kind === "put" ? [{ id: e.id, body: bodyBytes(e.body) }] : []
								)
								const again = restated(d)
								const stated =
									again === undefined
										? puts
										: [
												...puts,
												{
													id: again.id,
													body: bodyBytes(
														d.again === "twice"
															? again.body
															: oneOff(again.body, again.body.length - 1)
													)
												}
											]
								const deletes = Arr.flatMap(d.edits, (e) =>
									e.kind === "delete" ? [{ id: e.id, body: bodyBytes(e.body) }] : []
								)
								const outcome = yield* writeAnswerOf(
									db.workload.edit.once({
										params: {},
										facts: { put: { Blob: stated }, delete: { Blob: deletes } }
									})
								)
								if (again !== undefined && d.again === "one byte off") {
									assert.equal(
										outcome._tag,
										"refused",
										"two facts at one key one byte apart are refused on the key"
									)
									return
								}
								const put = Arr.filter(d.edits, (e) => e.kind === "put" && e.as !== "same").length
								const deleted = Arr.filter(d.edits, (e) => e.kind === "delete" && e.exact).length
								if (put + deleted === 0) {
									assert.equal(outcome._tag, "unchanged", "no edit changes a row")
								} else {
									if (outcome._tag !== "accepted") {
										return assert.fail(`the edits are accepted, not ${outcome._tag}`)
									}
									const counts = defined(
										Option.getOrUndefined(
											Arr.findFirst(outcome.counts, (n) => n.relation === "Blob")
										),
										"the edited relation's counts"
									)
									assert.deepEqual(
										{ added: counts.added, deleted: counts.deleted, put: counts.put },
										{ added: 0n, deleted: BigInt(deleted), put: BigInt(put) },
										"the counts net each row by its value's digest"
									)
								}
								const expected = Arr.sort(
									Arr.flatMap(d.edits, (e) => {
										if (e.kind === "put") {
											return [{ id: e.id, body: bodyBytes(e.body) }]
										}
										const held = {
											id: e.id,
											body: bodyBytes(defined(d.stored[e.id], "a stored row"))
										}
										return e.kind === "delete" && e.exact ? [] : [held]
									}),
									byId
								)
								const blobRows = yield* rowsOf(db.workload.blobRows.once({ params: {}, facts: {} }))
								const blobs = Arr.sort(blobRows, byId)
								assert.deepEqual(
									Arr.map(blobs, (row) => row.id),
									Arr.map(expected, (row) => row.id),
									"the rows the model holds"
								)
								assert.ok(
									Arr.every(Arr.zip(blobs, expected), ([row, model]) =>
										sameBytes(row.body, model.body)
									),
									"each row holds the value the model holds"
								)
							}).pipe(
								(run) =>
									Effect.flatMap(Layer.build(o.served.layer), (context) =>
										Effect.provideContext(run, context)
									),
								Effect.scoped
							)
						})
					),
					Substrate,
					taken.substrate
				)
			),
	oracle: { kind: "second-implementation", name: "a model of the relation's rows" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/scalar/values/bytes.ts",
			original: "\t\tsuper(sha256Hex(bytes))",
			replacement: "\t\tsuper(sha256Hex(bytes.subarray(0, -1)))",
			why: "A bytes value's host digest skips its last byte, so two values one byte apart share a digest and a write of both is refused as a collision where the model accepts it (CATCH census: the old suite caught it as plant fields-bytes-digest-short)."
		}
	]
})
