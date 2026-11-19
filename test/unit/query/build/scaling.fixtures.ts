/** What the properties of scaling.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr } from "effect"
import { decodeDesc, type QueryDesc } from "#compiler/ir/desc.ts"
import {
	type OrderedValue,
	queryOver as query,
	type QueryValue,
	varsOver as v
} from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { queryState } from "#compiler/query/build/state.ts"
import { containersOf, freshContainers, keyOrders } from "#test/support/containers.ts"
import { Task, Work } from "#test/support/fixtures/api/work.ts"
import { sitesRead } from "#test/support/sites.ts"

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
export const stepKinds = ["rule", "named", "attach", "import"] as const

export type StepKind = (typeof stepKinds)[number]

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
export const counts = (kind: StepKind, n: number): ReadonlyArray<number> => {
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

/**
 * The old path's check: the Description equals a whole decode of a plain copy of it, keys in the same order, its
 * locations' sites read as JSON would carry them (sitesRead).
 */
export const asTheOldPath = (value: QueryValue | OrderedValue): void => {
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
export const built = (
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
