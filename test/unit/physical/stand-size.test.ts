/**
 * A judged table's capture is as large as its own deltas, and the session tables a write of it reaches are each stated
 * once in the installation, however many stored relations stand above it: the capture requires two tables, the
 * sentinel and the table's marker, which its stand-up makes last once every table the write reaches stands
 * (physical/ddl/rules.ts addCapture, TableStanding), and the stand-up makes them by the maker of each closure its blocks
 * reach (Closure, addStandUps), and each delta two makers need, a closure's and a stand-up's, two closures' or two
 * stand-ups', by the one maker of their share (Share), so no delta's table is stated twice. Each stand-up and each
 * capture restated the closure of its table's deltas, every delta a block reads beside them and, through each upkeep,
 * beside the stored relations it writes, every event of a capture apart, so the emission grew with the schema's square:
 * qti-pie's pantry under D3, which stores its canonical relations, 340 judged tables of 583 deltas, held 54,883 tables
 * made across its stand-ups, 53.7 MB, and its captures 61.3 MB, Node's 588 KB of which 574 KB required the 499 deltas
 * its writes reach; over this box's deepest stack, 284,129 bytes of captures and 124,848 of stand-ups, where now 97,390
 * and 40,416. Where closures and stand-ups each made a delta they both needed, 77 of the pantry's deltas were made 324
 * times.
 *
 * Box: the stacks of upkeep-size.fixtures.ts, pantry's Node's shape: N, written, beneath one to four levels of stored
 * derivations, each over every derivation of the level below, one or two of them, and N, named or imported, the top
 * computing a declared function's value or not, D, stored over T and the top, and Linked, live over Link and the top,
 * under a check, so a write of N reaches every stored relation of the stack and every delta the judge reads beside
 * theirs; and beside the stack nothing, W contained in X within its document, a whole rule whose block reads X's delta,
 * which the closure of F, stored over X, holds, beside W's with no stored relation's, E stored over T and read across
 * documents under a check, whose closure holds T's and Link's deltas beside the stack's, or both
 * (stand-size.fixtures.ts).
 *
 * Oracle: specification: each table's capture names its own deltas, the sentinel and one marker; each delta's table is
 * made by one function of the installation; and each table's stand-up makes, itself and by the makers it calls, every
 * delta a statement of the judge reads or fills beside its own, and beside each delta an upkeep that runs fills, in turn
 * (test/support/judge.ts judgeStatementsOf), the tables the judge may read once a statement writes the table, makes
 * none of the deltas of the closures it calls apart from them, and makes the marker each stored relation its write
 * reaches requires, whose capture its upkeep's write fires inside the judge.
 *
 * Features: each depth, each fan, each naming, a top that computes a declared function's value or nothing, each thing
 * beside the stack, and a delta a closure and a stand-up, two closures, or two stand-ups need.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import {
	type Beside,
	type SharedBy,
	standCaseGen,
	type StandCase,
	standingOf
} from "#test/unit/physical/stand-size.fixtures.ts"
import type { Computes, Naming } from "#test/unit/physical/upkeep-size.fixtures.ts"

type StandFeature =
	| `depth ${1 | 2 | 3 | 4}`
	| `fan ${1 | 2}`
	| `naming ${Naming}`
	| `the top computes ${Computes}`
	| `beside ${Beside}`
	| `a delta ${SharedBy} need`

/** Each judged table's capture names its own deltas and two tables more, and each delta's table is made once, at every
 * depth, fan and naming, and with what stands beside the stack. */
