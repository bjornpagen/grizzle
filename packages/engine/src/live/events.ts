/**
 * The live event model as data: every event of a call's answer and every error that ends one is a descriptor here, its
 * name and the slots its payload holds, from which the TypeScript types below, the SSE frames and the OpenAPI schema
 * all derive, so no shape is spelled twice.
 *
 * A read's answer opens with `reset`, which names the key fields its rows are keyed by, once its read has answered;
 * sends an `upsert` per row as it decodes, provisional until `ready`, which follows the read's COMMIT; and then, live,
 * an `upsert` or `remove` per change, each sent after its re-run's COMMIT. Every read's rows are a list in its order,
 * its key's where it states none, so an upsert carries its row and the key of the row it follows, null for the first.
 * An answered read's answer, a read its member declares
 * answered(...) or one whose member binds a parameter to the database's clock, is its read at its call's instant alone:
 * `reset`, its upserts, `ready`, then `end`, with no `remove`, since no change wakes it, and time passing is no change.
 * A write's answer is its `outcome`, after its COMMIT. Every failure is one `error`, and an answer ends with `end` after
 * its error or outcome, an answered read's after its ready too. A read that
 * fails before it answered, its input refused at the door or by PostgreSQL as it binds it among them, answers its error
 * alone: no `reset` opened an answer it never gave.
 */
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { TransientTag } from "#compiler/core/errors.ts"
import type { ParamPlace } from "#compiler/core/identity.ts"
import type { Sqlstate } from "#compiler/core/sqlstate.ts"
import type { KeyFields, RowKey } from "#compiler/live/key.ts"
import type { BrokenLaws, Witness } from "#compiler/types/changeset/changeset.ts"

/**
 * Why a session's connection was not authenticated, either way (`credentialRefused`), each met again by the same call
 * until the connection's configuration changes:
 *
 * - `passwordFailed`: the connection's password Effect failed (CredentialError), so no credential was offered;
 * - `passwordRefused`: the server refused the password, SQLSTATE 28P01 (invalid_password);
 * - `loginRefused`: the server refused the login with any other SQLSTATE of class 28 (invalid authorization
 *   specification), 28000 among them: no pg_hba.conf entry admits it, or its role does not exist or may not log in;
 * - `tlsUnverified`: TLS did not come up verified: the server's certificate does not chain to the CA bundle or does
 *   not name the host, the handshake failed with a code no system error has, or the server offers no TLS or answered
 *   the SSLRequest with neither yes nor no;
 * - `driverRefused`: the driver ended the authentication itself, with no SQLSTATE and no code: a SCRAM exchange whose
 *   server proof does not verify, a mechanism it does not support, or a server asking a password of a role given none,
 *   a connection over a Unix socket among them, which carries none.
 */
export const credentialReasons = [
	"passwordFailed",
	"passwordRefused",
	"loginRefused",
	"tlsUnverified",
	"driverRefused"
] as const

/** Why a session's connection was not authenticated (credentialReasons). */
export type CredentialReason = (typeof credentialReasons)[number]

