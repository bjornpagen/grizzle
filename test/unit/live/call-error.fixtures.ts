/** What the properties of call-error.test.ts read: its spaces, models and helpers. */

import { constants } from "node:os"
import { word } from "@bjornpagen/testing/dictionary"
import {
	aimed,
	boolean,
	characterOf,
	element,
	type Gen,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import { CredentialError } from "#adapter/errors/credential.ts"
import {
	type ApplyError,
	ExecutionFailure,
	type ReadError,
	ReadFailure,
	serializationRefusal,
	TransportFailure
} from "#adapter/errors/execution.ts"
import {
	type AcquireRefusal,
	type ConnectRefusal,
	ConnectionClosed,
	ConnectionLost,
	DriverFailure,
	DriverRefused,
	LayerReleased,
	NoCancelKey,
	ParamRejected,
	ServerError,
	SocketFailed,
	StartupRefused,
	TlsRefused
} from "#adapter/errors/failures.ts"
import { applyCallError, readCallError, sourceCallError } from "#adapter/live/call-error.ts"
import { LeaderFailed } from "#adapter/live/leader.ts"
import type { ParamPlace } from "#compiler/core/identity.ts"
import { type Sqlstate, sqlstates } from "#compiler/core/sqlstate.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { slotDecoders, slotEncoders } from "#compiler/live/codec.ts"
import type { CallError, CredentialReason, UnavailableCause } from "#compiler/live/events.ts"
import type { MemberWire, RoleWitness, WireOptions } from "#compiler/live/shape.ts"
import type { WireJson, WireScalar } from "#compiler/live/wire.ts"
import { paramDomainsOf } from "#compiler/physical/ddl/domains.ts"

import { assert } from "@bjornpagen/testing/assert"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"
import { states } from "#test/unit/live/call-error.dictionary.ts"

/** Where a refusal met the call: a features' pair of the search. */
export type Met =
	| "a serialization refusal of a read"
	| "a serialization refusal of a write"
	| "another refusal of a read"
	| "another refusal of a write"
	| "a pattern's refusal of a read"
	| "a pattern's refusal of a write"

/**
 * A statement's refusal: the server's report of a SQLSTATE the runtime branches on, or PostgreSQL's refusal of a
 * parameter's value by its pattern as it bound it, which the classifier reads off a 23514 on the parameter's own domain
 * (ParamRejected), at the parameter's place.
 */
export type StatementRefusal =
	| { readonly kind: "server"; readonly sqlstate: Sqlstate }
	| { readonly kind: "pattern"; readonly param: ParamPlace }

/**
 * A parameter's name, of one to three of `a` and `.`, which a parameter's name may hold: so a scalar parameter's name
 * is at times a relation parameter's and its field's joined by a dot, `a.a` beside the field `a` of `a`.
 */
export const paramName: Gen<string> = string(characterOf(["a", "."]), { min: 1, max: 3 })

/** A field's name of a relation parameter's facts, of one or two `a`. */
const fieldName: Gen<string> = string(characterOf(["a"]), { min: 1, max: 2 })

/** A refused parameter's place (core/identity.ts ParamPlace): a scalar parameter, or a relation parameter's field. */
const refusedPlace: Gen<ParamPlace> = (source) => {
	const name = source.draw(paramName)
	return source.draw(boolean)
		? { kind: "field", name, field: source.draw(fieldName) }
		: { kind: "scalar", name }
}

/** A statement's refusal: every SQLSTATE the runtime branches on, or a pattern's refusal at a drawn parameter. */
export const statementRefusal: Gen<StatementRefusal> = (source) =>
	source.draw(boolean)
		? { kind: "pattern", param: source.draw(refusedPlace) }
		: { kind: "server", sqlstate: source.draw(word(states)) }

/** The pattern a refused parameter's domain checks here, any text: the call error a refusal reads as holds none. */
const refusedPatterns = [{ source: "^.*$", flags: "su" }] as const

/**
 * A statement's refusal as a read and as a write meet it: the server's report as the shell classifies it, a transient
 * refusal where it rolled the transaction back for a concurrent one (serializationRefusal), else the read's failure or
 * the write's execution failure for it; a pattern's refusal as ParamRejected at its parameter.
 */
export const refusalMet = (
	refusal: StatementRefusal
): { readonly read: ReadError; readonly write: ApplyError } => {
	if (refusal.kind === "pattern") {
		const rejected = new ParamRejected({ param: refusal.param, patterns: refusedPatterns })
		return {
			read: new ReadFailure({ reason: rejected }),
			write: new ExecutionFailure({ reason: rejected })
		}
	}
	const report = new ServerError({
		sqlstate: refusal.sqlstate,
		message: `refused with ${refusal.sqlstate}`,
		constraint: undefined,
		schema: undefined,
		table: undefined,
		column: undefined,
		dataType: undefined,
		detail: undefined,
		hint: undefined
	})
	const transient = serializationRefusal(report)
	return {
		read: transient ?? new ReadFailure({ reason: report }),
		write: transient ?? new ExecutionFailure({ reason: report })
	}
}

/** The SQLSTATEs with which PostgreSQL rolls a transaction back for a concurrent transaction's work. */
export const rolledBack: ReadonlySet<string> = new Set([
	sqlstates.serializationFailure,
	sqlstates.deadlockDetected
])

/** The pattern the parameters joinedRead declares are of. */
const Tag = str.regex("^[a-z]{1,8}$", "u")
/** The heading of joinedRead's relation parameter: one field, `code`, of Tag. */
const Tagged = relation("Tagged", { code: Tag }, ["code"])
/** The relation joinedRead matches. */
const Note = relation("Note", { id: Id }, ["id"])
const Notes = schema("Notes", [Note, Tagged], [])

/**
 * A read declaring the relation parameter `name`, of Tagged's heading, and the scalar parameter of Tag named as that
 * parameter's field `code` joined to its name by a dot, `<name>.code`: two places a text joining names spells alike.
 */
const joinedRead = (name: string) =>
	query(Notes).rule((r) => {
		const { id } = v(Note, "note")
		const { code } = v(Tagged, "tagged")
		return r
			.match(Note, { id })
			.match(r.relation(name, Tagged), { code })
			.find({ id, code, tag: r.param(`${name}.code`, Tag) })
	})

/** Whether the relation parameter joinedRead declares is named with a dot: a feature of its search. */
export type DeclaredFeature =
	| "a relation parameter's name holding a dot"
	| "a relation parameter's name holding none"

/** The places joinedRead(name)'s pattern domains name, as a served file's refusals hold them (paramDomainsOf). */
export const joinedPlaces = (name: string): ReadonlyArray<ParamPlace> =>
	Arr.map(
		[
			...paramDomainsOf(
				succeeded(compileTemplate(joinedRead(name), undefined, testCompile)).params
			).values()
		],
		(domain) => domain.param
	)

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
	| "closed before ready"
	| "pg ended the startup"
	| "no cancellation key"
	| "no TLS offered"
	| "TLS answered neither"

/** What each other end reads as, by README "Errors and outcomes". */
const endedOracle: { readonly [E in Ended]: Expected } = {
	"the password Effect failed": credential("passwordFailed"),
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
	| { readonly kind: "driver refused" }

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
	[1, (source) => ({ kind: "statement refused", sqlstate: source.draw(sqlstateGen) })],
	[1, () => ({ kind: "driver refused" })]
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
		case "driver refused":
			return paths
	}
}

