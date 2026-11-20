/**
 * A backfill's UPDATE of a table of many stored generated columns holds memory flat in the rows it writes, on
 * PostgreSQL 19: Member, 48 generated fields over `x` and one over `cheap`, counted under Owner, then folded by sum of
 * `x` by a third version, whose backfill draws the fold's hidden accumulators over the stored members, as C18's fill drew
 * qti.attribute's: its UPDATE of Member sets only those accumulators, which no generated column reads.
 *
 * PostgreSQL builds an UPDATE's generation expressions on its first row and finds them built on the next, unless no
 * stored generated column reads an assigned column: then it frees them and builds them again for every row
 * (nodeModifyTable.c ExecInitGenerated), in the query's memory, which nothing frees until the statement ends: each
 * expression's tree parsed again, 83 KB a row over qti.attribute on 19rc1, whose ExecInitGenerated 19.0 keeps. So the
 * backfill assigns Member's anchor to itself
 * (sql/generation.ts), `cheap`, whose one reader is the cheapest to compute again.
 *
 * Property: the ExecutorState of the fold's backfill UPDATE of Member, read by a statement-level trigger as the UPDATE
 * ends, holds no more bytes at 2n and at 4n members than at n: what an UPDATE builds once is the same at every size,
 * and what it builds per row grows with them. And the UPDATE assigns `cheap` to itself. No slack, no threshold, no
 * clock.
 *
 * The box, exhausted: one case, the three sizes, each its own installation of the first version under a unique name,
 * its n owners each with one member, then the second and third versions migrated by the real runner
 * (test/support/installed.ts migrated), the third's Structure file holding the probe's trigger around the fold's
 * backfill UPDATE (generated-fill-memory.fixtures.ts heldAt).
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import {
	type Held,
	heldAt,
	type Scale,
	scales,
	smallest
} from "#test/pg/migrate/generated-fill-memory.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The box's one case: Member, its sizes the case's own. */
const memberGen: Gen<"Member"> = (source) => source.draw(element(["Member"] as const))

/** What the case reaches: each size's backfill. */
type Situation = `${Scale}n members`

/** A fold's backfill UPDATE of a table of 49 stored generated columns, none of which reads the accumulators it draws, holds ExecutorState flat from n to 2n and 4n rows, and assigns the cheapest reader's column to itself. */
export const generatedFillMemory = property.exhaust(finite(memberGen), {
	needs: { substrate: Substrate.fresh },
	situations: Arr.map(scales, (scale): Situation => `${scale}n members`) satisfies ReadonlyArray<
		Reached<Situation>
	>,
	check:
		({ substrate }, k: Case<Situation>) =>
		() =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					const held: Array<Held> = []
					for (const scale of scales) {
						k.note(`${scale}n members`)
						const at = yield* heldAt(scale * smallest)
						held.push(at)
					}
					const [first, ...rest] = held
					if (first === undefined) {
						throw new Error("the box holds its sizes")
					}
					assert.ok(
						Str.includes(`"cheap" = "t"."cheap"`)(first.update),
						`the fold's backfill UPDATE of Member assigns its anchor, cheap, to itself: ${first.update}`
					)
					for (const h of rest) {
						assert.ok(
							h.bytes <= first.bytes,
							`ExecutorState of the fold's backfill UPDATE of Member holds ${h.bytes} bytes at ${h.members} members, more than its ${first.bytes} at ${first.members}: it builds memory per row`
						)
					}
				}),
				Substrate,
				substrate
			),
	oracle: {
		kind: "specification",
		name: "flat memory, judged over one case's three sizes: ExecutorState of the fold's backfill UPDATE at 2n and 4n rows no larger than at n, read by PostgreSQL's own pg_backend_memory_contexts"
	},
	box: `Member of 49 stored generated columns at n, 2n and 4n members (n = ${smallest}), each its own owner's one, counted by the second version and folded by the third`,
	kept: [],
	kills: [
		{
			file: "packages/engine/src/sql/generation.ts",
			original:
				"\treturn anchor === undefined\n\t\t? brand(set)\n\t\t: brand([...set, { column: anchor.column, value: col(target, anchor.column) }])",
			replacement: "\treturn anchor === undefined ? brand(set) : brand(set)",
			why: "No anchor: the fold's backfill UPDATE sets only Member's accumulators, so PostgreSQL builds Member's 50 generation expressions again for every row and ExecutorState grows with the members."
		}
	]
})
