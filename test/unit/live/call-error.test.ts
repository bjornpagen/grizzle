/**
 * readCallError and applyCallError (packages/grizzle/src/adapter/live/call-error.ts): a statement's refusal, on a read
 * or a write, read as the call error a live answer ends with, through the shell's own classification of the server's
 * report (serializationRefusal). Every SQLSTATE the runtime branches on is drawn, on a read and on a write.
 *
 * - The error is retry `safe` exactly where PostgreSQL rolled the whole transaction back for a concurrent
 *   transaction's work, 40001 or 40P01, so nothing committed and the same call may succeed; every other refusal of a
 *   statement is the statement's own, and retry `never`; its message carries the server's. Oracle: PostgreSQL's
 *   documentation of serialization_failure and deadlock_detected.
 *
 * Features: a serialization refusal and another refusal, each on a read and on a write.
 *
 * Plant (~/.cache/grizzle-release/LIVE-EVENTS/plants): transient-never (the classification table makes a transient
 * failure retry never).
 *
 * Every source's reading (call-error.ts readings), over every source a call's failure is met at (live/events.ts
 * failures), exhausted:
 *
 * - Exact: the kinds its table reads its failures as are exactly the kinds the event model gives the source, so each
 *   kind the document lists for a source is one some failure there reads as, and its type holds every producer of the
 *   source to them. Oracle: the classification's own tables, beside the model's.
 *
 * Features: every source.
 *
 * Plants (~/.cache/grizzle-release/OPENAPI/plants): read-reading-drops-transport (the read's table reads a broken
 * connection as unavailable, so no read failure reads as transport), failures-read-outside-world (the model gives a
 * read outsideWorld, which no read failure reads as).
 *
 * A session never had (call-error.ts connectCallError), over drawn driver failures: the server's refusal of a startup
 * by a SQLSTATE (each condition errcodes.txt lists for the classes a connection meets, 08, 28, 53 and 57, every class's
 * own code, a drawn code within any of its 43 classes, and any five characters a SQLSTATE may be), the socket's failure
 * by a code (each errno name of this platform, os.constants.errno, the resolver's, Node's own and any drawn one), a TLS
 * handshake's failure by a code (a certificate's, a negotiation's or a system error's), and every other way an attempt
 * ends, each met by a read, a write, a live source's open and a live leader's candidacy; a released layer's lease, met
 * by a read and a write; and a live source's open session lost by the transport, ended by the server with a drawn
 * SQLSTATE, or refused a statement with one, met by the source and by its leader:
 *
 * - Total and exact: the call error is the oracle table's, its kind and its reason, the table written from
 *   PostgreSQL 19's errcodes.txt (class 28, Invalid Authorization Specification, is the login's refusal and 28P01,
 *   invalid_password, the password's; 53300 too_many_connections; 57P01 admin_shutdown, 57P02 crash_shutdown and 57P03
 *   cannot_connect_now; any other SQLSTATE its own code), a session ended by the server or a statement refused by its
 *   SQLSTATE alike, and from README "Errors and outcomes" for the socket's codes, a session the transport lost
 *   (`sessionLost`) and every other end; its retry is `never` unless it is `unavailable`; its message carries the
 *   failure's own; and
 *   the wire carries it unchanged (decode after encode, live/codec.ts slotEncoders and slotDecoders).
 *
 * Oracle: errcodes.txt's conditions and classes, and the README's reasons, as the table below.
 *
 * Features: every reason, `failed`, and every path.
 *
 * Plant (~/.cache/grizzle-release/CALLERROR/plants): password-reads-as-connection-refused.patch (28P01 reads as
 * `unavailable`, `connectionRefused`).
 */
