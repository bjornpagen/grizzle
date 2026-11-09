import { maxStringLength, messageMaxBytes } from "#compiler/core/limits.ts"

/**
 * The bytes of a Bind message beside its parameters' texts, as the wire writes it: `statement`, its own fields and its
 * statement's name; `parameter`, the fields each parameter adds.
 */
export interface BindFrame {
	readonly statement: number
	readonly parameter: number
}

/**
 * What one statement carries, one array per column: a Bind message of at most `messageBytes` bytes, as its length
 * word counts it, around `frame`, and array literals of at most `literalUnits` UTF-16 code units each.
 */
export interface Transport {
	readonly messageBytes: number
	readonly literalUnits: number
	readonly frame: BindFrame
}

/** The transport in force over the wire's frame: PostgreSQL's longest message and V8's longest string. */
export const inForce = (frame: BindFrame): Transport => ({
	messageBytes: messageMaxBytes.value,
	literalUnits: maxStringLength.value,
	frame
})
