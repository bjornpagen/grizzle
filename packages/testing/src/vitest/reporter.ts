import { Array as Arr, Console, Effect, Order } from "effect"
import type { TestAnnotation } from "vitest"
import type { Reporter, TestCase, Vitest } from "vitest/node"

/** The annotation an exploration's residual line arrives at the reporter as. */
export const RESIDUAL = "residual"

/** The annotation an exhaustion's line arrives at the reporter as. */
export const EXHAUSTED = "exhausted"

/** The annotation a search's oracle kind arrives at the reporter as, for the count of oracles by kind. */
export const ORACLE = "oracle"

/** One line of the residual table, and the bound it is ordered by, Infinity for a risk that is unknown. */
type Row = Readonly<{ line: string; risk: number }>

/** The table of one run's searches, or nothing when no search ran. */
const tableOf = (
	rows: ReadonlyArray<Row>,
	proofs: ReadonlyArray<string>,
	oracles: ReadonlyMap<string, number>
): ReadonlyArray<string> => [
	...(Arr.isReadonlyArrayNonEmpty(rows)
		? [
				"residual risk, riskiest first:",
				...Arr.map(
					Arr.sort(
						rows,
						Order.mapInput(Order.Number, (row: Row) => -row.risk)
					),
					(row) => `  ${row.line}`
				)
			]
		: []),
	...(Arr.isReadonlyArrayNonEmpty(proofs)
		? [
				"exhausted, each a proof inside its box:",
				...Arr.map(Arr.sort(proofs, Order.String), (line) => `  ${line}`)
			]
		: []),
	...(oracles.size > 0
		? [
				`oracles, by kind: ${Arr.join(
					Arr.map(
						Arr.sort(
							Arr.fromIterable(oracles.entries()),
							Order.mapInput(Order.String, ([kind]: readonly [string, number]) => kind)
						),
						([kind, searches]) => `${kind === "unstated" ? "not stated" : kind} ${searches}`
					),
					", "
				)}`
			]
		: [])
]

/**
 * The run's search table, printed at its end: every exploration's residual, riskiest first by its bound, an unknown
 * risk first of all; then every exhaustion's proof, by suite; then how many searches state an oracle of each kind, and
 * how many state none. Each measures a generator and its features, never the program, and each line names the
 * search's oracle. A search leaves its line on its test as an annotation (`searched`), and the table collects them, so
 * it needs nothing from the test processes but Vitest's own reporting. Each run collects its own rows and lets them go
 * once it has printed them, so a watch mode's reruns never pile up. It prints through Vitest's logger, so it goes where
 * the run's other output goes.
 *
 * A package whose tests run searches names it in its Vitest config, beside the library's global setup, which chooses
 * the run's seed; Vitest loads it by name, through the same loader as the tests, so a package that has the library in
 * its node_modules, as TypeScript source, loads it as the tests load the library:
 *
 * @example
 * export default defineConfig({
 * 	test: {
 * 		globalSetup: ["@grizzle/testing/vitest/global-setup"],
 * 		reporters: ["default", "@grizzle/testing/vitest/reporter"]
 * 	}
 * })
 */
export default class ResidualReporter implements Reporter {
	#rows: Array<Row> = []
	#proofs: Array<string> = []
	#oracles = new Map<string, number>()
	#print: (table: string) => void = (table) => Effect.runSync(Console.log(table))

	onInit(vitest: Vitest): void {
		this.#print = (table) => {
			vitest.logger.log(table)
		}
	}

	onTestRunStart(): void {
		this.#rows = []
		this.#proofs = []
		this.#oracles = new Map()
	}

	onTestCaseAnnotate(_testCase: TestCase, annotation: TestAnnotation): void {
		if (annotation.type === RESIDUAL) {
			this.#rows.push({
				line: annotation.message,
				risk: Number(annotation.attachment?.body ?? Number.POSITIVE_INFINITY)
			})
		}
		if (annotation.type === EXHAUSTED) {
			this.#proofs.push(annotation.message)
		}
		if (annotation.type === ORACLE) {
			const kind = String(annotation.attachment?.body ?? "unstated")
			this.#oracles.set(kind, (this.#oracles.get(kind) ?? 0) + 1)
		}
	}

	onTestRunEnd(): void {
		const table = tableOf(this.#rows, this.#proofs, this.#oracles)
		this.onTestRunStart()
		if (Arr.isReadonlyArrayNonEmpty(table)) {
			this.#print(Arr.join(table, "\n"))
		}
	}
}

/** The residual reporter as a value, for a config that builds its reporters itself, as `defineTestConfig` does. */
export const residualReporter = (): Reporter => new ResidualReporter()
