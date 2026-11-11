/**
 * Compute.sha256 on PostgreSQL 19rc1, against the host.
 *
 * 1. The digest over drawn bytes, the empty value, one byte, every byte value, values about a SHA-256 block's 64 bytes,
 *    where its padding takes one block or two, short values and a long one of a few MiB, each as a check and a query
 *    lower it: PostgreSQL's value of the SQL each lowering renders, PostgreSQL's own `encode(sha256(v), 'hex')`, the
 *    oracle, and the host evaluator's value over the value as a write admits it (scalar/values/bytes.ts
 *    AdmittedBytes) are one text. That text is a member of the language the lowered term states, and the language is
 *    exactly the digests' spelling: of the digest and of its uppercase, shortened, lengthened and non-hex neighbours,
 *    the stated language holds exactly those that are 64 lowercase hex digits.
 * 2. An installed Media schema whose Entry stores its bytes `content` and generates `digest`, the pantry's declaration
 *    `generated(str.regex("^[0-9a-f]{64}$"), Compute.sha256(row.content))`, and `proved`, the same digest cast into its
 *    type, which compilation proves with no guard; a row check holds `digest` to the digest of `content`; and Page, an
 *    ordered family of an Entry's pages, copies its entry's generated digest along the owner axis, so each nested
 *    insert fills each page's copy on the host from the owner's bytes and PostgreSQL's foreign key proves it. Each case
 *    inserts entries with their pages nested; every write is accepted; both columns are STORED generated columns
 *    holding PostgreSQL's own `encode(sha256(content), 'hex')` of each stored value, read back as the host's digest of
 *    the bytes written; a query's head computes the same digest from a read of the bytes; every page's copy is its
 *    entry's digest; and a direct writer's insert that states a digest, even the right one, is refused by PostgreSQL
 *    (428C9), which alone writes a generated column. A ChangeSet's fact that states one is a type error, "a member fact
 *    is not a fact of the relation", and a JavaScript caller's an EncodingFailure (factShape), since an insert holds
 *    only the fields its caller writes: the ChangeSet type/engine agreement's "a generated field supplied" holds both.
 *
 * Plants: compute-digest-hex-upper (the digest's SQL writes uppercase hex, which the generated field's domain refuses
 * and the host's digest never equals).
 *
 * Features: each class of drawn bytes and each lowering the digest is checked through.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, Layer, Option, Order, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import { textOf } from "#compiler/ir/scalar.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import {
	accumulated,
	bytes,
	drawn as drawnField,
	generated,
	natural,
	uuid
} from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, contained, fin, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { evaluateTable } from "#compiler/scalar/compute/evaluate.ts"
import type { Lowered } from "#compiler/scalar/compute/lower.ts"
import { CompilePatterns, ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import { textCell } from "#test/pg/compute/support.ts"
import { probe } from "#test/pg/physical/checks.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { answered, rowsOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	baseParams,
	field,
	type LeafBinding,
	lowerWith,
	plainRender,
	renderSql
} from "#test/unit/compute/support.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/** `length` bytes of a xorshift stream from `seed`, so a case draws two numbers, not MiB. */
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

type Arm = "empty" | "one byte" | "every byte" | "about a block" | "short" | "long"

/** A drawn value: the arm it was drawn from, its length and its seed, its bytes made when the case runs. */
interface Value {
	readonly arm: Arm
	readonly length: number
	readonly seed: number
}

/** A value's bytes: one byte of its seed's value, every byte value once rotated by its seed, or its stream. */
const bodyOf = (value: Value): Uint8Array<ArrayBuffer> =>
	value.arm === "one byte"
		? Uint8Array.of(value.seed & 0xff)
		: value.arm === "every byte"
			? Uint8Array.from({ length: 256 }, (_, i) => (i + value.seed) & 0xff)
			: streamBytes(value.length, value.seed)

const seed: Gen<number> = int(1, 0x7fff_ffff)

/**
 * The lengths about SHA-256's blocks: a message of at most 55 bytes pads within its last block and one of 56 to 63 into
 * a block more, at one block and at two.
 */
