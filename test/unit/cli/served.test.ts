import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, filter, type Gen, int, map, oneOf, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	DateTime,
	Effect,
	FileSystem,
	Formatter,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import { check } from "#cli/check.ts"
import { type Json, writeCanonicalJson } from "#compiler/core/canonical.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { servedDirectory, servedPath } from "#compiler/served/forms.ts"
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

/**
 * A login's served file is held to its workload's compile, byte for byte: `grizzle generate` writes
 * `served/<login>.json` beside the snapshot for every login of the configuration, and `grizzle check` compiles every
 * login again under the committed snapshot and refuses a committed served file that is not that text (one that
 * differs, named with the first program where it parts, one missing, and one of a login the configuration does not
 * list), each a finding of its own naming the login.
 *
 * A case takes the committed directory of one schema's first draft, whose login serves reads, a key and a ChangeSet over
 * its two roles (the CLI fixture's shop, test/pg/cli/fixture.ts), and plants one fault (Plant): the SQL of a nonempty
 * set of its programs that state SQL edited, each at a drawn place by a drawn
 * character; its file deleted; or a stray file beside it, of a drawn login name the configuration does not list. The
 * oracle is the first draft: check passes on it as generate wrote it, so a login compiles to the same bytes from the
 * drafted snapshot and from the committed one; after the plant, check finds exactly the plant's one finding, at the
 * planted file, naming the login and, for an edit, the first edited program in the file's order; generate writes or
 * removes exactly the planted file, drafting no folder, and leaves the served directory as the first draft wrote it,
 * byte for byte; and check passes again.
 */

/** A program of the served file, in the file's order: its role's and its own name, and its first SQL text's path. */
interface Program {
	readonly role: string
	readonly program: string
	readonly sql: ReadonlyArray<string | number>
}

/**
 * One fault planted into the committed served directory: the programs at `programs` in the file's order edited, the
 * code unit `code` inserted into each one's first SQL text at `at`, counted around its length; the login's file
 * deleted; or a stray file of the login `login` written beside it.
 */
type Plant =
	| {
			readonly kind: "edited"
			readonly programs: ReadonlyArray<number>
			readonly at: number
			readonly code: number
	  }
	| { readonly kind: "missing" }
	| { readonly kind: "stray"; readonly login: string }

type Situation =
	| "a program edited"
	| "programs of both roles edited"
	| "a program of the second role edited alone"
	| "the file missing"
	| "a stray file"

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

/** The path of the first string under a member named `sql` within `json`, its records walked in key order. */
const firstSql = (
	json: unknown,
	path: ReadonlyArray<string | number>
): ReadonlyArray<string | number> | undefined => {
	if (isList(json)) {
		for (const [i, item] of json.entries()) {
			const found = firstSql(item, [...path, i])
			if (found !== undefined) {
				return found
			}
		}
		return undefined
	}
	if (!isRecord(json)) {
		return undefined
	}
	for (const key of Arr.sort(Rec.keys(json), Order.String)) {
		const member = json[key]
		const found =
			key === "sql" && typeof member === "string"
				? [...path, key]
				: firstSql(member, [...path, key])
		if (found !== undefined) {
			return found
		}
	}
	return undefined
}

/** The name a served file's role or program records, which generate always writes as text. */
const nameOf = (record: unknown, what: string): string => {
	const name = isRecord(record) ? record["name"] : undefined
	return typeof name === "string" ? name : assert.fail(`${what} records its name`)
}

/**
 * Every program of a served file's JSON form that states SQL under a member named `sql`, in the file's order: its roles',
 * each role's programs in order.
 */
/**
 * A list member of a served file's JSON record, with the path to its items: a list holding a revived value is written
 * `{"~a": [item, ...], "~": [index, ...]}` (served/json.ts), its items under `~a`.
 */
const listOf = (
	record: unknown,
	key: string
): { readonly items: ReadonlyArray<unknown>; readonly at: ReadonlyArray<string> } => {
	const value = isRecord(record) ? record[key] : undefined
	if (isList(value)) {
		return { items: value, at: [key] }
	}
	const revived = isRecord(value) ? value["~a"] : undefined
	return isList(revived) ? { items: revived, at: [key, "~a"] } : { items: [], at: [key] }
}

const programsOf = (file: Json): ReadonlyArray<Program> => {
	const roles = listOf(file, "roles")
	return Arr.flatMap(roles.items, (role, i) => {
		const members = listOf(role, "members")
		return Arr.flatMap(members.items, (member, j): ReadonlyArray<Program> => {
			const sql = firstSql(member, [...roles.at, i, ...members.at, j])
			return sql === undefined
				? []
				: [
						{
							role: nameOf(role, `role ${i}`),
							program: nameOf(member, `program ${j} of role ${i}`),
							sql
						}
					]
		})
	})
}

