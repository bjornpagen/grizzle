import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	constant,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	subarray,
	unicodeScalar
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	DateTime,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Order,
	String as Str
} from "effect"
import { check } from "#cli/check.ts"
import { type Json, writeCanonicalJson } from "#compiler/core/canonical.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"
import { type ServedFile, servedDirectory, servedPath } from "#compiler/served/forms.ts"
import { servedFile, servedText } from "#compiler/served/json.ts"
import { defineConfig } from "#index.ts"
import { shopV1 } from "#test/pg/cli/fixture.ts"
import {
	cliOver,
	configName,
	offlineOwner,
	resolvedConfig,
	workspace
} from "#test/pg/cli/support.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { dictionaryNameGen } from "#test/support/kernel/dict.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { editedAt, firstSql, memberPaths, without } from "#test/support/served.ts"

/**
 * A login's served file is held to its workload's compile, byte for byte: `grizzle generate` writes
 * `served/<login>.json` beside the snapshot for every login of the configuration, and `grizzle check` compiles every
 * login again under the committed snapshot and refuses a committed served file that is not that text (one that
 * differs, named with the first program where it parts, one missing, and one of a login the configuration does not
 * list), each a finding of its own naming the login.
 *
 * A case takes the committed directory of one schema's first draft, whose login serves reads, a key and a ChangeSet over
 * its two roles (the CLI fixture's shop, test/pg/cli/fixture.ts), and plants one fault (Plant): the SQL of a nonempty
 * set of its programs that state SQL edited, each at a drawn place by a drawn character; its file deleted; a stray
 * file beside it, of a drawn login name the configuration does not list; or its text mutated (Mutation), a character
 * inserted, replaced or deleted at a drawn place, one member of its JSON value dropped and the rest written as
 * generate writes a file, or whitespace put before or after it. The oracle is the first draft: check passes on it as
 * generate wrote it, so a login compiles to the same bytes from the drafted snapshot and from the committed one; after
 * the plant, check finds exactly the plant's one finding where the planted text is not the draft's byte for byte, at
 * the planted file, naming the login, for an edit the first edited program in the file's order and for another layout
 * its layout alone, and none where it is; generate writes or removes exactly the planted file, drafting no folder, and
 * leaves the served directory as the first draft wrote it, byte for byte; and check passes again.
 *
 * Plant (~/.cache/grizzle-release/TSERVED/plants): served-check-layout.patch lets check pass a committed file that
 * reads as the compile's in another layout, so a file generate does not regenerate byte for byte passes.
 */

/** A program of the served file, in the file's order: its role's and its own name, and its first SQL text's path. */
interface Program {
	readonly role: string
	readonly program: string
	readonly sql: ReadonlyArray<string | number>
}

/**
 * One fault planted into the committed served directory: the programs at `programs` in the file's order edited, the
 * character `char` inserted into each one's first SQL text at `at`, counted around its length; the login's file
 * deleted; a stray file of the login `login` written beside it; or the login's file's text mutated.
 */
type Plant =
	| {
			readonly kind: "edited"
			readonly programs: ReadonlyArray<number>
			readonly at: number
			readonly char: string
	  }
	| { readonly kind: "missing" }
	| { readonly kind: "stray"; readonly login: string }
	| { readonly kind: "mutated"; readonly mutation: Mutation }

/**
 * An edit of a served file's text: the character `char` inserted at `at` or put in place of the character there, or
 * the character there deleted, `at` counted around the text's length; the member of its JSON value at `member` among
 * every member path dropped, the rest written as generate writes a file; or a whitespace character JSON admits between
 * tokens put before its text or after it, which leaves its value as it is.
 */
type Mutation =
	| {
			readonly kind: "character"
			readonly op: "insert" | "replace" | "delete"
			readonly at: number
			readonly char: string
	  }
	| { readonly kind: "dropped"; readonly member: number }
	| {
			readonly kind: "layout"
			readonly whitespace: string
			readonly place: "leading" | "trailing"
	  }

type Situation =
	| "a program edited"
	| "programs of both roles edited"
	| "a program of the second role edited alone"
	| "the file missing"
	| "a stray file"
	| "a character inserted"
	| "a character replaced"
	| "a character deleted"
	| "a member dropped"
	| "another layout"

const shop = shopV1("ServedShop", "full")
const ident = identifierOf(identity.schema(parsedSchemaName("ServedShop")))
const schemaDir = `migrations/${ident}`
const login = "server"

const config = defineConfig({
	schemas: [shop.schema],
	logins: [shop.server],
	migrations: "migrations",
	connection: () => offlineOwner
})

