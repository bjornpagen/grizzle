/**
 * Sub-queries shared by the statements of one program and repeated inside one statement (shapes/share/statements.ts):
 * the carried sub-queries of a stratum's statements, the MATERIALIZED CTEs of one statement, and the attachment
 * parts of a program's statement it feeds from an earlier one (R25). The first two rules are exhausted over the
 * number of copies:
 *
 * - n statements each reading `pick` carry it once, its every copy read through the carrier, exactly when n is more
 *   than one; the highest shared sub-query is chosen, so `first`, which pick reads, is never carried beside it;
 * - a statement reading r copies of an unbounded union, a closed relation or a step computes it once as a CTE exactly
 *   when r is more than one;
 * - an attachment of a parent is fed the rows of the first earlier attachment part of that parent computing its
 *   sub-query, and every other is a part of its own, the parts in the order the program holds them;
 * - two calls of a volatile function, each drawing its own rows, are never one carrier or one CTE, where one call read
 *   twice is, as two equal calls of an immutable or stable function are.
 *
 * Oracle: each rule's statement as a checker (a specification): the share keys and copies the statements read, and
 * the part each attachment reads computed from the filters in program order.
 *
 * Features: carried and inline; shared and inline, of a union, a closed relation and a step; fed and sent; volatile
 * calls apart and read twice.
 */

import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { agree, exact, set, structuralHash } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { DagTemplates } from "#compiler/ir/dag-digest.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import {
	type CarriedShare,
	decidingClasses,
	noneHeld,
	noneOpaque,
	planStatementShares,
	reach,
	ShareIndex,
	statementCtes
} from "#compiler/lower/shapes/share/statements.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import {
	attachedJobs,
	attachmentFilters,
	chained,
	chainedGen,
	drawnCalls,
	drawnCallsGen,
	expectedAnswers,
	Jobs,
	program,
	type Repeated,
	repeated,
	repeatedGen
} from "#test/unit/lower/shapes/share-statements.fixtures.ts"
import { placedPlain, present } from "#test/unit/lower/support.ts"

/** Sub-queries carried across a stratum's statements carry pick once, every copy through the carrier, exactly when enough statements read it. */
export const subQueriesCarriedAcrossAStratumsStatementsCarryPickOnceEveryCopyThroughTheCarrierExactlyWhenEnoughStatementsReadIt =
	property.exhaust(finite(int(1, 4)), {
		needs: {},
		situations: ["carried", "inline"] satisfies ReadonlyArray<Reached<"carried" | "inline">>,
		check: (_, c: Case<"carried" | "inline">) => (statements) =>
			Effect.sync(() => {
				const p = program(statements)
				const index = new ShareIndex(p.dag, new DagTemplates("derivation"), placedPlain)
				const shares = succeeded(planStatementShares(index, p.roots, noneHeld, { kind: "never" }))
				if (statements < 2) {
					assert.deepEqual(shares, [])
					c.note("inline")
					return
				}
				const [pick] = p.picks
				assert.equal(shares.length, 1)
				const share = present(shares[0], "the carried share")
				assert.equal(share.key, present(index.key(present(pick, "a pick")), "pick's key"))
				unorderedEqual([...share.copies], p.picks)
				c.note("carried")
			}),
		oracle: {
			kind: "specification",
			name: "pick carried once, every copy through the carrier, exactly when more than one statement reads it"
		},
		box: "one to four statements each reading pick",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original: "\t\tif (statementsOf(group) < 2) {\n",
				replacement: "\t\tif (statementsOf(group) < 4) {\n",
				why: "A sub-query is carried only when more than three statements read it; the carried search fails."
			}
		]
	})

/**
 * Sub-queries repeated inside one statement compute an unbounded sub-query, a closed relation or a step once exactly
 * when it is read more than once.
 */
