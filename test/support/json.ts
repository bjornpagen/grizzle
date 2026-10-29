import { Schema } from "effect"
import { succeeded } from "#test/support/assert.ts"

/**
 * A JSON text as the value it denotes, admitted by Effect Schema: JSON is external input even when this process wrote
 * it, so no JSON.parse result reaches a test untyped (Type safety). The caller names the schema of what the text holds;
 * `Schema.Unknown` only where the next consumer is itself a boundary decoder that takes unknown. A text the schema
 * refuses fails the assertion.
 */
export const decodeJson = <A>(schema: Schema.Codec<A, unknown>): ((text: string) => A) => {
	const decode = Schema.decodeResult(Schema.fromJsonString(schema))
	return (text: string): A => succeeded(decode(text))
}

const encodeJsonText = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))

/**
 * The JSON text of `value`, as JSON.stringify spells it, byte for byte: what a test sends as a json parameter or names
 * in a message. A value JSON has no text for (undefined, a function) fails the assertion.
 */
export const jsonText = (value: unknown): string => succeeded(encodeJsonText(value))