const at = (second: number) =>
	DateTime.makeUnsafe({
		year: 2026,
		month: 11,
		day: 9,
		hour: 12,
		minute: 0,
		second,
		millisecond: 0
	})

/**
 * Every program of a served file, as a layer reads it (served/json.ts servedFile), that states SQL under a member named
 * `sql`, in the file's order: its roles', each role's programs in order.
 */
const programsOf = (file: ServedFile): ReadonlyArray<Program> =>
	Arr.flatMap(file.roles, (role, i) =>
		Arr.flatMap(role.members, (member, j): ReadonlyArray<Program> => {
			const sql = firstSql(member, ["roles", i, "members", j])
			return sql === undefined ? [] : [{ role: role.name, program: member.name, sql }]
		})
	)

/**
 * The served file's text with the plant's programs edited: the file read as a layer reads it, each planted program's
 * first SQL text edited, and written again as generate writes a file (served/json.ts servedText).
 */
const editedText = (
	text: string,
	programs: ReadonlyArray<Program>,
	plant: Extract<Plant, { readonly kind: "edited" }>
): string => {
	const edited = Arr.reduce(plant.programs, servedFile(trustedJson<unknown>(text)), (file, i) =>
		trusted<ServedFile>(
			editedAt(file, defined(programs[i], `program ${i}`).sql, (sql) => {
				const place = plant.at % (sql.length + 1)
				return `${Str.slice(0, place)(sql)}${plant.char}${Str.slice(place)(sql)}`
			})
		)
	)
	return succeeded(servedText(edited), "the edited served file's text")
}

/**
 * The text `text`, a served file's, mutated: a character inserted, replaced or deleted, a member of its JSON value
 * `json` dropped, every member path `paths`, and the rest written canonically as generate writes a file, or whitespace
 * put before its text or after it.
 */
const mutatedText = (
	text: string,
	json: unknown,
	paths: Arr.NonEmptyReadonlyArray<ReadonlyArray<string | number>>,
	mutation: Mutation
): string => {
	switch (mutation.kind) {
		case "character": {
			const place = mutation.at % (text.length + (mutation.op === "insert" ? 1 : 0))
			const after = Str.slice(mutation.op === "insert" ? place : place + 1)(text)
			return `${Str.slice(0, place)(text)}${mutation.op === "delete" ? "" : mutation.char}${after}`
		}
		case "dropped": {
			const path = defined(paths[mutation.member % paths.length], "a member path")
			return `${succeeded(writeCanonicalJson(trusted<Json>(without(json, path))), "the dropped file's text")}\n`
		}
		case "layout":
			return mutation.place === "leading"
				? `${mutation.whitespace}${text}`
				: `${text}${mutation.whitespace}`
	}
}

/** A plant editing the first SQL text of each program `picked` draws, by its place in the file's order. */
const editedGen =
	(picked: Gen<ReadonlyArray<number>>): Gen<Plant> =>
	(source) => ({
		kind: "edited",
		programs: source.draw(picked),
		at: source.draw(int(0, 4096)),
		char: source.draw(unicodeScalar)
	})

/** A nonempty set of the places of the file's `programs` programs. */
const someOf = (programs: number): Gen<ReadonlyArray<number>> =>
	filter(subarray(Arr.range(0, programs - 1)), (picked) => picked.length > 0, 8)

/** A plant inserting, replacing or deleting one character of the file's text, by `op`. */
const characterGen =
	(op: Gen<"insert" | "replace" | "delete">): Gen<Plant> =>
	(source) => ({
		kind: "mutated",
		mutation: {
			kind: "character",
			op: source.draw(op),
			at: source.draw(int(0, 4096)),
			char: source.draw(unicodeScalar)
		}
	})

/** A plant dropping one of the file's `paths` member paths. */
const droppedGen =
	(paths: number): Gen<Plant> =>
	(source) => ({
		kind: "mutated",
		mutation: { kind: "dropped", member: source.draw(int(0, paths - 1)) }
	})

/** A plant putting whitespace before or after the file's text. */
const layoutGen: Gen<Plant> = (source) => ({
	kind: "mutated",
	mutation: {
		kind: "layout",
		whitespace: source.draw(element([" ", "\t", "\n", "\r"])),
		place: source.draw(element(["leading", "trailing"] as const))
	}
})

const missingGen = constant<Plant>({ kind: "missing" })

/** A plant writing a stray file of a login the configuration does not list beside the login's. */
const strayGen: Gen<Plant> = map(
	filter(dictionaryNameGen, (name) => Str.toLowerCase(name.declared) !== login, 8),
	(name): Plant => ({ kind: "stray", login: name.declared })
)