export const aJudgedTablesCaptureIsAsLargeAsItsOwnDeltasAndEachTableItsWritesReachIsMadeByOneFunction =
	property.exhaust(finite(standCaseGen), {
		needs: {},
		situations: [
			"depth 1",
			"depth 2",
			"depth 3",
			"depth 4",
			"fan 1",
			"fan 2",
			"naming named",
			"naming imported",
			"the top computes nothing",
			"the top computes a call",
			"beside nothing",
			"beside W contained in X",
			"beside E stored over T",
			"beside both",
			"a delta a closure and a stand-up need",
			"a delta two closures need",
			"a delta two stand-ups need"
		] satisfies ReadonlyArray<Reached<StandFeature>>,
		check: (_, c: Case<StandFeature>) => (drawn: StandCase) =>
			Effect.sync(() => {
				const { stack } = drawn
				c.note(`depth ${stack.depth === 1 ? 1 : stack.depth === 2 ? 2 : stack.depth === 3 ? 3 : 4}`)
				c.note(`fan ${stack.fan === 1 ? 1 : 2}`)
				c.note(`naming ${stack.naming}`)
				c.note(`the top computes ${stack.computes}`)
				c.note(`beside ${drawn.beside}`)
				const standing = standingOf(drawn)
				for (const by of standing.shared) {
					c.note(`a delta ${by} need`)
				}
				const markerOf = (named: ReadonlySet<string>): string | undefined => {
					const [marker, ...more] = Arr.filter([...named], Str.startsWith("__stood_"))
					return more.length === 0 ? marker : undefined
				}
				for (const t of standing.tables) {
					const marker = markerOf(t.named)
					assert.ok(
						marker !== undefined,
						`${t.relation}'s capture requires one marker, not ${Arr.join([...t.named], ", ")}`
					)
					const beyond = Arr.filter(
						[...t.named],
						(n) => !t.own.has(n) && n !== standing.sentinel && n !== marker
					)
					assert.deepEqual(
						beyond,
						[],
						`${t.relation}'s capture names its own deltas, the sentinel and its marker alone, not ${Arr.join(beyond, ", ")}: it restates the tables its writes reach`
					)
					assert.ok(
						t.made.has(marker) && t.made.has(standing.sentinel),
						`${t.relation}'s stand-up makes the sentinel and the marker its capture requires`
					)
					const unmade = Arr.filter([...t.reached], (d) => !t.made.has(d))
					assert.deepEqual(
						unmade,
						[],
						`${t.relation}'s stand-up makes every delta a write of it reaches, not ${Arr.join(unmade, ", ")}`
					)
					const restated = Arr.filter([...t.apart], (d) => t.closured.has(d))
					assert.deepEqual(
						restated,
						[],
						`${t.relation}'s stand-up makes, itself or by a share, none of the deltas the closures it calls make, not ${Arr.join(restated, ", ")}`
					)
				}
				for (const s of Arr.filter(standing.tables, (t) => t.upkept)) {
					const marker = markerOf(s.named)
					for (const t of Arr.filter(standing.tables, (u) =>
						Arr.some([...s.own], (d) => u.reached.has(d))
					)) {
						assert.ok(
							marker !== undefined && t.made.has(marker),
							`${t.relation}'s stand-up makes the marker ${s.relation}'s capture requires, which its upkeep's write inside the judge fires`
						)
					}
				}
				const twice = Arr.filter([...standing.creates], ([, n]) => n > 1)
				assert.deepEqual(
					Arr.map(twice, ([d, n]) => `${d} ${n} times`),
					[],
					`each delta's table is made by one function of the installation, over ${stack.depth} ${stack.naming} levels of fan ${stack.fan} beside ${drawn.beside}: ${String(standing.bytes.captures)} bytes of captures, ${String(standing.bytes.standUps)} of stand-ups`
				)
			}),
		oracle: {
			kind: "specification",
			name: "each capture names its own deltas, the sentinel and one marker; each delta's table is made by one function; each stand-up makes every delta the judge's statements read or fill beside its table's, through the upkeeps, none of its closures' apart from them, and the marker of each stored relation its write reaches"
		},
		box: "N beneath a stack of one to four levels of stored derivations, each over every derivation of the level below, one or two of them, named or imported, its top computing a call or not, D and Linked over the top; beside it nothing, W contained in X beside F over X contained in Y, E stored over T read across documents under Smaller, or both",
		kept: [
			{
				token: ReplayToken(
					"test/unit/physical/stand-size.test.ts#aJudgedTablesCaptureIsAsLargeAsItsOwnDeltasAndEachTableItsWritesReachIsMadeByOneFunction:-:3.1.1.0.0"
				),
				reason:
					"qti-pie's Node's shape at pantry's depth: four levels of imported stored queries, each read by both of the level above, as ForwardBranchRule reads the queries beneath it over qti.node; under D3 each stand-up and capture restated the closure of its table's deltas, N's capture 31,043 bytes naming every delta of the stack, the stack's captures 284,129 bytes and stand-ups 124,848, as pantry's Node's capture required 499 deltas in 588 KB",
				since: "2026-11-26"
			},
			{
				token: ReplayToken(
					"test/unit/physical/stand-size.test.ts#aJudgedTablesCaptureIsAsLargeAsItsOwnDeltasAndEachTableItsWritesReachIsMadeByOneFunction:-:0.0.0.0.1"
				),
				reason:
					"main's shape on merging EMITSIZE (f17faeec2184): a whole rule's block reads W's delta and X's with no stored relation's, and F's upkeep reads X's, so X's delta was loose in W's stand-up and held by F's closure, made by both, as 77 of the pantry's deltas were made 324 times by closures and stand-ups that each needed them",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\tmade: deltas.filter((d) => (owners.get(d.name) ?? []).length === 1),\n",
				replacement: "\t\tmade: deltas,\n",
				why: "Each maker makes every delta it needs itself and shares none: X's delta, loose in W's stand-up and held by F's closure, is made by both, and Link's by both closures beside E; the property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					"\t\t\tloose: [...reach.values()].filter((d) => !covered.has(d.name)).toSorted(byName),\n",
				replacement: "\t\t\tloose: [...need.values()].toSorted(byName),\n",
				why: "Each table's stand-up needs every table its writes reach as loose, as each did before the closures, and calls their makers too: every delta of the stack's closure is made apart from it, by a share N's stand-up and the closure's maker call; the property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\tparent.set(root(d.name), root(first.name))\n",
				replacement: "\t\t\tparent.set(d.name, d.name)\n",
				why: "No two deltas an upkeep writes stand in one closure: each kept delta's closure holds the blocks of that delta alone, so a stored relation's sides stand in two closures, and the marker its capture requires, of both, is made by its own stand-up alone, which no write that reaches it calls; the property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\t\t\t\t\tcalled.map((c) => c.fn),\n",
				replacement: "\t\t\t\t\t\t\t[],\n",
				why: "A table's stand-up calls no closure's maker: it makes its loose deltas, its shares and its marker alone, so N's stand-up makes none of the deltas of the stored relations above it, which the upkeeps its write runs fill; the property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					"\tconst required = standing([sentinelStood(sentinel, judge), markerStood(marker)], {\n",
				replacement:
					"\tconst required = standing([sentinelStood(sentinel, judge), ...t.sides.map((s) => deltaStood(s.delta))], {\n",
				why: "A capture requires its own deltas and not its marker: nothing proves the tables its writes reach stand, which a session whose other stand-ups made its own deltas leaves unmade; the property fails."
			}
		]
	})
