import { Array as Arr, DateTime, Option } from "effect"
import { type TimestampParts, timestampParts, timestampText } from "#compiler/plan/migration.ts"

/**
 * The timestamp of a migration folder, which leads its name: fourteen digits `YYYYMMDDHHMMSS` naming a UTC second, in
 * the compiler's one grammar of a timestamp (deploy/render/folder.ts timestampParts, timestampText), so folders sort by
 * name in chain order.
 *
 * A new folder's timestamp is a function of its schema's committed chain alone (nextTimestamp), and no command reads a
 * clock for it, so a draft is a function of its source and its committed chain, byte for byte, its folder's name
 * included: one source drafted on one chain in any directory, under any time zone or locale, at any time, is one draft.
 *
 * The UTC second of `at` as YYYYMMDDHHMMSS. An instant past year 9999, the second after a folder of the last second,
 * writes fifteen digits, which the compiler's folder name refuses as the draft's refusal (deploy/render/folder.ts
 * folderName).
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
 * The timestamp of a schema's first folder: the Unix epoch, 19700101000000, the second a chain of no folder names.
 *
 * @formatConstant the first folder's timestamp: the Unix epoch
 */
const chainStart: DateTime.Utc = DateTime.makeUnsafe(0)

/**
 * The timestamp of a new folder of a schema whose committed chain's folders name `chain`, each the second its name
 * names, in chain order (cli/committed.ts wholeChain, deploy/render/folder.ts folderParts): the second after the last
 * folder's, or the epoch for a chain of none. The chain's timestamps strictly increase, two folders of one second being
 * refused as a fork (cli/committed.ts), so the new folder sorts after every folder of its schema; and two drafts on one
 * chain share their timestamp, so a fork of the chain is two folders of one second, never two that sort apart.
 */
export const nextTimestamp = (chain: ReadonlyArray<TimestampParts>): string =>
	formatTimestamp(
		Option.match(Arr.last(chain), {
			onNone: () => chainStart,
			onSome: (last) => DateTime.add(instantOf(last), timestampResolution)
		})
	)