const blockLengths: Arr.NonEmptyReadonlyArray<number> = [55, 56, 63, 64, 65, 119, 120, 127, 128]

const value: Gen<Value> = weighted<Value>([
	[1, () => ({ arm: "empty", length: 0, seed: 1 })],
	[2, (s) => ({ arm: "one byte", length: 1, seed: s.draw(int(0, 255)) })],
	[1, (s) => ({ arm: "every byte", length: 256, seed: s.draw(int(0, 255)) })],
	[3, (s) => ({ arm: "about a block", length: s.draw(element(blockLengths)), seed: s.draw(seed) })],
	[3, (s) => ({ arm: "short", length: s.draw(int(2, 200)), seed: s.draw(seed) })]
])

/** A long value of 1 to 4 MiB. */
const long: Gen<Value> = (s) => ({
	arm: "long",
	length: s.draw(int(1 << 20, 4 << 20)),
	seed: s.draw(seed)
})

/** A batch of values, a long one a quarter of the time. */
const batch: Gen<ReadonlyArray<Value>> = (s) => {
	const values = s.draw(array(value, { min: 1, max: 24 }))
	return s.draw(int(0, 3)) === 0 ? [...values, s.draw(long)] : values
}

type SqlFeature =
	| "the empty value"
	| "one byte"
	| "every byte value"
	| "a value that pads within its block"
	| "a value that pads into a block more"
	| "a long value"

const sqlNotes = (values: ReadonlyArray<Value>): ReadonlyArray<SqlFeature> =>
	Arr.flatMap(values, (x): ReadonlyArray<SqlFeature> => {
		const tail = x.length % 64
		return [
			...(x.arm === "empty" ? (["the empty value"] as const) : []),
			...(x.arm === "one byte" ? (["one byte"] as const) : []),
			...(x.arm === "every byte" ? (["every byte value"] as const) : []),
			...(x.arm === "about a block" && tail <= 55
				? (["a value that pads within its block"] as const)
				: []),
			...(x.arm === "about a block" && tail > 55
				? (["a value that pads into a block more"] as const)
				: []),
			...(x.arm === "long" ? (["a long value"] as const) : [])
		]
	})

/** A bytes column, the operand every digest reads. */
const contentColumn: LeafBinding = {
	kind: "column",
	type: field({ kind: "bytes" }, "bytea").scalar
}

/** Compute.sha256 of the variable v, as a Description states it. */
const digestDesc: ExprDesc = { kind: "compute", fn: "sha256", args: [{ kind: "var", var: "v" }] }

/** The term Compute.sha256(v) lowers to as a check and as a query lower it. */
const lowered = (mode: "check" | "query"): Lowered =>
	succeeded(
		lowerWith(mode, digestDesc, { v: contentColumn }, false, baseParams),
		`Compute.sha256 lowers in a ${mode}`
	).root

/** The digests' spelling, 64 lowercase hex digits, as encode's 'hex' writes 32 bytes: the stated language's oracle. */
const digestSpelling = regex("^[0-9a-f]{64}$")

/** A digest's neighbours outside the spelling, or in it where they happen to be: uppercase, a digit short, one more, a non-hex digit first. */
const neighbours = (digest: string): ReadonlyArray<string> => [
	Str.toUpperCase(digest),
	Str.slice(1)(digest),
	`${digest}0`,
	`g${Str.slice(1)(digest)}`
]

/** The host evaluator's value of a lowered term over a bytes value, as a write admits it. */
const hostDigest = (term: Lowered, body: Uint8Array<ArrayBuffer>): string => {
	const table = predicateTable(term.expr)
	const admitted = new AdmittedBytes(body)
	const value = succeeded(
		evaluateTable(
			table.exprs,
			table.root,
			{ value: undefined, column: () => admitted, closed: () => undefined },
			ProgramPatterns.of(tablePatterns(table))
		),
		"the host evaluates the digest"
	)
	if (typeof value !== "string") {
		return assert.fail(`the host's digest is a text, not ${Formatter.format(value)}`)
	}
	return value
}

