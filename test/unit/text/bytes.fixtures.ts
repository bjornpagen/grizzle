/** What the properties of bytes.test.ts read: its spaces, models and helpers. */

import { type Text } from "#test/support/text/bytes.ts"

/** The most UTF-8 bytes a side's pattern holds, none for a pattern of no bound. */
const patternBytes = (t: Text): number =>
	t.pattern.kind === "upTo" ? 4 * t.pattern.codePoints : Number.POSITIVE_INFINITY

/** The bytes a side's type bounds, the lesser of its pattern's and its byte bound; none where neither bounds it. */
export const expectedBytes = (t: Text): number | undefined => {
	const bound = Math.min(patternBytes(t), t.bytes ?? Number.POSITIVE_INFINITY)
	return Number.isFinite(bound) ? bound : undefined
}
