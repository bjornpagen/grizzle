/** What the properties of scanners.test.ts read: its spaces, models and helpers. */
import { element, type Gen, int, string, unicodeScalar, weighted } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { String as Str } from "effect"

/** A SQLSTATE's characters, the ends of both ranges among them. */
const codeCharacter = element(["0", "1", "5", "9", "A", "M", "Y", "Z"])

/** Characters no SQLSTATE holds: each range's neighbours, and the look-alikes a careless scanner admits. */
const outsideCharacter = element(["/", ":", "@", "[", "a", "z", "_", " ", "٠", "Ａ"])

/** How a drawn text was made. */
type Kind =
	| "a code"
	| "a character outside the code's"
	| "a character short"
	| "a character long"
	| "any text"

interface Drawn {
	readonly kind: Kind
	readonly text: string
}

const codeOf = (length: number): Gen<string> => string(codeCharacter, { min: length, max: length })

export const textGen: Gen<Drawn> = weighted<Drawn>([
	[3, (s) => ({ kind: "a code", text: s.draw(codeOf(5)) })],
	[
		3,
		(s) => {
			const code = s.draw(codeOf(5))
			const at = s.draw(int(0, 4))
			return {
				kind: "a character outside the code's",
				text: `${Str.slice(0, at)(code)}${s.draw(outsideCharacter)}${Str.slice(at + 1)(code)}`
			}
		}
	],
	[1, (s) => ({ kind: "a character short", text: s.draw(codeOf(4)) })],
	[1, (s) => ({ kind: "a character long", text: s.draw(codeOf(6)) })],
	[1, (s) => ({ kind: "any text", text: s.draw(string(unicodeScalar, { min: 0, max: 7 })) })]
])

export type Feature = Kind | "a code read"

/** The RegExp Sqlstate.parse replaced, the second implementation it is held to. */
export const reference = regex("^[0-9A-Z]{5}$")