/**
 * The causes no session could be had for now (`unavailable`) that carry nothing beside their name, each one that may
 * pass:
 *
 * - `connectionRefused`: nothing accepted the connection at its address: ECONNREFUSED, or ENOENT where a socket's path
 *   is absent;
 * - `hostUnreachable`: no route reaches the host: EHOSTUNREACH, ENETUNREACH, EHOSTDOWN, ENETDOWN;
 * - `hostUnresolved`: the host's name did not resolve: ENOTFOUND, EAI_AGAIN;
 * - `timedOut`: the operating system gave up on the connection, ETIMEDOUT: no answer reached it within its TCP
 *   timeouts;
 * - `connectionClosed`: the connection closed before the session was ready: the server closed it with no
 *   ErrorResponse, or the socket was reset, ECONNRESET, EPIPE, ECONNABORTED;
 * - `serverDown`: the server is shut down by its administrator (57P01 admin_shutdown), after a crash (57P02
 *   crash_shutdown), or accepts no connection now, starting, recovering or stopping (57P03 cannot_connect_now);
 * - `tooManyConnections`: every connection slot the server or the role allows is taken, 53300 too_many_connections;
 * - `layerReleased`: the DbLayer the Db was opened under, or the live read registered on, was released;
 * - `verifierUnavailable`: the layer's verify could not judge the call's token now (VerifierUnavailable), its
 *   verifier's service down or unreachable: no token was refused, and the same call may pass once it answers;
 * - `sessionLost`: a session the installation's live source holds was lost with no report of the server's: its
 *   listening session ended, the transport lost its connection, a fan-out's COMMIT went
 *   unanswered, or its leader's replication stream sent nothing past its deadline (a session the server ended with
 *   its report reads by that report's SQLSTATE instead, 57P01 as `serverDown`);
 * - `slotInvalidated`: the installation's replication slot was invalidated: its live leader makes it again;
 * - `leaderFailed`: the process's candidacy for the installation's live leader failed with no connection's refusal,
 *   no server's report and no lost session as its cause: an answer, a message or a secret it cannot read, a statement
 *   past a bound, or a replication stream the server ended.
 */
export const unavailableCauses = [
	"connectionRefused",
	"hostUnreachable",
	"hostUnresolved",
	"timedOut",
	"connectionClosed",
	"serverDown",
	"tooManyConnections",
	"layerReleased",
	"verifierUnavailable",
	"sessionLost",
	"slotInvalidated",
	"leaderFailed"
] as const

/** A cause no session could be had for now that carries nothing beside its name (unavailableCauses). */
export type UnavailableCause = (typeof unavailableCauses)[number]

/**
 * Why no session could be had for now (`unavailable`): a named cause (unavailableCauses); or, for a cause no name
 * classifies, the code that reports it, never its words: `otherSqlstate`, the server's refusal with any other SQLSTATE,
 * 3D000 for a database that does not exist among them; `otherSocketCode`, the socket's failure with any other code,
 * its errno's name for a system error.
 */
export type UnavailableReason =
	| { readonly _tag: UnavailableCause }
	| { readonly _tag: "otherSqlstate"; readonly sqlstate: Sqlstate }
	| { readonly _tag: "otherSocketCode"; readonly code: string }

/**
 * What one payload member holds, by the slot that types it: a text; reset's key fields; a row; a key; the key a row
 * follows, null for the first; a write's outcome; a CallError, of the kinds its answer may end with
 * (Failure); a refusal's laws and witness; which concurrent refusal a transient error met (core/errors.ts
 * TransientTag); why a connection was not authenticated (CredentialReason); why no session could be had for now
 * (UnavailableReason); and the parameter a pattern refused a value at (core/identity.ts ParamPlace).
 */
export interface SlotValues<Row, Outcome, Failure = CallError> {
	readonly text: string
	readonly fields: KeyFields
	readonly row: Row
	readonly key: RowKey
	readonly after: RowKey | null
	readonly outcome: Outcome
	readonly error: Failure
	readonly refused: BrokenLaws
	readonly witness: Witness
	readonly transientReason: TransientTag
	readonly credentialReason: CredentialReason
	readonly unavailableReason: UnavailableReason
	readonly paramPlace: ParamPlace
}

/** The slots a payload member is typed by. */
export type Slot = keyof SlotValues<unknown, unknown, unknown>

/** A payload: each member's name, with the slot that types it. */
export type Payload = { readonly [member: string]: Slot }

/**
 * Whether running the same call again is safe: `safe`, nothing committed and the failure is not the call's own, so the
 * same call may succeed; `never`, the same call meets the same answer, or may apply twice.
 */
export type Retry = "safe" | "never"