import { constants } from "node:os"
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { characterOf, element, type Gen, string, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import {
	ExecutionFailure,
	ReadFailure,
	serializationRefusal,
	TransportFailure
} from "#adapter/errors/execution.ts"
import {
	type AcquireRefusal,
	type ConnectRefusal,
	ConnectionClosed,
	ConnectionLost,
	ConnectTimedOut,
	CredentialError,
	DriverRefused,
	LayerReleased,
	NoCancelKey,
	ServerError,
	SocketFailed,
	StartupRefused,
	TlsRefused
} from "#adapter/errors/failures.ts"
import {
	applyCallError,
	readCallError,
	readings,
	sourceCallError
} from "#adapter/live/call-error.ts"
import { LeaderFailed } from "#adapter/live/leader.ts"
import { type Sqlstate, sqlstates } from "#compiler/core/sqlstate.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { slotDecoders, slotEncoders, wireText } from "#compiler/live/codec.ts"
import {
	type CallError,
	type CredentialReason,
	type FailureSource,
	failures,
	type UnavailableCause
} from "#compiler/live/events.ts"
import type { MemberWire, RoleWitness, WireOptions } from "#compiler/live/shape.ts"
import type { WireJson, WireScalar } from "#compiler/live/wire.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"

/** Where a refusal met the call: a features' pair of the search. */
type Met =
	| "a serialization refusal of a read"
	| "a serialization refusal of a write"
	| "another refusal of a read"
	| "another refusal of a write"

/** Every SQLSTATE the runtime branches on (core/sqlstate.ts sqlstates). */
const states: Arr.NonEmptyReadonlyArray<Sqlstate> = [
	sqlstates.serializationFailure,
	...Arr.filter(Rec.values(sqlstates), (state) => state !== sqlstates.serializationFailure)
]

/** The SQLSTATEs with which PostgreSQL rolls a transaction back for a concurrent transaction's work. */
const rolledBack: ReadonlySet<string> = new Set([
	sqlstates.serializationFailure,
	sqlstates.deadlockDetected
])

describe("readCallError and applyCallError", () => {
	it.effect(
		"a refusal is retry safe exactly where PostgreSQL rolled back for a concurrent transaction",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/live/call-error-sqlstate",
						generator: (source) => ({
							sqlstate: element(states)(source),
							program: element(["read", "write"] as const)(source)
						}),
						literal: Formatter.format,
						box: "every SQLSTATE the runtime branches on, on a read and on a write",
						oracle: {
							kind: "specification",
							name: "PostgreSQL's serialization_failure and deadlock_detected roll the transaction back"
						},
						coverage: requiredInSpace<Met>([
							"a serialization refusal of a read",
							"a serialization refusal of a write",
							"another refusal of a read",
							"another refusal of a write"
						]),
						caseHang,
						concurrency: 1
					},
					({ sqlstate, program }, c) =>
						Effect.sync(() => {
							const report = new ServerError({
								sqlstate,
								message: `refused with ${sqlstate}`,
								constraint: undefined,
								schema: undefined,
								table: undefined,
								column: undefined,
								dataType: undefined,
								detail: undefined,
								hint: undefined
							})
							const transient = serializationRefusal(report)
							const read = transient ?? new ReadFailure({ reason: report })
							const write = transient ?? new ExecutionFailure({ reason: report })
							const refused = program === "read" ? read : write
							const error = program === "read" ? readCallError(read) : applyCallError(write)
							const safe = rolledBack.has(sqlstate)
							assert.equal(error.retry, safe ? "safe" : "never")
							assert.ok(Str.includes(refused.message)(error.message), "the failure's own message")
							c.note(
								safe
									? program === "read"
										? "a serialization refusal of a read"
										: "a serialization refusal of a write"
									: program === "read"
										? "another refusal of a read"
										: "another refusal of a write"
							)
						})
				)
			)
	)
})

/** Every source a call's failure is met at, the event model's own roster (live/events.ts failures). */
const sources: ReadonlyArray<FailureSource> = Arr.map(Rec.toEntries(failures), ([source]) => source)