/** Every plant of a served file holding `programs` programs and `paths` member paths in its JSON value. */
const plantGen = (programs: number, paths: number): Gen<Plant> =>
	oneOf<Plant>([
		editedGen(someOf(programs)),
		characterGen(element(["insert", "replace", "delete"] as const)),
		droppedGen(paths),
		layoutGen,
		missingGen,
		strayGen
	])

/**
 * The arm of the plant generator each situation one draw of it reaches, as the steered phase aims a witness at what
 * is pending, the file's `programs` programs in its order, its second role's last: every program edited reaches both
 * roles, and the last one alone the second role alone.
 */
const aims = (
	programs: number,
	paths: number
): Arr.NonEmptyReadonlyArray<readonly [Situation, Gen<Plant>]> => [
	["a program edited", editedGen(someOf(programs))],
	["programs of both roles edited", editedGen(constant(Arr.range(0, programs - 1)))],
	["a program of the second role edited alone", editedGen(constant([programs - 1]))],
	["the file missing", missingGen],
	["a stray file", strayGen],
	["a character inserted", characterGen(constant("insert" as const))],
	["a character replaced", characterGen(constant("replace" as const))],
	["a character deleted", characterGen(constant("delete" as const))],
	["a member dropped", droppedGen(paths)],
	["another layout", layoutGen]
]

/**
 * The plant a case runs: its drawn one, or, for a witness while some situation is pending, a draw of the arm of one
 * pending situation, itself drawn among them, so one steering window reaches several.
 */
const aimedPlant = (plant: Plant, c: Case<Situation>, programs: number, paths: number): Plant =>
	Option.match(c.steering, {
		onNone: () => plant,
		onSome: (pending) => {
			const [first, ...rest] = Arr.filter(aims(programs, paths), ([situation]) =>
				pending.names(situation)
			)
			return first === undefined ? plant : c.draw(c.draw(element([first, ...rest]))[1])
		}
	})

/** The finding a plant makes: its kind, the served file it names, and what its problem must say. */
interface Expected {
	readonly kind: "servedStale" | "servedMissing" | "servedExtra"
	readonly file: string
	readonly says: string
}

/**
 * The findings a plant makes, `planted` the login's file's text it leaves, if any: one, but none for a mutation that
 * leaves the text the first draft's byte for byte.
 */
const expectedOf = (
	plant: Plant,
	programs: ReadonlyArray<Program>,
	planted: string,
	text: string
): ReadonlyArray<Expected> => {
	const stale = (says: string): ReadonlyArray<Expected> => [
		{ kind: "servedStale", file: `${schemaDir}/${servedPath(login)}`, says }
	]
	switch (plant.kind) {
		case "edited": {
			const earliest = Arr.reduce(plant.programs, programs.length, (least, i) => Math.min(least, i))
			const first = defined(programs[earliest], "the first edited program")
			return stale(`login ${login}, first at program ${first.program} of role ${first.role}:`)
		}
		case "missing":
			return [
				{
					kind: "servedMissing",
					file: `${schemaDir}/${servedPath(login)}`,
					says: `login ${login}:`
				}
			]
		case "stray":
			return [
				{
					kind: "servedExtra",
					file: `${schemaDir}/${servedPath(plant.login)}`,
					says: `login ${plant.login}:`
				}
			]
		case "mutated":
			return planted === text
				? []
				: stale(
						plant.mutation.kind === "layout"
							? `login ${login}, in its layout alone:`
							: `login ${login}, `
					)
	}
}

const situationsOf = (plant: Plant, programs: ReadonlyArray<Program>): ReadonlyArray<Situation> => {
	switch (plant.kind) {
		case "edited": {
			const roles = Arr.dedupe(
				Arr.map(plant.programs, (i) => defined(programs[i], `program ${i}`).role)
			)
			const second = defined(programs[programs.length - 1], "the last program").role
			return [
				"a program edited",
				...(roles.length > 1 ? (["programs of both roles edited"] as const) : []),
				...(roles.length === 1 && roles[0] === second
					? (["a program of the second role edited alone"] as const)
					: [])
			]
		}
		case "missing":
			return ["the file missing"]
		case "stray":
			return ["a stray file"]
		case "mutated":
			switch (plant.mutation.kind) {
				case "character":
					return [
						plant.mutation.op === "insert"
							? "a character inserted"
							: plant.mutation.op === "replace"
								? "a character replaced"
								: "a character deleted"
					]
				case "dropped":
					return ["a member dropped"]
				case "layout":
					return ["another layout"]
			}
	}
}

