import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	characterOf,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { quoteIdent } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { dictionaryNameGen } from "#test/support/kernel/dict.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { realize } from "#test/support/worlds/execute/index.ts"
import { docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import type { LoginSpec } from "#test/support/worlds/model/types.ts"

/**
 * SET ROLE and SET SESSION AUTHORIZATION from a direct writer logged in as a login (README "Direct SQL access"): a name
 * no role holds is 22023, whichever statement sends it; a role that exists is 42501 unless the statement may take it
 * on, which it then does (SET ROLE to one of the login's own roles or to the login itself, SET SESSION AUTHORIZATION to
 * the login itself); and SET ROLE to `none` is RESET ROLE.
 *
 * The installation is the documents base's README-shaped worlds, two logins of two roles each. A drawn name is one of
 * its installed names (a role of the writer's login, a role of the other login, either login, the owner), kept or
 * edited (a character's case flipped; a character dropped, replaced or appended; padded past an identifier's 63 bytes),
 * a name of the identifier dictionary, or drawn printable characters. Each statement runs in a transaction of its own,
 * rolled back. The oracle is PostgreSQL's reading of an identifier, its longest prefix of whole characters within 63
 * bytes, and the catalog: whether pg_roles holds the name so read, as the owner sees it.
 *
 * Plant: ~/.cache/grizzle-release/BR08/plants/missing-role-login-cannot-set-its-roles.patch, a login granted its roles
 * without SET, must turn the property red.
 */

/** Whose installed name a drawn name starts from. */
type Start = "its own role" | "another login's role" | "its login" | "the other login" | "the owner"

/** An edit of an installed name: none, or one a PostgreSQL identifier's reading branches on. */
type Edit =
	| { readonly kind: "none" }
	| { readonly kind: "case flipped"; readonly at: number }
	| { readonly kind: "dropped"; readonly at: number }
	| { readonly kind: "replaced"; readonly at: number; readonly by: string }
	| { readonly kind: "appended"; readonly by: string }
	| { readonly kind: "padded past 63 bytes"; readonly by: string; readonly past: number }

type NameSketch =
	| {
			readonly kind: "installed"
			readonly start: Start
			readonly pick: number
			readonly edit: Edit
	  }
	| { readonly kind: "dictionary"; readonly name: string }
	| { readonly kind: "printable"; readonly name: string }

type Statement = "SET ROLE" | "SET SESSION AUTHORIZATION"

type LoginName = "web" | "ops"

interface RoleCase {
	readonly login: LoginName
	readonly statement: Statement
	readonly name: NameSketch
}

/**
 * The characters an edit writes: a letter of either case, a digit, the underscore, a space, the double quote the
 * statement's text doubles and a semicolon, characters of two, three and four bytes, and letters whose case mappings
 * change their length. None is a control character, which the writer's statement text never carries.
 */
const characters = characterOf(["a", "Z", "7", "_", " ", '"', ";", "é", "ß", "İ", "ﬀ", "€", "😀"])

/** A printable character: ASCII's, or any scalar past the C1 controls but a surrogate. */
const printable: Gen<string> = oneOf([
	codePoint(0x20, 0x7e),
	codePoint(0xa0, 0xd7ff),
	codePoint(0xe000, 0x10_ffff)
])

const editGen: Gen<Edit> = weighted<Edit>([
	[2, constant<Edit>({ kind: "none" })],
	[2, (source) => ({ kind: "case flipped", at: source.draw(int(0, 0xffff)) })],
	[1, (source) => ({ kind: "dropped", at: source.draw(int(0, 0xffff)) })],
	[
		1,
		(source) => ({
			kind: "replaced",
			at: source.draw(int(0, 0xffff)),
			by: source.draw(characters)
		})
	],
	[1, (source) => ({ kind: "appended", by: source.draw(characters) })],
	[
		2,
		(source) => ({
			kind: "padded past 63 bytes",
			by: source.draw(characters),
			past: source.draw(int(1, 8))
		})
	]
])

const starts: Arr.NonEmptyReadonlyArray<Start> = [
	"its own role",
	"another login's role",
	"its login",
	"the other login",
	"the owner"
]

const nameGen: Gen<NameSketch> = weighted<NameSketch>([
	[
		6,
		(source) => ({
			kind: "installed",
			start: source.draw(element(starts)),
			pick: source.draw(int(0, 0xffff)),
			edit: source.draw(editGen)
		})
	],
	[1, (source) => ({ kind: "dictionary", name: source.draw(dictionaryNameGen).converted })],
	[
		1,
		(source) => ({
			kind: "printable",
			name: source.draw(
				string(
					weighted([
						[3, characters],
						[1, printable]
					]),
					{ min: 1, max: 12 }
				)
			)
		})
	]
])

const logins: Arr.NonEmptyReadonlyArray<LoginName> = ["web", "ops"]

const statements: Arr.NonEmptyReadonlyArray<Statement> = ["SET ROLE", "SET SESSION AUTHORIZATION"]

const caseGen: Gen<RoleCase> = (source) => ({
	login: source.draw(element(logins)),
	statement: source.draw(element(statements)),
	name: source.draw(nameGen)
})

/** The longest identifier PostgreSQL keeps, in bytes: NAMEDATALEN less its terminator. */
const identifierBytes = 63

const utf8 = new TextEncoder()

const bytesOf = (text: string): number => utf8.encode(text).length

/** An identifier as PostgreSQL reads it: its longest prefix of whole characters within 63 bytes. */
const readIdentifier = (text: string): string => {
	let kept = ""
	for (const point of text) {
		if (bytesOf(`${kept}${point}`) > identifierBytes) {
			return kept
		}
		kept = `${kept}${point}`
	}
	return kept
}

/** A character with its case flipped where it has one, any other as it is. */
const flipped = (point: string): string =>
	Str.toUpperCase(point) === point ? Str.toLowerCase(point) : Str.toUpperCase(point)

/** A name's characters with the one at a drawn position replaced by `replace`'s answer for it. */
const atPosition = (name: string, at: number, replace: (point: string) => string): string => {
	const points = Arr.fromIterable(name)
	const position = at % points.length
	return Arr.join(
		Arr.map(points, (point, i) => (i === position ? replace(point) : point)),
		""
	)
}

const edited = (name: string, edit: Edit): string => {
	switch (edit.kind) {
		case "none":
			return name
		case "case flipped":
			return atPosition(name, edit.at, flipped)
		case "dropped": {
			const kept = atPosition(name, edit.at, () => "")
			return kept === "" ? `${name}${name}` : kept
		}
		case "replaced":
			return atPosition(name, edit.at, () => edit.by)
		case "appended":
			return `${name}${edit.by}`
		case "padded past 63 bytes": {
			let padded = name
			while (bytesOf(padded) <= identifierBytes + edit.past) {
				padded = `${padded}${edit.by}`
			}
			return padded
		}
	}
}

/** What a statement did: took the role on, or was refused with a SQLSTATE. */
type Answer = { readonly kind: "taken" } | { readonly kind: "refused"; readonly sqlstate: string }

type RoleFeature =
	| `${Statement}: ${"22023" | "42501" | "taken"}`
	| "22023 one edit from an installed name"
	| "22023 past 63 bytes"
	| "22023 by case alone"

const loginOf = (name: LoginName): LoginSpec =>
	defined(
		Option.getOrUndefined(Arr.findFirst(docsInstall.logins, (l) => l.name === name)),
		`the login ${name}`
	)

layer(Substrate.layer, { excludeTestServices: true })(
	"a direct writer's SET ROLE and SET SESSION AUTHORIZATION",
	(it) => {
		it.effect(
			"a name no role holds is 22023, a role the login may not take on 42501, whatever the name",
			(ctx) =>
				searched(
					ctx,
					Effect.scoped(
						Effect.gen(function* () {
							const substrate = yield* Substrate
							const world = yield* realize(docsInstall, ordinarySession)
							const names = world.names
							const writers = { web: yield* world.psql("web"), ops: yield* world.psql("ops") }
							const installedRole = (role: string): string =>
								defined(names.roles[role], `the installed role ${role}`)
							const installedLogin = (login: string): string =>
								defined(names.logins[login], `the installed login ${login}`)
							/** Whether the catalog holds a role of the name, as the owner sees every role. */
							const holds = (read: string) =>
								Effect.map(
									substrate.admin.queryValues(
										"SELECT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = $1)",
										[read]
									),
									(rows) => rows[0]?.[0] === true
								)
							return yield* explore(
								{
									suite: "pg/direct-writers/missing-role",
									draw: drawn(caseGen),
									literal: Formatter.format,
									oracle: {
										kind: "postgresql",
										name: "README's SQLSTATEs over pg_roles, each name read as PostgreSQL reads an identifier"
									},
									coverage: required<RoleFeature>(
										[
											"SET ROLE: 22023",
											"SET SESSION AUTHORIZATION: 22023",
											"SET ROLE: 42501",
											"SET SESSION AUTHORIZATION: 42501",
											"SET ROLE: taken",
											"SET SESSION AUTHORIZATION: taken",
											"22023 one edit from an installed name",
											"22023 past 63 bytes",
											"22023 by case alone"
										],
										{ cases: 400, sense: notesOnly }
									),
									kept: [],
									runs: 120,
									shrink: { kind: "bounded", candidates: 200 },
									concurrency: 1,
									steerEvery: 16,
									caseHang
								},
								(drawnCase, c) =>
									Effect.gen(function* () {
										const login = loginOf(drawnCase.login)
										const other = loginOf(drawnCase.login === "web" ? "ops" : "web")
										const own = Arr.map(login.roles, installedRole)
										const loginName = installedLogin(login.name)
										const startsOf = (start: Start): Arr.NonEmptyReadonlyArray<string> => {
											switch (start) {
												case "its own role":
													return own
												case "another login's role":
													return Arr.map(other.roles, installedRole)
												case "its login":
													return [loginName]
												case "the other login":
													return [installedLogin(other.name)]
												case "the owner":
													return [substrate.owner.role]
											}
										}
										const sketch = drawnCase.name
										const name = ((): string => {
											switch (sketch.kind) {
												case "installed": {
													const candidates = startsOf(sketch.start)
													const start = defined(
														candidates[sketch.pick % candidates.length],
														"an installed name"
													)
													return edited(start, sketch.edit)
												}
												case "dictionary":
												case "printable":
													return sketch.name
											}
										})()
										const read = readIdentifier(name)
										const expected: Answer = !(yield* holds(read))
											? drawnCase.statement === "SET ROLE" && read === "none"
												? { kind: "taken" }
												: { kind: "refused", sqlstate: "22023" }
											: read === loginName ||
												  (drawnCase.statement === "SET ROLE" && Arr.contains(own, read))
												? { kind: "taken" }
												: { kind: "refused", sqlstate: "42501" }
										const writer = writers[drawnCase.login]
										yield* writer.begin
										const sent = yield* Effect.result(
											writer.run(`${drawnCase.statement} ${quoteIdent(name)}`)
										)
										yield* writer.rollback
										const answer: Answer = Result.isSuccess(sent)
											? { kind: "taken" }
											: sent.failure._tag === "PsqlStatementError"
												? { kind: "refused", sqlstate: sent.failure.fields.code }
												: yield* Effect.die(sent.failure)
										assert.deepEqual(answer, expected, `${drawnCase.statement} ${quoteIdent(name)}`)
										c.note(
											answer.kind === "taken"
												? `${drawnCase.statement}: taken`
												: answer.sqlstate === "22023"
													? `${drawnCase.statement}: 22023`
													: `${drawnCase.statement}: 42501`
										)
										if (
											answer.kind !== "refused" ||
											answer.sqlstate !== "22023" ||
											sketch.kind !== "installed" ||
											sketch.edit.kind === "none"
										) {
											return
										}
										c.note("22023 one edit from an installed name")
										if (sketch.edit.kind === "padded past 63 bytes") {
											c.note("22023 past 63 bytes")
										}
										if (sketch.edit.kind === "case flipped") {
											c.note("22023 by case alone")
										}
									})
							)
						})
					)
				)
		)
	}
)