describe("every source's reading", () => {
	it.effect("reads its failures as exactly the kinds the event model gives its source", (ctx) =>
		Arr.isReadonlyArrayNonEmpty(sources)
			? searched(
					ctx,
					exhaust(
						{
							suite: "unit/live/call-error-readings",
							generator: element(sources),
							literal: Formatter.format,
							box: "every source a call's failure is met at",
							oracle: {
								kind: "specification",
								name: "the classification's own tables (call-error.ts readings) beside the event model's failures"
							},
							coverage: requiredInSpace<FailureSource>(sources),
							caseHang,
							concurrency: 1
						},
						(source, c) =>
							Effect.sync(() => {
								const reading: ReadonlyArray<string> = readings[source]
								const read = Arr.sort(Arr.dedupe(reading), Order.String)
								const given = Arr.sort(Arr.dedupe(failures[source]), Order.String)
								assert.deepEqual(read, given, `the reading of ${source}`)
								c.note(source)
							})
					)
				)
			: Effect.die(new Error("the event model gives no source"))
	)
})

/** What a session never had reads as, by the oracle: its kind and its reason, or `failed`, which holds none. */
type Expected =
	| { readonly kind: "credentialRefused"; readonly reason: CredentialReason }
	| { readonly kind: "unavailable"; readonly reason: UnavailableExpected }
	| { readonly kind: "failed" }

/** An unavailable error's reason, as the oracle states it. */
type UnavailableExpected =
	| { readonly kind: UnavailableCause }
	| { readonly kind: "otherSqlstate"; readonly sqlstate: string }
	| { readonly kind: "otherSocketCode"; readonly code: string }

const credential = (reason: CredentialReason): Expected => ({ kind: "credentialRefused", reason })
const unavailable = (cause: UnavailableCause): Expected => ({
	kind: "unavailable",
	reason: { kind: cause }
})

/**
 * PostgreSQL 19's errcodes.txt (src/backend/utils/errcodes.txt): every class it lists, the first two characters of
 * each `Section: Class` line, in its order.
 */
const errcodeClasses = [
	"00",
	"01",
	"02",
	"03",
	"08",
	"09",
	"0A",
	"0B",
	"0F",
	"0L",
	"0P",
	"0Z",
	"10",
	"20",
	"21",
	"22",
	"23",
	"24",
	"25",
	"26",
	"27",
	"28",
	"2B",
	"2D",
	"2F",
	"34",
	"38",
	"39",
	"3B",
	"3D",
	"3F",
	"40",
	"42",
	"44",
	"53",
	"54",
	"55",
	"57",
	"58",
	"F0",
	"HV",
	"P0",
	"XX"
] as const

/**
 * errcodes.txt's conditions of the classes a connection's startup meets, each by its SQLSTATE and its spec_name: 08
 * Connection Exception, 28 Invalid Authorization Specification, 53 Insufficient Resources, 57 Operator Intervention.
 */
const connectionConditions = [
	["08000", "connection_exception"],
	["08003", "connection_does_not_exist"],
	["08006", "connection_failure"],
	["08001", "sqlclient_unable_to_establish_sqlconnection"],
	["08004", "sqlserver_rejected_establishment_of_sqlconnection"],
	["08007", "transaction_resolution_unknown"],
	["08P01", "protocol_violation"],
	["28000", "invalid_authorization_specification"],
	["28P01", "invalid_password"],
	["53000", "insufficient_resources"],
	["53100", "disk_full"],
	["53200", "out_of_memory"],
	["53300", "too_many_connections"],
	["53400", "configuration_limit_exceeded"],
	["57000", "operator_intervention"],
	["57014", "query_canceled"],
	["57P01", "admin_shutdown"],
	["57P02", "crash_shutdown"],
	["57P03", "cannot_connect_now"],
	["57P04", "database_dropped"],
	["57P05", "idle_session_timeout"]
] as const

/**
 * The oracle's table of SQLSTATEs, written from errcodes.txt: the conditions a reason names, by their spec_name; every
 * other code of class 28 (Invalid Authorization Specification) is the login's refusal, as its class's own condition,
 * invalid_authorization_specification, is; any other SQLSTATE is `otherSqlstate`, carrying it.
 */
const sqlstateTable: Arr.NonEmptyReadonlyArray<readonly [string, Expected]> = [
	["28P01", credential("passwordRefused")],
	["28000", credential("loginRefused")],
	["53300", unavailable("tooManyConnections")],
	["57P01", unavailable("serverDown")],
	["57P02", unavailable("serverDown")],
	["57P03", unavailable("serverDown")]
]

