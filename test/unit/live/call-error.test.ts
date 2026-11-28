/**
 * readCallError and applyCallError (packages/grizzle/src/adapter/live/call-error.ts): a statement's refusal, on a read
 * or a write, read as the call error a live answer ends with, through the shell's own classification of the server's
 * report (serializationRefusal). Every SQLSTATE the runtime branches on is drawn, and PostgreSQL's refusal of a
 * parameter's value by its pattern (ParamRejected) at every place of a bounded box: a scalar parameter or a relation
 * parameter's field, its names holding `a` and `.`, so two places a text joining names spells alike are both in it
 * (the scalar `a.a` and the field `a` of `a`), each on a read and on a write.
 *
 * - The error is retry `safe` exactly where PostgreSQL rolled the whole transaction back for a concurrent
 *   transaction's work, 40001 or 40P01, so nothing committed and the same call may succeed; every other refusal of a
 *   statement is the statement's own, and retry `never`; its message carries the failure's own. Oracle: PostgreSQL's
 *   documentation of serialization_failure and deadlock_detected.
 * - A pattern's refusal is `paramRejected`, its `param` the refused place as data (docs/errors-and-concurrency.md "Errors and outcomes"), and
 *   the wire carries every error unchanged (decode after encode, live/codec.ts slotEncoders and slotDecoders).
 *
 * Features: a serialization refusal, another refusal and a pattern's refusal, each on a read and on a write.
 *
 * A pattern's refusal at each place a declaration's pattern domains name (physical/ddl/domains.ts paramDomainsOf, what
 * a served file's refusals hold), over a read declaring a relation parameter of every name of one to three of `a` and
 * `.` and the scalar parameter named as its field `code` joined to its name by a dot, `<name>.code`:
 *
 * - Exact: the places its refusals read as, on a read and on a write and off the wire, are exactly the two declared,
 *   the scalar parameter by its name and the relation parameter's field by both names, though one text spells both.
 *   Oracle: the declaration.
 *
 * Features: a relation parameter's name holding a dot, and one holding none.
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
 * A session never had (call-error.ts connectCallError), over drawn driver failures: the server's refusal of a startup
 * by a SQLSTATE (each condition errcodes.txt lists for the classes a connection meets, 08, 28, 53 and 57, every class's
 * own code, a drawn code within any of its 43 classes, and any five characters a SQLSTATE may be), the socket's failure
 * by a code (each errno name of this platform, os.constants.errno, the resolver's, Node's own and any drawn one), a TLS
 * handshake's failure by a code (a certificate's, a negotiation's or a system error's), and every other way an attempt
 * ends, each met by a read, a write, a live source's open and a live leader's candidacy; a released layer's lease, met
 * by a read and a write; a live source's open session lost by the transport, ended by the server with a drawn
 * SQLSTATE, or refused a statement with one, met by the source and by its leader; and pg's refusal of a query on a
 * connection still standing (DriverFailure, wire/session.ts unexplained and batch.ts broken), met on every path:
 *
 * - Total and exact: the call error is the oracle table's, its kind and its reason, the table written from
 *   PostgreSQL 19's errcodes.txt (class 28, Invalid Authorization Specification, is the login's refusal and 28P01,
 *   invalid_password, the password's; 53300 too_many_connections; 57P01 admin_shutdown, 57P02 crash_shutdown and 57P03
 *   cannot_connect_now; any other SQLSTATE its own code), a session ended by the server or a statement refused by its
 *   SQLSTATE alike, and from docs/errors-and-concurrency.md "Errors and outcomes" for the socket's codes, a session the transport lost
 *   (`sessionLost`) and every other end; its retry is `never` unless it is `unavailable`; its message carries the
 *   failure's own; and
 *   the wire carries it unchanged (decode after encode, live/codec.ts slotEncoders and slotDecoders).
 *
 * Oracle: errcodes.txt's conditions and classes, and the README's reasons, as the table below.
 *
 * Features: every reason, `failed`, and every path.
 */
import { assert, assertVariant, unorderedEqual } from "@bjornpagen/testing/assert"
import { word } from "@bjornpagen/testing/dictionary"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, String as Str } from "effect"
import { applyCallError, readCallError, readings } from "#adapter/live/call-error.ts"
import type { ParamPlace } from "#compiler/core/identity.ts"
import { type FailureSource, failures } from "#compiler/live/events.ts"
import { sources } from "#test/unit/live/call-error.dictionary.ts"
import {
	calledWith,
	type ConnectFeature,
	type DeclaredFeature,
	decodedOff,
	expectedOf,
	joinedPlaces,
	type Met,
	metGen,
	paramName,
	reachedOf,
	refusalMet,
	rolledBack,
	statedOf,
	statementRefusal
} from "#test/unit/live/call-error.fixtures.ts"

/**
 * A statement's refusal read by readCallError and applyCallError is retry safe exactly where PostgreSQL rolled back for
 * a concurrent transaction, a pattern's refusal names its place, and the wire carries it.
 */
