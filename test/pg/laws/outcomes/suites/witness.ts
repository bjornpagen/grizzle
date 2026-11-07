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
import { Effect, Formatter, Layer, pipe, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import { ChangeSet, type Witness } from "#compiler/public/changeset.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	Club,
	Clubs,
	captainKey,
	clubs,
	codeLaw,
	Member,
	memberKey,
	positiveSeats,
	Seats,
	seatsLaw
} from "#test/pg/laws/outcomes/schemas.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { namesOf, parsedName } from "#test/support/kernel/naming.ts"
import { type PgErrorFields, pgErrorFields } from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
import { Uuid } from "#compiler/public/fields.ts"
import { caseHang } from "#test/support/limits.ts"
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

/** The outcome db.apply reports for a change of an empty ChangeSet's reads. */
type Applied = ApplyOutcome<Readonly<Record<string, never>>>

/** The refusal by `law` alone, as the installation describes it, with `witness`: no law of Clubs merges into another. */
const refusedBy = (at: Installed, law: LawId, witness: Witness): Applied => ({
	kind: "invariant-rejected",
	refused: { kind: "every", laws: [namesOf(at).described(law)] },
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

/**
 * A statement-time native violation as a case draws it, each kind over values of its own: a member at a stored email
 * (the candidate key), a second captain of the stored club (the selected side's key, a UNIQUE over its law columns), and a club whose
 * seats are below one (the table CHECK) or above the contract's bound (the contract domain), or whose code is past the
 * refinement's twenty characters (the text refinement domain).
 */
type NativeCase =
	| {
			readonly kind: "a candidate key"
			readonly id: Uuid
			readonly email: "ann@example.org" | "ben@example.org"
	  }
	| { readonly kind: "a selected side's UNIQUE"; readonly id: Uuid; readonly email: string }
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
		kind: "a selected side's UNIQUE",
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

/** A club's row as its INSERT's parameters, its region as the code `code` gives its handle. */
const club = (
	k: ClubKey,
	seatsValue: number,
	code: (region: ClubKey["region"]) => string
): ReadonlyArray<string> => [code(k.region), String(k.number), k.code, String(seatsValue)]

/**
 * What a law's refusal names, against PostgreSQL 19.
 *
 * The Clubs schema (schemas.ts) installs under a fresh schema name, every law native. A writer session in its full
 * world provokes each kind of violation, and PostgreSQL's error fields are read as the server sent them; the same
 * change through db.apply must be refused with the law the host names and the witness the host names: a native
 * violation at its statement (a candidate key, a selected side's UNIQUE, a table CHECK, a contract domain, a
 *   text refinement domain), each drawn over values of its own, is raised under the constraint the naming door names
 *   for its law, and db.apply reports the law and the key of the fact it states that breaks it: a unique object's
 *   refusal, which the insert protocol finds in its own rows, probing a unique object besides its arbiter, names the
 *   requested fact at the object's fields; a CHECK's and a domain's, which PostgreSQL states only in prose, the host
 *   names, judging the stated club (write/program/witness.ts).
 *
 * The expected outcome is stated from the drawn values alone; the classifier that maps a server error to it is never
 * read. The oracle is the specification turned into a checker: each kind's constraint, read through the naming door.
 */
export const witnessSuite = (): void => {
	layer(Substrate.layer)("what a law's refusal names, against PostgreSQL 19", (it) => {
		it.effect(
			"statement-time native violations are raised under their law's constraint, and db.apply reports the law",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const o = yield* installed(Clubs, clubFacts, extensions)
						const q = quoteIdent(o.installed.schema)
						const insertMember = `INSERT INTO ${q}."member" ("id", "region", "number", "code", "email", "captain") VALUES ($1::uuid, $2::smallint, $3::bigint, $4::text, $5::text, $6::boolean)`
						const insertClub = `INSERT INTO ${q}."club" ("region", "number", "code", "seats") VALUES ($1::smallint, $2::bigint, $3::text, $4::integer)`
						/** A region's code, as the installation numbers its roster: a closed id is stored as its code. */
						const regions = defined(
							o.installed.names.codes.rosters.get(parsedName("Region")),
							"the codes of Region"
						)
						const region = (handle: ClubKey["region"]): string => String(codeOf(regions, handle))
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
									case "a selected side's UNIQUE": {
										const fact = {
											id: k.id,
											region: "North" as const,
											number: 1n,
											code: "alpha",
											email: k.email,
											captain: k.kind === "a selected side's UNIQUE"
										}
										const law = k.kind === "a candidate key" ? memberKey : clubs.lawOf(captainKey)
										return {
											sql: insertMember,
											params: [
												fact.id,
												region(fact.region),
												"1",
												fact.code,
												fact.email,
												String(fact.captain)
											],
											sqlstate: sqlstates.uniqueViolation,
											/** The key's UNIQUE, a field's or a selected side's law columns', read through the naming door. */
											constraint: clubs.constraintOf(law, "Unique"),
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
											params: club(k.club, seatsValue, region),
											sqlstate: sqlstates.checkViolation,
											/** A table CHECK's and a domain's CHECK, read through the naming door. */
											constraint:
												k.kind === "a table CHECK"
													? clubs.constraintOf(law, "TableCheck")
													: k.kind === "a contract domain"
														? seats.constraint
														: undefined,
											/** The club the ChangeSet states is the row that breaks the law, which the host names. */
											expected: refusedBy(o.installed, law, {
												kind: "key",
												relation: "Club",
												values: { region: k.club.region, number: k.club.number, code: k.club.code }
											}),
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
									oracle: {
										kind: "postgresql",
										name: "each kind's constraint, read through the naming door, as PostgreSQL raises it, and the outcome db.apply must report"
									},
									kept: [],
									runs: 60,
									shrink: { kind: "bounded", candidates: 100 },
									concurrency: 1,
									steerEvery: 16,
									coverage: required<NativeFeature>(
										[
											"refused by a candidate key",
											"refused by a selected side's UNIQUE",
											"refused by a table CHECK",
											"refused by a contract domain",
											"refused by a text refinement domain"
										],
										{ cases: 60, sense: notesOnly }
									),
									caseHang
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
