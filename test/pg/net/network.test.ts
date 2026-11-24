/**
 * pg.inet and pg.cidr on PostgreSQL 19, and an inet context's address filtering a cidr relation by Net.within.
 *
 * 1. Values. Over a batch of drawn texts, IPv4 and IPv6, masked and not, PostgreSQL's spellings beside its values' own
 *    (a cidr's class-based shorthand and hexadecimal form, an inet's trailing dot, an embedded IPv4 tail, leading
 *    zeros, a mask wrapping a C int) and texts that are none: grizzle's parse of each as an inet and as a cidr
 *    (Inet.parse, Cidr.parse) is PostgreSQL's own, the same value or the same refusal, a cidr's bit right of its mask
 *    refused as such, and its value the one text inet_out and cidr_out print. Every text PostgreSQL reads is inserted
 *    through grizzle as the value it spells, each inet value once as a Host's key and each cidr as a Network's, and
 *    reads back as PostgreSQL's own output text of it, the value's one form.
 * 2. Contexts. Over drawn networks and an address, a token's claim of it (Where, the nested `net` object) or the
 *    server's attestation (Origin), a Db reads the networks within which its context's address lies, Net.within in a
 *    filter, which are PostgreSQL's own `address <<= network` over the stored networks; a token that claims Origin's
 *    fact, by its name or at its top level, reads none of Origin's, which only the server attests. The installation
 *    holds a GiST index on the network column, the containment probe's request. Over HTTP, through the client and an
 *    edge in front of the login's handler, the handler's attest reads the edge's own header alone, and the read
 *    answers the networks it answers in process.
 *
 * Oracle: PostgreSQL 19's inet_in, cidr_in, inet_out and cidr_out over the drawn texts, and its `<<=` over the stored
 * values.
 */

import { openApiText } from "@bjornpagen/grizzle-openapi/openapi"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, Redacted, String as Str } from "effect"
import { HttpClient } from "effect/http"
import { Db } from "#adapter/public/db.ts"
import { clientCalls } from "#client/client.ts"
import { handlerClient } from "#client/handler.ts"
import { admitCidr, admitInet, type Cidr, type Inet } from "#compiler/scalar/values/net.ts"
import { httpHandler } from "#http/index.ts"
import {
	campusAt,
	campusTemplate,
	type ContextsFeature,
	contextsCases,
	Network,
	spellings,
	type ValuesFeature
} from "#test/pg/net/network.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { rowsOf } from "#test/support/calls.ts"
import { jsonOf } from "#test/support/chunked.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { servedGenerated } from "#test/support/served-db.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { tokenOf } from "#test/support/worlds.ts"

/** PostgreSQL's verdict on a text: the value it reads it as, by its one form, or its refusal. */
type Verdict =
	| { readonly kind: "value"; readonly text: string }
	| { readonly kind: "refused"; readonly hostBits: boolean }

/** A text cell of a row, or none for NULL. */
const cell = (row: ReadonlyArray<unknown>, i: number): string | undefined => {
	const v = row[i]
	return typeof v === "string" ? v : undefined
}

/**
 * PostgreSQL's verdicts on a batch of texts as inets and as cidrs, in order: inet_in's value printed by inet_out (abbrev
 * of an inet is inet_out's text, where its ::text states every mask), cidr_in's printed by cidr_out (its ::text), and
 * whether cidr_in's refusal is of a bit right of the mask.
 */
const verdictsSql = `SELECT
	CASE WHEN pg_catalog.pg_input_is_valid(t, 'inet') THEN pg_catalog.abbrev(t::inet) END,
	CASE WHEN pg_catalog.pg_input_is_valid(t, 'cidr') THEN (t::cidr)::text END,
	((pg_catalog.pg_input_error_info(t, 'cidr')).message LIKE 'invalid cidr value%')::text
FROM pg_catalog.unnest($1::text[]) WITH ORDINALITY AS r(t, ord) ORDER BY ord`

/** A text array literal of `texts`, each quoted, for one parameter. */
const textArray = (texts: ReadonlyArray<string>): string =>
	`{${Arr.join(
		Arr.map(texts, (t) => `"${Str.replaceAll('"', '\\"')(Str.replaceAll("\\", "\\\\")(t))}"`),
		","
	)}}`

/** grizzle's verdict on a text by `admit` (Inet.parse, Cidr.parse), as PostgreSQL's is stated. */
const grizzleVerdict = (admit: typeof admitInet | typeof admitCidr, text: string): Verdict => {
	const read = admit(text)
	return read.ok
		? { kind: "value", text: read.value }
		: { kind: "refused", hostBits: read.error === "cidrHostBits" }
}