/** A byte array's hex text, which the batch's SQL decodes. */
const hexOf = (body: Uint8Array<ArrayBuffer>): string => Buffer.from(body).toString("hex")

/** The patterns membership in a term's stated language is read by, parsed as the compile parses them. */
const patterns = new CompilePatterns()

/** Every value's digest, row by row: the check's rendered SQL, the query's, and PostgreSQL's own encode(sha256(v), 'hex'). */
const digestsSql = (check: Lowered, read: Lowered): string =>
	`SELECT (${renderSql(check.expr, plainRender)})::text, (${renderSql(read.expr, plainRender)})::text, pg_catalog.encode(pg_catalog.sha256(r0.v), 'hex') FROM unnest($1::text[]) WITH ORDINALITY AS h(hex, ord) CROSS JOIN LATERAL (SELECT pg_catalog.decode(h.hex, 'hex') AS v) AS r0 ORDER BY h.ord`

/** The pantry's digest type: 64 lowercase hex digits, every digest's language. */
const Digest = str.regex("^[0-9a-f]{64}$")

/** The start a page's copy holds at its axis's base, which no page reaches: its owner axis copies every page's owner. */
const noDigest = Str.repeat(64)("0")

const Entry = relation.generated(
	"Entry",
	{ id: uuid, content: bytes, pages: drawnField(natural) },
	["id"],
	(row) => ({
		digest: generated(Digest, Compute.sha256(row.content)),
		proved: generated(Digest, Compute.cast(Compute.sha256(row.content), Digest))
	})
)
const Page = relation(
	"Page",
	{ id: uuid, entry: uuid, at: drawnField(natural), entryDigest: accumulated(Digest, noDigest) },
	["id"]
)
const Media = schema(
	"Media",
	[Entry, Page],
	[
		ordered(on(Page, "entry", "at"), fin(Entry, "pages")),
		contained(on(Page, "entry", "entryDigest"), on(Entry, "id", "digest")),
		check("Digested", Entry, (row) => row.eq(row.digest, Compute.sha256(row.content)))
	]
)

/**
 * The full world's workload: entries written with their pages nested, the entries' digests read back, a query's head
 * computing each entry's digest from its bytes, and the pages' copies read back.
 */
const programs = Object.freeze({
	insertEntries: ChangeSet.empty(Media).insert(Entry, []),
	entries: query(Media).rule((r) => {
		const { id, digest, proved } = v(Entry, "e")
		return r.match(Entry, { id, digest, proved }).find({ id, digest, proved })
	}),
	computed: query(Media).rule((r) => {
		const { id, content } = v(Entry, "e")
		return r
			.match(Entry, { id, content })
			.find({ id, computed: Compute.cast(Compute.sha256(content), Digest) })
	}),
	pages: query(Media).rule((r) => {
		const { id, entry, entryDigest } = v(Page, "p")
		return r.match(Page, { id, entry, entryDigest }).find({ id, entry, entryDigest })
	})
})

/** A drawn installed case: each entry's value and its count of pages. */
interface Stored {
	readonly entries: ReadonlyArray<{ readonly value: Value; readonly pages: number }>
}

const stored: Gen<Stored> = (s) => ({
	entries: s.draw(
		array((r) => ({ value: r.draw(value), pages: r.draw(int(0, 3)) }), { min: 1, max: 6 })
	)
})

type StoredFeature =
	| "an entry of the empty value"
	| "an entry with no page"
	| "an entry of pages"
	| "entries of two values"

const storedNotes = (d: Stored): ReadonlyArray<StoredFeature> => [
	...(Arr.some(d.entries, (e) => e.value.arm === "empty")
		? (["an entry of the empty value"] as const)
		: []),
	...(Arr.some(d.entries, (e) => e.pages === 0) ? (["an entry with no page"] as const) : []),
	...(Arr.some(d.entries, (e) => e.pages > 0) ? (["an entry of pages"] as const) : []),
	...(d.entries.length >= 2 ? (["entries of two values"] as const) : [])
]

const byId = Order.mapInput(Order.String, (row: { readonly id: string }) => row.id)