export const aStatementsRefusalIsRetrySafeExactlyWherePostgreSQLRolledBackAPatternsNamesItsPlaceAndTheWireCarriesIt =
	property.exhaust(
		finite((source) => ({
			refusal: source.draw(statementRefusal),
			program: source.draw(element(["read", "write"] as const))
		})),
		{
			needs: {},
			situations: [
				"a serialization refusal of a read",
				"a serialization refusal of a write",
				"another refusal of a read",
				"another refusal of a write",
				"a pattern's refusal of a read",
				"a pattern's refusal of a write"
			] satisfies ReadonlyArray<Reached<Met>>,
			check:
				(_, c: Case<Met>) =>
				({ refusal, program }) =>
					Effect.sync(() => {
						const { read, write } = refusalMet(refusal)
						const refused = program === "read" ? read : write
						const error = program === "read" ? readCallError(read) : applyCallError(write)
						const safe = refusal.kind === "server" && rolledBack.has(refusal.sqlstate)
						assert.equal(error.retry, safe ? "safe" : "never")
						assert.ok(Str.includes(refused.message)(error.message), "the failure's own message")
						assert.deepEqual(decodedOff(error), error, "the wire carries the error unchanged")
						if (refusal.kind === "pattern") {
							assertVariant(error, "_tag", "paramRejected", "a pattern's refusal of a parameter")
							assert.deepEqual(error.param, refusal.param, "the refused place, as data")
							c.note(
								program === "read"
									? "a pattern's refusal of a read"
									: "a pattern's refusal of a write"
							)
							return
						}
						c.note(
							safe
								? program === "read"
									? "a serialization refusal of a read"
									: "a serialization refusal of a write"
								: program === "read"
									? "another refusal of a read"
									: "another refusal of a write"
						)
					}),
			oracle: {
				kind: "specification",
				name: "PostgreSQL's serialization_failure and deadlock_detected roll the transaction back; a pattern's refusal names its place"
			},
			box: "every SQLSTATE the runtime branches on, and a pattern's refusal at every scalar parameter named by one to three of a and ., and every field of one or two a of a relation parameter so named, on a read and on a write",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/live/events.ts",
					original:
						'\ttransient: { retry: "safe", payload: { message: "text", reason: "transientReason" } },',
					replacement:
						'\ttransient: { retry: "never", payload: { message: "text", reason: "transientReason" } },',
					why: "The classification table makes a transient failure retry never; the statement refusal's property fails."
				},
				{
					file: "packages/grizzle/src/adapter/live/call-error.ts",
					original: "\t\t\t\t\tparam: reason.param\n",
					replacement:
						'\t\t\t\t\tparam: { kind: "scalar", name: reason.param.kind === "scalar" ? reason.param.name : reason.param.name + "." + reason.param.field }\n',
					why: "A read's pattern refusal names its place by the text joining its names, so a field reads as the scalar parameter of that text; the refused place's assertion fails."
				},
				{
					file: "packages/grizzle/src/adapter/live/call-error.ts",
					original: "{ message: error.message, param: reason.param }",
					replacement:
						'{ message: error.message, param: { kind: "scalar", name: reason.param.name } }',
					why: "A write's pattern refusal names a field by its parameter alone; the refused place's assertion fails."
				},
				{
					file: "packages/engine/src/live/codec.ts",
					original: "\t\t\treturn { kind, name, field }",
					replacement: '\t\t\treturn { kind: "scalar", name: name + "." + field }',
					why: "The server writes a field's place as the scalar parameter of the text joining its names; the wire's round trip fails."
				},
				{
					file: "packages/engine/src/live/codec.ts",
					original:
						'\t\t? { kind: "field", name, field: trustedString(trustedMember(record, "field")) }',
					replacement: '\t\t? { kind: "scalar", name }',
					why: "The client reads a field's place as its parameter alone; the wire's round trip fails."
				}
			]
		}
	)

/**
 * A pattern's refusal at each place a declaration's pattern domains name reads as exactly that place, though a scalar
 * parameter's name is a relation parameter's and its field's joined by a dot.
 */