layer(NodeServices.layer, { excludeTestServices: true })("served files", (it) => {
	it.effect(
		"check refuses a served file that is not its login's compile, one missing and one of no login, each naming the login and an edit its first program, and generate writes the served directory back",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const base = yield* workspace("served-base")
					const drafted = yield* cliOver(
						base,
						config,
						["generate", configName, "--name", "init"],
						at(0)
					)
					assert.equal(drafted.code, 0, drafted.stderr)
					assert.ok(
						Str.includes(`${schemaDir}/${servedPath(login)}`)(drafted.stdout),
						`generate names the served file it writes: ${drafted.stdout}`
					)
					const passed = yield* cliOver(base, config, ["check", configName], at(1))
					assert.equal(passed.code, 0, `check passes on the first draft: ${passed.stdout}`)
					const file = `${base}/${schemaDir}/${servedPath(login)}`
					const text = yield* fs.readFileString(file)
					const json = trustedJson<unknown>(text)
					const programs = nonEmpty(programsOf(servedFile(json)), "the served programs")
					const paths = nonEmpty(memberPaths(json, []), "the served file's member paths")
					const listed = yield* fs.readDirectory(`${base}/${schemaDir}`)
					const entries = Arr.sort(listed, Order.String)
					return yield* explore(
						{
							suite: "unit/cli/served",
							draw: drawn(plantGen(programs.length, paths.length)),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "the first draft's own served file, which check passes and generate writes back"
							},
							coverage: required<Situation>(
								[
									"a program edited",
									"programs of both roles edited",
									"a program of the second role edited alone",
									"the file missing",
									"a stray file",
									"a character inserted",
									"a character replaced",
									"a character deleted",
									"a member dropped",
									"another layout"
								],
								{ cases: 40, sense: notesOnly }
							),
							kept: [],
							runs: 8,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(drawnPlant, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const plant = aimedPlant(drawnPlant, c, programs.length, paths.length)
									c.noteAll(situationsOf(plant, programs))
									const ws = yield* workspace("served-planted")
									yield* fs.copy(base, ws, { overwrite: true })
									const planted = `${ws}/${schemaDir}/${servedPath(login)}`
									const written = ((): string => {
										switch (plant.kind) {
											case "edited":
												return editedText(text, programs, plant)
											case "missing":
											case "stray":
												return text
											case "mutated":
												return mutatedText(text, json, paths, plant.mutation)
										}
									})()
									switch (plant.kind) {
										case "edited":
										case "mutated":
											yield* fs.writeFileString(planted, written)
											break
										case "missing":
											yield* fs.remove(planted)
											break
										case "stray":
											yield* fs.writeFileString(
												`${ws}/${schemaDir}/${servedPath(plant.login)}`,
												text
											)
											break
									}
									const expected = expectedOf(plant, programs, written, text)
									const refused = yield* cliOver(ws, config, ["check", configName], at(2))
									assert.equal(refused.code, expected.length === 0 ? 0 : 1, refused.stdout)
									const read = yield* resolvedConfig(config, `${ws}/${configName}`)
									const [checked] = yield* check(succeeded(read), ws)
									const findings = defined(checked, "the schema's check").findings
									assert.deepEqual(
										Arr.map(findings, (f) => ({ kind: f.kind, where: f.where })),
										Arr.map(expected, (e) => ({ kind: e.kind, where: e.file })),
										Formatter.format(plant)
									)
									for (const [i, e] of expected.entries()) {
										const found = defined(findings[i], "the finding")
										assert.ok(
											Str.startsWith(e.says)(found.problem),
											`the finding names ${e.says}: ${Formatter.format(found)}`
										)
									}
									const regenerated = yield* cliOver(ws, config, ["generate", configName], at(3))
									assert.equal(regenerated.code, 0, regenerated.stderr)
									for (const e of expected) {
										assert.ok(
											Str.includes(e.file)(regenerated.stdout),
											`generate names the file it writes or removes: ${regenerated.stdout}`
										)
									}
									const after = yield* fs.readDirectory(`${ws}/${schemaDir}`)
									assert.deepEqual(
										Arr.sort(after, Order.String),
										entries,
										"generate drafts no folder"
									)
									const served = yield* fs.readDirectory(`${ws}/${schemaDir}/${servedDirectory}`)
									assert.deepEqual(
										Arr.sort(served, Order.String),
										[`${login}.json`],
										"the served directory holds the login's file alone"
									)
									const rewritten = yield* fs.readFileString(planted)
									assert.equal(rewritten, text, "the served file is the first draft's again")
									const again = yield* cliOver(ws, config, ["check", configName], at(4))
									assert.equal(again.code, 0, again.stdout)
								})
							)
					)
				})
			)
	)
})