/** The oracle's SQLSTATEs (sqlstateTable), by code. */
const sqlstateOracle: ReadonlyMap<string, Expected> = new Map(sqlstateTable)

/** errcodes.txt's class of invalid authorization specification. */
const authorizationClass = "28"

/** What the server's refusal of a startup with `code` reads as (sqlstateOracle). */
const expectedOfSqlstate = (code: string): Expected =>
	sqlstateOracle.get(code) ??
	(Str.startsWith(authorizationClass)(code)
		? credential("loginRefused")
		: { kind: "unavailable", reason: { kind: "otherSqlstate", sqlstate: code } })

/**
 * The oracle's table of socket codes, written from README "Errors and outcomes": each code a reason names; any other
 * code is `otherSocketCode`, carrying it.
 */
const socketTable: Arr.NonEmptyReadonlyArray<readonly [string, Expected]> = [
	["ECONNREFUSED", unavailable("connectionRefused")],
	["ENOENT", unavailable("connectionRefused")],
	["EHOSTUNREACH", unavailable("hostUnreachable")],
	["ENETUNREACH", unavailable("hostUnreachable")],
	["EHOSTDOWN", unavailable("hostUnreachable")],
	["ENETDOWN", unavailable("hostUnreachable")],
	["ENOTFOUND", unavailable("hostUnresolved")],
	["EAI_AGAIN", unavailable("hostUnresolved")],
	["ETIMEDOUT", unavailable("timedOut")],
	["ECONNRESET", unavailable("connectionClosed")],
	["EPIPE", unavailable("connectionClosed")],
	["ECONNABORTED", unavailable("connectionClosed")]
]

/** The oracle's socket codes (socketTable), by code. */
const socketOracle: ReadonlyMap<string, Expected> = new Map(socketTable)

/** What the socket's failure with `code` reads as (socketOracle). */
const expectedOfSocket = (code: string): Expected =>
	socketOracle.get(code) ?? {
		kind: "unavailable",
		reason: { kind: "otherSocketCode", code }
	}

/** This platform's system errors, by their errno's names: what a socket's code is, besides the resolver's and Node's. */
const errnoNames: Arr.NonEmptyReadonlyArray<string> = Arr.dedupe(
	Arr.prepend(Rec.keys(constants.errno), "ECONNREFUSED")
)

/**
 * What a TLS handshake that failed with `code` reads as, by README "Errors and outcomes": a system error's code is the
 * socket's (expectedOfSocket); any other, a certificate's or a negotiation's, `tlsUnverified`.
 */
const expectedOfHandshake = (code: string): Expected =>
	Arr.contains(errnoNames, code) ? expectedOfSocket(code) : credential("tlsUnverified")

/** Every other way a connection attempt ends, besides a SQLSTATE and a code. */
type Ended =
	| "the password Effect failed"
	| "no answer within the connect timeout"
	| "closed before ready"
	| "pg ended the startup"
	| "no cancellation key"
	| "no TLS offered"
	| "TLS answered neither"

/** What each other end reads as, by README "Errors and outcomes". */
const endedOracle: { readonly [E in Ended]: Expected } = {
	"the password Effect failed": credential("passwordFailed"),
	"no answer within the connect timeout": unavailable("timedOut"),
	"closed before ready": unavailable("connectionClosed"),
	"pg ended the startup": credential("driverRefused"),
	"no cancellation key": { kind: "failed" },
	"no TLS offered": credential("tlsUnverified"),
	"TLS answered neither": credential("tlsUnverified")
}

/**
 * A driver's failure, drawn: the server's SQLSTATE, the socket's code, a TLS handshake's code, or another end of an
 * attempt; a lease of a released layer, which attempts nothing; or, to a live source's open session, its connection
 * lost by the transport or ended by the server with a SQLSTATE, or a statement of it the server refused with one.
 */
type Failure =
	| { readonly kind: "startup"; readonly sqlstate: string }
	| { readonly kind: "socket"; readonly code: string }
	| { readonly kind: "handshake"; readonly code: string }
	| { readonly kind: "ended"; readonly ended: Ended }
	| { readonly kind: "released" }
	| { readonly kind: "lost by the transport" }
	| { readonly kind: "ended by the server"; readonly sqlstate: string }
	| { readonly kind: "statement refused"; readonly sqlstate: string }

