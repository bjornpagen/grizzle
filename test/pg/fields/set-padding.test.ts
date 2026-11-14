/**
 * The set algebra over a drafted bits domain keeps every padding bit 0, on PostgreSQL 19rc2. A set over a roster of n
 * codes is bit(m), m the codes rounded up to whole hex digits, and its domain's CHECK holds every bit past the last
 * code at 0; so every set grizzle computes must leave those bits clear, or the CHECK refuses the write with 23514.
 *
 * Each case installs a roster of 1 to 9 codes, so every padding of 0 to 3 bits is met, a closed relation C over pairs
 * of its codes, and a relation R holding two drawn sets a and b and a code k, whose generated columns are a ∪ b, a ∩ b,
 * a − b, the complement of a within the roster ((a ∪ the full set's literal) − a, the complement masked by the
 * roster's full set), and C.row(k), each cast to the bits domain by its column. The writes are drawn rows of R, which must all
 * be accepted: the domain's CHECK never fires on a value grizzle computed. A query reads each row back, its stored
 * columns and the same union and difference computed in the query, which must equal the host model's sets; and every
 * stored set's text must be the model's positional text at m bits (test/support/closed/bit-text.ts setText), so a bit
 * past the last code reads 0 wherever it lies.
 *
 * Oracle: the host model, plain Sets of codes, and the test oracle's positional text of each.
 *
 * Plants: fields-set-padding-bit-set (a set's text sets its last bit, a padding bit wherever the roster's codes do not
 * fill their last hex digit).
 *
 * Features: the vocabulary Feature below, each padding width a roster meets.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, type Gen, int, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Order, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { Bits, bits, closedId, generated, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert } from "#test/support/assert.ts"
import { answered, rowsOf } from "#test/support/calls.ts"
import { setText, wholeDigits } from "#test/support/closed/bit-text.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** The handle of code c of the drawn roster. */
const handleOf = (code: number): string => `s${code}`

/** One drawn row of R: its code k and its two sets' codes. */
interface Row {
	readonly k: number
	readonly a: ReadonlyArray<number>
	readonly b: ReadonlyArray<number>
}

/** A drawn case: the roster's codes, which pairs (from, to) C holds, row-major, and R's rows. */
interface Drawn {
	readonly size: number
	readonly pairs: ReadonlyArray<boolean>
	readonly rows: NonEmptyReadonlyArray<Row>
}

const cases: Gen<Drawn> = (s) => {
	const size = s.draw(int(1, 9))
	const codes = Array.from({ length: size }, (_, code) => code)
	const row: Gen<Row> = (r) => ({
		k: r.draw(int(0, size - 1)),
		a: r.draw(subarray(codes)),
		b: r.draw(subarray(codes))
	})
	return {
		size,
		pairs: s.draw(array(boolean, { min: size * size, max: size * size })),
		rows: [s.draw(row), ...s.draw(array(row, { min: 0, max: 3 }))]
	}
}

type Feature =
	| "one pad bit"
	| "two pad bits"
	| "three pad bits"
	| "no pad bit"
	| "an empty set computed"
	| "a full set computed"

/** The features of a padding of `pad` bits. */
const padFeature = (pad: number): Feature =>
	pad === 0
		? "no pad bit"
		: pad === 1
			? "one pad bit"
			: pad === 2
				? "two pad bits"
				: "three pad bits"

/**
 * The schema a case declares, its sets over the roster S, and its full world's workload: R's rows written with the facts
 * each call gives, and every row read back with its stored sets and the query's own union and difference of a and b.
 */
const schemaOf = (d: Drawn) => {
	const handles: NonEmptyReadonlyArray<string> = [
		handleOf(0),
		...Array.from({ length: d.size - 1 }, (_, code) => handleOf(code + 1))
	]
	const S = closed("S", handles)
	const C = closed.relation(
		"C",
		{ from: closedId(S), to: closedId(S) },
		["from", "to"],
		Arr.flatMap(d.pairs, (held, at) =>
			held ? [{ from: handleOf(Math.floor(at / d.size)), to: handleOf(at % d.size) }] : []
		)
	)
	const R = relation.generated(
		"R",
		{ id: pg.integer, k: closedId(S), a: bits(S), b: bits(S) },
		["id"],
		(r) => ({
			u: generated(bits(S), Compute.union(r.a, r.b)),
			i: generated(bits(S), Compute.intersection(r.a, r.b)),
			d: generated(bits(S), Compute.difference(r.a, r.b)),
			e: generated(bits(S), Compute.difference(Compute.union(r.a, Bits.of(S, handles)), r.a)),
			w: generated(bits(S), C.row(r.k))
		})
	)
	const Sets = schema("SetPadding", [S, C, R], [])
	const programs = {
		write: ChangeSet.empty(Sets).insert(R, []),
		sets: query(Sets).rule((r) => {
			const { id, a, b, u, i, d: diff, e, w } = v(R, "r")
			return r.match(R, { id, a, b, u, i, d: diff, e, w }).find({
				id,
				u,
				i,
				d: diff,
				e,
				w,
				qu: Compute.union(a, b),
				qd: Compute.difference(a, b)
			})
		})
	}
	return { S, R, Sets, programs }
}

