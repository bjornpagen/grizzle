import { Array as Arr, DateTime, Option, Order, String as Str } from "effect"

const pad = (n: number, width: number): string => Str.padStart(width, "0")(String(n))

/**
 * The timestamp of a new migration folder.
 *
 * The CLI supplies the timestamp, because the compiler reads no clock: fourteen digits `YYYYMMDDHHMMSS` in UTC, so
 * folders sort by name in creation order. Two drafts within one second, or a clock behind the newest folder (a
 * folder drafted on another machine, a clock step), would break that order, so a new folder's timestamp is the current
 * UTC second or one second after the schema's newest folder, whichever is later: the new folder always sorts last.
 *
 * The UTC second of `at` as YYYYMMDDHHMMSS. A timestamp parsed from fourteen digits has a four-digit year, and the
 * clock reads none before 1970; an instant past year 9999, a clock's or the second after a folder of the last second,
 * writes fifteen digits, which the compiler's folder name refuses as the draft's refusal (deploy/render/folder.ts
 * folderName).
 */
export const formatTimestamp = (at: DateTime.Utc): string => {
	const parts = DateTime.toPartsUtc(at)
	return (
		pad(parts.year, 4) +
		pad(parts.month, 2) +
		pad(parts.day, 2) +
		pad(parts.hour, 2) +
		pad(parts.minute, 2) +
		pad(parts.second, 2)
	)
}

const isDigit = (c: string): boolean => c >= "0" && c <= "9"

/**
 * The instant a YYYYMMDDHHMMSS timestamp names, or none when it names no valid UTC second: its parts must read
 * back as themselves, so a month, day or time out of range names nothing. A year below 1000 is no four-digit year.
 */
export const parseTimestamp = (text: string): Option.Option<DateTime.Utc> => {
	if (text.length !== 14 || !Arr.every(Str.split(text, ""), isDigit)) {
		return Option.none()
	}
	const part = (from: number, to: number) => Number(Str.slice(from, to)(text))
	if (part(0, 4) < 1000) {
		return Option.none()
	}
	const parsed = DateTime.make({
		year: part(0, 4),
		month: part(4, 6),
		day: part(6, 8),
		hour: part(8, 10),
		minute: part(10, 12),
		second: part(12, 14),
		millisecond: 0
	})
	return Option.filter(parsed, (at) => formatTimestamp(at) === text)
}

/**
 * The timestamp of a new folder at `now`, after every existing folder's timestamp of the schema.
 *
 * A folder name's fourteen digits that name no real second (a hand-made folder) still sort as text; one more
 * second after the largest real one cannot be computed, so the digits are incremented as a number.
 */
export const nextTimestamp = (now: DateTime.Utc, existing: ReadonlyArray<string>): string => {
	const current = formatTimestamp(now)
	if (!Arr.isReadonlyArrayNonEmpty(existing)) {
		return current
	}
	const latest = Arr.max(existing, Order.String)
	if (current > latest) {
		return current
	}
	const parsed = parseTimestamp(latest)
	return Option.isSome(parsed)
		? formatTimestamp(DateTime.add(parsed.value, { seconds: 1 }))
		: pad(Number(latest) + 1, 14)
}