/** Where the failure met a call: a read's lease, a write's, a live source's open, a live leader's candidacy. */
type Path = "a read" | "a write" | "a live source" | "a live leader"

/** One case: a failure, and where it met the call. */
interface Drawn {
	readonly failure: Failure
	readonly path: Path
}

/** The characters of a SQLSTATE: digits and ASCII capitals. */
const sqlstateCharacter = characterOf(
	Arr.prepend(Str.split("123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", ""), "0")
)

/**
 * A SQLSTATE: one errcodes.txt lists for a class a connection meets, one the oracle names, a class's own code, a drawn
 * code within any of errcodes.txt's classes, or any five characters.
 */
const sqlstateGen: Gen<string> = weighted<string>([
	[3, element(Arr.map(connectionConditions, ([code]) => code))],
	[3, element(Arr.map(sqlstateTable, ([code]) => code))],
	[1, (source) => `${source.draw(element(errcodeClasses))}000`],
	[
		2,
		(source) =>
			`${source.draw(element(errcodeClasses))}${source.draw(string(sqlstateCharacter, { min: 3, max: 3 }))}`
	],
	[1, string(sqlstateCharacter, { min: 5, max: 5 })]
])

/** Codes Node gives a socket's failure that are no errno's: the resolver's and its own. */
const nodeCodes = [
	"ENOTFOUND",
	"EAI_AGAIN",
	"EAI_FAIL",
	"ERR_SOCKET_CLOSED",
	"ERR_STREAM_DESTROYED"
] as const

/** A socket's code: one the oracle names, any errno name of this platform, or one of Node's own. */
const socketGen: Gen<string> = weighted<string>([
	[3, element(Arr.map(socketTable, ([code]) => code))],
	[2, element(errnoNames)],
	[1, element(nodeCodes)]
])

/**
 * Codes a TLS handshake fails with that are no system error's: Node's for a certificate that does not verify or does
 * not name the host, and OpenSSL's for a negotiation that failed.
 */
const tlsCodes = [
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"CERT_HAS_EXPIRED",
	"CERT_NOT_YET_VALID",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"ERR_SSL_WRONG_VERSION_NUMBER",
	"ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE"
] as const

/** A TLS handshake's code: a certificate's or a negotiation's, or a system error's. */
const handshakeGen: Gen<string> = weighted<string>([
	[2, element(tlsCodes)],
	[1, element(Arr.map(socketTable, ([code]) => code))],
	[1, element(errnoNames)]
])

/** Every other end. */
const endings: Arr.NonEmptyReadonlyArray<Ended> = [
	"the password Effect failed",
	"no answer within the connect timeout",
	"closed before ready",
	"pg ended the startup",
	"no cancellation key",
	"no TLS offered",
	"TLS answered neither"
]

/** A drawn driver failure. */
const failureGen: Gen<Failure> = weighted<Failure>([
	[4, (source) => ({ kind: "startup", sqlstate: source.draw(sqlstateGen) })],
	[3, (source) => ({ kind: "socket", code: source.draw(socketGen) })],
	[2, (source) => ({ kind: "handshake", code: source.draw(handshakeGen) })],
	[2, (source) => ({ kind: "ended", ended: source.draw(element(endings)) })],
	[1, () => ({ kind: "released" })],
	[1, () => ({ kind: "lost by the transport" })],
	[1, (source) => ({ kind: "ended by the server", sqlstate: source.draw(sqlstateGen) })],
	[1, (source) => ({ kind: "statement refused", sqlstate: source.draw(sqlstateGen) })]
])

const paths: Arr.NonEmptyReadonlyArray<Path> = [
	"a read",
	"a write",
	"a live source",
	"a live leader"
]

/** Where a live source's open session meets a failure: its own sessions, or its leader's. */
const livePaths: Arr.NonEmptyReadonlyArray<Path> = ["a live source", "a live leader"]

