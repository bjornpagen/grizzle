import { Result } from "effect"
import { useState } from "react"

type Filters = Readonly<Record<string, string>>

const cleared = (filters: Filters, name: string): Result.Result<Filters, string> =>
	name in filters ? Result.succeed({ ...filters, [name]: "" }) : Result.fail(name)

export function FiltersReset(props: Readonly<{ names: ReadonlyArray<string> }>) {
	const [filters, setFilters] = useState<Filters>({})
	const reset = Result.gen(function* () {
		let next = filters
		for (const name of props.names) {
			next = yield* cleared(next, name) // violation
		}
		return next
	})
	return (
		<button type="button" onClick={() => Result.match(reset, { onSuccess: setFilters, onFailure: () => {} })}>
			Reset
		</button>
	)
}