export const aPatternsRefusalAtEachDeclaredPlaceReadsAsThatPlaceThoughOneTextSpellsTwo =
	property.exhaust(finite(paramName), {
		needs: {},
		situations: [
			"a relation parameter's name holding a dot",
			"a relation parameter's name holding none"
		] satisfies ReadonlyArray<Reached<DeclaredFeature>>,
		check: (_, c: Case<DeclaredFeature>) => (name) =>
			Effect.sync(() => {
				const declared: ReadonlyArray<ParamPlace> = [
					{ kind: "scalar", name: `${name}.code` },
					{ kind: "field", name, field: "code" }
				]
				for (const program of ["read", "write"] as const) {
					const read = Arr.map(joinedPlaces(name), (param) => {
						const { read: onRead, write: onWrite } = refusalMet({ kind: "pattern", param })
						const error = decodedOff(
							program === "read" ? readCallError(onRead) : applyCallError(onWrite)
						)
						assertVariant(error, "_tag", "paramRejected", "a pattern's refusal of a parameter")
						return error.param
					})
					unorderedEqual(read, declared, `the places a refusal of a ${program} reads as`)
				}
				c.note(
					Str.includes(".")(name)
						? "a relation parameter's name holding a dot"
						: "a relation parameter's name holding none"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the declaration: the scalar parameter by its name, the relation parameter's field by both names"
		},
		box: "a relation parameter of every name of one to three of a and ., and the scalar parameter <name>.code",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/domains.ts",
				original: "\t\t\t{ param: place, patterns: regex.patterns }",
				replacement:
					'\t\t\t{ param: { kind: "scalar", name: paramPlaceText(place) }, patterns: regex.patterns }',
				why: "A served file's refusals name each domain's place by the text joining its names, so the field reads as the scalar parameter of that text; the declared places' assertion fails."
			}
		]
	})

/** Every source's reading reads its failures as exactly the kinds the event model gives its source. */
export const everySourcesReadingReadsItsFailuresAsExactlyTheKindsTheEventModelGivesItsSource =
	property.exhaust(finite(word(sources)), {
		needs: {},
		situations: sources satisfies ReadonlyArray<Reached<FailureSource>>,
		check: (_, c: Case<FailureSource>) => (source) =>
			Effect.sync(() => {
				const reading: ReadonlyArray<string> = readings[source]
				const read = Arr.sort(Arr.dedupe(reading), Order.String)
				const given = Arr.sort(Arr.dedupe(failures[source]), Order.String)
				assert.deepEqual(read, given, `the reading of ${source}`)
				c.note(source)
			}),
		oracle: {
			kind: "specification",
			name: "the classification's own tables (call-error.ts readings) beside the event model's failures"
		},
		box: "every source a call's failure is met at",
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/live/call-error.ts",
				original: '\tConnectionLost: "transport",\n\tCommitLost: "transport",',
				replacement: '\tConnectionLost: "unavailable",\n\tCommitLost: "unavailable",',
				why: "The read's table reads a broken connection as unavailable, so no read failure reads as transport; the exact property fails."
			},
			{
				file: "packages/engine/src/live/events.ts",
				original: '\t\t"stale",\n\t\t"failed"',
				replacement: '\t\t"stale",\n\t\t"failed",\n\t\t"outsideWorld"',
				why: "The event model gives a read outsideWorld, which no read failure reads as; the exact property fails."
			},
			{
				file: "packages/grizzle/src/adapter/live/call-error.ts",
				original: '\tCommitLost: "transport",',
				replacement: '\tCommitLost: "commitUnknown",',
				why: "The read's table reads a lost COMMIT as commitUnknown, which the event model gives no read; the exact property fails."
			}
		]
	})

/**
 * A session never had reads as the oracle table's kind and reason, by its SQLSTATE or its code, alike on every path,
 * and the wire carries it.
 *
 * Budget: its suite's count before the conversion (unit/live/call-error-connect: 400 independent cases and 16 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const aSessionNeverHadReadsAsTheOracleTablesKindAndReasonByItsSQLSTATEOrItsCodeAlikeOnEveryPathAndTheWireCarriesIt =
	property.explore(metGen, {
		needs: {},
		situations: [
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
			"a driver's refusal",
			"a read",
			"a write",
			"a live source",
			"a live leader"
		] satisfies ReadonlyArray<Reached<ConnectFeature>>,
		check:
			(_, notes: Case<ConnectFeature>) =>
			({ failure, path }) =>
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
					assert.deepEqual(decodedOff(error), error, "the wire carries the error unchanged")
					notes.note(reachedOf(expected))
					notes.note(path)
					if (failure.kind === "driver refused") {
						notes.note("a driver's refusal")
					}
				}),
		oracle: {
			kind: "specification",
			name: 'PostgreSQL 19\'s errcodes.txt and docs/errors-and-concurrency.md "Errors and outcomes", as a table of kinds and reasons'
		},
		budget: { runs: 400, steered: 16 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/live/call-error.ts",
				original: '): CallErrorIn<"credentialRefused" | "unavailable"> => {',
				replacement:
					'): CallErrorIn<"credentialRefused" | "unavailable"> => {\n\tif (sqlstate === sqlstates.invalidPassword) {\n\t\treturn unavailable("connectionRefused", message)\n\t}',
				why: "28P01 reads as `unavailable`, `connectionRefused`; the session-never-had property fails."
			},
			{
				file: "packages/grizzle/src/adapter/live/call-error.ts",
				original: '\tCommitLost: "transport",\n\tDriverFailure: "failed",',
				replacement: '\tCommitLost: "transport",\n\tDriverFailure: "transport",',
				why: "A read's DriverFailure reads as `transport`; the session-never-had property fails."
			}
		]
	})
