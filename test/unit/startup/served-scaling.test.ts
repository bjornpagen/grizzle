/**
 * `grizzle generate`'s compile of a served login does the work of each request, write and roster use once, linear in
 * the schema: over the compile benchmark's generated schema (bench/compile/schema.ts) with its full role and a login
 * whose workload looks up the first relations by key, as the benchmark builds them, compiled with no database as
 * generate drafts it, the snapshot and the login's served file over it (test/support/compiled-served.ts
 * compiledServedFile), at a scale, twice it and three times it, every count of which grows with the factor, each
 * counted site's calls are the exact function of the factor its work is:
 *
 * - certify's group of an outside read (analysis/isolation/certify.ts groupOf), once per outside read, 12 calls a
 *   factor, proportional: condition 5b reads each statement's outside reads once for the statement
 *   (statementOutsides), each read's group written once, where each write of the statement filtered every outside read
 *   of it by its group again, the writes times the reads;
 * - the index engine's test of whether an index serves a request (physical/indexes/engine.ts serves), once per index of
 *   a request's relation, 60 calls a factor and 31 beside them, affine, the workload's lookups and the first
 *   relation's missing containment its constant: a landing reads its own relation's indexes (IndexHosts), where every
 *   request scanned every index of the installation;
 * - hex's bit setter (core/hex.ts setBit), once per live handle of each roster's constants, 1,600 calls a factor,
 *   proportional: a roster's constants, named by the digests of its names and its live codes, are minted once per
 *   roster as the installation's names are built (physical/ddl/names.ts InstallNames rosterConstants), where every read
 *   of a roster's names constant, each decoded closed id a statement or view reads, spelled the roster's live codes
 *   again, the uses times the handles.
 *
 * A proportional count is twice and three times its count at twice and three times the scale, and an affine one grows
 * by one step from each to the next, its step and its constant read off two scales and held at the third, exactly: the
 * counts are deterministic, so no slack lets an n log n or a quadratic term through. Each grew with the square of the
 * schema, about four times the calls at twice it: the benchmark's growth check (bench compile --quick, x4.00, x3.13 and
 * x3.36 at 30 relations) is the kept case. The count is work, never time: V8's precise coverage counts each site's
 * calls (kernel/calls.ts callCounts). The box is exhausted: the scale at its base and at twice the base.
 *
 * Features: the base scale, twice the base.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Record as Rec } from "effect"
import { generatedSchema, type Scale } from "#bench/compile/schema.ts"
import { compiledServedFile } from "#test/support/compiled-served.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** The sites the property counts, each by its module and its function's name. */
const sites = {
	groupOf: { file: "packages/engine/src/analysis/isolation/certify.ts", name: "groupOf" },
	serves: { file: "packages/engine/src/physical/indexes/engine.ts", name: "serves" },
	setBit: { file: "packages/engine/src/core/hex.ts", name: "setBit" }
} as const

/**
 * The function of the scale's factor each site's calls are: proportional, `c·f`, no call standing apart from the
 * schema's parts; or affine, `c·f + b`, a constant `b` of calls the parts that do not grow make.
 */
const laws = { groupOf: "proportional", serves: "affine", setBit: "proportional" } as const

type ScaleFeature = "the base scale" | "twice the base"

/** The scale at `factor` times the least: closed relations of rows every one a pair of their rosters' handles. */
const scaleAt = (factor: number): Scale => ({
	handles: 40 * factor,
	relations: 12 * factor,
	rows: 800 * factor,
	patterns: 12 * factor
})

/** How many relations the workload looks up by key, as the benchmark's does (bench/compile/main.ts lookups). */
const lookedUp = 6

/** The calls each site makes while generate compiles the generated schema at `scale` served through its full world. */
const callsAt = (scale: Scale) =>
	Effect.map(
		callCounts(
			Effect.sync(() => {
				const base = generatedSchema(scale)
				const programs = Rec.fromEntries(
					Array.from({ length: lookedUp }, (_, i) => [`byR${i}`, base.relations[`R${i}`]] as const)
				)
				return compiledServedFile(fullWorld(base, programs, []).server)
			}),
			sites
		),
		([, counts]) => counts
	)

/** Each counted site's calls are the exact proportional or affine function of the scale its work is. */
export const generatesCompileOfAServedLoginDoesEachRequestWriteAndRosterUseOnce = property.exhaust(
	finite(int(1, 2)),
	{
		needs: {},
		box: "the generated schema's scale at its base and at twice it, each counted site's calls at the scale, twice it and three times it",
		situations: ["the base scale", "twice the base"] satisfies ReadonlyArray<Reached<ScaleFeature>>,
		check: (_, c: Case<ScaleFeature>) => (base) =>
			Effect.gen(function* () {
				c.note(base === 1 ? "the base scale" : "twice the base")
				const once = yield* callsAt(scaleAt(base))
				const twice = yield* callsAt(scaleAt(2 * base))
				const thrice = yield* callsAt(scaleAt(3 * base))
				for (const [site, law] of Rec.toEntries(laws)) {
					const counts = `${sites[site].file} ${site}'s calls at the scale, twice it and three times it: ${once[site]}, ${twice[site]}, ${thrice[site]}`
					assert.ok(
						once[site] > 0 && thrice[site] - twice[site] === twice[site] - once[site],
						`${counts}, one step from each to the next`
					)
					if (law === "proportional") {
						assert.ok(twice[site] === 2 * once[site], `${counts}, proportional`)
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "each counted site's calls (kernel/calls.ts callCounts) the exact function of the scale its work is: one step from each scale to the next, none beside it where the count is proportional"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/isolation/certify.ts",
				original: "\t\t\tconst outsides = outsidesAt.get(statement)\n",
				replacement:
					"\t\t\tconst outsides = statementOutsides(grouped.map((g) => ({ ...g, group: groupOf(g.placed.read) }))).get(statement)\n",
				why: "Each write groups its statement's outside reads again, every read's group written per write: certify's groupOf calls grow with the writes times the reads, the square of the schema."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\tconst [host] = (hosts.byRelation.get(entry.request.relation) ?? [])\n",
				replacement: "\tconst [host] = [...hosts.byRelation.values()].flat()\n",
				why: "A request's landing scans every index of the installation, whichever relation it is on: serves' calls grow with the requests times the indexes, the square of the schema."
			},
			{
				file: "packages/engine/src/physical/ddl/names.ts",
				original: "\t\tconstants.get(roster) ?? ",
				replacement: "\t\trosterConstants(codes.rosters.get(roster)) ?? ",
				why: "A roster's constants are digested again at each read of them, its live codes spelled bit by bit: setBit's calls grow with the roster uses times the handles, the square of the schema."
			}
		]
	}
)
