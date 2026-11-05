import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int, map, shuffled } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { Db } from "#adapter/public/db.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A schema of closed relations only installs, opens and reads on PostgreSQL 19.
 *
 * Closed relations state no key law of their own, so such a schema has no law at all and an empty law DAG. No
 * generated population reaches it (every generated schema holds a stored relation), so it is planted: each case draws
 * the rosters of two closed relations, a drawn subset of a handle pool in a drawn order, one of them with a payload of a
 * number and a text drawn per handle. It installs through its first migration as any schema does, its law theory is
 * empty, Db.open admits it, and a reader reads every closed relation's facts, payload included, from its typed VALUES
 * template, which needs no stored table: all of them, and those a drawn bound on the number admits.
 */
const Label = str.regex("^.*$", "su")

const handlePool = ["Free", "Pro", "Team", "Gold", "Basic"] as const
const labelPool = ["", "a", "é", "\u{1F600}", "two words"] as const

/** A nonempty subset of the handle pool, in a drawn order. */
const rosterGen: Gen<Arr.NonEmptyReadonlyArray<string>> = map(
	shuffled(handlePool, { min: 1, max: handlePool.length }),
	(handles) => nonEmptyList(handles, "a roster")
)

interface PlansCase {
	readonly tiers: Arr.NonEmptyReadonlyArray<string>
	/** Each tier's seats and label, by position. */
	readonly payload: ReadonlyArray<readonly [number, number]>
	readonly regions: Arr.NonEmptyReadonlyArray<string>
	readonly floor: number
}

const plansCaseGen: Gen<PlansCase> = (source) => ({
	tiers: source.draw(rosterGen),
	payload: source.draw(
		array(
			(drawing) => [drawing.draw(int(-3, 60)), drawing.draw(int(0, labelPool.length - 1))] as const,
			{ min: handlePool.length, max: handlePool.length }
		)
	),
	regions: source.draw(rosterGen),
	floor: source.draw(int(-3, 61))
})

type ClosedFeature =
	| "one handle"
	| "every handle"
	| "a bound admitting none"
	| "a bound admitting some"
	| "a bound admitting all"

layer(Substrate.layer, { excludeTestServices: true })("a schema of closed relations only", (it) => {
	it.effect(
		"installs with no law, opens, and reads every closed relation's facts, payload included",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "reads/closed-only",
						draw: drawn(plansCaseGen),
						literal: Formatter.format,
						coverage: required<ClosedFeature>(
							[
								"one handle",
								"every handle",
								"a bound admitting none",
								"a bound admitting some",
								"a bound admitting all"
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
					(c, notes) =>
						Effect.gen(function* () {
							const tierFacts = Arr.map(c.tiers, (id, i) => {
								const [seats, label] = defined(c.payload[i])
								return { id, seats, label: defined(labelPool[label]) }
							})
							const Tier = closed("Tier", c.tiers).with(
								{ seats: pg.integer, label: Label },
								Rec.fromEntries(Arr.map(tierFacts, ({ id, ...fields }) => [id, fields]))
							)
							const Region = closed("Region", c.regions)
							const Plans = schema("Plans", { Tier, Region }, [])
							const opened = yield* installed(Plans, {}, { label: "real", extensions: [] })
							assert.deepEqual(opened.installed.installation.laws.theory.laws, [])
							const tiers = query(opened.schema).rule((r) => {
								const { id, seats, label } = v(Tier, "tier")
								return r.match(Tier, { id, seats, label }).find({ id, seats, label })
							})
							const admitted = query(opened.schema).rule((r) => {
								const { id, seats } = v(Tier, "tier")
								return r.match(Tier, { id, seats }).where(r.ge(seats, c.floor)).find({ id, seats })
							})
							const regions = query(opened.schema).rule((r) => {
								const { id } = v(Region, "region")
								return r.match(Region, { id }).find({ id })
							})
							const bounded = Arr.filter(tierFacts, (f) => f.seats >= c.floor)
							yield* Effect.gen(function* () {
								const db = yield* Db.open(opened.server.roles.app, {})
								const all = yield* (yield* db.execute(tiers, {})).collect
								unorderedEqual(
									Arr.map(all, (row) => ({ id: row.id, seats: row.seats, label: row.label })),
									tierFacts
								)
								const some = yield* (yield* db.execute(admitted, {})).collect
								unorderedEqual(
									Arr.map(some, (row) => ({ id: row.id, seats: row.seats })),
									Arr.map(bounded, (f) => ({ id: f.id, seats: f.seats }))
								)
								const rs = yield* (yield* db.execute(regions, {})).collect
								unorderedEqual(
									Arr.map(rs, (row) => row.id),
									[...c.regions]
								)
							}).pipe(Effect.scoped, withLayer(opened.layer))
							notes.noteAll(
								Arr.flatMap([c.tiers, c.regions], (roster): ReadonlyArray<ClosedFeature> =>
									roster.length === 1
										? ["one handle"]
										: roster.length === handlePool.length
											? ["every handle"]
											: []
								)
							)
							notes.note(
								bounded.length === 0
									? "a bound admitting none"
									: bounded.length === tierFacts.length
										? "a bound admitting all"
										: "a bound admitting some"
							)
						}).pipe(Effect.scoped)
				)
			)
	)
})
