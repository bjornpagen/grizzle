/**
 * A query builder step reads only what it adds. A stage's Description holds its input stage, its earlier arms, an
 * attachment's child and an imported query as the Descriptions they already are (shape.ts recognized), so the step
 * builds a fixed number of containers whatever the query's size, where a decode of the whole would copy every one.
 * The count is taken at every step of a chain of one drawn step kind and a drawn length. The Description is the one the
 * whole decode gives, the old path, kept here as the oracle.
 *
 * The chains here are the builder's own steps (rules, named stages, attachments, imports, an order and a take) drawn by
 * kind and length; test/unit/query/desc-order.test.ts holds the same Description contract over generated public
 * programs, a family these chains do not reach, and these chains reach depths and attachments it does not.
 *
 * Oracles: the first step's count, which every later step must equal, a specification of a step's cost; the whole
 * decode of a plain copy, a second implementation, for the Description.
 *
 * Features: each step kind.
 *
 * Plant (~/.cache/grizzle-release/BR06/plants): scaling-step-copies-chain (a step that copies its whole stage, so it
 * builds as many containers as the chain holds).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { decodeDesc, type QueryDesc } from "#compiler/ir/desc.ts"
import {
	type OrderedValue,
	type QueryValue,
	queryOver as query,
	varsOver as v
} from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { queryState } from "#compiler/query/build/state.ts"
import { assert, defined } from "#test/support/assert.ts"
import { Task, Work } from "#test/support/fixtures/api/work.ts"
import { caseHang } from "#test/support/limits.ts"
import { sitesRead } from "#test/support/sites.ts"

/** The arrays and plain objects reachable from `value`, added to `into`. */
const containersOf = (value: unknown, into: Set<object>): Set<object> => {
	const pending: Array<unknown> = [value]
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		if (isRecord(at) && !into.has(at)) {
			into.add(at)
			for (const child of Rec.values(at)) {
				pending.push(child)
			}
		}
	}
	return into
}

/** The containers reachable from `value` without passing through one of `known`: the ones a step built. */
const freshContainers = (value: unknown, known: ReadonlySet<object>): number => {
	const seen = new Set<object>()
	const pending: Array<unknown> = [value]
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		if (isRecord(at) && !known.has(at) && !seen.has(at)) {
			seen.add(at)
			for (const child of Rec.values(at)) {
				pending.push(child)
			}
		}
	}
	return seen.size
}

/** A query value's Description, read from its state, pending attachment children or not. */
const descOf = (value: unknown): QueryDesc => defined(queryState(value), "a query's state").desc

/** The i-th arm: a rule over Task with a parameter of its own. */
const arm = (i: number) => (r: RuleValue) => {
	const { account, kind } = v(Task, "task")
	const id = r.param(`task${i}`, Task.fields.id)
	return r.match(Task, { id, account, kind }).find({ id, account, kind })
}

/** An attachment child over the parent's account. */
const childOf = (p: Readonly<Record<string, unknown>>) =>
	query(Work).rule((r: RuleValue) => {
		const { id } = v(Task, "task")
		return r.match(Task, { id, account: p["account"] }).find({ id })
	})

/** A query over the chain so far, matching its rows. */
const importing = (q: QueryValue): QueryValue =>
	query(Work).rule((r: RuleValue) => {
		const vars = v(q, "out")
		return r.match(q, vars).find(vars)
	})

/** One step of each kind, with the Descriptions it adds that were built before it: an attachment's child. */
const stepKinds = ["rule", "named", "attach", "import"] as const
type StepKind = (typeof stepKinds)[number]

/** The i-th step of `kind` on `q`, and the Descriptions built before it that the step's Description holds. */
const stepOf = (
	kind: StepKind,
	q: QueryValue,
	i: number
): { readonly after: QueryValue; readonly given: ReadonlyArray<unknown> } => {
	switch (kind) {
		case "rule":
			return { after: q.rule(arm(i)), given: [] }
		case "named":
			return { after: q.named(`stage${i}`), given: [] }
		case "attach": {
			const children: Array<unknown> = []
			const after = q.attach(
				`a${i}`,
				(p: Readonly<Record<string, unknown>>) => {
					const child = childOf(p)
					children.push(child)
					return child
				},
				"array"
			)
			return { after, given: Arr.map(children, descOf) }
		}
		case "import":
			return { after: importing(q), given: [] }
	}
}

