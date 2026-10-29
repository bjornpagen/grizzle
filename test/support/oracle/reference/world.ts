import { Array as Arr, Order } from "effect"

/** One answer: its column names in order, and its rows' texts, sorted and distinct. */
export interface TextAnswer {
	readonly columns: ReadonlyArray<string>
	readonly rows: ReadonlyArray<ReadonlyArray<string>>
}

/** Rows as an answer's: each row's texts, the rows sorted by their joined texts, repeats dropped. */
export const textAnswer = (
	columns: ReadonlyArray<string>,
	rows: ReadonlyArray<ReadonlyArray<string>>
): TextAnswer => {
	const keyed = new Map(Arr.map(rows, (row) => [Arr.join(row, "\u0001"), row]))
	return {
		columns,
		rows: Arr.map(Arr.sort([...keyed.keys()], Order.String), (k) => keyed.get(k) ?? [])
	}
}
