/**
 * A test's reading of a text grizzle holds as its chunks (grizzle-text TextChunks): a test's texts are small, so it reads
 * one whole (`joined`), as its JSON value (`jsonOf`), or makes chunks of a text it wrote (`chunked`). grizzle itself never
 * joins a text's chunks; a test holds a fixture's text whole to read it as a string.
 */
import { chunksOf, readJson, type TextChunks } from "@bjornpagen/grizzle-text/chunks"
import { Array as Arr } from "effect"
import { wellFormed } from "#compiler/core/text.ts"
import { succeeded } from "#test/support/assert.ts"

/** The text a test's chunks make, whole. */
export const joined = (chunks: TextChunks): string => Arr.join(chunks, "")

/** The JSON value of a text's chunks, as JSON.parse reads the text they make (readJson), which a test's text is. */
export const jsonOf = (chunks: TextChunks): unknown =>
	succeeded(readJson(chunks), "a test's text reads as JSON")

/** A text a test wrote, as its chunks: well-formed, as every text a test writes of its own is (core/text.ts wellFormed). */
export const chunked = (text: string): TextChunks => chunksOf(wellFormed(text))