/**
 * The paths a failure meets a call on: a released layer's lease a read's and a write's alone, never a live source's,
 * whose open connects outside the pool; an open session's loss and a statement's refusal a live source's alone, here
 * (a read's and a write's are the tables' above).
 */
const pathsOf = (failure: Failure): Arr.NonEmptyReadonlyArray<Path> => {
	switch (failure.kind) {
		case "released":
			return ["a read", "a write"]
		case "lost by the transport":
		case "ended by the server":
		case "statement refused":
			return livePaths
		case "startup":
		case "socket":
		case "handshake":
		case "ended":
			return paths
	}
}

/** A case: a failure and a path it meets a call on (pathsOf). */
const metGen = drawn<Drawn>((source) => {
	const failure = source.draw(failureGen)
	const path = source.draw(element(pathsOf(failure)))
	return { failure, path }
})

/** The connection a failure is, as the adapter classifies it (failures.ts ConnectRefusal). */
const connectRefusalOf = (
	failure: Extract<Failure, { readonly kind: "startup" | "socket" | "handshake" | "ended" }>
): ConnectRefusal => {
	switch (failure.kind) {
		case "startup":
			return new StartupRefused({
				error: serverError({ ...nothingReported, sqlstate: failure.sqlstate })
			})
		case "socket":
			return new SocketFailed({ code: failure.code })
		case "handshake":
			return new TlsRefused({ fault: { kind: "handshake", code: failure.code } })
		case "ended":
			return endedRefusal(failure.ended)
	}
}

/** Every other end, as the adapter's class of it. */
const endedRefusal = (ended: Ended): ConnectRefusal => {
	switch (ended) {
		case "the password Effect failed":
			return new CredentialError({ cause: "the provider resolved nothing" })
		case "no answer within the connect timeout":
			return new ConnectTimedOut({ millis: 1 })
		case "closed before ready":
			return new ConnectionClosed()
		case "pg ended the startup":
			return new DriverRefused({
				said: "SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature does not match"
			})
		case "no cancellation key":
			return new NoCancelKey()
		case "no TLS offered":
			return new TlsRefused({ fault: { kind: "notOffered" } })
		case "TLS answered neither":
			return new TlsRefused({ fault: { kind: "unanswered" } })
	}
}

/** A live source's open session's failure, as the adapter classifies it. */
const sessionFailureOf = (
	failure: Extract<
		Failure,
		{ readonly kind: "lost by the transport" | "ended by the server" | "statement refused" }
	>
): ConnectionLost | ServerError => {
	switch (failure.kind) {
		case "lost by the transport":
			return new ConnectionLost({ operation: "query", ended: { by: "transport" } })
		case "ended by the server":
			return new ConnectionLost({
				operation: "query",
				ended: {
					by: "server",
					error: serverError({ ...nothingReported, sqlstate: failure.sqlstate })
				}
			})
		case "statement refused":
			return serverError({ ...nothingReported, sqlstate: failure.sqlstate })
	}
}

/** The failure a case's draw is: a lease's refusal, a connection's, or a live source's open session's. */
const causeOf = (failure: Failure): AcquireRefusal | ConnectionLost | ServerError => {
	switch (failure.kind) {
		case "released":
			return new LayerReleased()
		case "lost by the transport":
		case "ended by the server":
		case "statement refused":
			return sessionFailureOf(failure)
		case "startup":
		case "socket":
		case "handshake":
		case "ended":
			return connectRefusalOf(failure)
	}
}

/** What the oracle says a failure reads as. */
const expectedOf = (failure: Failure): Expected => {
	switch (failure.kind) {
		case "startup":
			return expectedOfSqlstate(failure.sqlstate)
		case "socket":
			return expectedOfSocket(failure.code)
		case "handshake":
			return expectedOfHandshake(failure.code)
		case "ended":
			return endedOracle[failure.ended]
		case "released":
			return unavailable("layerReleased")
		case "lost by the transport":
			return unavailable("sessionLost")
		case "ended by the server":
		case "statement refused":
			return expectedOfSqlstate(failure.sqlstate)
	}
}

