/**
 * A write compile lowers each distinct read-back once (write/readback/lower.ts lowerReadBack): a read-back whose lowering
 * was asked for before under the same names and law model, one query over one delta source at one numbering, takes the
 * program kept for it, where each asking lowered it again. On qti's write compile at hub 2c1aa525b (edullm qti-database)
 * a learner's skipTestItem lowered nine read-backs its answerTestItem had lowered alike, 68 s of its SERIALIZABLE compile
 * in one of them. The work is counted, never timed (test/support/kernel/calls.ts): the calls of lowerReadBack, each a
 * lowering asked for, and of loweredAfresh, each one made.
 *
 * The box, drawn: a sketch of readback-placement's box (test/unit/write/readback-placement.fixtures.ts) and a second of
 * its read-back over other writes, M's action, the action beside it, the second stratum and where W is written drawn
 * again. Over one subject's names the first sketch is compiled, then the second, then the first again; and each over a
 * subject of its own, which no compile read under before.
 *
 * Oracle: a model of the lowerings asked for. A compile is a function of its sketch and its subject's schema, so it asks
 * for the same lowerings over any subject; a sketch compiled again asks for the ones it asked for before, every one kept,
 * and lowers none afresh; the first compile over the subject finds nothing kept and lowers what it does over a subject
 * of its own, and the second at most that. Each compile's artifact is its sketch's over a subject of its own, the
 * programs it took kept but for the origins of their names, which no statement prints (sql/naming.ts NameOrigin): the
 * kept lowering against the fresh one.
 *
 * Features: a sketch compiled again, its read-back's lowerings all kept; a ChangeSet of other writes taking a program
 * another kept; one lowering its read-back afresh; and a compile refused.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { sameUnder } from "#compiler/core/canonical.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import {
	compiledSketch,
	freshSubject,
	type Sketch,
	sketchGen
} from "#test/unit/write/readback-placement.fixtures.ts"

type Situation =
	| "a sketch compiled again, its read-back's lowerings all kept"
	| "a ChangeSet of other writes taking a program another kept"
	| "a ChangeSet of other writes lowering its read-back afresh"
	| "a compile refused"

/** A case: a sketch, and its read-back over other writes. */
interface Drawn {
	readonly first: Sketch
	readonly second: Sketch
}

const drawnGen: Gen<Drawn> = (source) => {
	const first = source.draw(sketchGen)
	return {
		first,
		second: {
			...first,
			op: source.draw(element(["insert", "delete", "put"] as const)),
			beside: source.draw(boolean),
			again: source.draw(boolean),
			written: source.draw(element(["none", "first", "second"] as const))
		}
	}
}

const lowerings = "packages/engine/src/write/readback/lower.ts"

/** A compile of `sketch` over `at`: its program, and the lowerings it asked for and made afresh. */
const counted = (sketch: Sketch, at: ReturnType<typeof freshSubject>) =>
	Effect.map(
		callCounts(
			Effect.sync(() => compiledSketch(sketch, at)),
			{
				asked: { file: lowerings, name: "lowerReadBack" },
				made: { file: lowerings, name: "loweredAfresh" }
			}
		),
		([program, counts]) => ({ program, ...counts })
	)

/** The kinds of a generated name's origin (sql/naming.ts NameOrigin). */
const nameOrigins: ReadonlySet<unknown> = new Set([
	"occurrence",
	"node",
	"var",
	"field",
	"param",
	"internal"
])

/** Whether two values are one but for their generated names' origins, which travel in diagnostics only (NameOrigin). */
const sameButNameOrigins = sameUnder(
	(key, value) =>
		key === "origin" &&
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		nameOrigins.has(value.kind)
)

/** Whether two compiles of one sketch agree: both refused alike, or both compiled to artifacts one but for origins. */
const agree = (
	got: ReturnType<typeof compiledSketch>,
	fresh: ReturnType<typeof compiledSketch>
): boolean =>
	got.ok && fresh.ok
		? sameButNameOrigins(got.value.artifact, fresh.value.artifact)
		: !got.ok && !fresh.ok && got.error.reason._tag === fresh.error.reason._tag

/** A write compile lowers each distinct read-back once, a lowering asked for again under the same names taking the program kept for it. */
export const aWriteCompileLowersEachDistinctReadBackOnceALoweringAskedForAgainUnderTheSameNamesTakingTheProgramKeptForIt =
	property.explore(drawnGen, {
		needs: {},
		budget: { runs: 40, steered: 40 },
		situations: [
			"a sketch compiled again, its read-back's lowerings all kept",
			"a ChangeSet of other writes taking a program another kept",
			"a ChangeSet of other writes lowering its read-back afresh",
			"a compile refused"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (d) =>
			Effect.gen(function* () {
				const shared = freshSubject()
				const first = yield* counted(d.first, shared)
				const second = yield* counted(d.second, shared)
				const again = yield* counted(d.first, shared)
				const firstAlone = yield* counted(d.first, freshSubject())
				const secondAlone = yield* counted(d.second, freshSubject())
				for (const [name, got, alone] of [
					["the first compile", first, firstAlone],
					["the second compile", second, secondAlone],
					["the first sketch compiled again", again, firstAlone]
				] as const) {
					assert.equal(
						got.asked,
						alone.asked,
						`${name} asks for the lowerings it asks over a subject of its own`
					)
					assert.ok(
						agree(got.program, alone.program),
						`${name} compiles to its sketch's artifact over a subject of its own: ${Formatter.format(d)}`
					)
				}
				assert.equal(first.made, firstAlone.made, "the first compile finds nothing kept")
				assert.ok(
					second.made <= secondAlone.made,
					"the second compile lowers at most what it does alone"
				)
				assert.equal(again.made, 0, "the first sketch compiled again lowers nothing afresh")
				if (first.asked > 0) {
					assert.ok(first.made > 0, "a compile asking for a lowering over nothing kept makes one")
					c.note("a sketch compiled again, its read-back's lowerings all kept")
				}
				if (second.asked > 0 && second.made < secondAlone.made) {
					c.note("a ChangeSet of other writes taking a program another kept")
				}
				if (second.asked > 0 && second.made === secondAlone.made) {
					c.note("a ChangeSet of other writes lowering its read-back afresh")
				}
				if (!first.program.ok || !second.program.ok) {
					c.note("a compile refused")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the lowerings asked for: a compile asks for the same ones over any subject, and lowers afresh none asked for before over its names"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/readback/lower.ts",
				original: "\t\treturn found.program\n",
				replacement: "\t\treturn loweredAfresh(read, deltas, start, options)\n",
				why: "Each lowering asked for is made, as at 2c1aa525b: the first sketch compiled again lowers its read-back again, and the property fails."
			},
			{
				file: "packages/engine/src/write/readback/lower.ts",
				original: "\treturn source === undefined ? [relation, side] : [relation, side, source]\n",
				replacement: "\treturn [relation, side]\n",
				why: "A read-back's surroundings leave out the delta sources its Delta nodes read: a ChangeSet of other writes whose read-back reads its delta from another statement, or from none, takes the program kept for one that reads it elsewhere, its artifact is not its own, and the property fails."
			}
		]
	})