/** The rows of a read, in order of their ids. */
const byId = <R extends { readonly id: number }>(rows: ReadonlyArray<R>): ReadonlyArray<R> =>
	Arr.sort(
		rows,
		Order.mapInput(Order.Number, (r: R) => r.id)
	)

/** pg.inet and pg.cidr on PostgreSQL 19, grizzle reads every text as PostgreSQL does and stores and reads back each value as its one text. */
export const pgInetAndPgCidrOnPostgreSQL19GrizzleReadsEveryTextAsPostgreSQLDoesAndStoresAndReadsBackEachValueAsItsOneText =
	property.explore(spellings, {
		needs: { campus: Substrate.fresh(campusTemplate) },
		situations: [
			"an IPv4 inet stored",
			"an IPv6 inet stored",
			"an IPv4 cidr stored",
			"an IPv6 cidr stored",
			"a spelling read to its one form",
			"refused as no inet",
			"a cidr's host bits refused",
			"refused as no cidr"
		] satisfies ReadonlyArray<Reached<ValuesFeature>>,
		check:
			({ campus }, k: Case<ValuesFeature>) =>
			(texts) =>
				Effect.scoped(
					Effect.flatMap(campus, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const generated = taken.value
								const m = generated.installed
								const s = yield* Substrate
								const owner = yield* s.session({ ...ownerSession(), label: "campus owner" })
								const rows = yield* owner.values(verdictsSql, [textArray(texts)])
								const inets: Array<{
									readonly id: number
									readonly held: Inet
									readonly value: string
								}> = []
								const cidrs: Array<{
									readonly id: number
									readonly held: Cidr
									readonly value: string
								}> = []
								for (const [at, text] of texts.entries()) {
									const row = rows[at] ?? []
									const inet = cell(row, 0)
									const cidr = cell(row, 1)
									const pgInet: Verdict =
										inet === undefined
											? { kind: "refused", hostBits: false }
											: { kind: "value", text: inet }
									const pgCidr: Verdict =
										cidr === undefined
											? { kind: "refused", hostBits: cell(row, 2) === "true" }
											: { kind: "value", text: cidr }
									assert.deepEqual(
										grizzleVerdict(admitInet, text),
										pgInet,
										`${Formatter.format(text)} as an inet`
									)
									assert.deepEqual(
										grizzleVerdict(admitCidr, text),
										pgCidr,
										`${Formatter.format(text)} as a cidr`
									)
									if (pgInet.kind === "value") {
										if (Arr.every(inets, (i) => i.value !== pgInet.text)) {
											inets.push({
												id: at,
												held: succeeded(admitInet(text), "an inet PostgreSQL reads"),
												value: pgInet.text
											})
										}
										k.note(
											Str.includes(":")(pgInet.text) ? "an IPv6 inet stored" : "an IPv4 inet stored"
										)
										if (pgInet.text !== text) {
											k.note("a spelling read to its one form")
										}
									} else {
										k.note("refused as no inet")
									}
									if (pgCidr.kind === "value") {
										cidrs.push({
											id: at,
											held: succeeded(admitCidr(text), "a cidr PostgreSQL reads"),
											value: pgCidr.text
										})
										k.note(
											Str.includes(":")(pgCidr.text) ? "an IPv6 cidr stored" : "an IPv4 cidr stored"
										)
									} else {
										k.note(pgCidr.hostBits ? "a cidr's host bits refused" : "refused as no cidr")
									}
								}
								const served = servedGenerated(generated, campusAt(m.declared).web)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(served.login.roles.campus, {
										token: tokenOf({}),
										attested: {}
									})
									yield* db.workload.putHosts.once({
										params: {},
										facts: {
											insert: { Host: Arr.map(inets, ({ id, held }) => ({ id, address: held })) }
										}
									})
									yield* db.workload.putNetworks.once({
										params: {},
										facts: {
											insert: { Network: Arr.map(cidrs, ({ id, held }) => ({ id, network: held })) }
										}
									})
									const hostRows = yield* rowsOf(db.workload.hosts.once({ params: {}, facts: {} }))
									const networkRows = yield* rowsOf(
										db.workload.networks.once({ params: {}, facts: {} })
									)
									const hosts = byId(hostRows)
									const networks = byId(networkRows)
									assert.deepEqual<ReadonlyArray<readonly [number, string]>>(
										Arr.map(hosts, (h) => [h.id, h.address] as const),
										Arr.map(inets, (i) => [i.id, i.value] as const),
										"every inet reads back as inet_out's text of what PostgreSQL read"
									)
									assert.deepEqual<ReadonlyArray<readonly [number, string]>>(
										Arr.map(networks, (n) => [n.id, n.network] as const),
										Arr.map(cidrs, (c) => [c.id, c.value] as const),
										"every cidr reads back as cidr_out's text of what PostgreSQL read"
									)
								}).pipe(Effect.scoped, withLayer(served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "PostgreSQL 19's inet_in, cidr_in, inet_out and cidr_out over each drawn text"
		},
		budget: { runs: 40, steered: 40 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/net.ts",
				original: '\tif (carrier === "cidr" && !addressOK(parsed.address, parsed.bits, family)) {',
				replacement: "\tif (false) {",
				why: "A cidr's bit right of its mask is admitted on the host, where PostgreSQL refuses it: Cidr.parse of 10.1.2.3/8 is a value."
			},
			{
				file: "packages/engine/src/scalar/values/net.ts",
				original: "\t\t\t\t(best.len === 5 && words[5] === 0xffff))",
				replacement: "\t\t\t\tfalse)",
				why: "An IPv4-mapped IPv6 address prints its words in hexadecimal, ::ffff:102:304, where inet_out prints ::ffff:1.2.3.4."
			},
			{
				file: "packages/engine/src/scalar/values/net.ts",
				original:
					"const decimalStep = (n: number, ch: number): number => (Math.imul(n, 10) + (ch - 0x30)) | 0",
				replacement: "const decimalStep = (n: number, ch: number): number => n * 10 + (ch - 0x30)",
				why: "A mask's digits read past a C int's range, so /4294967304 is refused on the host, where PostgreSQL's int wraps it to 8."
			}
		]
	})

