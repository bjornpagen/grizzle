/** The character a two-character escape stands for, by the character after the backslash. */
const escapeChar = (code: number): string => {
	switch (code) {
		case 0x62:
			return "\b"
		case 0x66:
			return "\f"
		case 0x6e:
			return "\n"
		case 0x72:
			return "\r"
		case 0x74:
			return "\t"
		default:
			return String.fromCharCode(code)
	}
}

/**
 * The JSON strings of a JSON text grizzle's own SQL wrote, read in order without a check.
 *
 * PostgreSQL writes them with escape_json (to_jsonb(...)::text and jsonb_out): a string is double-quoted, with `\"`,
 * `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t` and `\uXXXX` escapes, and every other character as itself. A reader of such a
 * text knows its shape (a law's DETAIL, a fused attachment's element), so it asks for the strings one at a time and
 * skips the structure between them: JSON.parse would rebuild values the reader then walks again.
 */
export class JsonStrings {
	readonly #text: string
	#at = 0

	constructor(text: string) {
		this.#text = text
	}

	/**
	 * The next JSON string's value, escapes decoded, skipping whatever precedes its opening quote. A run without escapes
	 * is one slice.
	 */
	string(): string {
		const text = this.#text
		let start = text.indexOf('"', this.#at) + 1
		let value = ""
		for (;;) {
			const quote = text.indexOf('"', start)
			const backslash = text.indexOf("\\", start)
			if (backslash < 0 || backslash > quote) {
				this.#at = quote + 1
				return value + text.slice(start, quote)
			}
			value += text.slice(start, backslash)
			const code = text.charCodeAt(backslash + 1)
			if (code === 0x75) {
				value += String.fromCharCode(Number.parseInt(text.slice(backslash + 2, backslash + 6), 16))
				start = backslash + 6
			} else {
				value += escapeChar(code)
				start = backslash + 2
			}
		}
	}

	/** The strings of the next array of strings: only structure lies between the reader and the array's bracket. */
	strings(): ReadonlyArray<string> {
		const out: Array<string> = []
		this.#at = this.#text.indexOf("[", this.#at) + 1
		while (this.#text.charCodeAt(this.#at) === 0x22) {
			out.push(this.string())
			this.#at += 1
		}
		return out
	}
}