export const subQueriesRepeatedInsideOneStatementComputeAnUnboundedSubQueryAClosedRelationOrAStepOnceExactlyWhenReadMoreThanOnce =
	property.exhaust(finite(repeatedGen), {
		needs: {},
		situations: [
			"shared",
			"inline",
			"a union",
			"a closed relation",
			"a step"
		] satisfies ReadonlyArray<Reached<Repeating>>,
		check:
			(_, c: Case<Repeating>) =>
			([subject, reads]) =>
				Effect.gen(function* () {
					const { built, copies } = repeated(subject, reads)
					const index = new ShareIndex(built.dag, new DagTemplates("derivation"), placedPlain)
					const ctes = statementCtes(index, built.dag.roots[0], () => false)
					const expected =
						reads > 1 ? [present(index.cteKey(present(copies[0], "a copy")), "its key")] : []
					yield* agree(
						[
							["the share keys the statement computes once", [...new Set(ctes.values())]],
							["the copies' share key", expected]
						],
						set(structuralHash, exact)
					)
					unorderedEqual([...ctes.keys()], reads > 1 ? Arr.map(copies, (copy) => copy.id) : [])
					c.note(reads > 1 ? "shared" : "inline")
					c.note(repeating[subject])
				}),
		oracle: {
			kind: "specification",
			name: "the repeated sub-query computed once as a CTE exactly when it is read more than once"
		},
		box: "one statement reading one to four copies of an unbounded union, a closed relation or a step",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original: "\t\t\tif ((byKey.get(key) ?? 0) < 2) {",
				replacement: "\t\t\tif ((byKey.get(key) ?? 0) < 4) {",
				why: "A statement computes a sub-query once as a CTE only when it reads it more than three times; the CTE search fails."
			},
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original: "\t\t\t(readWhole(node, this.#realization) && this.#isShareable(node)\n",
				replacement: "\t\t\t(false && this.#isShareable(node)\n",
				why: "A node every read computes whole has no key a statement computes it once by unless the CTE policy shares it by cost: each copy of the closed relation and of the step, a scan, is printed and computed at its read."
			},
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original:
					"\t\t\t\t(costly.get(node) === true || (index.readWhole(node) && !closedDerivation(node)))\n",
				replacement: "\t\t\t\tcostly.get(node) === true\n",
				why: "The statement computes once only a node with a costly stage: the step's copies, each a scan of the tasks behind its fence, are printed and computed at each read."
			},
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original: '\t\t\t\t(node.kind === "Closed" && node.rows.length > 0) ||\n',
				replacement: "",
				why: "A closed relation's rows are no costly stage: each copy of it, a scan of its VALUES, is printed and planned at each read."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: '\t\t(node.kind === "Step" ||\n',
				replacement: "\t\t(false ||\n",
				why: "A step is no node read whole: each copy of the step, a scan of the tasks, inlined at its read and computed apart at each."
			}
		]
	})

/** What a repeated sub-query's case reached: shared or inline, and which sub-query it repeated. */
type Repeating = "shared" | "inline" | "a union" | "a closed relation" | "a step"

/** Each repeated sub-query's feature. */
const repeating: { readonly [R in Repeated]: Repeating } = {
	union: "a union",
	closed: "a closed relation",
	step: "a step"
}

/** Attachment parts fed from an earlier one feed a later attachment from the first earlier part computing its sub-query, and place every other. */
export const attachmentPartsFedFromAnEarlierOneFeedALaterAttachmentFromTheFirstEarlierPartComputingItsSubQueryAndPlaceEveryOther =
	property.exhaust(attachmentFilters, {
		needs: {},
		situations: ["fed", "sent"] satisfies ReadonlyArray<Reached<"fed" | "sent">>,
		check: (_, c: Case<"fed" | "sent">) => (filters) =>
			Effect.sync(() => {
				const optimized = succeeded(compileTemplate(attachedJobs(filters), Jobs, testCompile))
					.programs.optimized
				const [main] = optimized.roots
				const filterOf = new Map<string, number>(
					Arr.map(filters, (filter, i) => [`jobs${i}`, filter])
				)
				assert.equal(main.attachments.length, filters.length)
				const answers: ReadonlyArray<number> = [
					main.statement.answer,
					...Arr.map(main.attachments, (a) => a.statement.answer)
				]
				assert.deepEqual(
					answers,
					expectedAnswers(
						Arr.map(main.attachments, (a) =>
							present(filterOf.get(a.attach.name), `the filter of ${a.attach.name}`)
						)
					)
				)
				const placed = new Set<number>()
				for (const answer of Arr.drop(answers, 1)) {
					c.note(placed.has(answer) ? "fed" : "sent")
					placed.add(answer)
				}
			}),
		oracle: {
			kind: "specification",
			name: "each attachment fed from the first earlier part of its filter, every other a part of its own"
		},
		box: "one to three attachments of one parent, each of three filters",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/index.ts",
				original: "\t\t\tconst feeder = siblings.find((s) => this.#sameRows(s, attach, parentKey))",
				replacement: "\t\t\tconst feeder = siblings.find(() => false)",
				why: "No attachment part is fed from an earlier one, each placed as a part of its own; the feeding search fails."
			}
		]
	})

type DrawnFeature =
	| "two volatile calls apart"
	| "one volatile call read twice"
	| "two calls of an immutable or stable function"