/** The call error a failure ends a call with on `path`, and the message of the failure it carries. */
const calledWith = (
	failure: Failure,
	path: Path
): { readonly error: CallError; readonly own: string } => {
	const cause = causeOf(failure)
	switch (path) {
		case "a read":
		case "a write": {
			assert.ok(
				cause._tag !== "ConnectionLost" && cause._tag !== "ServerError",
				"a read's and a write's lease meets a refusal of a session alone"
			)
			return path === "a read"
				? { error: readCallError(new ReadFailure({ reason: cause })), own: cause.message }
				: { error: applyCallError(new TransportFailure({ reason: cause })), own: cause.message }
		}
		case "a live source":
		case "a live leader": {
			assert.ok(cause._tag !== "LayerReleased", "a live source connects outside the pool")
			const reason = path === "a live source" ? cause : new LeaderFailed({ reason: cause })
			return { error: sourceCallError(reason, reason.message), own: cause.message }
		}
	}
}

/** What a call error states, as the oracle states it: its kind and its reason, none for `failed`. */
const statedOf = (error: CallError): Expected | string =>
	error.kind === "credentialRefused"
		? { kind: error.kind, reason: error.reason }
		: error.kind === "unavailable"
			? { kind: error.kind, reason: error.reason }
			: error.kind === "failed"
				? { kind: error.kind }
				: error.kind

/** A refresh's wire: an error's encode reads nothing of a member's beside its role's witness. */
const errorWire: MemberWire = {
	shape: "write",
	input: { kind: "call", params: [], facts: [] },
	outcome: { kind: "refresh" }
}

/** A role's witness that names no relation: no error here is a refusal, which alone carries a witness. */
const noWitness: RoleWitness<WireScalar> = []

/** Effect's Option, as the wire spells an absent value (its codecs never meet one in an error). */
const errorOptions: WireOptions = {
	some: Option.some,
	none: Option.none(),
	is: Option.isOption,
	fold: (option, cases) => Option.match(option, cases)
}

/** The features of a case: the reason its error reads as, `failed`, and its path. */
type Reached =
	| CredentialReason
	| UnavailableCause
	| "otherSqlstate"
	| "otherSocketCode"
	| "failed"
	| Path

/** The reason an expected error names, as a feature. */
const reachedOf = (expected: Expected): Reached =>
	expected.kind === "failed"
		? "failed"
		: expected.kind === "credentialRefused"
			? expected.reason
			: expected.reason.kind

describe("a session never had", () => {
	it.effect(
		"reads as the oracle table's kind and reason, by its SQLSTATE or its code, alike on every path, and the wire carries it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: 'PostgreSQL 19\'s errcodes.txt and README "Errors and outcomes", as a table of kinds and reasons'
						},
						suite: "unit/live/call-error-connect",
						draw: metGen,
						literal: Formatter.format,
						coverage: required<Reached>(
							[
								"passwordFailed",
								"passwordRefused",
								"loginRefused",
								"tlsUnverified",
								"driverRefused",
								"connectionRefused",
								"hostUnreachable",
								"hostUnresolved",
								"timedOut",
								"connectionClosed",
								"serverDown",
								"tooManyConnections",
								"layerReleased",
								"sessionLost",
								"otherSqlstate",
								"otherSocketCode",
								"failed",
								"a read",
								"a write",
								"a live source",
								"a live leader"
							],
							{ cases: 120, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ failure, path }, notes) =>
						Effect.sync(() => {
							const expected = expectedOf(failure)
							const { error, own } = calledWith(failure, path)
							assert.deepEqual(statedOf(error), expected, `${Formatter.format(failure)} on ${path}`)
							assert.equal(
								error.retry,
								expected.kind === "unavailable" ? "safe" : "never",
								"retry safe only where the cause may pass"
							)
							assert.ok(Str.includes(own)(error.message), "the failure's own message")
							const encoded = slotEncoders(errorWire, noWitness, errorOptions).error(error)
							const decoded = slotDecoders(errorWire, noWitness, errorOptions).error(
								trustedJson<WireJson>(wireText(encoded))
							)
							assert.deepEqual(decoded, error, "the wire carries the error unchanged")
							notes.note(reachedOf(expected))
							notes.note(path)
						})
				)
			)
	)
})