/**
 * The one classification of every failure a call ends with: each error's retry, and the members its payload holds
 * beside its `message`, the failure's own words (the server's report where the database refused).
 *
 * - `route`: no served program at the path: an unknown login, role or program, or a method other than POST.
 * - `input`: the body, a parameter or a fact does not decode, or a parameter or fact a codec refuses, past its size
 *   bound included.
 * - `paramRejected`: PostgreSQL refused a parameter's value outside its pattern as it bound it, a byte bound
 *   (`str.bytes`) among them: `param` is where, a scalar parameter by its name or a field of a relation parameter's
 *   facts by the parameter's name and the field's (ParamPlace).
 * - `tokenRefused`: no token where the role declares a context, a token its verify refuses, or claims that do not
 *   decode through the role's contexts.
 * - `tokenExpired`: the token expired, before the call or while it streamed: the same call with a fresh token.
 * - `refused`: the schema's laws refused the write: which laws and how grizzle decided them, and the witness.
 * - `outsideWorld`: a fact the write adds lies outside the written world relation.
 * - `transient`: SERIALIZABLE refused the attempt (40001, 40P01) or a concurrent writer's change met it, and it
 *   changed nothing (TransientFailure); `reason` names which.
 * - `credentialRefused`: no session could be had because its connection was not authenticated, either way: the
 *   credential could not be had or the server refused it, or the server's certificate did not verify; nothing was
 *   sent, and the same call meets the same refusal until the connection's configuration changes; `reason` names which
 *   (CredentialReason).
 * - `unavailable`: no session could be had for now: the pool or the handle refused one before anything was sent, for
 *   a cause that may pass; `reason` names which (UnavailableReason).
 * - `transport`: a connection broke before the terminal event, the client's exchange or the server's session, of a
 *   read, which commits nothing, or of a write before its COMMIT was sent.
 * - `stale`: the database does not hold the snapshot the server was deployed with, so the call ran nothing.
 * - `commitUnknown`: a write's COMMIT was sent and no answer came: it may have committed.
 * - `failed`: the server or the database failed the call otherwise: a statement it refused, a lost connection, an
 *   answer that does not read.
 */
export const callErrors = {
	route: { retry: "never", payload: { message: "text" } },
	input: { retry: "never", payload: { message: "text" } },
	paramRejected: { retry: "never", payload: { message: "text", param: "paramPlace" } },
	tokenRefused: { retry: "never", payload: { message: "text" } },
	tokenExpired: { retry: "safe", payload: { message: "text" } },
	refused: {
		retry: "never",
		payload: { message: "text", refused: "refused", witness: "witness" }
	},
	outsideWorld: { retry: "never", payload: { message: "text", relation: "text" } },
	transient: { retry: "safe", payload: { message: "text", reason: "transientReason" } },
	credentialRefused: { retry: "never", payload: { message: "text", reason: "credentialReason" } },
	unavailable: { retry: "safe", payload: { message: "text", reason: "unavailableReason" } },
	transport: { retry: "safe", payload: { message: "text" } },
	stale: { retry: "never", payload: { message: "text" } },
	commitUnknown: { retry: "never", payload: { message: "text" } },
	failed: { retry: "never", payload: { message: "text" } }
} as const satisfies {
	readonly [kind: string]: { readonly retry: Retry; readonly payload: Payload }
}

/** The errors' kinds. */
export type CallErrorKind = keyof typeof callErrors

/** The members of a payload, each typed by its slot, an error as Failure, the kinds its answer may end with. */
export type PayloadOf<P extends Payload, Row, Outcome, Failure> = {
	readonly [M in keyof P]: SlotValues<Row, Outcome, Failure>[P[M]]
}

/**
 * The error of kind K: its kind as its `_tag`, so Effect's catchTag selects it (`Effect.catchTag("refused", ...)`), the
 * retry the classification gives it, and its payload.
 */
