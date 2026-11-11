import { Array as Arr, Cause, Formatter, Option, Result } from "effect"

/** How each kind of reason ended a case: an error in the error channel, a thrown defect, or an interruption. */
const endings = {
	Fail: "failed",
	Die: "died, a defect",
	Interrupt: "interrupted"
} as const satisfies Readonly<Record<Cause.Reason<unknown>["_tag"], string>>

/** The value a reason carries: a failure's error, a defect, or none for an interruption. */
const carried = (reason: Cause.Reason<unknown>): Option.Option<unknown> => {
	switch (reason._tag) {
		case "Fail":
			return Option.some(reason.error)
		case "Die":
			return Option.some(reason.defect)
		case "Interrupt":
			return Option.none()
	}
}

/**
 * The data of a carried value that is an object: every own enumerable property but its message, which the rendering
 * of its error states, its tag among them, so an error with no message still reads as its tag and its fields; none for
 * a primitive, whose rendering is the value, or an object with no such property. Reading a hostile value throws here,
 * and its reason is then stated as unreadable (reasonText).
 */
const dataOf = (value: unknown): Option.Option<string> => {
	if (typeof value !== "object" || value === null) {
		return Option.none()
	}
	const fields: Record<string, unknown> = {}
	for (const key of Object.keys(value)) {
		if (key !== "message") {
			const field: unknown = Reflect.get(value, key)
			fields[key] = field
		}
	}
	return Object.keys(fields).length === 0 ? Option.none() : Option.some(Formatter.format(fields))
}

/**
 * One reason of a cause as a report states it: how it ended the case, the data it carries, then its error as Effect
 * renders it. A value whose reading throws (a hostile proxy the code under test threw) is stated as unreadable, how it
 * ended the case kept, and is read no further, so rendering a report never throws.
 */
const reasonText = (reason: Cause.Reason<unknown>): string => {
	const ending = endings[reason._tag]
	const rendered = Result.try(() => {
		const head = Option.match(Option.flatMap(carried(reason), dataOf), {
			onNone: () => ending,
			onSome: (data) => `${ending}: ${data}`
		})
		return `${head}\n${Cause.pretty(Cause.fromReasons([reason]))}`
	})
	return Result.getOrElse(rendered, () => `${ending}: its value unreadable, as reading it throws`)
}

/**
 * A failure's cause as a report states it: each of its reasons, how it ended the case (the error channel's failure, a
 * thrown defect, or an interruption), every own field of the value it carries, and its error with its message and
 * stack as Effect renders it. A value whose message is empty still states its tag and its data, so no report reads as
 * a bare name.
 */
export const failureText = (cause: Cause.Cause<unknown>): string =>
	Arr.join(Arr.map(cause.reasons, reasonText), "\n")
