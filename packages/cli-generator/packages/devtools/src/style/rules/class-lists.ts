import { Array as Arr, Option, Result } from "effect"
import type { ClassRule, CompiledClass, ExplainedClass } from "#style/types.ts"

const isSameEffect = (left: CompiledClass, right: CompiledClass): boolean =>
	left.variants === right.variants && left.properties === right.properties

/** What makes a later class of a list conflict with an earlier one: the same class again, or another class with
 * the same effect. */
const conflictOf = (
	later: ExplainedClass,
	earlier: ReadonlyArray<ExplainedClass>
): Option.Option<string> => {
	if (Arr.some(earlier, (candidate) => candidate.text === later.text)) {
		return Option.some(`Class "${later.text}" appears twice in this list.`)
	}
	const compiled = later.compiled
	if (compiled === undefined || compiled.properties === "") {
		return Option.none()
	}
	return Option.map(
		Arr.findFirst(
			earlier,
			(candidate) => candidate.compiled !== undefined && isSameEffect(candidate.compiled, compiled)
		),
		(rival) =>
			`Class "${later.text}" sets ${compiled.properties} like "${rival.text}" in the same list; Tailwind's stylesheet order picks the winner, not this order.`
	)
}

/**
 * Two classes of one list that compile to the same CSS properties under the same variants conflict: which one wins
 * is decided by Tailwind's stylesheet order, not by their order in the list, so one of them is dead or the list
 * is wrong. A class written twice conflicts with itself. `p-2 px-4` refines and `text-sm leading-6` overrides one
 * property on purpose; neither conflicts.
 */
export const noConflictingClasses: ClassRule = ({ list }) =>
	Arr.filterMap(list, (later, index) =>
		Option.match(conflictOf(later, Arr.take(list, index)), {
			onNone: () => Result.failVoid,
			onSome: (message) =>
				Result.succeed({
					token: later,
					message,
					suggestion: "Keep one. To switch between them, choose a complete class string per state."
				})
		})
	)
