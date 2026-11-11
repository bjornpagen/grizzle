/**
 * Edits of stored bytes values on PostgreSQL 19rc1, which the host knows only by their SHA-256 digests: a write returns
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
 * Plants: fields-bytes-digest-short (a bytes value's digest skips its last byte, so a value one byte off at its end, or
 * one byte longer, is netted as the value it differs from).
 *
 * Features: the vocabulary Feature below, each kind of put and delete the model counts.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, proportional } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { bytes, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema } from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { answered, rowsOf } from "#test/support/calls.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** `length` bytes of a xorshift stream from `seed`. */
const streamBytes = (length: number, seed: number): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(length)
	let x = seed | 1
	for (let i = 0; i < length; i += 1) {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		out[i] = x & 0xff
	}
	return out
}

/** A value of `length` bytes from `seed`, its byte at `flip` changed when one is given. */
interface Body {
	readonly length: number
	readonly seed: number
	readonly flip: number | undefined
}

const bodyBytes = (body: Body): Uint8Array<ArrayBuffer> => {
	const out = streamBytes(body.length, body.seed)
	if (body.flip !== undefined) {
		out[body.flip] = (defined(out[body.flip], "a flipped byte within its value") + 1) & 0xff
	}
	return out
}

/** The value one byte off `body`, at `at`: the same length, one byte changed. */
const oneOff = (body: Body, at: number): Body => ({
	...body,
	flip: body.flip === at ? undefined : at
})

/** What a case does to one stored row, or to a new one. */
type Edit =
	| { readonly kind: "keep"; readonly id: number }
	| { readonly kind: "put"; readonly id: number; readonly body: Body; readonly as: Put }
	| { readonly kind: "delete"; readonly id: number; readonly body: Body; readonly exact: boolean }

type Put = "same" | "one byte off" | "resized" | "new"

/** A staged value for a stored row: none, its own, one byte off it, or of another length. */
type Staged = "unstaged" | "same" | "one byte off" | "resized"

/** A drawn case: the stored rows' values, each its own id, the edits, how one put fact is stated again, and the stage. */
interface Drawn {
	readonly stored: ReadonlyArray<Body>
	readonly edits: ReadonlyArray<Edit>
	readonly again: "none" | "twice" | "one byte off"
	readonly staged: ReadonlyArray<{ readonly as: Staged; readonly body: Body }>
}

type Feature =
	| "a put that keeps a value"
	| "a put one byte off"
	| "a put of another length"
	| "a put of a new row"
	| "an exact delete of a stored value"
	| "an exact delete one byte off"
	| "a fact stated twice"
	| "two facts at one key one byte apart"
	| "no change"
	| "a described put that keeps a value"
	| "a described put one byte off"
	| "a described put of another length"

const seed: Gen<number> = int(1, 0x7fff_ffff)

const body: Gen<Body> = (s) => ({ length: s.draw(int(0, 24)), seed: s.draw(seed), flip: undefined })

/** The edit of stored row `id`, whose value is `stored`. */
const editOf =
	(id: number, stored: Body): Gen<Edit> =>
	(s) => {
		const longEnough = stored.length > 0
		return s.draw(
			proportional<Edit>([
				[1, () => ({ kind: "keep", id })],
				[2, () => ({ kind: "put", id, body: stored, as: "same" })],
				[
					longEnough ? 3 : 0,
					(r) => ({
						kind: "put",
						id,
						body: oneOff(stored, r.draw(int(0, Math.max(0, stored.length - 1)))),
						as: "one byte off"
					})
				],
				[
					2,
					(r) => ({
						kind: "put",
						id,
						body: { ...stored, length: stored.length + r.draw(int(1, 3)), flip: undefined },
						as: "resized"
					})
				],
				[2, () => ({ kind: "delete", id, body: stored, exact: true })],
				[
					longEnough ? 2 : 0,
					(r) => ({
						kind: "delete",
						id,
						body: oneOff(stored, r.draw(int(0, Math.max(0, stored.length - 1)))),
						exact: false
					})
				]
			])
		)
	}