/** The header the test's edge states a request's address in, which the handler's attest alone reads. */
const edgeHeader = "x-edge-address"

/** The origin the client's requests name, which no server answers: the edge hands each to the handler in process. */
const origin = "http://grizzle.invalid"

/** A row's id, as the client decodes a row the read answers over HTTP. */
const rowId = (row: object): number => {
	const id = "id" in row ? row.id : undefined
	return typeof id === "number" ? id : assert.fail("a row of an id")
}

/** The networks a context's address lies within, by PostgreSQL's own `<<=` over the stored rows. */
const withinSql = (names: ReturnType<typeof namesOf>) =>
	`SELECT ${names.column(Network, "id")} FROM ${names.table(Network)} WHERE $1::inet <<= ${names.column(Network, "network")} ORDER BY 1`

/** Whether the network column holds a GiST index, inet_ops being its default class. */
const gistSql = (names: ReturnType<typeof namesOf>) =>
	`SELECT count(*)::text FROM pg_catalog.pg_index AS i
	JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid
	JOIN pg_catalog.pg_am AS am ON am.oid = c.relam
	JOIN pg_catalog.pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
	WHERE i.indrelid = '${names.table(Network)}'::regclass AND am.amname = 'gist' AND i.indnatts = 1
		AND a.attname = '${names.columnIdent(Network, "network")}'`

