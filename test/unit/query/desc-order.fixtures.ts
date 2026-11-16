/** What the properties of desc-order.test.ts read: its spaces, models and helpers. */

import { Array as Arr, Record as Rec } from "effect"
import { isRecord } from "#compiler/core/record.ts"

/** The keys of every object reachable from `value`, in order, by path: the key order a Description has. */
export const keyOrders = (value: unknown): ReadonlyArray<string> => {
	const out: Array<string> = []
	const pending: Array<readonly [string, unknown]> = [["", value]]
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		const [path, node] = at
		if (!isRecord(node)) {
			continue
		}
		out.push(`${path}: ${Arr.join(Rec.keys(node), ",")}`)
		for (const [key, child] of Rec.toEntries(node)) {
			pending.push([`${path}.${key}`, child])
		}
	}
	return out
}

/** Every container reachable from `value` that is not frozen, by path. */
export const unfrozen = (value: unknown): ReadonlyArray<string> => {
	const out: Array<string> = []
	const pending: Array<readonly [string, unknown]> = [["", value]]
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		const [path, node] = at
		if (!isRecord(node)) {
			continue
		}
		if (!Object.isFrozen(node)) {
			out.push(path)
		}
		for (const [key, child] of Rec.toEntries(node)) {
			pending.push([`${path}.${key}`, child])
		}
	}
	return out
}

/** The kind of every node a Description holds that names one: a stage's, a source's, an expression's or a term's. */
export const kindsOf = (value: unknown): ReadonlySet<string> => {
	const out = new Set<string>()
	const pending: Array<unknown> = [value]
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		if (!isRecord(node)) {
			continue
		}
		const kind = node["kind"]
		if (typeof kind === "string") {
			out.add(kind)
		}
		for (const child of Rec.values(node)) {
			pending.push(child)
		}
	}
	return out
}

export type OrderFeature = "a query" | `a node of kind ${string}`
