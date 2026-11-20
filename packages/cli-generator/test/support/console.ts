import { Array as Arr, Console } from "effect"

/** What a run printed through the Console service: each `log` and each `error` call as one line, in order. */
export type Printed = Readonly<{ log: Array<string>; error: Array<string> }>

/** A fresh, empty record of printed lines. */
export const printed = (): Printed => ({ log: [], error: [] })

const lineOf = (parts: ReadonlyArray<unknown>): string => Arr.join(Arr.map(parts, String), " ")

/**
 * A Console that records `log` (and `info`) and `error` (and `warn`) lines, each followed by `end` (`""` for bare
 * lines, `"\n"` to append to text another writer shares), into `into` and drops everything else, so a CLI run's printed
 * output is read back as data: a whole object, never the host console with two methods swapped in.
 */
export const recordingConsole = (into: Printed, end: string): Console.Console => ({
	assert: () => undefined,
	clear: () => undefined,
	count: () => undefined,
	countReset: () => undefined,
	debug: () => undefined,
	dir: () => undefined,
	dirxml: () => undefined,
	error: (...parts) => {
		into.error.push(`${lineOf(parts)}${end}`)
	},
	group: () => undefined,
	groupCollapsed: () => undefined,
	groupEnd: () => undefined,
	info: (...parts) => {
		into.log.push(`${lineOf(parts)}${end}`)
	},
	log: (...parts) => {
		into.log.push(`${lineOf(parts)}${end}`)
	},
	table: () => undefined,
	time: () => undefined,
	timeEnd: () => undefined,
	timeLog: () => undefined,
	trace: () => undefined,
	warn: (...parts) => {
		into.error.push(`${lineOf(parts)}${end}`)
	}
})
