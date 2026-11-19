/** The containers a built value holds, as the builders' scaling properties count and order them. */

import { Array as Arr, Record as Rec } from "effect"
import { isRecord } from "#compiler/core/record.ts"

/** The arrays and plain objects reachable from `value`, added to `into`: every pending value is read, an undefined field
 * among them, which ends no walk. */
export const containersOf = (value: unknown, into: Set<object>): Set<object> => {
	const pending: Array<unknown> = [value]
	while (pending.length > 0) {
		const at = pending.pop()
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
export const freshContainers = (value: unknown, known: ReadonlySet<object>): number => {
	const seen = new Set<object>()
	const pending: Array<unknown> = [value]
	while (pending.length > 0) {
		const at = pending.pop()
		if (isRecord(at) && !known.has(at) && !seen.has(at)) {
			seen.add(at)
			for (const child of Rec.values(at)) {
				pending.push(child)
			}
		}
	}
	return seen.size
}

/** The keys of every object reachable from `value`, in order, by path: the key order a Description has. */
export const keyOrders = (value: unknown): ReadonlyArray<string> => {
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
