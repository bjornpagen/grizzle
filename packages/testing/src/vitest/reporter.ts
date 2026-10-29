import { Array as Arr, Console, Effect, Option, Order } from "effect"
import type { Reporter } from "vitest/node"

/** One line of a table, and the chance it tables for ordering. */
type Row = Readonly<{ line: string; chance: number }>

/** The tables the reporter prints, each by the annotation type its rows arrive as, and its heading. */
const TABLES = [
	{ type: "residual", heading: "residual risk, riskiest first:" },
	{ type: "reach", heading: "requirements a fresh seed may miss, likeliest first:" }
] as const

type Table = (typeof TABLES)[number]["type"]

/**
 * Prints two tables at the end of the run. The residual table holds every exploration's residual, riskiest first: the
 * chance the next case would have reached a situation no case reached. The reach table holds every requirement whose
 * estimated miss for a fresh seed (Reach) shows at the printed precision, likeliest first. Both measure each generator
 * and its features, never the program. Each run collects its own rows and lets them go once it has printed them, so a
 * watch mode's reruns never pile up.
 */
export const residualReporter = (): Reporter => {
	let rows = new Map<Table, Array<Row>>()
	return {
		onTestRunStart: () => {
			rows = new Map()
		},
		onTestCaseAnnotate: (_testCase, annotation) => {
			const table = Arr.findFirst(TABLES, (tabled) => tabled.type === annotation.type)
			if (Option.isSome(table)) {
				rows.set(table.value.type, [
					...(rows.get(table.value.type) ?? []),
					{ line: annotation.message, chance: Number(annotation.attachment?.body ?? "0") }
				])
			}
		},
		onTestRunEnd: () => {
			const ended = rows
			rows = new Map()
			const printed = Arr.flatMap(TABLES, (table) => {
				const tabled = ended.get(table.type) ?? []
				return Arr.isReadonlyArrayNonEmpty(tabled)
					? [
							table.heading,
							...Arr.map(
								Arr.sort(
									tabled,
									Order.mapInput(Order.Number, (row: Row) => -row.chance)
								),
								(row) => `  ${row.line}`
							)
						]
					: []
			})
			if (Arr.isReadonlyArrayNonEmpty(printed)) {
				Effect.runSync(Console.log(Arr.join(printed, "\n")))
			}
		}
	}
}