/** A case of `failures`: a failure and a path it meets a call on (pathsOf). */
const metOf =
	(failures: Gen<Failure>): Gen<Drawn> =>
	(source) => {
		const failure = source.draw(failures)
		const path = source.draw(element(pathsOf(failure)))
		return { failure, path }
	}

/** The socket's failure with one of `codes`. */
const socketOf =
	(codes: Arr.NonEmptyReadonlyArray<string>): Gen<Failure> =>
	(source) => ({ kind: "socket", code: source.draw(element(codes)) })

/**
 * The drawn cases (failureGen), aimed at the reasons only a few socket codes read as: `connectionRefused`, ECONNREFUSED
 * or ENOENT, and `timedOut`, ETIMEDOUT alone, the operating system's verdict, since no connect timeout of grizzle's
 * raises one.
 */
export const metGen = aimed<Drawn, ConnectFeature>(metOf(failureGen), [
	["connectionRefused", metOf(socketOf(["ECONNREFUSED", "ENOENT"]))],
	["timedOut", metOf(socketOf(["ETIMEDOUT"]))]
])

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
const causeOf = (
	failure: Failure
): AcquireRefusal | ConnectionLost | ServerError | DriverFailure => {
	switch (failure.kind) {
		case "released":
			return new LayerReleased()
		case "driver refused":
			return new DriverFailure({ operation: "query" })
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
export const expectedOf = (failure: Failure): Expected => {
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
		case "driver refused":
			return { kind: "failed" }
	}
}

/** The call error a failure ends a call with on `path`, and the message of the failure it carries. */
export const calledWith = (
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
export const statedOf = (error: CallError): Expected | string =>
	error.kind === "credentialRefused"
		? { kind: error.kind, reason: error.reason }
		: error.kind === "unavailable"
			? { kind: error.kind, reason: error.reason }
			: error.kind === "failed"
				? { kind: error.kind }
				: error.kind

/** A write's wire, of a ChangeSet writing nothing: an error's encode reads nothing of a member's beside its role's witness. */
const errorWire: MemberWire = {
	shape: "write",
	input: { kind: "call", params: [], facts: [] },
	outcome: { kind: "change", relations: [], reads: [[]] }
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

/** A call error as a client decodes it off the wire the server encodes it on (live/codec.ts slotEncoders, slotDecoders). */
export const decodedOff = (error: CallError): CallError =>
	slotDecoders(errorWire, noWitness, errorOptions).error(
		trustedJson<WireJson>(jsonText(slotEncoders(errorWire, noWitness, errorOptions).error(error)))
	)

/** The features of a case: the reason its error reads as, `failed`, a driver's refusal, and its path. */
export type ConnectFeature =
	| CredentialReason
	| UnavailableCause
	| "otherSqlstate"
	| "otherSocketCode"
	| "failed"
	| "a driver's refusal"
	| Path

/** The reason an expected error names, as a feature. */
export const reachedOf = (expected: Expected): ConnectFeature =>
	expected.kind === "failed"
		? "failed"
		: expected.kind === "credentialRefused"
			? expected.reason
			: expected.reason.kind
