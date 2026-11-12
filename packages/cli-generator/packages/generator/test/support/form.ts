import { Array as Arr, Option, String as Str } from "effect"

/** A pair of a form or a query, its name and its value decoded. */
export type Pair = readonly [name: string, value: string]

/** One name or value as the WHATWG URL Standard reads it: each `+` a space, then each percent triplet a UTF-8 byte. */
const decoded = (component: string): string =>
	decodeURIComponent(Str.replaceAll("+", " ")(component))

/**
 * The pairs of `application/x-www-form-urlencoded` text as the WHATWG URL Standard reads them: split at each `&`,
 * empty sequences skipped, each split at its first `=`, one without an `=` a name with the empty value.
 */
const pairsOfText = (text: string): ReadonlyArray<Pair> =>
	Arr.map(Arr.filter(Str.split("&")(text), Str.isNonEmpty), (sequence): Pair =>
		Option.match(Str.indexOf("=")(sequence), {
			onNone: () => [decoded(sequence), ""],
			onSome: (at) => [decoded(Str.slice(0, at)(sequence)), decoded(Str.slice(at + 1)(sequence))]
		})
	)

/** A form body's pairs, its bytes read as UTF-8 and then as a form. */
export const formPairs = (body: Uint8Array): ReadonlyArray<Pair> =>
	pairsOfText(Buffer.from(body).toString("utf8"))

/** A request target's query pairs, the text after its `?` read as a form; none without a `?`. */
export const queryPairs = (target: string): ReadonlyArray<Pair> =>
	Option.match(Str.indexOf("?")(target), {
		onNone: () => [],
		onSome: (at) => pairsOfText(Str.slice(at + 1)(target))
	})
