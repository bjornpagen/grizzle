import { Array as Arr, DateTime, Option, Order, Record as Rec, String as Str } from "effect"
import { timestampLength, timestampWidths } from "#compiler/plan/migration.ts"

type TimestampField = keyof typeof timestampWidths

/** The fields in the order a timestamp writes them, each with its width, as the compiler's folder names state them
 * (deploy/render/folder.ts timestampWidths). */
const timestampFields: ReadonlyArray<readonly [TimestampField, number]> =
	Rec.toEntries(timestampWidths)

/** Where a field's digits start in a timestamp: after the digits of every field written before it. */
const startOf = (field: TimestampField): number =>
	Arr.reduce(
		Arr.takeWhile(timestampFields, ([written]) => written !== field),
		0,
		(at, [, width]) => at + width
	)

/** Each field's digits in a timestamp: where they start and how many. */
const timestampLayout: Readonly<
	Record<TimestampField, { readonly start: number; readonly width: number }>
> = Rec.map(timestampWidths, (width, field) => ({
	start: startOf(field),
	width
}))

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
	return Arr.join(
		Arr.map(timestampFields, ([field, width]) => pad(parts[field], width)),
		""
	)
}

const isDigit = (c: string): boolean => c >= "0" && c <= "9"

/**
 * The instant a YYYYMMDDHHMMSS timestamp names, or none when it names no valid UTC second: its parts must read
 * back as themselves, so a month, day or time out of range names nothing. A year written with a leading zero, below
 * 1000, is no four-digit year.
 */
export const parseTimestamp = (text: string): Option.Option<DateTime.Utc> => {
	if (
		text.length !== timestampLength ||
		!Arr.every(Str.split(text, ""), isDigit) ||
		Str.startsWith("0")(text)
	) {
		return Option.none()
	}
	const parsed = DateTime.make({
		...Rec.map(timestampLayout, ({ start, width }) =>
			Number(Str.slice(start, start + width)(text))
		),
		millisecond: 0
	})
	return Option.filter(parsed, (at) => formatTimestamp(at) === text)
}

/**
 * The step from one timestamp to the next, the format's resolution: its last field counts seconds.
 *
 * @formatConstant a timestamp's resolution: one UTC second
 */
const timestampResolution = { seconds: 1 } as const

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
		? formatTimestamp(DateTime.add(parsed.value, timestampResolution))
		: pad(Number(latest) + 1, timestampLength)
}
