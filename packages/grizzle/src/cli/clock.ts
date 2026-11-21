import { Array as Arr, DateTime, Option, Order } from "effect"
import { type TimestampParts, timestampParts, timestampText } from "#compiler/plan/migration.ts"

/**
 * The timestamp of a new migration folder.
 *
 * The CLI supplies the timestamp, because the compiler reads no clock: fourteen digits `YYYYMMDDHHMMSS` in UTC, so
 * folders sort by name in creation order. Two drafts within one second, or a clock behind the newest folder (a
 * folder drafted on another machine, a clock step), would break that order, so a new folder's timestamp is the current
 * UTC second or one second after the schema's newest folder, whichever is later: the new folder always sorts last.
 *
 * The UTC second of `at` as YYYYMMDDHHMMSS, in the compiler's one grammar of a timestamp (deploy/render/folder.ts
 * timestampText). The clock reads none before 1970; an instant past year 9999, a clock's or the second after a folder
 * of the last second, writes fifteen digits, which the compiler's folder name refuses as the draft's refusal
 * (deploy/render/folder.ts folderName).
 */
export const formatTimestamp = (at: DateTime.Utc): string => {
	const { year, month, day, hour, minute, second } = DateTime.toPartsUtc(at)
	return timestampText({ year, month, day, hour, minute, second })
}

/** The UTC second a timestamp's parts name (deploy/render/folder.ts timestampParts, which proves them one). */
const instantOf = (parts: TimestampParts): DateTime.Utc =>
	DateTime.makeUnsafe({ ...parts, millisecond: 0 })

/**
 * The instant a YYYYMMDDHHMMSS timestamp names, or none when it names no valid UTC second: the compiler's one grammar
 * of a timestamp reads it (deploy/render/folder.ts timestampParts), so a month, day or time out of range, or a year
 * written with a leading zero, names nothing.
 */
export const parseTimestamp = (text: string): Option.Option<DateTime.Utc> =>
	Option.map(Option.fromUndefinedOr(timestampParts(text)), instantOf)

/**
 * The step from one timestamp to the next, the format's resolution: its last field counts seconds.
 *
 * @formatConstant a timestamp's resolution: one UTC second
 */
const timestampResolution = { seconds: 1 } as const

/**
 * The timestamp of a new folder at `now`, after every existing folder's of the schema: each the second a folder's name
 * names, which the committed chain read by the compiler's grammar (cli/committed.ts, deploy/render/folder.ts
 * folderParts), a folder whose digits name no second being refused there by name.
 */
export const nextTimestamp = (
	now: DateTime.Utc,
	existing: ReadonlyArray<TimestampParts>
): string => {
	const current = formatTimestamp(now)
	if (!Arr.isReadonlyArrayNonEmpty(existing)) {
		return current
	}
	/** The newest folder's second: timestamps of one width sort by text in time order. */
	const newest = Arr.max(existing, Order.mapInput(Order.String, timestampText))
	return current > timestampText(newest)
		? current
		: formatTimestamp(DateTime.add(instantOf(newest), timestampResolution))
}