export type CallErrorOf<K extends CallErrorKind> = {
	readonly _tag: K
	readonly retry: (typeof callErrors)[K]["retry"]
} & PayloadOf<(typeof callErrors)[K]["payload"], never, never, never>

/** The errors of the kinds K, each of its own kind (CallErrorOf). */
export type CallErrorIn<K extends CallErrorKind> = { readonly [k in K]: CallErrorOf<k> }[K]

/** Every failure a call ends with (callErrors). */
export type CallError = CallErrorIn<CallErrorKind>

/** The error of kind `kind` with its payload, its retry the classification's. */
export const callError = <K extends CallErrorKind>(
	kind: K,
	payload: PayloadOf<(typeof callErrors)[K]["payload"], never, never, never>
): CallErrorOf<K> => ({ _tag: kind, retry: callErrors[kind].retry, ...payload })

/**
 * Where a call's failure is met, each with exactly the kinds of CallError it is read as. Each source's reading is a
 * table keyed by what fails there (adapter live/call-error.ts), which must name each of its kinds and no other, and
 * each of its producers is typed by its kinds (FailureOf):
 *
 * - `door`: the HTTP door, before any member runs: a request line no route serves, a wire header naming no digest or
 *   another (wireRefusals), an Authorization header holding no bearer token68, no token where the role declares a context,
 *   a body that is no JSON text or not the member's input;
 * - `open`: the opening of the Db a served call runs on, through the layer's verify and the role's contexts
 *   (OpenError), its verifier unavailable among them;
 * - `read`: a read's run, its input's parse included (ReadError);
 * - `watch`: a live read's subscription: its change source's refusal or loss, its layer's release, its token's expiry;
 * - `apply`: a write's run, its input's parse included (ApplyError);
 * - `outcome`: a ChangeSet's application that is a refusal: by the laws, or a fact outside the world relation.
 */
export const failures = {
	door: ["route", "input", "tokenRefused", "stale"],
	open: ["route", "tokenRefused", "unavailable", "failed"],
	read: [
		"refused",
		"input",
		"paramRejected",
		"transient",
		"credentialRefused",
		"unavailable",
		"transport",
		"stale",
		"failed"
	],
	watch: ["credentialRefused", "unavailable", "stale", "failed", "tokenExpired"],
	apply: [
		"input",
		"paramRejected",
		"transient",
		"credentialRefused",
		"unavailable",
		"transport",
		"stale",
		"commitUnknown",
		"failed"
	],
	outcome: ["refused", "outsideWorld"]
} as const satisfies { readonly [source: string]: NonEmptyReadonlyArray<CallErrorKind> }

/** The sources a call's failure is met at (failures). */
export type FailureSource = keyof typeof failures

/** The kinds of CallError the sources S read their failures as. */
export type FailureKind<S extends FailureSource> = (typeof failures)[S][number]

/** The CallErrors the sources S read their failures as. */
export type FailureOf<S extends FailureSource> = CallErrorIn<FailureKind<S>>

/**
 * What a member's answer is, each with the sources of the failures its calls meet (failures): a live read's, its run's
 * and its subscription's; an answered read's, at its call's instant alone, its run's alone; and a ChangeSet's, its run's
 * and its outcome's.
 */
export const answers = {
	live: ["read", "watch"],
	answered: ["read"],
	change: ["apply", "outcome"]
} as const satisfies { readonly [answer: string]: NonEmptyReadonlyArray<FailureSource> }

/** The kind of a member's answer (answers). */
export type AnswerKind = keyof typeof answers

/** The CallErrors a member's calls of the answers A end with. */
export type AnswerFailure<A extends AnswerKind> = FailureOf<(typeof answers)[A][number]>

/** The sources every call over HTTP meets before its member runs, beside its answer's: its door, then its Db's opening. */
export const servedSources = [
	"door",
	"open"
] as const satisfies NonEmptyReadonlyArray<FailureSource>

