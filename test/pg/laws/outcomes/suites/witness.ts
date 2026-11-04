import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	characterOf,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	string
} from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { bigint, uuid } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter, Layer, Option, pipe, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { ChangeSet, type Witness } from "#compiler/public/changeset.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	Club,
	Clubs,
	captainCount,
	clubs,
	codeLaw,
	Member,
	memberCount,
	memberKey,
	positiveSeats,
	Seats,
	seatsLaw
} from "#test/pg/laws/outcomes/schemas.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { strictDetail } from "#test/support/detail.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { type PgErrorFields, pgErrorFields } from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
import { Uuid } from "#compiler/public/fields.ts"
const member = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe((0x6000 + n).toString(16), Str.padStart(12, "0"))}`

/** One lawful club with two members, the first its captain. */
const clubFacts = {
	Club: [{ region: "North", number: 1n, code: "alpha", seats: 10 }],
	Member: [
		{
			id: member(1),
			region: "North",
			number: 1n,
			code: "alpha",
			email: "ann@example.org",
			captain: true
		},
		{
			id: member(2),
			region: "North",
			number: 1n,
			code: "alpha",
			email: "ben@example.org",
			captain: false
		}
	]
} as const

const extensions = { label: "real", extensions: [] } as const

/** Runs `body` with the services `layer` builds, which are released when `body` ends. */
const withLayer = <A, E, R, ROut, E2>(
	body: Effect.Effect<A, E, R>,
	provided: Layer.Layer<ROut, E2>
): Effect.Effect<A, E | E2, Exclude<R, ROut>> =>
	Effect.scoped(
		Effect.flatMap(Layer.build(provided), (services) => Effect.provideContext(body, services))
	)

/** PostgreSQL's fields of a failure a server raised; any other failure is a defect of the test. */
const serverFields = (error: unknown): PgErrorFields =>
	defined(pgErrorFields(error), "a server error")

/** A statement that must fail, then the rollback of its aborted transaction. */
const failingStatement = (session: RawSession, sql: string, params: ReadonlyArray<unknown>) =>
	Effect.gen(function* () {
		const error = yield* Effect.flip(session.query(sql, params))
		yield* session.rollback
		return serverFields(error)
	})

/** A transaction whose COMMIT must fail. */
const failingCommit = (
	session: RawSession,
	statements: ReadonlyArray<readonly [string, ReadonlyArray<unknown>]>
) =>
	Effect.gen(function* () {
		for (const [sql, params] of statements) {
			yield* session.query(sql, params)
		}
		return serverFields(yield* Effect.flip(session.commit))
	})

/** The outcome db.apply reports for a change of an empty ChangeSet's reads. */
type Applied = ApplyOutcome<Readonly<Record<string, never>>>

/** The refusal by `law`, as the installation describes it, with `witness`. */
const refusedBy = (at: Installed, law: LawId, witness: Witness): Applied => ({
	kind: "invariant-rejected",
	law: namesOf(at).described(law),
	witness
})

const codeCharacters = [
	'"',
	"\\",
	",",
	"[",
	"]",
	"'",
	"\n",
	"\t",
	"é",
	"\u{1F600}",
	" ",
	"a",
	"Z",
	"0"
] as const

const int8Min = -(2n ** 63n)
const int8Max = 2n ** 63n - 1n
const int4Max = 2 ** 31 - 1
const int4Min = -(2 ** 31)

const codeGen = (min: number, max: number): Gen<string> =>
	string(characterOf(codeCharacters), { min, max })

/** A bigint at or beside a limit or zero half the time, anywhere in its range otherwise. */
const numberGen: Gen<bigint> = oneOf([
	element([int8Min, int8Min + 1n, -1n, 0n, 1n, int8Max - 1n, int8Max]),
	bigint(int8Min, int8Max)
])
const regionGen = element(["North", "South"] as const)

/** A club's key as a case draws it. */
interface ClubKey {
	readonly region: "North" | "South"
	readonly number: bigint
	readonly code: string
}

const clubKeyGen: Gen<ClubKey> = (source) => ({
	region: source.draw(regionGen),
	number: source.draw(numberGen),
	code: source.draw(codeGen(1, 20))
})

type DetailFeature =
	| "region North"
	| "region South"
	| "a number at a limit of bigint"
	| "a code with a quote"
	| "a code with a backslash"
	| "a code with a comma or bracket"
	| "a code with a line break or tab"
	| "a code with a non-ASCII letter"
	| "a code with an astral character"

const detailFeatures = (key: ClubKey): ReadonlyArray<DetailFeature> => [
	key.region === "North" ? "region North" : "region South",
	...(key.number === int8Min || key.number === int8Max
		? (["a number at a limit of bigint"] as const)
		: []),
	...(Str.includes('"')(key.code) ? (["a code with a quote"] as const) : []),
	...(Str.includes("\\")(key.code) ? (["a code with a backslash"] as const) : []),
	...(regex("[,[\\]]").test(key.code) ? (["a code with a comma or bracket"] as const) : []),
	...(regex("[\\n\\t]").test(key.code) ? (["a code with a line break or tab"] as const) : []),
	...(Str.includes("é")(key.code) ? (["a code with a non-ASCII letter"] as const) : []),
	...(Str.includes("\u{1F600}")(key.code) ? (["a code with an astral character"] as const) : [])
]

/**
 * A statement-time native violation as a case draws it, each kind over values of its own: a member at a stored email
 * (the candidate key), a second captain of the stored club (the capacity's partial UNIQUE index), and a club whose
 * seats are below one (the table CHECK) or above the contract's bound (the contract domain), or whose code is past the
 * refinement's twenty characters (the text refinement domain).
 */
type NativeCase =
	| {
			readonly kind: "a candidate key"
			readonly id: Uuid
			readonly email: "ann@example.org" | "ben@example.org"
	  }
	| { readonly kind: "a partial UNIQUE index"; readonly id: Uuid; readonly email: string }
	| { readonly kind: "a table CHECK"; readonly club: ClubKey; readonly seats: number }
	| { readonly kind: "a contract domain"; readonly club: ClubKey; readonly seats: number }
	| { readonly kind: "a text refinement domain"; readonly club: ClubKey }

/** How many draws a fresh value's filter tries: a stored value is drawn about never. */
const freshAttempts = 10

/** A club key no stored club holds. */
const freshClubGen = filter(
	clubKeyGen,
	(k) => !(k.region === "North" && k.number === 1n && k.code === "alpha"),
	freshAttempts
)
/** A member id no stored member holds, and an email none holds. */
const freshIdGen = filter(
	map(uuid(4), (text) => succeeded(Uuid.parse(text), "a version 4 uuid's text")),
	(id) => id !== member(1) && id !== member(2),
	freshAttempts
)
const freshEmailGen = filter(
	matching(regex("^[a-z]{1,12}@example\\.org$")),
	(e) => e !== "ann@example.org" && e !== "ben@example.org",
	freshAttempts
)

const nativeCaseGen: Gen<NativeCase> = oneOf<NativeCase>([
	(source) => ({
		kind: "a candidate key",
		id: source.draw(freshIdGen),
		email: source.draw(element(["ann@example.org", "ben@example.org"] as const))
	}),
	(source) => ({
		kind: "a partial UNIQUE index",
		id: source.draw(freshIdGen),
		email: source.draw(freshEmailGen)
	}),
	(source) => ({
		kind: "a table CHECK",
		club: source.draw(freshClubGen),
		seats: source.draw(oneOf([element([0, int4Min]), int(int4Min, 0)]))
	}),
	(source) => ({
		kind: "a contract domain",
		club: source.draw(freshClubGen),
		seats: source.draw(oneOf([element([501, int4Max]), int(501, int4Max)]))
	}),
	(source) => ({
		kind: "a text refinement domain",
		club: {
			region: source.draw(regionGen),
			number: source.draw(numberGen),
			code: source.draw(codeGen(21, 40))
		}
	})
])

type NativeFeature = `refused by ${NativeCase["kind"]}`

const club = (k: ClubKey, seatsValue: number): ReadonlyArray<string> => [
	k.region,
	String(k.number),
	k.code,
	String(seatsValue)
]

/**
 * What a law's refusal names, against PostgreSQL 19.
 *
 * The Clubs schema (schemas.ts) installs under a fresh schema name with its residual laws. A writer session in its full
 * world provokes each kind of violation, and PostgreSQL's error fields are read as the server sent them;
 * the same change through db.apply must be refused with the law the host names and the witness the host names:
 *
 * - a residual law's function raises 23000 at COMMIT under the law's identity, with a DETAIL that reads back, under
 *   the host's statement of the law's witness (the club's whole key), to exactly the drawn key: both enum labels,
 *   bigints at and between their limits, and codes of quotes, backslashes, commas, brackets, line breaks, non-ASCII
 *   and astral characters; db.apply's witness carries that key;
 * - a native violation at its statement (a candidate key, a partial UNIQUE index, a table CHECK, a contract domain, a
 *   text refinement domain), each drawn over values of its own, is raised under the constraint the naming door names
 *   for its law, and db.apply reports the law with no key, although PostgreSQL's DETAIL carries the key or the whole
 *   row in prose; except where the insert protocol refuses the change in its own rows, probing a unique object besides
 *   its arbiter, whose witness is the requested fact at the object's fields.
 *
 * The expected outcome is stated from the drawn values alone; the classifier that maps a server error to it is never
 * read.
 *
 * A club without members: its count, zero, is below the lower bound one at COMMIT.
 *
 * The law's witness is the club, by its whole key.
 */
export const witnessSuite = (): void => {
	layer(Substrate.layer)("what a law's refusal names, against PostgreSQL 19", (it) => {
		it.effect(
			"a residual law's DETAIL carries any key, and db.apply's witness is that key: enum labels, bigints at their limits, text to escape",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const o = yield* installed(Clubs, clubFacts, extensions)
						const q = quoteIdent(o.installed.schema)
						const insertClub = `INSERT INTO ${q}."club" ("region", "number", "code", "seats") VALUES ($1::text::${q}."region", $2::bigint, $3::text, $4::integer)`
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(o.server.roles.app, {})
							const writer = yield* s.session({
								...worldSession(o.installed.world(o.app)),
								label: "writer"
							})
							return yield* explore(
								{
									suite: "laws/witness/detail",
									draw: drawn(clubKeyGen),
									literal: Formatter.format,
									kept: [],
									runs: 60,
									shrink: { kind: "bounded", candidates: 100 },
									concurrency: 1,
									steerEvery: 16,
									coverage: required<DetailFeature>(
										[
											"region North",
											"region South",
											"a number at a limit of bigint",
											"a code with a quote",
											"a code with a backslash",
											"a code with a comma or bracket",
											"a code with a line break or tab",
											"a code with a non-ASCII letter",
											"a code with an astral character"
										],
										{ cases: 60, sense: notesOnly }
									),
									caseHang: Duration.minutes(2)
								},
								(key, c) =>
									Effect.gen(function* () {
										c.noteAll(detailFeatures(key))
										yield* writer.begin
										const failure = yield* failingCommit(writer, [
											[insertClub, [key.region, String(key.number), key.code, "10"]]
										])
										assert.equal(failure.code, sqlstates.integrityConstraintViolation)
										assert.equal(failure.constraint, memberCount)
										assert.deepEqual(
											strictDetail(
												{ relation: "Club", keys: ["region", "number", "code"] },
												Option.getOrThrow(failure.detail)
											),
											[key.region, String(key.number), key.code]
										)
										const outcome = yield* db.apply(
											ChangeSet.empty(o.schema).insert(Club, [{ ...key, seats: Seats(10) }]),
											{}
										)
										assert.deepEqual(
											outcome,
											refusedBy(o.installed, memberCount, {
												kind: "key",
												relation: "Club",
												values: { ...key }
											})
										)
									})
							)
						}).pipe(Effect.scoped, (body) => withLayer(body, o.layer))
					}).pipe(Effect.scoped)
				)
		)

		it.effect(
			"statement-time native violations are raised under their law's constraint, and db.apply reports the law",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const o = yield* installed(Clubs, clubFacts, extensions)
						const q = quoteIdent(o.installed.schema)
						const insertMember = `INSERT INTO ${q}."member" ("id", "region", "number", "code", "email", "captain") VALUES ($1::uuid, $2::text::${q}."region", $3::bigint, $4::text, $5::text, $6::boolean)`
						const insertClub = `INSERT INTO ${q}."club" ("region", "number", "code", "seats") VALUES ($1::text::${q}."region", $2::bigint, $3::text, $4::integer)`
						/** The contract's domain CHECK, read through the naming door. */
						const seats = clubs.contract("Seats")
						if (seats.kind !== "checked") {
							return assert.fail("Seats is a checked contract")
						}
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(o.server.roles.app, {})
							const writer = yield* s.session({
								...worldSession(o.installed.world(o.app)),
								label: "writer"
							})
							/**
							 * What each case provokes as the writer, the constraint PostgreSQL must raise it under, and the same
							 * change through db.apply with the outcome it must have.
							 */
							const provoked = (k: NativeCase) => {
								switch (k.kind) {
									case "a candidate key":
									case "a partial UNIQUE index": {
										const fact = {
											id: k.id,
											region: "North" as const,
											number: 1n,
											code: "alpha",
											email: k.email,
											captain: k.kind === "a partial UNIQUE index"
										}
										const law = k.kind === "a candidate key" ? memberKey : clubs.lawOf(captainCount)
										return {
											sql: insertMember,
											params: [
												fact.id,
												fact.region,
												"1",
												fact.code,
												fact.email,
												String(fact.captain)
											],
											sqlstate: sqlstates.uniqueViolation,
											/**
											 * The candidate key's constraint, read through the naming door; the partial UNIQUE index
											 * is named apart from its capacity's law.
											 */
											constraint:
												k.kind === "a candidate key"
													? clubs.constraintOf(law, "Unique")
													: undefined,
											expected: refusedBy(
												o.installed,
												law,
												k.kind === "a candidate key"
													? { kind: "key", relation: "Member", values: { email: k.email } }
													: {
															kind: "key",
															relation: "Member",
															values: { region: "North", number: 1n, code: "alpha" }
														}
											),
											applied: db.apply(ChangeSet.empty(o.schema).insert(Member, [fact]), {})
										}
									}
									case "a table CHECK":
									case "a contract domain":
									case "a text refinement domain": {
										const seatsValue = k.kind === "a text refinement domain" ? 10 : k.seats
										const law =
											k.kind === "a table CHECK"
												? positiveSeats
												: k.kind === "a contract domain"
													? seatsLaw
													: codeLaw
										return {
											sql: insertClub,
											params: club(k.club, seatsValue),
											sqlstate: sqlstates.checkViolation,
											/** A table CHECK's and a domain's CHECK, read through the naming door. */
											constraint:
												k.kind === "a table CHECK"
													? clubs.constraintOf(law, "TableCheck")
													: k.kind === "a contract domain"
														? seats.constraint
														: undefined,
											expected: refusedBy(o.installed, law, { kind: "unreported" }),
											/**
											 * Outside the contract or the refinement through the unchecked brand constructor, or a
											 * code of this language read as any string: only PostgreSQL checks them.
											 */
											applied: db.apply(
												ChangeSet.empty(o.schema).insert(Club, [
													{ ...k.club, seats: Seats(seatsValue) }
												]),
												{}
											)
										}
									}
								}
							}
							return yield* explore(
								{
									suite: "laws/witness/native",
									draw: drawn(nativeCaseGen),
									literal: Formatter.format,
									kept: [],
									runs: 60,
									shrink: { kind: "bounded", candidates: 100 },
									concurrency: 1,
									steerEvery: 16,
									coverage: required<NativeFeature>(
										[
											"refused by a candidate key",
											"refused by a partial UNIQUE index",
											"refused by a table CHECK",
											"refused by a contract domain",
											"refused by a text refinement domain"
										],
										{ cases: 60, sense: notesOnly }
									),
									caseHang: Duration.minutes(2)
								},
								(k, c) =>
									Effect.gen(function* () {
										const p = provoked(k)
										yield* writer.begin
										const failure = yield* failingStatement(writer, p.sql, p.params)
										assert.equal(failure.code, p.sqlstate, k.kind)
										if (p.constraint !== undefined) {
											assert.equal(failure.constraint, p.constraint, k.kind)
										}
										const applied = yield* Effect.result(p.applied)
										assert.ok(Result.isSuccess(applied), k.kind)
										assert.deepEqual(applied.success, p.expected, k.kind)
										c.note(`refused by ${k.kind}`)
									})
							)
						}).pipe(Effect.scoped, (body) => withLayer(body, o.layer))
					}).pipe(Effect.scoped)
				)
		)
	})
}
