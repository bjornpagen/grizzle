import { Array as Arr, Option, String as Str } from "effect"

/** A pair of a form or a query, its name and its value decoded. */
export type Pair = readonly [name: string, value: string]

/**
 * The pairs of `&`-joined `name=value` text, each component decoded by `decode`: split at each `&`, empty sequences
 * skipped, each split at its first `=`, one without an `=` a name with the empty value.
 */
const pairsOfText = (text: string, decode: (component: string) => string): ReadonlyArray<Pair> =>
	Arr.map(Arr.filter(Str.split("&")(text), Str.isNonEmpty), (sequence): Pair =>
		Option.match(Str.indexOf("=")(sequence), {
			onNone: () => [decode(sequence), ""],
			onSome: (at) => [decode(Str.slice(0, at)(sequence)), decode(Str.slice(at + 1)(sequence))]
		})
	)

/** A form component as the WHATWG URL Standard reads it: each `+` a space, then each percent triplet a UTF-8 byte. */
const formComponent = (component: string): string =>
	decodeURIComponent(Str.replaceAll("+", " ")(component))

/**
 * A form body's pairs: its bytes read as UTF-8, then as `application/x-www-form-urlencoded` by the WHATWG URL Standard,
 * where a `+` is a space.
 */
export const formPairs = (body: Uint8Array): ReadonlyArray<Pair> =>
	pairsOfText(Buffer.from(body).toString("utf8"), formComponent)

/**
 * A request target's query pairs, none without a `?`: the text after it read as RFC 3986 percent-encoding, each
 * percent triplet a UTF-8 byte and a `+` a plus, so a query that writes `+` for a space reads as the plus it says.
 */
export const queryPairs = (target: string): ReadonlyArray<Pair> =>
	Option.match(Str.indexOf("?")(target), {
		onNone: () => [],
		onSome: (at) => pairsOfText(Str.slice(at + 1)(target), decodeURIComponent)
	})
