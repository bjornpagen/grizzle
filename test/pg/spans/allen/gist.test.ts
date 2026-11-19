/**
 * GiST span indexes on PostgreSQL 19: every Allen mask and pointIn the search draws reads its span relation through the
 * GiST the installation holds for it, in both artifacts, at each data size.
 *
 * Booking's span key is a primary WITHOUT OVERLAPS over (room, during); Visit's GiST over (room, during) is the access
 * index the engine creates for a workload read. Each case draws a predicate (one disjunct, a union, pointIn, or an
 * endpoint in the window), a window and a room, reads each relation by room or across rooms, and EXPLAINs each
 * artifact's statement with sequential and plain index scans disabled: the plan reads the relation's GiST, named at the
 * naming door, and scans no relation sequentially. The conservative artifact keeps an endpoint in the window as
 * written, which no index drives, so only the optimized one is judged there.
 *
 * Features: each relation, predicate kind and prefix, and each data size.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { planIndexNames, planNodeTypes } from "#bench/harness/explain.ts"
import {
	allenWhere,
	endpointWhere,
	gistIn,
	gistTemplates,
	type PlanFeature,
	planSketchGen,
	pointWhere,
	predicateKind,
	prefixes,
	relationNames,
	requiredFeatures,
	roomId,
	roomRule,
	Rooms,
	spanTop
} from "#test/pg/spans/allen/gist.fixtures.ts"
import { compileSpanDesc } from "#test/pg/spans/allen/support.ts"
import { contains, defined, lacks } from "#test/support/assert.ts"
import { declaredOf, paramTexts, testCompile } from "#test/support/compile.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * GiST span indexes reads the span relation through its GiST index for every mask and pointIn the search draws.
 *
 * Its pre-conversion budget: runs 80, coverage cases 80 (test/pg/spans/allen/gist.test.ts at d8eed1786).
 */
export const giSTSpanIndexesReadsTheSpanRelationThroughItsGiSTIndexForEveryMaskAndPointInTheSearchDraws =
	property.explore(planSketchGen, {
		needs: Substrate.oneOf(gistTemplates, Substrate.seat),
		situations: requiredFeatures satisfies ReadonlyArray<Reached<PlanFeature>>,
		check: (seats, c: Case<PlanFeature>) => (sketch) =>
			Effect.gen(function* () {
				const seat = yield* defined(seats[sketch.size.name], `the template of ${sketch.size.name}`)
				const { installed, reader, gist } = yield* gistIn(seat)
				c.note(`size ${sketch.size.name}`)
				const kind = predicateKind(sketch.predicate)
				const where =
					sketch.predicate.kind === "pointIn"
						? pointWhere
						: sketch.predicate.kind === "endpointIn"
							? endpointWhere(sketch.predicate.upper)
							: allenWhere(sketch.predicate.mask)
				/**
				 * The conservative artifact keeps an endpoint in the window as written, which no index drives.
				 */
				const judged =
					sketch.predicate.kind === "endpointIn"
						? (["optimized"] as const)
						: (["optimized", "conservative"] as const)
				yield* reader.begin
				yield* reader.query("SET LOCAL enable_seqscan = off", [])
				yield* reader.query("SET LOCAL enable_indexscan = off", [])
				yield* reader.query("SET LOCAL enable_indexonlyscan = off", [])
				for (const relation of relationNames) {
					const top = spanTop(sketch.size, relation)
					const start = BigInt(sketch.start % top)
					const w = { start, end: start + BigInt(sketch.length) }
					for (const prefix of prefixes) {
						const read: PlanFeature = `${relation} ${kind} ${prefix}`
						c.note(read)
						const params =
							prefix === "by room"
								? { room: roomId(sketch.room % sketch.size.rooms), w, t: start }
								: { w, t: start }
						const rule = roomRule(relation, where, prefix)
						const template = compileSpanDesc(rule, Rooms, installed.schema)
						for (const artifact of judged) {
							const spec = defined(template[artifact][0], `the ${artifact} statement`)
							const rows = yield* reader.values(
								`EXPLAIN (FORMAT JSON) ${spec.sql}`,
								paramTexts(spec, params, declaredOf(template, rule, Rooms, testCompile))
							)
							const explained = defined(rows[0]?.[0], "the EXPLAIN cell")
							const nodeTypes = planNodeTypes(explained)
							contains(
								planIndexNames(explained),
								gist[relation],
								`the ${artifact} plan of ${read} reads ${relation}'s GiST: ${Arr.join(nodeTypes, " > ")}`
							)
							lacks(
								nodeTypes,
								"Seq Scan",
								`the ${artifact} plan of ${read} scans no relation sequentially: ${Arr.join(nodeTypes, " > ")}`
							)
						}
					}
				}
				yield* reader.rollback
			}),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's plan with sequential and plain index scans disabled reads the relation's GiST"
		},
		budget: { runs: 80, steered: 80 },
		kept: [],
		kills: []
	})
