import { Array as Arr, Console, Effect, Order } from "effect"
import type { Reporter } from "vitest/node"

/** One line of the residual table, and the risk it tables for ordering. */
type Row = Readonly<{ line: string; risk: number }>

/** The annotation type a residual row arrives as. */
const RESIDUAL = "residual"

/**
 * Prints the residual table at the end of the run: every exploration's residual, riskiest first, the chance the next
 * case would have reached a situation no case reached. It measures each generator and its features, never the program.
 * Each run collects its own rows and lets them go once it has printed them, so a watch mode's reruns never pile up.
 */
export const residualReporter = (): Reporter => {
	let rows: Array<Row> = []
	return {
		onTestRunStart: () => {
			rows = []
		},
		onTestCaseAnnotate: (_testCase, annotation) => {
			if (annotation.type === RESIDUAL) {
				rows.push({ line: annotation.message, risk: Number(annotation.attachment?.body ?? "0") })
			}
		},
		onTestRunEnd: () => {
			const ended = rows
			rows = []
			if (Arr.isReadonlyArrayNonEmpty(ended)) {
				Effect.runSync(
					Console.log(
						Arr.join(
							[
								"residual risk, riskiest first:",
								...Arr.map(
									Arr.sort(
										ended,
										Order.mapInput(Order.Number, (row: Row) => -row.risk)
									),
									(row) => `  ${row.line}`
								)
							],
							"\n"
						)
					)
				)
			}
		}
	}
}
