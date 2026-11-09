import * as Str from "effect/String"
import type { OutputRows } from "#compiler/plan/common.ts"
import { isDecimal } from "#compiler/plan/runtime.ts"

/**
 * The DETAIL the refresh block raises for the target at `position` in refresh order, and the position a DETAIL names.
 */
const concurrentRefreshTag = "ConcurrentRefresh "
export const concurrentRefreshDetail = (position: number): string =>
	`${concurrentRefreshTag}${position}`

export const concurrentRefreshPosition = (detail: string | undefined): number | undefined => {
	if (detail === undefined || !Str.startsWith(concurrentRefreshTag)(detail)) {
		return undefined
	}
	const digits = Str.slice(concurrentRefreshTag.length)(detail)
	return isDecimal(digits) ? Number(digits) : undefined
}

/**
 * The views `populatedSql` reported populated. A row is the view's name and PostgreSQL's boolean text, each a text
 * cell as the wire delivers every one.
 */
export const populatedViews = (rows: OutputRows): ReadonlySet<string> => {
	const out = new Set<string>()
	for (const [name, populated] of rows) {
		if (name !== undefined && populated === "true") {
			out.add(name)
		}
	}
	return out
}
