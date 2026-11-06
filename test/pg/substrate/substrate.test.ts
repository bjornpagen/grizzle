import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { characterOf, type Gen, string, subarray, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Exit, Formatter, Layer, Order } from "effect"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { leftovers } from "#test/support/substrate/shared.ts"
import { Substrate, type SubstrateShape } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * What the native multi-session test substrate judges a test to leave behind in a shared database: every object a
 * clean test database does not hold. Its sessions, psql writers and expectations are the substrate every other pg
 * suite runs on, the lock barrier among them under every schedule (test/support/schedules/interleave.ts); psql's
 * native errors are the direct-writer suites' (test/pg/direct-writers); the expectations' judgment is the unit tier's
 * (test/unit/substrate).
 *
 * The property plants a drawn set of strays, each a kind of object a test may create in a shared database under a name
 * of its own, and requires the leftover listing to name exactly those strays, and none once they are dropped. A drawn
 * case leaves its strays to its claim's release instead, in a claim of its own: the release fails, and no later claim
 * is given a dirty database (the sweep drops it once no file runs, which this file cannot observe).
 */
type Stray =
	| "a table"
	| "a view"
	| "a sequence"
	| "a function"
	| "a domain"
	| "an enum"
	| "a schema"

const strays: Arr.NonEmptyReadonlyArray<Stray> = [
	"a table",
	"a view",
	"a sequence",
	"a function",
	"a domain",
	"an enum",
	"a schema"
]

/** A stray's statements, its creation and its removal, and the line the leftover listing names it by. */
const strayOf = (
	kind: Stray,
	name: string
): { readonly create: string; readonly drop: string; readonly listed: string } => {
	const inPublic = `public.${quoteIdent(name)}`
	switch (kind) {
		case "a table":
			return {
				create: `CREATE TABLE ${inPublic} ("k" int4)`,
				drop: `DROP TABLE ${inPublic}`,
				listed: `relation public.${name}`
			}
		case "a view":
			return {
				create: `CREATE VIEW ${inPublic} AS SELECT 1 AS "k"`,
				drop: `DROP VIEW ${inPublic}`,
				listed: `relation public.${name}`
			}
		case "a sequence":
			return {
				create: `CREATE SEQUENCE ${inPublic}`,
				drop: `DROP SEQUENCE ${inPublic}`,
				listed: `relation public.${name}`
			}
		case "a function":
			return {
				create: `CREATE FUNCTION ${inPublic}() RETURNS int4 LANGUAGE sql IMMUTABLE RETURN 1`,
				drop: `DROP FUNCTION ${inPublic}()`,
				listed: `routine public.${name}`
			}
		case "a domain":
			return {
				create: `CREATE DOMAIN ${inPublic} AS int4`,
				drop: `DROP DOMAIN ${inPublic}`,
				listed: `type public.${name}`
			}
		case "an enum":
			return {
				create: `CREATE TYPE ${inPublic} AS ENUM ('a')`,
				drop: `DROP TYPE ${inPublic}`,
				listed: `type public.${name}`
			}
		case "a schema":
			return {
				create: `CREATE SCHEMA ${quoteIdent(name)}`,
				drop: `DROP SCHEMA ${quoteIdent(name)}`,
				listed: `schema ${name}`
			}
	}
}

const lowercase = nonEmpty(Arr.fromIterable("abcdefghijklmnopqrstuvwxyz"), "lowercase letters")

/** A case: the strays it plants, each named `stray_<kind's index>_<word>`, and whether its claim's release meets them. */
interface Planting {
	readonly strays: ReadonlyArray<Stray>
	readonly word: string
	readonly released: boolean
}

const plantingGen: Gen<Planting> = (source) => ({
	strays: source.draw(subarray(strays)),
	word: source.draw(string(characterOf(lowercase), { min: 1, max: 6 })),
	released: source.draw(
		weighted<boolean>([
			[5, () => false],
			[1, () => true]
		])
	)
})

const plantedOf = (p: Planting) =>
	Arr.map(p.strays, (kind, i) => strayOf(kind, `stray_${i}_${p.word}`))

type LeftoverFeature = Stray | "clean" | "a dirty release refused"

layer(Substrate.layer)("native PG test substrate", (it) => {
	it.effect(
		"lists exactly the strays a test leaves in a shared database, fails the release of a claim that leaves any, and gives no later claim a dirty database",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "substrate/leftovers",
						draw: drawn(plantingGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the strays planted, each named by the line of its kind, and none once they are dropped"
						},
						coverage: required<LeftoverFeature>([...strays, "clean", "a dirty release refused"], {
							cases: 60,
							sense: notesOnly
						}),
						kept: [],
						runs: 16,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(p, c) =>
						Effect.gen(function* () {
							const planted = plantedOf(p)
							const plant = (substrate: SubstrateShape) =>
								Effect.forEach(planted, (s) => substrate.admin.query(s.create, []), {
									discard: true
								})
							if (p.released && Arr.isReadonlyArrayNonEmpty(planted)) {
								/** Each claim is a substrate of its own, built fresh: the suite's is memoized under the same layer. */
								const exit = yield* Effect.exit(
									Effect.flatMap(Substrate, plant).pipe(withLayer(Layer.fresh(Substrate.layer)))
								)
								assert.ok(
									Exit.isFailure(exit),
									"the release of a claim that left objects behind fails"
								)
								const after = yield* Effect.flatMap(Substrate, (substrate) =>
									leftovers(substrate.admin)
								).pipe(withLayer(Layer.fresh(Substrate.layer)))
								assert.deepEqual(after, [])
								c.note("a dirty release refused")
								return
							}
							const s = yield* Substrate
							yield* plant(s)
							const listed = yield* leftovers(s.admin)
							yield* Effect.forEach(
								Arr.reverse(planted),
								(stray) => s.admin.query(stray.drop, []),
								{
									discard: true
								}
							)
							assert.deepEqual(
								Arr.sort(listed, Order.String),
								Arr.sort(
									Arr.map(planted, (stray) => stray.listed),
									Order.String
								)
							)
							const cleared = yield* leftovers(s.admin)
							assert.deepEqual(cleared, [])
							c.noteAll(p.strays)
							if (!Arr.isReadonlyArrayNonEmpty(planted)) {
								c.note("clean")
							}
						})
				)
			)
	)
})
