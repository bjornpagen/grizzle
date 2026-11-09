import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int, map, shuffled } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { compiledOpen } from "#adapter/db/open.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { loginLayer } from "#test/support/worlds.ts"

/**
 * A schema of closed relations only installs, opens and reads on PostgreSQL 19.
 *
 * Rosters and closed relations state no law of their own, so such a schema has no law at all and an empty law DAG. No
 * generated population reaches it (every generated schema holds a stored relation), so it is planted: each case draws
 * two rosters, a drawn subset of a handle pool in a drawn order, and a closed relation over one of them, keyed by its
 * closed id, with a number and a text drawn per handle. It installs through its first migration as any schema does, its
 * law theory is empty, it stores no table (a roster is a domain and its names constant, a closed relation's rows reach
 * the database only as constants), Db.open admits it, and a reader reads every roster's handles. A closed relation's
 * rows are read only through its closed reads, which stand in predicates and generation expressions, never in a query's
 * head, so no query delivers them.
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
}

const plansCaseGen: Gen<PlansCase> = (source) => ({
	tiers: source.draw(rosterGen),
	payload: source.draw(
		array(
			(drawing) => [drawing.draw(int(-3, 60)), drawing.draw(int(0, labelPool.length - 1))] as const,
			{ min: handlePool.length, max: handlePool.length }
		)
	),
	regions: source.draw(rosterGen)
})

type ClosedFeature = "one handle" | "every handle"

layer(Substrate.layer, { excludeTestServices: true })("a schema of closed relations only", (it) => {
	it.effect("installs with no law and no table, opens, and reads every roster's handles", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "reads/closed-only",
					draw: drawn(plansCaseGen),
					literal: Formatter.format,
					coverage: required<ClosedFeature>(["one handle", "every handle"], {
						cases: 24,
						sense: notesOnly
					}),
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
						const Tier = closed("Tier", c.tiers)
						const TierInfo = closed.relation(
							"TierInfo",
							{ id: closedId(Tier), seats: pg.integer, label: Label },
							["id"],
							tierFacts
						)
						const Region = closed("Region", c.regions)
						const Plans = schema("Plans", { Tier, TierInfo, Region }, [])
						const opened = yield* installed(
							Plans,
							{},
							{ label: "real", extensions: [], programs: {} }
						)
						assert.deepEqual(opened.installed.installation.laws.theory.laws, [])
						assert.ok(
							Rec.isEmptyRecord(opened.installed.plan.tables),
							"a schema of rosters and closed relations stores no table"
						)
						const tiers = query(opened.schema).rule((r) => {
							const { id } = v(Tier, "tier")
							return r.match(Tier, { id }).find({ id })
						})
						const regions = query(opened.schema).rule((r) => {
							const { id } = v(Region, "region")
							return r.match(Region, { id }).find({ id })
						})
						yield* Effect.gen(function* () {
							const db = yield* compiledOpen(opened.server.roles.app, {})
							const all = yield* (yield* db.execute(tiers, {})).collect
							unorderedEqual(
								Arr.map(all, (row) => row.id),
								[...c.tiers]
							)
							const rs = yield* (yield* db.execute(regions, {})).collect
							unorderedEqual(
								Arr.map(rs, (row) => row.id),
								[...c.regions]
							)
						}).pipe(Effect.scoped, withLayer(loginLayer(opened.installed, opened.server)))
						notes.noteAll(
							Arr.flatMap([c.tiers, c.regions], (roster): ReadonlyArray<ClosedFeature> =>
								roster.length === 1
									? ["one handle"]
									: roster.length === handlePool.length
										? ["every handle"]
										: []
							)
						)
					}).pipe(Effect.scoped)
			)
		)
	)
})