/** Two calls of a volatile function are never one carrier or one CTE; one call read twice is, as two equal calls of an immutable or stable function are. */
export const twoCallsOfAVolatileFunctionAreNeverOneCarrierOrOneCteWhereOneCallReadTwiceIsAsTwoEqualCallsOfAnImmutableOrStableFunctionAre =
	property.exhaust(drawnCallsGen, {
		needs: {},
		situations: [
			"two volatile calls apart",
			"one volatile call read twice",
			"two calls of an immutable or stable function"
		] satisfies ReadonlyArray<Reached<DrawnFeature>>,
		check:
			(_, c: Case<DrawnFeature>) =>
			({ volatility, twice }) =>
				Effect.sync(() => {
					const p = drawnCalls(volatility, twice)
					const shares = succeeded(
						planStatementShares(
							new ShareIndex(p.dag, new DagTemplates("derivation"), placedPlain),
							p.roots,
							noneHeld,
							{
								kind: "never"
							}
						)
					)
					const ctes = statementCtes(
						new ShareIndex(p.dag, new DagTemplates("derivation"), placedPlain),
						p.root,
						() => false
					)
					if (volatility === "volatile" && !twice) {
						assert.deepEqual(
							Arr.map(shares, (s) => s.key),
							[],
							"two volatile calls carried as one"
						)
						assert.equal(ctes.size, 0, "two volatile calls computed as one CTE")
						c.note("two volatile calls apart")
						return
					}
					assert.equal(shares.length, 1, `the shares of ${volatility} calls`)
					const share = present(shares[0], "the carried share")
					unorderedEqual([...share.copies], p.calls)
					assert.equal(new Set(ctes.values()).size, 1, "one CTE")
					unorderedEqual(
						[...ctes.keys()],
						Arr.map(p.calls, (call) => call.id)
					)
					c.note(
						volatility === "volatile"
							? "one volatile call read twice"
							: "two calls of an immutable or stable function"
					)
				}),
		oracle: {
			kind: "specification",
			name: "each call of a volatile function its own evaluation, never one carrier or CTE with another; one call read twice, or equal calls of an immutable or stable function, one"
		},
		box: "two statements reading the rows of a declared function of each volatility, by two calls built alike or one call read twice, and one statement reading them both",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/dag-digest.ts",
				original:
					"\tcallsVolatile(node) ? { ...nodeForms[form](entry), evaluation: node.id } : nodeForms[form](entry)",
				replacement: "\tnodeForms[form](entry)",
				why: "A volatile call is keyed by its shape, as every node is: two calls built alike share one key, so the statements carry them as one share and the statement computes them as one CTE, one evaluation where there are two."
			}
		]
	})

/** A share index that counts the inputs its planning reads: every node a statement's reach walks, once per walk. */
class CountingIndex extends ShareIndex {
	walked = 0

	override inputs(node: RelNode): ReadonlyArray<RelNode> {
		this.walked += 1
		return super.inputs(node)
	}
}

/**
 * The planning as it was (shapes/share/statements.ts at 74dc1011f), every round reading every statement's reach again
 * from its root: the carried shares, and each round's statements whose reach held a node of the key that round
 * carries, the fill that round enters aside.
 */
const plannedByRounds = (
	index: ShareIndex,
	roots: ReadonlyArray<RelNode>
): {
	readonly shares: ReadonlyArray<CarriedShare>
	readonly touched: ReadonlyArray<{ readonly statements: number; readonly read: number }>
} => {
	const chosen: Array<CarriedShare> = []
	const carriedKeys = new Set<string>()
	const seen = new Map<RelNode, number>()
	const carried = (node: RelNode): boolean => {
		const key = index.eligible(node) ? index.key(node) : undefined
		return key !== undefined && carriedKeys.has(key)
	}
	const touched: Array<{ readonly statements: number; readonly read: number }> = []
	let last: ReadonlyArray<ReadonlyArray<RelNode>> = []
	for (let round = 0; ; round++) {
		const units: ReadonlyArray<{ readonly root: RelNode; readonly own: string | undefined }> = [
			...Arr.map(roots, (root) => ({ root, own: undefined })),
			...Arr.map(chosen, (c) => ({ root: c.node, own: c.key }))
		]
		const readers = new Map<RelNode, Set<number>>()
		const reached: Array<ReadonlyArray<RelNode>> = []
		for (const [u, unit] of units.entries()) {
			const nodes =
				unit.own === undefined && carried(unit.root)
					? []
					: reach(index, unit.root, carried, noneOpaque)
			reached.push(nodes)
			for (const node of nodes) {
				if (!index.eligible(node) || node.heading.length === 0 || carried(node)) {
					continue
				}
				readers.getOrInsertComputed(node, () => new Set<number>()).add(u)
				seen.getOrInsert(node, round)
			}
		}
		last = reached
		const tied = decidingClasses(index, (n) => index.key(n), [...seen.keys()], readers)
		const [first, ...rest] = tied
		if (first === undefined) {
			break
		}
		const keyed = Arr.map([first, ...rest], (nodes) => ({
			nodes,
			key: present(index.key(present(nodes[0], "a class's first node")), "an eligible key")
		}))
		const winner = Arr.reduce(keyed, present(keyed[0], "a class"), (a, b) =>
			b.key < a.key ? b : a
		)
		const node = present(winner.nodes[0], "a class's first node")
		carriedKeys.add(winner.key)
		touched.push({
			statements: last.length,
			read: Arr.filter(last, (nodes, u) =>
				Arr.some(nodes, (n) => (u >= roots.length ? n !== nodes[0] : true) && carried(n))
			).length
		})
		chosen.push({
			key: winner.key,
			node,
			copies: [],
			restriction: { kind: "whole" },
			height: index.height(node)
		})
	}
	const roundOf = new Map(Arr.map(chosen, (c, i) => [c.key, i] as const))
	const shares = Arr.sort(
		Arr.map(chosen, (c) => ({
			...c,
			copies: Arr.flatMap([...seen], ([node, round]) =>
				round <= present(roundOf.get(c.key), "a carried key's round") && index.key(node) === c.key
					? [node]
					: []
			)
		})),
		Order.mapInput(Order.Number, (c: CarriedShare) => index.height(c.node))
	)
	return { shares, touched }
}