layer(Substrate.layer, { excludeTestServices: true })("Compute.sha256 on PostgreSQL", (it) => {
	it.effect(
		"the host's digest of any bytes is PostgreSQL's encode(sha256(v), 'hex'), in exactly the language its term states",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const db = yield* s.session(ownerSession())
					const check = lowered("check")
					const read = lowered("query")
					return yield* explore(
						{
							suite: "pg/compute/digest-sql",
							oracle: {
								kind: "second-implementation",
								name: "PostgreSQL's encode(sha256(v), 'hex')"
							},
							draw: drawn(batch),
							literal: (values: ReadonlyArray<Value>) =>
								Formatter.format(Arr.map(values, (x) => ({ arm: x.arm, length: x.length }))),
							coverage: required<SqlFeature>(
								[
									"the empty value",
									"one byte",
									"every byte value",
									"a value that pads within its block",
									"a value that pads into a block more",
									"a long value"
								],
								{ cases: 24, sense: notesOnly }
							),
							kept: [],
							runs: 24,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						(values: ReadonlyArray<Value>, c: Case<SqlFeature>) =>
							Effect.gen(function* () {
								for (const feature of sqlNotes(values)) {
									c.note(feature)
								}
								const bodies = Arr.map(values, bodyOf)
								const rows = yield* db.values(digestsSql(check, read), [Arr.map(bodies, hexOf)])
								assert.equal(rows.length, bodies.length, "a row per value")
								for (const [row, body] of Arr.zip(rows, bodies)) {
									const oracle = textCell(row, 2)
									assert.equal(textCell(row, 0), oracle, "a check's digest is PostgreSQL's")
									assert.equal(textCell(row, 1), oracle, "a query's digest is PostgreSQL's")
									for (const term of [check, read]) {
										assert.equal(
											hostDigest(term, body),
											oracle,
											"the host's digest is PostgreSQL's"
										)
										const language = defined(textOf(term.nominal), "a digest is text").regex
										if (language === "wildcard") {
											return assert.fail("a digest's term states its language")
										}
										for (const text of [oracle, ...neighbours(oracle)]) {
											assert.equal(
												patterns.member(language, text),
												digestSpelling.test(text),
												`the stated language holds ${Formatter.format(text)} exactly where it is 64 lowercase hex digits`
											)
										}
									}
								}
							})
					)
				})
			)
	)

	it.effect(
		"a generated digest is PostgreSQL's own, read back as the host's, copied into a family by the host, and never written",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/compute/digest-installed",
						oracle: {
							kind: "second-implementation",
							name: "PostgreSQL's encode(sha256(content), 'hex') of each stored value"
						},
						draw: drawn(stored),
						literal: (d: Stored) =>
							Formatter.format(
								Arr.map(d.entries, (e) => ({
									arm: e.value.arm,
									length: e.value.length,
									pages: e.pages
								}))
							),
						coverage: required<StoredFeature>(
							[
								"an entry of the empty value",
								"an entry with no page",
								"an entry of pages",
								"entries of two values"
							],
							{ cases: 8, sense: notesOnly }
						),
						kept: [],
						runs: 8,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					(d: Stored, c: Case<StoredFeature>) =>
						Effect.scoped(
							Effect.gen(function* () {
								for (const feature of storedNotes(d)) {
									c.note(feature)
								}
								const o = yield* installed(Media, {}, { label: "digest", extensions: [], programs })
								const facts = Arr.map(d.entries, (e, i) => ({
									id: uuidOf(i + 1),
									content: bodyOf(e.value),
									pages: upTo(e.pages, (k) => ({ id: uuidOf(1000 * (i + 1) + k) }))
								}))
								const expected = new Map(
									Arr.map(facts, (f) => [f.id, new AdmittedBytes(f.content).digest] as const)
								)
								const stating = defined(facts[0], "an entry whose digest a direct writer states")
								yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									const inserted = yield* answered(
										db.workload.insertEntries.once({
											params: {},
											facts: { insert: { Entry: facts } }
										})
									)
									assert.equal(inserted.kind, "accepted", "every entry and its pages are written")
									const entryRows = yield* rowsOf(
										db.workload.entries.once({ params: {}, facts: {} })
									)
									const entries = Arr.sort(entryRows, byId)
									assert.deepEqual(
										Arr.map(entries, (e) => [e.id, e.digest, e.proved]),
										Arr.map(Arr.sort(facts, byId), (f) => {
											const digest = defined(expected.get(f.id), "an entry's digest")
											return [f.id, digest, digest]
										}),
										"each entry reads back the host's digest of its bytes, uncast and cast"
									)
									const computedRows = yield* rowsOf(
										db.workload.computed.once({ params: {}, facts: {} })
									)
									const computed = Arr.sort(computedRows, byId)
									assert.deepEqual(
										Arr.map(computed, (e) => [e.id, e.computed]),
										Arr.map(entries, (e) => [e.id, e.digest]),
										"a query's head computes each entry's digest from a read of its bytes"
									)
									const pages = yield* rowsOf(db.workload.pages.once({ params: {}, facts: {} }))
									assert.equal(
										pages.length,
										Arr.reduce(d.entries, 0, (n, e) => n + e.pages),
										"every page is written"
									)
									for (const page of pages) {
										assert.equal(
											page.entryDigest,
											defined(expected.get(page.entry), "its entry's digest"),
											"a page's copy is its entry's digest, filled on the host from the owner's bytes"
										)
									}
								}).pipe(
									(body) =>
										Effect.flatMap(Layer.build(o.served.layer), (context) =>
											Effect.provideContext(body, context)
										),
									Effect.scoped
								)
								const s = yield* Substrate
								const owner = yield* s.session(ownerSession())
								const names = namesOf(o.installed)
								const content = names.column(Entry, "content")
								const columns = yield* owner.values(
									`SELECT '"' || replace(attname, '"', '""') || '"', attgenerated::text FROM pg_catalog.pg_attribute WHERE attrelid = $1::text::regclass AND attnum > 0 AND NOT attisdropped`,
									[names.table(Entry)]
								)
								for (const name of [names.column(Entry, "digest"), names.column(Entry, "proved")]) {
									const generatedAs = Option.getOrUndefined(
										Arr.findFirst(columns, (row) => textCell(row, 0) === name)
									)
									assert.equal(
										textCell(defined(generatedAs, `the column ${name}`), 1),
										"s",
										`${name} is a STORED generated column`
									)
								}
								const rows = yield* owner.values(
									`SELECT ${names.column(Entry, "id")}::text, ${names.column(Entry, "digest")}, ${names.column(Entry, "proved")}, pg_catalog.encode(pg_catalog.sha256(${content}), 'hex') FROM ${names.table(Entry)} ORDER BY ${names.column(Entry, "id")}`,
									[]
								)
								assert.deepEqual(
									Arr.map(rows, (row) => [textCell(row, 0), textCell(row, 1), textCell(row, 2)]),
									Arr.map(rows, (row) => [textCell(row, 0), textCell(row, 3), textCell(row, 3)]),
									"each stored digest is PostgreSQL's own encode(sha256(content), 'hex')"
								)
								assert.deepEqual(
									Arr.map(rows, (row) => textCell(row, 0)),
									Arr.map(Arr.sort(facts, byId), (f) => f.id),
									"the entries written are stored"
								)
								const pinned = yield* s.admin.pin
								yield* pinned.query("BEGIN ISOLATION LEVEL SERIALIZABLE", [])
								const stated = yield* probe(
									pinned,
									`INSERT INTO ${names.table(Entry)} (${names.column(Entry, "id")}, ${content}, ${names.column(Entry, "pages")}, ${names.column(Entry, "digest")}) VALUES ($1::uuid, pg_catalog.decode($2::text, 'hex'), 0, $3::text)`,
									[
										uuidOf(999_999),
										hexOf(stating.content),
										defined(expected.get(stating.id), "its digest")
									]
								)
								yield* pinned.query("ROLLBACK", [])
								assert.deepEqual(
									stated.kind === "refused" ? stated.code : stated.kind,
									"428C9",
									"a direct writer that states a digest, even the right one, is refused: PostgreSQL alone writes a generated column"
								)
							})
						)
				)
			)
	)
})
