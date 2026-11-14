import { String as Str } from "effect"

/**
 * A text of exactly `bytes` UTF-8 bytes no compression shortens: distinct supplementary-plane code points (wideText)
 * for every four, then ASCII letters for the rest.
 */
export const wideOctets = (bytes: number, salt: number): string =>
	`${wideText(Math.floor(bytes / 4), salt)}${Str.repeat(bytes % 4)("z")}`

/** Distinct supplementary-plane code points, four UTF-8 bytes each, spread so that pglz finds no repeat. */
export const wideText = (length: number, salt: number): string => {
	let out = ""
	let x = (salt * 2654435761) >>> 0
	for (let i = 0; i < length; i++) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0
		out += String.fromCodePoint(0x20000 + ((x >>> 7) % 0x9fff) * 2 + (i % 2))
	}
	return out
}