/** The staged value of a stored row whose value is `stored`. */
const stagedOf =
	(stored: Body): Gen<{ readonly as: Staged; readonly body: Body }> =>
	(s) =>
		s.draw(
			proportional<{ readonly as: Staged; readonly body: Body }>([
				[1, () => ({ as: "unstaged", body: stored })],
				[1, () => ({ as: "same", body: stored })],
				[
					stored.length > 0 ? 3 : 0,
					(r) => ({
						as: "one byte off",
						body: oneOff(stored, r.draw(int(0, Math.max(0, stored.length - 1))))
					})
				],
				[
					1,
					(r) => ({
						as: "resized",
						body: { ...stored, length: stored.length + r.draw(int(1, 3)), flip: undefined }
					})
				]
			])
		)

const cases: Gen<Drawn> = (s) => {
	const stored = s.draw(array(body, { min: 0, max: 4 }))
	const edits: Array<Edit> = Arr.map(stored, (b, id) => s.draw(editOf(id, b)))
	const fresh = s.draw(int(0, 2))
	for (let i = 0; i < fresh; i += 1) {
		edits.push({ kind: "put", id: stored.length + i, body: s.draw(body), as: "new" })
	}
	const staged = Arr.map(stored, (b) => s.draw(stagedOf(b)))
	return {
		stored,
		edits,
		again: s.draw(element(["none", "twice", "one byte off"] as const)),
		staged
	}
}

/** The put edit a case states again, the first whose value has a byte, when it states one again. */
const restated = (d: Drawn): Extract<Edit, { readonly kind: "put" }> | undefined =>
	d.again === "none"
		? undefined
		: Option.getOrUndefined(
				Arr.findFirst(
					d.edits,
					(e): e is Extract<Edit, { readonly kind: "put" }> =>
						e.kind === "put" && (d.again === "twice" || e.body.length > 0)
				)
			)

const notes = (d: Drawn): ReadonlyArray<Feature> => {
	const out: Array<Feature> = []
	const named: Record<Put, Feature> = {
		same: "a put that keeps a value",
		"one byte off": "a put one byte off",
		resized: "a put of another length",
		new: "a put of a new row"
	}
	for (const e of d.edits) {
		if (e.kind === "put") {
			out.push(named[e.as])
		}
		if (e.kind === "delete") {
			out.push(e.exact ? "an exact delete of a stored value" : "an exact delete one byte off")
		}
	}
	const again = restated(d)
	if (again !== undefined) {
		out.push(d.again === "twice" ? "a fact stated twice" : "two facts at one key one byte apart")
	}
	if (again === undefined || d.again === "twice") {
		const counted = Arr.filter(
			d.edits,
			(e) => (e.kind === "put" && e.as !== "same") || (e.kind === "delete" && e.exact)
		)
		if (counted.length === 0) {
			out.push("no change")
		}
	}
	const described: Record<Staged, Feature | undefined> = {
		unstaged: undefined,
		same: "a described put that keeps a value",
		"one byte off": "a described put one byte off",
		resized: "a described put of another length"
	}
	for (const st of d.staged) {
		const feature = described[st.as]
		if (feature !== undefined) {
			out.push(feature)
		}
	}
	return out
}

const Blob = relation("Blob", { id: pg.integer, body: bytes }, ["id"])
const Held = relation("Held", { id: pg.integer, body: bytes }, ["id"])
const Stage = relation("Stage", { id: pg.integer, body: bytes }, ["id"])
const Edits = schema("BytesEdits", { Blob, Held, Stage }, [mutable(Blob), mutable(Held)])

/** Every row of `target`, with its value. */
const rowsOf = (target: typeof Blob | typeof Held) =>
	query(Edits).rule((r) => {
		const { id, body } = v(target, "row")
		return r.match(target, { id, body }).find({ id, body })
	})

/**
 * The full world's workload: the stored rows written with the facts each call gives; every staged value put into Held
 * through a query; the edits, one write that puts and deletes Blob facts, each op's facts each call gives; and Blob's
 * and Held's rows read back.
 */
