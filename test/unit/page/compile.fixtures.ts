/** What the properties of compile.test.ts read: its spaces, models and helpers. */

import { flagged, flaggedByTitle } from "#test/support/unit/page/fixtures.ts"

export type Union = "flagged" | "flagged by title"

export type Reorder = "the union's own order" | "its key reversed"

export type Feature = Union | Reorder

/**
 * The union taken at `take` and ordered again: by its own order (flagged's id descending, flaggedByTitle's title
 * ascending), or by its key in the other direction.
 */
export const bounded = (union: Union, reorder: Reorder, take: number): unknown => {
	const own = reorder === "the union's own order"
	switch (union) {
		case "flagged":
			return flagged.take(take).orderBy(["id", own ? "desc" : "asc"])
		case "flagged by title":
			return flaggedByTitle.take(take).orderBy(["title", own ? "asc" : "desc"])
	}
}
