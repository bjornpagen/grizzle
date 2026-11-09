/**
 * A query-sourced write into a relation with generated fields, against PostgreSQL 19.
 *
 * Items holds two relations of one heading, Item and Spot, the second mutable: each a key `id`, four written fields
 * (`v`, a tier, a numeral `k`, also a candidate key, and a day's text, one per numeral) and four generated fields of three kinds: `copy`,
 * the written `v` itself; `rate`, a closed read of the tier's rate, which Rate holds for low and mid and not for high, so
 * a high row's `rate` has no value; `parsed`, the numeral cast into a bigint; and `when`, the day's text parsed into a
 * date, which a generated column holds only as an IMMUTABLE expression. Each case stores up to three lawful rows,
 * then inserts or puts one to three rows, each fresh or a repeat of a stored one, from a query over a relation
 * parameter, a source the write cannot prove unique on the key, into one of the two relations. The write's statements
 * request the rows' written fields alone, and a requested fact's generated values are its generation expressions over
 * them.
 *
 * The oracle is the write restated over the drawn rows: the source's rows as a set; two at one key that differ is
 * the primary key's refusal; a high row the generated `rate`'s; an insert at a stored key that differs, the primary
 * key's; two source rows, or two rows after the write, that share `k` under two keys, the candidate key's; any other
 * write is applied, the stored rows after it each source row at its key over the rows before, every generated field
 * its expression's value, accepted where it changed a row and no-change otherwise. A refused write names one of the
 * laws it breaks and changes nothing.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { compiledOpen } from "#adapter/db/open.ts"
import { ChangeSet, type Law } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, date, generated, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, key, mutable, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, bareRecord, unorderedEqual } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { loginLayer } from "#test/support/worlds.ts"

const tiers = ["low", "mid", "high"] as const
type TierHandle = (typeof tiers)[number]

/** Each tier's rate, as Rate holds it: high holds none, so a high row's rate has no value. */
const rates: Readonly<Record<TierHandle, number | undefined>> = { low: 1, mid: 2, high: undefined }

const Tier = closed("Tier", tiers)
const Rate = closed.relation(
	"Rate",
	{ tier: closedId(Tier), rate: pg.integer },
	["tier"],
	[
		{ tier: "low", rate: 1 },
		{ tier: "mid", rate: 2 }
	]
)
const NumeralText = str.regex("^[0-9]{1,6}$", "u")
/** Days of 2024 whose text is a date's in every month: the 10th to the 19th of January to September. */
const DayText = str.regex("^2024-0[1-9]-1[0-9]$", "u")

const written = { id: pg.integer, v: pg.bigint, tier: closedId(Tier), k: NumeralText, day: DayText }

const Item = relation.generated("Item", written, ["id"], (r) => ({
	copy: generated(pg.bigint, r.v),
	rate: generated(pg.integer, Rate.at("rate", r.tier)),
	parsed: generated(pg.bigint, Compute.cast(r.k, pg.bigint)),
	when: generated(date, Compute.cast(r.day, date))
}))
const Spot = relation.generated("Spot", written, ["id"], (r) => ({
	copy: generated(pg.bigint, r.v),
	rate: generated(pg.integer, Rate.at("rate", r.tier)),
	parsed: generated(pg.bigint, Compute.cast(r.k, pg.bigint)),
	when: generated(date, Compute.cast(r.day, date))
}))
const itemNumeral = key(on(Item, "k"))
const spotNumeral = key(on(Spot, "k"))
const Items = schema("Items", { Tier, Rate, Item, Spot }, [itemNumeral, spotNumeral, mutable(Spot)])

/** A row as a case states it. */
interface Row {
	readonly id: number
	readonly v: bigint
	readonly tier: TierHandle
	readonly k: Numeral
}

/** The numerals a row draws, so rows often share one. */
const numerals = ["0", "1", "2"] as const
type Numeral = (typeof numerals)[number]

/** Each numeral's day: a row's day text is its numeral's, so the day adds no dimension to the space. */
const dayOf = {
	"0": "2024-01-10",
	"1": "2024-02-11",
	"2": "2024-09-19"
} as const satisfies Readonly<Record<Numeral, string>>

/** A row as its relation stores its written fields, its day its numeral's. */
const writtenOf = (row: Row) => ({ ...row, day: dayOf[row.k] })

type Target = "Item" | "Spot"

interface Case {
	readonly target: Target
	readonly op: "insert" | "put"
	/** The rows stored before the write: lawful, at distinct keys and numerals, of tiers Rate holds. */
	readonly stored: ReadonlyArray<Row>
	/** The rows the write's query delivers. */
	readonly source: Arr.NonEmptyReadonlyArray<Row>
}