const programs = {
	store: ChangeSet.empty(Edits).insert(Blob, []).insert(Held, []).insert(Stage, []),
	stage: ChangeSet.empty(Edits).put(
		Held,
		query(Edits).rule((r) => {
			const { id, body } = v(Stage, "staged")
			return r.match(Stage, { id, body }).match(Held, { id }).find({ id, body })
		})
	),
	edit: ChangeSet.empty(Edits).put(Blob, []).delete(Blob, []),
	blobRows: rowsOf(Blob),
	heldRows: rowsOf(Held)
}

const byId = Order.mapInput(Order.Number, (row: { readonly id: number }) => row.id)

/** Whether two values hold the same bytes. */
const sameBytes = (x: Uint8Array, y: Uint8Array): boolean =>
	x.length === y.length && x.every((byte, at) => byte === y[at])

layer(Substrate.layer, { excludeTestServices: true })("bytes edited by their digests", (it) => {
	it.effect(
		"counts each put of another value and each exact delete, refuses two facts at one key one byte apart, and holds the rows the model holds",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/fields/bytes-edits",
						oracle: { kind: "second-implementation", name: "a model of the relation's rows" },
						draw: drawn(cases),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a put that keeps a value",
								"a put one byte off",
								"a put of another length",
								"a put of a new row",
								"an exact delete of a stored value",
								"an exact delete one byte off",
								"a fact stated twice",
								"two facts at one key one byte apart",
								"no change"
							],
							{ cases: 24, sense: notesOnly }
						),
						kept: [],
						runs: 24,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(d: Drawn, c: Case<Feature>) =>
						Effect.scoped(
							Effect.gen(function* () {
								for (const feature of notes(d)) {
									c.note(feature)
								}
								const o = yield* installed(
									Edits,
									{},
									{ label: "bytesedits", extensions: [], programs }
								)
								yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									if (d.stored.length > 0) {
										const rows = Arr.map(d.stored, (b, id) => ({ id, body: bodyBytes(b) }))
										const stage = Arr.flatMap(d.staged, (st, id) =>
											st.as === "unstaged" ? [] : [{ id, body: bodyBytes(st.body) }]
										)
										const stored = yield* answered(
											db.workload.store.once({
												params: {},
												facts: { insert: { Blob: rows, Held: rows, Stage: stage } }
											})
										)
										assert.equal(stored.kind, "accepted", "every stored row is written")
									}
									const staging = yield* answered(db.workload.stage.once({ params: {}, facts: {} }))
									const staged = Arr.filter(
										d.staged,
										(st) => st.as === "one byte off" || st.as === "resized"
									).length
									if (staged === 0) {
										assert.equal(staging.kind, "unchanged", "no staged value changes a row")
									} else {
										if (staging.kind !== "accepted") {
											return assert.fail(`the staged values are put, not ${staging.kind}`)
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
									const heldRows = yield* rowsOf(
										db.workload.heldRows.once({ params: {}, facts: {} })
									)
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
									const outcome = yield* answered(
										db.workload.edit.once({
											params: {},
											facts: { put: { Blob: stated }, delete: { Blob: deletes } }
										})
									)
									if (again !== undefined && d.again === "one byte off") {
										assert.equal(
											outcome.kind,
											"refused",
											"two facts at one key one byte apart are refused on the key"
										)
										return
									}
									const put = Arr.filter(d.edits, (e) => e.kind === "put" && e.as !== "same").length
									const deleted = Arr.filter(d.edits, (e) => e.kind === "delete" && e.exact).length
									if (put + deleted === 0) {
										assert.equal(outcome.kind, "unchanged", "no edit changes a row")
									} else {
										if (outcome.kind !== "accepted") {
											return assert.fail(`the edits are accepted, not ${outcome.kind}`)
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
									const blobRows = yield* rowsOf(
										db.workload.blobRows.once({ params: {}, facts: {} })
									)
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
						)
				)
			)
	)
})
