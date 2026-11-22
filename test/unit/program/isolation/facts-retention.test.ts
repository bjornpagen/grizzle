/**
 * A member's isolation facts are plain data (analysis/isolation/facts.ts, program/isolation/extract.ts memberFacts):
 * once extracted they hold no walk of a statement's bodies (Walk), no statement's extraction state (Statement, whose
 * instances keep every walk of its query CTEs and whose queries are keyed by its AST's nodes), and no node of the
 * statements' ASTs, so a member's facts cost what certification compares and the walk that read them is dropped when
 * it returns. On edullm's qti at hub 74dc1011f, 48 s into certification, 15,452 walks held 601 MB of the heap
 * (perf/perf-phys/qti-cert-holders-tip.md), the extraction of one statement in flight.
 *
 * Oracle: universal, read off the heap: after a member's extraction, with its facts alive and its statements alive, no
 * Walk and no Statement of its extraction is alive (node:v8 queryObjects, after a full collection), each living only
 * while its extraction runs; and no object its facts reach is an object of its statements. A case's own are the Walks
 * and Statements alive after the extraction beyond those alive just before it: both counts follow a full collection,
 * and the extraction between them is synchronous (memberFacts returns its facts, awaiting nothing), so no other code
 * runs between the two counts and the difference is exactly what this extraction left alive. The count is the case's,
 * where it counted every Walk of the worker's process: a worker holds several properties' modules, and two Walks of
 * other work in trunk's worker, not this extraction (measured: 3,000 extractions in one process leave 0), reddened the
 * property at 7adcb4b34 and c2e208938.
 *
 * The box: extract.test.ts's members (test/unit/program/isolation/extract.fixtures.ts caseGen), one to three statements
 * of DML, query CTEs, probes, arbitrations and met rows, at either level.
 *
 * Features: a member whose statements read a query CTE; a member of several statements.
 */

import { queryObjects } from "node:v8"
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { memberFacts, Statement, Walk } from "#compiler/program/isolation/extract.ts"
import {
	buildStatement,
	caseGen,
	NAMES,
	PARAM_NAMES
} from "#test/unit/program/isolation/extract.fixtures.ts"

type Situation = "a member whose statements read a query CTE" | "a member of several statements"

/** The Walks and the Statements alive, counted by V8 after a full collection. */
const alive = () => ({
	walks: queryObjects(Walk, { format: "count" }),
	statements: queryObjects(Statement, { format: "count" })
})

/** Every object `value` reaches through its properties and elements, itself included. */
const objectsOf = (value: unknown): ReadonlySet<object> => {
	const seen = new Set<object>()
	const pending: Array<unknown> = [value]
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		if (typeof at !== "object" || at === null || seen.has(at)) {
			continue
		}
		seen.add(at)
		if (at instanceof Map) {
			for (const [k, v] of at) {
				pending.push(k, v)
			}
		} else if (at instanceof Set) {
			for (const v of at) {
				pending.push(v)
			}
		} else if (Arr.isArray(at)) {
			for (const v of at) {
				pending.push(v)
			}
		} else if (isRecord(at)) {
			for (const v of Rec.values(at)) {
				pending.push(v)
			}
		}
	}
	return seen
}

/** A member's facts hold no walk, no statement's extraction state and no node of its statements. */
export const aMembersFactsHoldNoWalkNoStatementsExtractionStateAndNoNodeOfItsStatements =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 40, steered: 20 },
		situations: [
			"a member whose statements read a query CTE",
			"a member of several statements"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (drawn) =>
			Effect.sync(() => {
				const statements = Arr.map(drawn.statements, buildStatement)
				const before = alive()
				const facts = memberFacts(
					"member",
					statements,
					NAMES,
					(_s, n) => PARAM_NAMES.get(n),
					drawn.level
				)
				const after = alive()
				assert.equal(after.walks - before.walks, 0, "no walk outlives the extraction")
				assert.equal(
					after.statements - before.statements,
					0,
					"no statement's extraction state outlives it"
				)
				const nodes = objectsOf(statements)
				const held = Arr.filter([...objectsOf(facts)], (o) => nodes.has(o))
				assert.equal(held.length, 0, "the facts hold no node of the member's statements")
				if (Arr.some(facts.statements, (s) => s.ctes.length > 0)) {
					c.note("a member whose statements read a query CTE")
				}
				if (statements.length > 1) {
					c.note("a member of several statements")
				}
			}),
		oracle: {
			kind: "universal",
			name: "plain facts: no Walk or Statement alive after an extraction, and the facts share no object with the statements"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original: "\t\treads: [...reads.map((r) => r.read), ...arbitrations],\n",
				replacement: "\t\treads: [...reads.map((r) => r.read), ...arbitrations],\n\t\twalk,\n",
				why: "A statement's facts keep its walk, and through it the statement's extraction state, every walk of its query CTEs and the queries they are keyed by: a Walk outlives the extraction, and the property fails."
			}
		]
	})