/** The containers each of `n` steps of `kind` builds. */
const counts = (kind: StepKind, n: number): ReadonlyArray<number> => {
	const out: Array<number> = []
	let before = query(Work).rule(arm(0))
	for (let i = 1; i <= n; i++) {
		const { after, given } = stepOf(kind, before, i)
		const known = containersOf(given, containersOf(descOf(before), new Set()))
		out.push(freshContainers(descOf(after), known))
		before = after
	}
	return out
}

/** The keys of every object reachable from `value`, in order, by path: the key order a Description has. */
const keyOrders = (value: unknown): ReadonlyArray<string> => {
	const out: Array<string> = []
	const pending: Array<readonly [string, unknown]> = [["", value]]
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		const [path, node] = at
		if (isRecord(node)) {
			out.push(`${path}: ${Arr.join(Rec.keys(node), ",")}`)
			for (const [key, child] of Rec.toEntries(node)) {
				pending.push([`${path}.${key}`, child])
			}
		}
	}
	return out
}

/**
 * The old path's check: the Description equals a whole decode of a plain copy of it, keys in the same order, its
 * locations' sites read as JSON would carry them (sitesRead).
 */
const asTheOldPath = (value: QueryValue | OrderedValue): void => {
	const desc = descOf(value)
	const read = sitesRead(desc)
	const whole = decodeDesc("query", structuredClone(read))
	if (!whole.ok) {
		throw whole.error
	}
	assert.deepEqual(read, whole.value)
	assert.deepEqual(keyOrders(read), keyOrders(whole.value))
	assert.ok(
		Arr.every([...containersOf(desc, new Set())], (c) => Object.isFrozen(c)),
		"the Description is frozen throughout"
	)
}

/** The values a chain of steps builds in turn from a one-arm query, each step drawn by kind, then ordered and taken. */
const built = (
	kinds: ReadonlyArray<StepKind>,
	take: number
): ReadonlyArray<QueryValue | OrderedValue> => {
	const out: Array<QueryValue | OrderedValue> = []
	let at = query(Work).rule(arm(0))
	for (const [i, kind] of kinds.entries()) {
		at = stepOf(kind, at, i + 1).after
		out.push(at)
	}
	const ordered = at.orderBy(["account", "asc"])
	return [...out, ordered, ordered.take(take)]
}

describe("a query builder step reads only what it adds", () => {
	it.effect("builds a fixed number of containers a step, whatever the chain's length", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "every step builds as many containers as the first"
					},
					suite: "unit/query/build/step-reads",
					/** A chain of one kind of step, two to four hundred long. */
					draw: drawn((source) => ({
						kind: source.draw(element(stepKinds)),
						steps: source.draw(int(2, 400))
					})),
					literal: Formatter.format,
					coverage: required<StepKind>(stepKinds, { cases: 16, sense: notesOnly }),
					kept: [],
					runs: 16,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ kind, steps }, c) =>
					Effect.sync(() => {
						c.note(kind)
						const counted = counts(kind, steps)
						const first = defined(counted[0], "the first step")
						for (const [i, step] of counted.entries()) {
							assert.equal(step, first, `step ${i + 1} of ${steps}`)
						}
					})
			)
		)
	)

	it.effect("gives the Description the whole decode gives, over generated chains", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "second-implementation",
						name: "the whole decode of a plain copy (decodeDesc)"
					},
					suite: "unit/query/build/recognized",
					draw: drawn(
						(source) =>
							[
								source.draw(array(element(stepKinds), { min: 0, max: 8 })),
								source.draw(int(1, 5))
							] as const
					),
					literal: Formatter.format,
					coverage: required<StepKind>(stepKinds, { cases: 200, sense: notesOnly }),
					kept: [],
					runs: 200,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([kinds, take], c) =>
					Effect.sync(() => {
						c.noteAll(kinds)
						for (const value of built(kinds, take)) {
							asTheOldPath(value)
						}
					})
			)
		)
	)
})
