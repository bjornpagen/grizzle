/**
 * @bjornpagen/grizzle/client: a login's served programs over HTTP, for a browser or any runtime with fetch. It loads no
 * Node module, no compiler and no served layer: the login's type alone (`import type`), its OpenAPI document as data,
 * Effect, and the exact values its answers decode into (Decimal, Money, Vector, keyed values).
 *
 * `clientOf<typeof Web>(document, "web", { url, token })` is a Result: the client, which holds each role's programs,
 * `client.<role>.<program>`, each with `watch` and `once`, or ClientDocumentRefused where the document is another
 * login's. The HttpClient its calls require is the caller's: FetchHttpClient.layer in a browser, or
 * handlerClient(handler) in the handler's own process.
 */
export {
	type Client,
	type ClientCalls,
	ClientDocumentRefused,
	type ClientOptions,
	clientCalls,
	clientOf,
	type ItemOf,
	type ProgramClient,
	type RoleClient,
	type TokenClientOptions,
	type UrlClientOptions,
	type Watched
} from "#client/client.ts"
export type { Answered, ProgramCalls, ShapedCalls, Token } from "#client/call.ts"
export { handlerClient } from "#client/handler.ts"
export {
	type Anchor,
	type CallError,
	type CallErrorKind,
	type CredentialReason,
	Decimal,
	KeyedList,
	Money,
	type RelationCounts,
	type Retry,
	RowKey,
	type UnavailableCause,
	type UnavailableReason,
	Vector,
	type Window,
	type WriteOutcome
} from "#compiler/plan/client.ts"
