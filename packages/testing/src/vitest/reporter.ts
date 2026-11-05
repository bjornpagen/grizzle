import { Array as Arr, Console, Effect, Order } from "effect"
import type { Reporter } from "vitest/node"

/** The annotation an exploration's residual line arrives at the reporter as. */
export const RESIDUAL = "residual"

/** The annotation an exhaustion's line arrives at the reporter as. */
export const EXHAUSTED = "exhausted"

/** One line of the residual table, and the risk it tables for ordering. */
type Row = Readonly<{ line: string; risk: number }>

/**
 * Prints the run's search table at its end: every exploration's residual, riskiest first, the chance the next case
 * would have reached a situation no case reached and how many situations none reached, by Chao1; then every
 * exhaustion's proof, by suite. Both measure each generator and its features, never the program, and each line names
 * the search's oracle. Each run collects its own rows and lets them go once it has printed them, so a watch mode's
 * reruns never pile up.
 */
export const residualReporter = (): Reporter => {
	let rows: Array<Row> = []
	let proofs: Array<string> = []
	return {
		onTestRunStart: () => {
			rows = []
			proofs = []
		},
		onTestCaseAnnotate: (_testCase, annotation) => {
			if (annotation.type === RESIDUAL) {
				rows.push({ line: annotation.message, risk: Number(annotation.attachment?.body ?? "0") })
			}
			if (annotation.type === EXHAUSTED) {
				proofs.push(annotation.message)
			}
		},
		onTestRunEnd: () => {
			const ended = rows
			const proved = proofs
			rows = []
			proofs = []
			const sections = [
				...(Arr.isReadonlyArrayNonEmpty(ended)
					? [
							"residual risk, riskiest first:",
							...Arr.map(
								Arr.sort(
									ended,
									Order.mapInput(Order.Number, (row: Row) => -row.risk)
								),
								(row) => `  ${row.line}`
							)
						]
					: []),
				...(Arr.isReadonlyArrayNonEmpty(proved)
					? [
							"exhausted, each a proof inside its box:",
							...Arr.map(Arr.sort(proved, Order.String), (line) => `  ${line}`)
						]
					: [])
			]
			if (Arr.isReadonlyArrayNonEmpty(sections)) {
				Effect.runSync(Console.log(Arr.join(sections, "\n")))
			}
		}
	}
}
