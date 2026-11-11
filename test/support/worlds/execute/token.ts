import { Effect, Option } from "effect"
import type { TokenError } from "#adapter/errors/failures.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { testVerify, tokenOf, tokenText } from "#test/support/worlds.ts"
import type { Token, TokenWild } from "#test/support/worlds/model/types.ts"

/**
 * The token the open in flight hands verify, as the executor performs it: its text, and the wild kind it was drawn as,
 * none for a live or stale token or a wild value that is a string. A verify call follows the token of its own open,
 * never another open's of the same text: a wild `verify-throws` token's text is a payload's JSON, which a later live
 * token may spell exactly.
 */
export interface Handed {
	readonly text: string
	readonly wild: Option.Option<TokenWild>
}

/**
 * The token `Db.open` is handed: none, a live or stale payload's JSON text, or a wild token's own text and kind, each
 * as a token (worlds.ts tokenText), so verify reads the text it was drawn as.
 */
export const handedOf = (token: Token): Option.Option<Handed> => {
	switch (token.kind) {
		case "none":
			return Option.none()
		case "live":
		case "stale":
			return Option.some({ text: tokenOf(trusted<Json>(token.payload)), wild: Option.none() })
		case "wild":
			return Option.some({ text: tokenText(token.text), wild: Option.some(token.wild) })
	}
}

/** A verify that throws, as a misbehaving JavaScript verifier does instead of returning an Effect. */
const throwing = (token: string): never => {
	throw new Error(`the world's verify throws on purpose for the token ${token}`)
}

/**
 * The verify of every login layer the executor builds: a token's payload is its JSON text, any other text a TokenError,
 * as a verifier's refusal is; every call is counted. It reads the token the open in flight handed (opens run one at a
 * time, and verify runs once per Db.open): drawn wild `verify-throws`, verify throws, and drawn `verify-not-object`, it
 * returns a number. A call with no open in flight, or with a text other than the one its open handed, is a defect of
 * the run.
 */
export const worldVerify =
	(handed: () => Option.Option<Handed>, counted: () => void) =>
	(token: string): Effect.Effect<unknown, TokenError> => {
		counted()
		const open = handed()
		if (Option.isNone(open) || open.value.text !== token) {
			return Effect.die(
				new Error(`verify was handed the token ${token}, which no open in flight handed it`)
			)
		}
		const wild = open.value.wild
		if (Option.isSome(wild) && wild.value === "verify-throws") {
			return throwing(token)
		}
		if (Option.isSome(wild) && wild.value === "verify-not-object") {
			return Effect.succeed(42)
		}
		return testVerify(token)
	}