/** A set's codes, ascending. */
const sorted = (codes: Iterable<number>): ReadonlyArray<number> =>
	Arr.sort(Arr.dedupe(Arr.fromIterable(codes)), Order.Number)

/** A read set's codes, ascending, each handle s<c> read back as c. */
const codesOf = (set: Iterable<string>): ReadonlyArray<number> =>
	sorted(Arr.map(Arr.fromIterable(set), (h) => Number(Str.slice(1)(h))))

layer(Substrate.layer, { excludeTestServices: true })(
	"the set algebra over a drafted bits domain",
	(it) => {
		it.effect(
			"computes every set with its padding bits 0, accepted by the domain and read back as the model's",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "pg/fields/set-padding",
							oracle: {
								kind: "second-implementation",
								name: "plain Sets of codes, and the oracle's positional text of each at the domain's width"
							},
							draw: drawn(cases),
							literal: Formatter.format,
							coverage: required<Feature>(
								[
									"one pad bit",
									"two pad bits",
									"three pad bits",
									"no pad bit",
									"an empty set computed",
									"a full set computed"
								],
								{ cases: 16, sense: notesOnly }
							),
							kept: [],
							runs: 12,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(d: Drawn, c: Case<Feature>) =>
							Effect.scoped(
								Effect.gen(function* () {
									const { S, R, Sets, programs } = schemaOf(d)
									const o = yield* installed(Sets, {}, { label: "setpadding", programs })
									const s = yield* Substrate
									const names = namesOf(o.installed)
									const all = Array.from({ length: d.size }, (_, code) => code)
									const model = Arr.map(d.rows, (row, id) => {
										const a = new Set(row.a)
										const b = new Set(row.b)
										return {
											id,
											a: sorted(row.a),
											b: sorted(row.b),
											u: sorted([...row.a, ...row.b]),
											i: sorted(Arr.filter(row.a, (x) => b.has(x))),
											d: sorted(Arr.filter(row.a, (x) => !b.has(x))),
											e: sorted(Arr.filter(all, (x) => !a.has(x))),
											w: sorted(Arr.filter(all, (to) => d.pairs[row.k * d.size + to] === true))
										}
									})
									yield* Effect.gen(function* () {
										const db = yield* Db.open(o.served.login.roles.app, {})
										const outcome = yield* answered(
											db.workload.write.once({
												params: {},
												facts: {
													insert: {
														R: Arr.map(d.rows, (row, id) => ({
															id,
															k: handleOf(row.k),
															a: Bits.of(S, Arr.map(row.a, handleOf)),
															b: Bits.of(S, Arr.map(row.b, handleOf))
														}))
													}
												}
											})
										)
										assert.equal(
											outcome.kind,
											"accepted",
											`every computed set meets the domain: ${Formatter.format(d)}`
										)
										const read = yield* rowsOf(db.workload.sets.once({ params: {}, facts: {} }))
										assert.deepEqual(
											Arr.sort(
												Arr.map(read, (row) => ({
													id: row.id,
													u: codesOf(row.u),
													i: codesOf(row.i),
													d: codesOf(row.d),
													e: codesOf(row.e),
													w: codesOf(row.w),
													qu: codesOf(row.qu),
													qd: codesOf(row.qd)
												})),
												Order.mapInput(Order.Number, (row: { readonly id: number }) => row.id)
											),
											Arr.map(model, (m) => ({
												id: m.id,
												u: m.u,
												i: m.i,
												d: m.d,
												e: m.e,
												w: m.w,
												qu: m.u,
												qd: m.d
											})),
											"every stored and queried set is the model's"
										)
									}).pipe(
										(body) =>
											Effect.flatMap(Layer.build(o.served.layer), (context) =>
												Effect.provideContext(body, context)
											),
										Effect.scoped
									)
									const columns = ["a", "b", "u", "i", "d", "e", "w"] as const
									const owner = yield* s.session(ownerSession())
									const stored = yield* owner.values(
										`SELECT ${Arr.join(
											Arr.map(columns, (f) => `${names.column(R, f)}::text`),
											", "
										)} FROM ${names.table(R)} ORDER BY ${names.column(R, "id")}`,
										[]
									)
									assert.deepEqual(
										Arr.map(stored, (row) => Arr.map(row, (cell) => String(cell))),
										Arr.map(model, (m) => Arr.map(columns, (f) => setText(d.size, m[f]))),
										"every stored set is the model's positional text, its padding 0"
									)
									c.note(padFeature(wholeDigits(d.size) - d.size))
									if (
										Arr.some(model, (m) => m.d.length === 0 || m.i.length === 0 || m.e.length === 0)
									) {
										c.note("an empty set computed")
									}
									if (Arr.some(model, (m) => m.u.length === d.size || m.e.length === d.size)) {
										c.note("a full set computed")
									}
								})
							)
					)
				)
		)
	}
)