/** `json` with the string at `path` replaced by what `edit` makes of it. */
const editedAt = (
	json: Json,
	path: ReadonlyArray<string | number>,
	edit: (text: string) => string
): Json => {
	const [head, ...rest] = path
	if (head === undefined) {
		return typeof json === "string" ? edit(json) : json
	}
	if (isList(json) && typeof head === "number") {
		return Arr.map(json, (item, i) => (i === head ? editedAt(item, rest, edit) : item))
	}
	if (isRecord(json) && typeof head === "string") {
		return { ...json, [head]: editedAt(defined(json[head], `member ${head}`), rest, edit) }
	}
	return json
}

/** The served file's text with the plant's programs edited, laid out as canonical JSON, as generate writes it. */
const editedText = (
	text: string,
	programs: ReadonlyArray<Program>,
	plant: Extract<Plant, { readonly kind: "edited" }>
): string => {
	const edited = Arr.reduce(plant.programs, trustedJson<Json>(text), (json, i) =>
		editedAt(json, defined(programs[i], `program ${i}`).sql, (sql) => {
			const place = plant.at % (sql.length + 1)
			return `${Str.slice(0, place)(sql)}${String.fromCharCode(plant.code)}${Str.slice(place)(sql)}`
		})
	)
	return `${succeeded(writeCanonicalJson(edited), "the edited served file's text")}\n`
}

/** Every plant of a served file holding `programs` programs. */
const plantGen = (programs: number): Gen<Plant> =>
	oneOf<Plant>([
		(source): Plant => ({
			kind: "edited",
			programs: source.draw(
				filter(subarray(Arr.range(0, programs - 1)), (picked) => picked.length > 0, 8)
			),
			at: source.draw(int(0, 4096)),
			code: source.draw(int(0x21, 0x7e))
		}),
		constant<Plant>({ kind: "missing" }),
		map(
			filter(dictionaryNameGen, (name) => Str.toLowerCase(name.declared) !== login, 8),
			(name): Plant => ({ kind: "stray", login: name.declared })
		)
	])

/** The finding a plant makes: its kind, the served file it names, and what its problem must say. */
interface Expected {
	readonly kind: "servedStale" | "servedMissing" | "servedExtra"
	readonly file: string
	readonly says: string
}

const expectedOf = (plant: Plant, programs: ReadonlyArray<Program>): Expected => {
	switch (plant.kind) {
		case "edited": {
			const earliest = Arr.reduce(plant.programs, programs.length, (least, i) => Math.min(least, i))
			const first = defined(programs[earliest], "the first edited program")
			return {
				kind: "servedStale",
				file: `${schemaDir}/${servedPath(login)}`,
				says: `login ${login}, first at program ${first.program} of role ${first.role}:`
			}
		}
		case "missing":
			return {
				kind: "servedMissing",
				file: `${schemaDir}/${servedPath(login)}`,
				says: `login ${login}:`
			}
		case "stray":
			return {
				kind: "servedExtra",
				file: `${schemaDir}/${servedPath(plant.login)}`,
				says: `login ${plant.login}:`
			}
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
					const programs = nonEmpty(programsOf(trustedJson<Json>(text)), "the served programs")
					const listed = yield* fs.readDirectory(`${base}/${schemaDir}`)
					const entries = Arr.sort(listed, Order.String)
					return yield* explore(
						{
							suite: "unit/cli/served",
							draw: drawn(plantGen(programs.length)),
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
									"a stray file"
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
						(plant, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									c.noteAll(situationsOf(plant, programs))
									const ws = yield* workspace("served-planted")
									yield* fs.copy(base, ws, { overwrite: true })
									const planted = `${ws}/${schemaDir}/${servedPath(login)}`
									switch (plant.kind) {
										case "edited":
											yield* fs.writeFileString(planted, editedText(text, programs, plant))
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
									const expected = expectedOf(plant, programs)
									const refused = yield* cliOver(ws, config, ["check", configName], at(2))
									assert.equal(refused.code, 1, refused.stdout)
									const read = yield* resolvedConfig(config, `${ws}/${configName}`)
									const [checked] = yield* check(succeeded(read), ws)
									const findings = defined(checked, "the schema's check").findings
									assert.deepEqual(
										Arr.map(findings, (f) => ({ kind: f.kind, where: f.where })),
										[{ kind: expected.kind, where: expected.file }],
										Formatter.format(plant)
									)
									const [found] = findings
									assert.ok(
										Str.startsWith(expected.says)(defined(found, "the finding").problem),
										`the finding names ${expected.says}: ${Formatter.format(found)}`
									)
									const regenerated = yield* cliOver(ws, config, ["generate", configName], at(3))
									assert.equal(regenerated.code, 0, regenerated.stderr)
									assert.ok(
										Str.includes(expected.file)(regenerated.stdout),
										`generate names the file it writes or removes: ${regenerated.stdout}`
									)
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
