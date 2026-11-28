/**
 * `grizzle generate` compiles a recursive read through every public form the public oracle serves a read by
 * (test/pg/oracle/public/run.ts casePrograms): the read itself, a member of its role's workload, and its read-back, a
 * ChangeSet that reads it, bound at its parameters where it has any, whose statement the isolation certifier walks
 * (program/isolation/extract.ts memberFacts). A recursive CTE's query reads itself, and the certifier's walk of the
 * columns a query carries a binding in (Statement columnBindings) names each query once, before its sources are walked,
 * so the self-reference is a node it meets again, never a call it recurses into: the walk ends on the cycle, where it
 * recursed until the stack overflowed and generate died (RangeError, lane REDS11's run of the public oracle at its floor
 * case 1, a recursive read's read-back over a relation of closed ids).
 *
 * Each case draws a recursion over Tree, Node's ids and Edge's pairs of them: every node, or the one a parameter names,
 * as its base, and one or two recursive arms, each stepping along an edge from the node its row reached, forward, or
 * forward and back, each row carrying the node it started from, so the self-reference's columns feed the arm's
 * binding; and the form it is served by. Each is compiled as generate drafts it, the snapshot and the login's served
 * file over it (test/support/compiled-served.ts compiledServedFile), through the full world of Tree, whose role holds
 * and writes every relation whole.
 *
 * Oracle: universal, the compile ends and its file serves the member. The box is exhausted: the base, the arms and the
 * form.
 *
 * Features: a rooted recursion, every node its own root, one recursive arm, two, the read, its read-back.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { boolean, element, finite, type Gen, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { int4 } from "#compiler/public/fields.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { compiledServedFile } from "#test/support/compiled-served.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** A tree's nodes. */
const Node = relation("Node", { id: int4 }, ["id"])

/** A tree's edges, each from a node to a node. */
const Edge = relation("Edge", { from: int4, to: int4 }, ["from", "to"])

/** The tree: nodes and edges, each end of an edge a node. */
const Tree = schema(
	"Tree",
	[Node, Edge],
	[contained(on(Edge, "from"), on(Node, "id")), contained(on(Edge, "to"), on(Node, "id"))]
)

/** The public forms the public oracle serves a read by: the read, and its read-back, a ChangeSet that reads it. */
type Form = "the read" | "its read-back"

/** A case: whether the recursion starts at the node a parameter names, how many recursive arms it has, and its form. */
interface RecursiveRead {
	readonly rooted: boolean
	readonly arms: 1 | 2
	readonly form: Form
}

const recursiveReadGen: Gen<RecursiveRead> = (source) => ({
	rooted: source.draw(boolean),
	arms: source.draw(int(1, 2)) === 1 ? 1 : 2,
	form: source.draw(element<Form>(["the read", "its read-back"]))
})

type RecursiveFeature =
	| "a rooted recursion"
	| "every node its own root"
	| "one recursive arm"
	| "two recursive arms"
	| Form

/**
 * The recursion a case draws: every node reached from its base along the edges, each row with the node it started
 * from, built as the public oracle builds one, through the builders' runtime (queryOver, varsOver).
 */
const reachOf = (c: RecursiveRead): QueryValue => {
	const forward = (r: RuleValue, self: unknown): FinishedValue => {
		const reached = varsOver(self, "self")
		const edge = varsOver(Edge, "edge")
		return r
			.match(self, { origin: reached["origin"], node: reached["node"] })
			.match(Edge, { from: reached["node"], to: edge["to"] })
			.find({ origin: reached["origin"], node: edge["to"] })
	}
	const back = (r: RuleValue, self: unknown): FinishedValue => {
		const reached = varsOver(self, "self")
		const edge = varsOver(Edge, "edge")
		return r
			.match(self, { origin: reached["origin"], node: reached["node"] })
			.match(Edge, { from: edge["from"], to: reached["node"] })
			.find({ origin: reached["origin"], node: edge["from"] })
	}
	return queryOver(Tree).recursive("Reach", {
		row: { origin: int4, node: int4 },
		base: [
			(r: RuleValue): FinishedValue => {
				const node = varsOver(Node, "node")
				const matched = r.match(Node, { id: node["id"] })
				return (c.rooted ? matched.where(r.eq(node["id"], r.param("root", int4))) : matched).find({
					origin: node["id"],
					node: node["id"]
				})
			}
		],
		rec: c.arms === 1 ? [forward] : [forward, back]
	})
}

/** The programs a case serves: its recursion, or its read-back, bound at the root where it has one. */
const programsOf = (c: RecursiveRead): Readonly<Record<string, unknown>> => {
	const reach = reachOf(c)
	if (c.form === "the read") {
		return { reach }
	}
	const back = changeSetOver.empty(Tree).read("reached", () => reach)
	return { back: c.rooted ? back.bind({ root: 1 }) : back }
}

/** generate compiles a recursive read through every public form the public oracle serves a read by. */
export const generateCompilesARecursiveReadThroughEveryPublicFormTheOracleServesItBy =
	property.exhaust(finite(recursiveReadGen), {
		needs: {},
		box: "a recursion rooted or not, of one or two recursive arms, served as the read or its read-back",
		situations: [
			"a rooted recursion",
			"every node its own root",
			"one recursive arm",
			"two recursive arms",
			"the read",
			"its read-back"
		] satisfies ReadonlyArray<Reached<RecursiveFeature>>,
		check: (_, c: Case<RecursiveFeature>) => (drawn) =>
			Effect.sync(() => {
				c.note(drawn.rooted ? "a rooted recursion" : "every node its own root")
				c.note(drawn.arms === 1 ? "one recursive arm" : "two recursive arms")
				c.note(drawn.form)
				const programs = programsOf(drawn)
				const file = compiledServedFile(fullWorld(Tree, programs, []).server)
				assert.ok(isRecord(file), "the login's served file")
			}),
		oracle: { kind: "universal", name: "the compile ends and its file serves the member" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original: "\t\tthis.#carried.set(q, noneCarried)\n",
				replacement: "",
				why: "A query is named only once its sources are walked: a recursive CTE's self-reference walks its query again, and generate's compile of the read-back overflows the stack."
			}
		]
	})