/** The request header a call names the wire it was built for by, its digest (live/member.ts WireDigest). */
export const wireHeader = "grizzle-wire"

/**
 * What a call's wire header is refused as, before its Db opens: naming no digest, `input`; naming another form of its
 * member than the one served, `stale`, so a client never decodes an answer by a form the server no longer serves.
 */
export const wireRefusals = { absent: "input", other: "stale" } as const satisfies {
	readonly [refusal: string]: CallErrorKind
}

/**
 * What an event is to its stream: an `item` of the answer; `ready`, the read's value is whole; `error`, the answer
 * failed; `end`, nothing follows.
 */
export type Role = "item" | "ready" | "error" | "end"

/**
 * An event's descriptor: its role, the members its payload holds, and the event that follows it where one event alone
 * may: an answered read's `ready` is followed by its `end` (`next`), since no change wakes it.
 */
export interface EventDescriptor {
	readonly role: Role
	readonly payload: Payload
	readonly next?: "end"
}

const reset = { role: "item", payload: { key: "fields" } } as const
const remove = { role: "item", payload: { key: "key" } } as const
const ready = { role: "ready", payload: {} } as const
const answeredReady = { role: "ready", payload: {}, next: "end" } as const
const error = { role: "error", payload: { error: "error" } } as const
const end = { role: "end", payload: {} } as const

const upsert = { role: "item", payload: { row: "row", after: "after" } } as const

/**
 * The events of each shape of answer, by name: a read's, its list's, live or answered at its call's instant alone
 * (answeredList), which no change wakes, and a write's.
 */
export const events = {
	list: { reset, upsert, remove, ready, error, end },
	answeredList: { reset, upsert, ready: answeredReady, error, end },
	write: { outcome: { role: "item", payload: { outcome: "outcome" } }, error, end }
} as const satisfies {
	readonly [shape: string]: { readonly [name: string]: EventDescriptor }
}

/** The shapes of answer: a read's list, live or answered at its call's instant alone, and a write's. */
export type Shape = keyof typeof events

/** The answers of each shape (answers): a read's live, an answered one's at its call's instant alone, a write's a ChangeSet's. */
export interface ShapeAnswers {
	readonly list: "live"
	readonly answeredList: "answered"
	readonly write: "change"
}

/** The CallErrors an answer of shape S ends with: its answers' (AnswerFailure). */
export type ShapeFailure<S extends Shape> = AnswerFailure<ShapeAnswers[S]>

/**
 * The event `name` of shape S over Row and Outcome: its name as `_tag`, and its payload's members, an error of the
 * kinds the shape's answers end with (ShapeFailure).
 */
type EventNamed<S extends Shape, Name extends keyof (typeof events)[S], Row, Outcome> = {
	readonly _tag: Name
} & PayloadOf<EventPayload<S, Name>, Row, Outcome, ShapeFailure<S>>

type EventPayload<
	S extends Shape,
	Name extends keyof (typeof events)[S]
> = (typeof events)[S][Name] extends { readonly payload: infer P extends Payload } ? P : never

/** Every event of an answer of shape S, over its rows Row and a write's Outcome. */
export type EventOfShape<S extends Shape, Row, Outcome> = {
	readonly [Name in keyof (typeof events)[S]]: EventNamed<S, Name, Row, Outcome>
}[keyof (typeof events)[S]]

/** A read's events. */
export type ListEvent<Row> = EventOfShape<"list", Row, never>

/** An answered read's events, at its call's instant alone. */
export type AnsweredListEvent<Row> = EventOfShape<"answeredList", Row, never>

/** A write's events. */
export type WriteEvent<Outcome> = EventOfShape<"write", never, Outcome>

/** A read's change: an upsert of a row after a key, a move when its key is present, or a removal. */
export type ListChange<Row> = Extract<ListEvent<Row>, { readonly _tag: "upsert" | "remove" }>
