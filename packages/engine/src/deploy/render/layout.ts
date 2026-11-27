/**
 * The layout of a migration folder's name, `<timestamp>_<name>`: the widths of its timestamp's fields, the separator
 * after it, and so the longest name a folder carries after them within one file name. A module of constants alone, so
 * what states a name's bound (the command line's usage, its refusal of a `--name`) reads it without loading the drafting
 * folder.ts holds.
 */

/**
 * The longest file name the operating system states, NAME_MAX: a migration folder is one directory entry, created where
 * it is drafted and wherever its repository is checked out. Darwin's NAME_MAX, whose comment reads "max bytes in a file
 * name", is Linux's too (https://github.com/torvalds/linux/blob/v7.3/include/uapi/linux/limits.h#L12, "#define
 * NAME_MAX         255"). A file system may admit a longer name (pathconf's _PC_NAME_MAX); grizzle writes none longer.
 *
 * @limitKind published
 * @owner Darwin (xnu 12377.121.6), and Linux alike
 * @unit bytes
 * @scope one file name, a single path component such as a migration folder's name
 * @constraint compile-time constant
 * @source https://github.com/apple-oss-distributions/xnu/blob/xnu-12377.121.6/bsd/sys/syslimits.h#L103
 * @quote #define NAME_MAX 255
 * @verified 2026-11-05
 */
export const fileNameMaxBytes = 255

/**
 * A migration folder's timestamp, a UTC second, which the CLI gives a new folder from its schema's committed chain (the
 * second after the chain's last folder's, the Unix epoch for its first: cli/timestamp.ts), never from a clock: its fields
 * in the order it writes them, each with its width in digits, YYYYMMDDHHMMSS, a four-digit year and two digits for each
 * of the month, the day, the hour, the minute and the second.
 *
 * @formatConstant the digits of each field of a migration folder's timestamp
 */
export const timestampWidths = { year: 4, month: 2, day: 2, hour: 2, minute: 2, second: 2 } as const

/** The UTC second a timestamp names: each of its fields' values, the month and the day counted from 1. */
export type TimestampParts = { readonly [F in keyof typeof timestampWidths]: number }

/** The digits of a timestamp's fields, summed: its length. */
/* @__NO_SIDE_EFFECTS__ */
const digitsOf = (widths: Readonly<Record<string, number>>): number => {
	let digits = 0
	for (const field in widths) {
		digits += widths[field] ?? 0
	}
	return digits
}

/** A timestamp's length: the digits of all its fields. */
export const timestampLength: number = digitsOf(timestampWidths)

/** What separates a migration folder's timestamp from its name. */
export const folderSeparator = "_"

/**
 * The longest name a migration folder carries after its timestamp, in UTF-8 bytes: given by `--name` or derived from
 * the change, it ends the folder's one file name. No limit of its own: the file system's NAME_MAX (fileNameMaxBytes)
 * less the prefix every folder's name starts with (folder.ts folderPrefix), a timestamp's timestampLength ASCII digits and the
 * separator, each one byte.
 */
export const maxMigrationNameLength: number =
	fileNameMaxBytes - timestampLength - folderSeparator.length
