import * as Data from "effect/Data"

/**
 * A password Effect failed, for example an AWS provider that could not resolve credentials: the application fails its
 * password Effect with it, the provider's failure as its `cause`. grizzle never fails with it on its own: it is the
 * reason of an OpenError, a ReadFailure or a TransportFailure, at stage `credential`. A configuration's connection
 * fails its password Effect with it as a login's does, so it is the authoring entry's (packages/grizzle/src/index.ts) as
 * well as the runtime's, and its module holds it alone, so the configuration loads none of the runtime's failures.
 */
export class CredentialError extends Data.TaggedError("CredentialError")<{
	readonly cause: unknown
}> {
	override get message(): string {
		return "the password Effect failed"
	}
}