const rowGen =
	(tierGen: Gen<TierHandle>): Gen<Row> =>
	(source) => ({
		id: source.draw(int(1, 3)),
		v: BigInt(source.draw(int(0, 2))),
		tier: source.draw(tierGen),
		k: source.draw(element(numerals))
	})

/** Stored rows at distinct keys and numerals, of tiers Rate holds. */
const storedGen: Gen<ReadonlyArray<Row>> = (source) =>
	Arr.dedupeWith(
		source.draw(array(rowGen(element(["low", "mid"] as const)), { min: 0, max: 3 })),
		(a, b) => a.id === b.id || a.k === b.k
	)

const caseGen: Gen<Case> = (source) => {
	const target = source.draw(element(["Item", "Spot"] as const))
	const op = source.draw(element(["insert", "put"] as const))
	const stored = source.draw(storedGen)
	/** A source row: a fresh one, or, half the time, a repeat of a stored one. */
	const row: Gen<Row> = Arr.isReadonlyArrayNonEmpty(stored)
		? oneOf([rowGen(element(tiers)), element(stored)])
		: rowGen(element(tiers))
	const first = source.draw(row)
	const more = source.draw(array(row, { min: 0, max: 2 }))
	return { target, op, stored, source: [first, ...more] }
}

/** A row's facts as Items stores them: its written fields and each generated field's value. */
const factOf = (row: Row): Readonly<Record<string, unknown>> =>
	bareRecord({
		id: row.id,
		v: row.v,
		tier: row.tier,
		k: row.k,
		day: dayOf[row.k],
		copy: row.v,
		rate: rates[row.tier],
		parsed: BigInt(row.k),
		when: dayOf[row.k]
	})

const sameRow = (a: Row, b: Row): boolean =>
	a.id === b.id && a.v === b.v && a.tier === b.tier && a.k === b.k

/** What the oracle says of a case: the laws a refusal may name, or the rows stored after it and whether any changed. */
type Expected =
	| { readonly kind: "refused"; readonly laws: Arr.NonEmptyReadonlyArray<Law["kind"]> }
	| { readonly kind: "applied"; readonly rows: ReadonlyArray<Row>; readonly changed: boolean }

const expectedOf = (c: Case): Expected => {
	const source = Arr.dedupeWith(c.source, sameRow)
	const laws: Array<Law["kind"]> = []
	if (Arr.some(source, (a) => Arr.some(source, (b) => a.id === b.id && !sameRow(a, b)))) {
		laws.push("primaryKey")
	}
	if (Arr.some(source, (r) => rates[r.tier] === undefined)) {
		laws.push("generated")
	}
	if (
		c.op === "insert" &&
		Arr.some(source, (r) => Arr.some(c.stored, (s) => s.id === r.id && !sameRow(r, s)))
	) {
		laws.push("primaryKey")
	}
	const after = [
		...Arr.filter(c.stored, (s) => !Arr.some(source, (r) => r.id === s.id)),
		...Arr.map(source, (r) =>
			c.op === "insert"
				? Option.getOrElse(
						Arr.findFirst(c.stored, (s) => s.id === r.id),
						() => r
					)
				: r
		)
	]
	const shareNumeral = (rows: ReadonlyArray<Row>): boolean =>
		Arr.some(rows, (a) => Arr.some(rows, (b) => a.k === b.k && a.id !== b.id))
	if (shareNumeral(source) || shareNumeral(after)) {
		laws.push("key")
	}
	if (Arr.isReadonlyArrayNonEmpty(laws)) {
		return { kind: "refused", laws }
	}
	const changed = !Arr.every(source, (r) => Arr.some(c.stored, (s) => sameRow(r, s)))
	return { kind: "applied", rows: after, changed }
}

type Feature =
	| `${Target} ${"insert" | "put"} applied`
	| `refused by ${"primaryKey" | "generated" | "key"}`
	| "an unchanged write"

