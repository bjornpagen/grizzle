import { Array as Arr, Record as Rec } from "effect"
import { isCapturedStack, readSite } from "#compiler/core/loc.ts"
import { isPlainRecord } from "#compiler/schema/protocol.ts"

/**
 * A value with every stack a builder captured (core/loc.ts CapturedStack) as the call site it reads to, which is what a
 * location's site is once it crosses a boundary as data: plain records and arrays copied, each record in its own key
 * order, and every other value kept. A live description so compares with one decoded from a plain copy of it. The
 * walk is iterative, so a description of any depth copies.
 */
export const sitesRead = (value: unknown): unknown => {
	const root: { copy: unknown } = { copy: undefined }
	const pending: Array<readonly [unknown, (copy: unknown) => void]> = [
		[
			value,
			(copy) => {
				root.copy = copy
			}
		]
	]
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		const [part, put] = at
		if (isCapturedStack(part)) {
			put(readSite(part))
		} else if (Arr.isArray(part)) {
			const items: Array<unknown> = []
			put(items)
			Arr.forEach(part, (item: unknown, i) => {
				items.push(undefined)
				pending.push([
					item,
					(copy) => {
						items[i] = copy
					}
				])
			})
		} else if (isPlainRecord(part)) {
			const members: Record<string, unknown> = {}
			put(members)
			for (const [key, member] of Rec.toEntries(part)) {
				members[key] = undefined
				pending.push([
					member,
					(copy) => {
						members[key] = copy
					}
				])
			}
		} else {
			put(part)
		}
	}
	return root.copy
}
