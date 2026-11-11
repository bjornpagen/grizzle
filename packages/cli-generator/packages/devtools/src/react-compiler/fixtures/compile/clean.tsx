import { Result } from "effect"
import { useState } from "react"

type Filters = Readonly<Record<string, string>>

const cleared = (filters: Filters, name: string): Result.Result<Filters, string> =>
	name in filters ? Result.succeed({ ...filters, [name]: "" }) : Result.fail(name)

const resetFilters = (filters: Filters, names: ReadonlyArray<string>): Result.Result<Filters, string> =>
	Result.gen(function* () {
		let next = filters
		for (const name of names) {
			next = yield* cleared(next, name)
		}
		return next
	})

export function FiltersReset(props: Readonly<{ names: ReadonlyArray<string> }>) {
	const [filters, setFilters] = useState<Filters>({})
	const reset = resetFilters(filters, props.names)
	return (
		<button type="button" onClick={() => Result.match(reset, { onSuccess: setFilters, onFailure: () => {} })}>
			Reset
		</button>
	)
}