/** Network containment of a context's address, its Db reads the networks PostgreSQL's `<<=` holds of the address its token claims or its server attests, and a token reaches no attested context. */
export const netContainmentOfAContextsAddressItsDbReadsTheNetworksPostgreSQLsHoldsOfTheAddressItsTokenClaimsOrItsServerAttestsAndATokenReachesNoAttestedContext =
	property.explore(contextsCases, {
		needs: { campus: Substrate.fresh(campusTemplate) },
		situations: [
			"a token's address within a network",
			"an attested address within a network",
			"within no network",
			"within several networks",
			"a network of the other family",
			"a token's claim of Origin reads no attested fact",
			"the network column's GiST index"
		] satisfies ReadonlyArray<Reached<ContextsFeature>>,
		check:
			({ campus }, k: Case<ContextsFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(campus, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const generated = taken.value
								const m = generated.installed
								const s = yield* Substrate
								const owner = yield* s.session({ ...ownerSession(), label: "campus owner" })
								const names = namesOf(m)
								const gist = yield* owner.values(gistSql(names), [])
								assert.equal(
									cell(gist[0] ?? [], 0),
									"1",
									"one GiST index on the network column alone"
								)
								k.note("the network column's GiST index")
								const served = servedGenerated(generated, campusAt(m.declared).web)
								return yield* Effect.gen(function* () {
									const setup = yield* Db.open(served.login.roles.campus, {
										token: tokenOf({}),
										attested: {}
									})
									yield* setup.workload.putNetworks.once({
										params: {},
										facts: {
											insert: {
												Network: Arr.map(c.networks, (network, id) => ({
													id,
													network: succeeded(admitCidr(network), "a drawn network is a cidr")
												}))
											}
										}
									})
									const withinRows = yield* owner.values(withinSql(names), [c.address])
									const expected = Arr.map(withinRows, (row) => Number(row[0]))
									if (
										Arr.some(
											c.networks,
											(n) => Str.includes(":")(n) !== Str.includes(":")(c.address)
										)
									) {
										k.note("a network of the other family")
									}
									const address = succeeded(admitInet(c.address), "the drawn address is an inet")
									const token =
										c.source === "token"
											? tokenOf({ net: { address: c.address } })
											: c.source === "attested"
												? tokenOf({})
												: tokenOf({ Origin: { address: c.address }, address: c.address })
									const db = yield* Db.open(served.login.roles.campus, {
										token,
										attested: c.source === "attested" ? { Origin: { address } } : {}
									})
									const whereRows = yield* rowsOf(
										db.workload.whereIn.once({ params: {}, facts: {} })
									)
									const originRows = yield* rowsOf(
										db.workload.originIn.once({ params: {}, facts: {} })
									)
									const whereIds = Arr.map(byId(whereRows), (r) => r.id)
									const originIds = Arr.map(byId(originRows), (r) => r.id)
									switch (c.source) {
										case "token":
											assert.deepEqual(
												whereIds,
												expected,
												"the token's address's networks, PostgreSQL's <<="
											)
											assert.deepEqual(originIds, [], "no attested address, no network")
											k.note(
												expected.length > 0
													? "a token's address within a network"
													: "within no network"
											)
											break
										case "attested":
											assert.deepEqual(
												originIds,
												expected,
												"the attested address's networks, PostgreSQL's <<="
											)
											assert.deepEqual(whereIds, [], "no claimed address, no network")
											k.note(
												expected.length > 0
													? "an attested address within a network"
													: "within no network"
											)
											break
										case "token naming Origin":
											assert.deepEqual(originIds, [], "a token's claims reach no attested context")
											assert.deepEqual(whereIds, [], "and no `net` claim, no Where")
											k.note("a token's claim of Origin reads no attested fact")
											break
									}
									if (expected.length > 1) {
										k.note("within several networks")
									}
									/**
									 * Over HTTP: the handler's attest reads the edge's header alone, the one channel of an attested
									 * fact, and the token, the body and every other header reach none.
									 */
									const handler = yield* httpHandler({
										logins: [served.login],
										heartbeatMs: 60_000,
										attest: (request) => {
											const header = request.headers.get(edgeHeader)
											const read = header === null ? undefined : admitInet(header)
											return read?.ok === true ? { Origin: { address: read.value } } : {}
										}
									})
									/**
									 * The edge in front of the handler: it states an attested address in its own header, and every
									 * request also carries the address where a client may write it, which the attest never reads.
									 */
									const edge = handlerClient((request) => {
										const headers = new Headers(request.headers)
										if (c.source === "attested") {
											headers.set(edgeHeader, c.address)
										}
										headers.set("x-forwarded-for", c.address)
										return handler(new Request(request, { headers }))
									})
									const document = succeeded(
										openApiText(served.login.file),
										"the login's OpenAPI document"
									)
									const roles = succeeded(
										clientCalls(jsonOf(document), "web", {
											url: new URL(origin),
											token: Redacted.make(token)
										}),
										"the login's client calls"
									)
									const program = defined(
										roles["campus"]?.["originIn"],
										"campus's originIn over HTTP"
									)
									if (program.shape !== "list") {
										return assert.fail(`originIn is a live read, not a ${program.shape}`)
									}
									const value = yield* Effect.provideService(
										program.calls.once({ params: {}, facts: {} }),
										HttpClient.HttpClient,
										edge
									)
									const overHttp = Arr.sort(
										Arr.map([...value], (row) => rowId(row)),
										Order.Number
									)
									assert.deepEqual(overHttp, originIds, "over HTTP, as in process")
								}).pipe(Effect.scoped, withLayer(served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's own `address <<= network` over the stored networks, and the context's one source"
		},
		budget: { runs: 40, steered: 40 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/db/claims.ts",
				original:
					'\t\tcontext.source.kind === "token" ? [{ context, claim: context.source.claim }] : []',
				replacement: "\t\t[{ context, claim: undefined }]",
				why: "Every context, Origin among them, is read from the token's top level, so a token stating Origin's fact reads networks a client chose."
			},
			{
				file: "packages/engine/src/physical/access/extract.ts",
				original: "\t\t\t\tthis.netContainment(n.input, n.pred)\n",
				replacement: "",
				why: "No containment probe requests the network column's GiST index, so the installation holds none."
			},
			{
				file: "packages/engine/src/ir/desc.ts",
				original: '\t\t\t\tdesc.type === "inet" ||\n',
				replacement: "",
				why: "A context admits no inet field, so the role's Where and Origin are refused when the schema is built."
			}
		]
	})