layer(Substrate.layer)(
	"a query-sourced write into generated fields, against PostgreSQL 19",
	(it) => {
		it.effect(
			"an insert or a put from a query requests the written fields alone and stores every generated field's value",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const o = yield* installed(
							Items,
							{},
							{ label: "genquery", extensions: [], programs: {} }
						)
						const group = installationGroup(namesOf(o.installed))
						return yield* Effect.gen(function* () {
							const db = yield* compiledOpen(o.server.roles.app, {})
							/** Each relation's rows as grizzle reads them, generated fields included, and the write's source,
							 * the rows its relation parameter binds, delivered as they are. */
							const rowsOf = {
								Item: query(o.schema).rule((r) => {
									const { id, v: value, tier, k, day, copy, rate, parsed, when } = v(Item, "item")
									return r
										.match(Item, { id, v: value, tier, k, day, copy, rate, parsed, when })
										.find({ id, v: value, tier, k, day, copy, rate, parsed, when })
								}),
								Spot: query(o.schema).rule((r) => {
									const { id, v: value, tier, k, day, copy, rate, parsed, when } = v(Spot, "spot")
									return r
										.match(Spot, { id, v: value, tier, k, day, copy, rate, parsed, when })
										.find({ id, v: value, tier, k, day, copy, rate, parsed, when })
								})
							}
							const sourceQuery = query(o.schema).rule((r) => {
								const rows = r.relation("rows", written)
								const row = v(rows, "row")
								return r.match(rows, row).find(row)
							})
							/** The rows of `target` as grizzle reads them. */
							const read = (target: Target) =>
								target === "Item"
									? Effect.flatMap(db.execute(rowsOf.Item, {}), (r) => r.collect)
									: Effect.flatMap(db.execute(rowsOf.Spot, {}), (r) => r.collect)
							/** The ChangeSet inserting `rows` into `target`, or the write of the case from its query. */
							const seed = (target: Target, rows: ReadonlyArray<Row>) =>
								target === "Item"
									? ChangeSet.empty(o.schema).insert(Item, Arr.map(rows, writtenOf))
									: ChangeSet.empty(o.schema).insert(Spot, Arr.map(rows, writtenOf))
							const write = (target: Target, op: Case["op"]) =>
								target === "Item"
									? op === "insert"
										? ChangeSet.empty(o.schema).insert(Item, sourceQuery)
										: ChangeSet.empty(o.schema).put(Item, sourceQuery)
									: op === "insert"
										? ChangeSet.empty(o.schema).insert(Spot, sourceQuery)
										: ChangeSet.empty(o.schema).put(Spot, sourceQuery)
							return yield* explore(
								{
									suite: "write/generated-source",
									draw: drawn(caseGen),
									literal: Formatter.format,
									oracle: {
										kind: "specification",
										name: "the write restated over the drawn rows, each generated field its expression's value"
									},
									kept: [
										{
											note: "the swarm's crash: a put from a query of one row into a relation with a generated field compiled to a statement requesting the generated column from its input",
											sketch: {
												target: "Spot",
												op: "put",
												stored: [{ id: 1, v: 0n, tier: "low", k: "0" }],
												source: [{ id: 1, v: 2n, tier: "low", k: "0" }]
											},
											draws: "",
											reaches: ["Spot put applied"]
										}
									],
									runs: 60,
									shrink: { kind: "bounded", candidates: 100 },
									concurrency: 1,
									steerEvery: 16,
									coverage: required<Feature>(
										[
											"Item insert applied",
											"Item put applied",
											"Spot insert applied",
											"Spot put applied",
											"refused by primaryKey",
											"refused by generated",
											"refused by key",
											"an unchanged write"
										],
										{ cases: 60, sense: notesOnly }
									),
									caseHang
								},
								(k, c) =>
									Effect.gen(function* () {
										yield* replaceRows(s.admin, group, [])
										if (Arr.isReadonlyArrayNonEmpty(k.stored)) {
											const seeded = yield* db.apply(seed(k.target, k.stored), {})
											assert.equal(seeded.kind, "accepted", "the stored rows are lawful")
										}
										const before: ReadonlyArray<Readonly<Record<string, unknown>>> = yield* read(
											k.target
										)
										const applied = yield* Effect.result(
											db.apply(write(k.target, k.op), { rows: Arr.map(k.source, writtenOf) })
										)
										if (Result.isFailure(applied)) {
											return assert.fail(
												`a lawful schema's write is an outcome: ${applied.failure._tag}`
											)
										}
										const outcome = applied.success
										const after: ReadonlyArray<Readonly<Record<string, unknown>>> = yield* read(
											k.target
										)
										const expected = expectedOf(k)
										if (expected.kind === "refused") {
											if (outcome.kind !== "invariant-rejected") {
												return assert.fail(
													`a write breaking ${Arr.join(expected.laws, ", ")} is refused, not ${outcome.kind}`
												)
											}
											const [law] = refusedLaws(outcome.refused)
											assert.ok(
												expected.laws.includes(law.kind),
												`the refusal names one of ${Arr.join(expected.laws, ", ")}, not ${Formatter.format(law)}`
											)
											unorderedEqual(after, before, "a refused write changes nothing")
											c.note(
												law.kind === "generated"
													? "refused by generated"
													: law.kind === "key"
														? "refused by key"
														: "refused by primaryKey"
											)
											return
										}
										assert.equal(
											outcome.kind,
											expected.changed ? "accepted" : "no-change",
											"accepted where the write changed a row"
										)
										unorderedEqual(
											after,
											Arr.map(expected.rows, factOf),
											"the rows after the write"
										)
										c.note(expected.changed ? `${k.target} ${k.op} applied` : "an unchanged write")
									})
							)
						}).pipe(Effect.scoped, withLayer(loginLayer(o.installed, o.server)))
					}).pipe(Effect.scoped)
				)
		)
	}
)