/**
 * The planning of a program's carried shares reads every statement's reach once, and again only in a round whose
 * carried key it read, where it read every statement's again every round: it carries the shares the round-by-round
 * planning carries, in its order, each with its copies, and walks fewer inputs wherever a round's key leaves a
 * statement as it was.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const theCarriedSharesPlanningReadsAStatementAgainOnlyInARoundWhoseKeyItReadAndCarriesWhatEveryRoundsReadingCarried =
	property.explore(chainedGen, {
		needs: {},
		situations: [
			"several rounds",
			"a round whose key a statement never read",
			"a level read only inside a carried one"
		] satisfies ReadonlyArray<
			Reached<
				| "several rounds"
				| "a round whose key a statement never read"
				| "a level read only inside a carried one"
			>
		>,
		check:
			(
				_,
				c: Case<
					| "several rounds"
					| "a round whose key a statement never read"
					| "a level read only inside a carried one"
				>
			) =>
			(reads) =>
				Effect.sync(() => {
					const p = chained(reads)
					const counting = new CountingIndex(p.dag, new DagTemplates("derivation"), placedPlain)
					const shares = succeeded(
						planStatementShares(counting, p.roots, noneHeld, { kind: "never" })
					)
					const reference = new CountingIndex(p.dag, new DagTemplates("derivation"), placedPlain)
					const byRounds = plannedByRounds(reference, p.roots)
					const view = (all: ReadonlyArray<CarriedShare>) =>
						Arr.map(all, (s) => ({
							key: s.key,
							node: s.node.id,
							copies: Arr.map(s.copies, (n) => n.id)
						}))
					assert.deepEqual(
						view(shares),
						view(byRounds.shares),
						`the shares of ${Formatter.format(reads)}`
					)
					assert.ok(counting.walked <= reference.walked, "no more inputs walked than every round's")
					if (byRounds.touched.length >= 2) {
						c.note("several rounds")
					}
					if (Arr.some(byRounds.touched, (t) => t.read < t.statements)) {
						c.note("a round whose key a statement never read")
						assert.ok(
							counting.walked < reference.walked,
							`${counting.walked} inputs walked where every round's reading walked ${reference.walked}, over ${Formatter.format(reads)}`
						)
					}
					if (Arr.some(shares, (s) => s.copies.length > 0 && byRounds.touched.length >= 2)) {
						c.note("a level read only inside a carried one")
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the planning as it was, every round reading every statement's reach again from its root"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original: "\t\t\tif (!isNonEmpty(now)) {\n\t\t\t\treturn\n\t\t\t}\n",
				replacement: "",
				why: "Every statement reads its reach again every round, as it did, whether or not the round's key reached it: the planning walks as many inputs as every round's reading, where a round's key leaves a statement as it was."
			},
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original: "\t\t\t\t\treaders.get(n)?.delete(u)\n",
				replacement: "",
				why: "A statement read again keeps its readings of the nodes it reads no longer, a carried key's copies and the levels inside them: the next round counts them read by statements that read them through a carrier now, and carries what every round's reading does not, or a key twice."
			}
		]
	})
