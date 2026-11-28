/** What the properties of served.test.ts read: its spaces, models and helpers. */

import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	aimed,
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	unicodeScalar
} from "@bjornpagen/testing/gen"
import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import { Array as Arr, Cause, Effect, FileSystem, Order, String as Str } from "effect"
import { type Json, writeCanonicalJson } from "#compiler/core/canonical.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"
import { paramDomainIdentity } from "#compiler/physical/ddl/domains.ts"
import { type ServedFile, servedPath } from "#compiler/served/forms.ts"
import { servedFile, servedText } from "#compiler/served/json.ts"
import { defineConfig } from "#index.ts"
import { succeeded } from "#test/support/assert.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { joined } from "#test/support/chunked.ts"
import { compileTestWorkload, testCompile } from "#test/support/compile.ts"
import { admittedNames, dictionaryNameGenOtherThan } from "#test/support/kernel/dict.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { shopV1 } from "#test/support/pg/cli/fixture.ts"
import { cliOver, configName, offlineOwner, workspace } from "#test/support/pg/cli/support.ts"
import { editedAt, firstSql, memberPaths, without } from "#test/support/served.ts"
import { upTo } from "#test/support/up-to.ts"

/** A program of the served file, in the file's order: its role's and its own name, and its first SQL text's path. */
interface Program {
	readonly role: string
	readonly program: string
	readonly sql: ReadonlyArray<string | number>
}

/**
 * The programs of a served file a plant edits, stated against the file's order whatever its length: a nonempty set of
 * places, each counted around the number of programs; every program; or the last alone, its second role's last.
 */
type Picked =
	| { readonly kind: "some"; readonly places: Arr.NonEmptyReadonlyArray<number> }
	| { readonly kind: "every" }
	| { readonly kind: "last" }

/** The places in the file's order of the `programs` programs `picked` names, each once, in order. */
const placesOf = (picked: Picked, programs: number): ReadonlyArray<number> => {
	switch (picked.kind) {
		case "some":
			return Arr.sort(Arr.dedupe(Arr.map(picked.places, (place) => place % programs)), Order.Number)
		case "every":
			return upTo(programs, (i) => i)
		case "last":
			return [programs - 1]
	}
}

/**
 * One fault planted into the committed served directory: the programs `picked` names in the file's order edited, the
 * character `char` inserted into each one's first SQL text at `at`, counted around its length; the login's file
 * deleted; a stray file of the login `login` written beside it; or the login's file's text mutated.
 */
type Plant =
	| {
			readonly kind: "edited"
			readonly picked: Picked
			readonly at: number
			readonly char: string
	  }
	| { readonly kind: "missing" }
	| { readonly kind: "stray"; readonly login: string }
	| { readonly kind: "mutated"; readonly mutation: Mutation }

/**
 * An edit of a served file's text: the character `char` inserted at `at` or put in place of the character there, or
 * the character there deleted, `at` counted around the text's length; the member of its JSON value at `member` among
 * every member path, counted around their number, dropped, the rest written as generate writes a file; or a whitespace character JSON admits between
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

export type Situation =
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

const servedShop = Object.freeze(shopV1("ServedShop", "full"))

/** The SQL of a schema directory's one drafted folder, every file's text joined in name order. */
const firstDraftSql = (fs: FileSystem.FileSystem, dir: string) =>
	Effect.gen(function* () {
		const entries = yield* fs.readDirectory(dir)
		const folder = Arr.headNonEmpty(
			nonEmpty(
				Arr.filter(entries, (n) => Str.endsWith("_init")(n)),
				"the first draft's folder"
			)
		)
		const names = yield* fs.readDirectory(`${dir}/${folder}`)
		const files = Arr.sort(
			Arr.filter(names, (n) => Str.endsWith(".sql")(n)),
			Order.String
		)
		const texts = yield* Effect.forEach(files, (f) => fs.readFileString(`${dir}/${folder}/${f}`))
		return Arr.join(texts, "\n")
	})

const ident = identifierOf(identity.schema(parsedSchemaName("ServedShop")))
export const schemaDir = `migrations/${ident}`
export const login = "server"

export const config = defineConfig({
	contracts: [],
	schemas: [servedShop.schema],
	logins: [servedShop.server],
	migrations: "migrations",
	rolePrefixBytes: 0,
	connection: () => offlineOwner
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
export const editedText = (
	text: string,
	programs: ReadonlyArray<Program>,
	plant: Extract<Plant, { readonly kind: "edited" }>
): string => {
	const read = succeeded(servedFile(trustedJson<unknown>(text)), "the served file")
	const edited = Arr.reduce(placesOf(plant.picked, programs.length), read, (file, i) =>
		trusted<ServedFile>(
			editedAt(file, defined(programs[i], `program ${i}`).sql, (sql) => {
				const place = plant.at % (sql.length + 1)
				return `${Str.slice(0, place)(sql)}${plant.char}${Str.slice(place)(sql)}`
			})
		)
	)
	return joined(succeeded(servedText(edited), "the edited served file's text"))
}

/**
 * The text `text`, a served file's, mutated: a character inserted, replaced or deleted, a member of its JSON value
 * `json` dropped, every member path `paths`, and the rest written canonically as generate writes a file, or whitespace
 * put before its text or after it.
 */
export const mutatedText = (
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
	(picked: Gen<Picked>): Gen<Plant> =>
	(source) => ({
		kind: "edited",
		picked: source.draw(picked),
		at: source.draw(int(0, 4096)),
		char: source.draw(unicodeScalar)
	})

/** A nonempty set of places among the file's programs, each counted around their number. */
const someGen: Gen<Picked> = (source) => ({
	kind: "some",
	places: [source.draw(int(0, 4096)), ...source.draw(array(int(0, 4096), { min: 0, max: 3 }))]
})

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

/** A plant dropping one of the file's member paths, counted around their number. */
const droppedGen: Gen<Plant> = (source) => ({
	kind: "mutated",
	mutation: { kind: "dropped", member: source.draw(int(0, 4096)) }
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
	dictionaryNameGenOtherThan(
		new Set(
			Arr.map(
				Arr.filter(admittedNames, (name) => Str.toLowerCase(name.declared) === login),
				(name) => name.declared
			)
		)
	),
	(name): Plant => ({ kind: "stray", login: name.declared })
)

/** Every plant of a served file. */
const plantGen: Gen<Plant> = oneOf<Plant>([
	editedGen(someGen),
	characterGen(element(["insert", "replace", "delete"] as const)),
	droppedGen,
	layoutGen,
	missingGen,
	strayGen
])

/**
 * The arm of the plant generator each situation one draw of it reaches, as the steered phase aims a witness at what
 * is pending, the file's programs in its order, its second role's last: every program edited reaches both roles, and
 * the last one alone the second role alone.
 */
const aims: Arr.NonEmptyReadonlyArray<readonly [Situation, Gen<Plant>]> = [
	["a program edited", editedGen(someGen)],
	["programs of both roles edited", editedGen(constant({ kind: "every" }))],
	["a program of the second role edited alone", editedGen(constant({ kind: "last" }))],
	["the file missing", missingGen],
	["a stray file", strayGen],
	["a character inserted", characterGen(constant("insert" as const))],
	["a character replaced", characterGen(constant("replace" as const))],
	["a character deleted", characterGen(constant("delete" as const))],
	["a member dropped", droppedGen],
	["another layout", layoutGen]
]

/**
 * The plants a case runs: every plant, or, for a witness while a situation is pending, the arm of the plant generator
 * that reaches it.
 */
export const plantSpace = aimed(plantGen, aims)

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
export const expectedOf = (
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
			const earliest = Arr.reduce(
				placesOf(plant.picked, programs.length),
				programs.length,
				(least, i) => Math.min(least, i)
			)
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

export const situationsOf = (
	plant: Plant,
	programs: ReadonlyArray<Program>
): ReadonlyArray<Situation> => {
	switch (plant.kind) {
		case "edited": {
			const roles = Arr.dedupe(
				Arr.map(
					placesOf(plant.picked, programs.length),
					(i) => defined(programs[i], `program ${i}`).role
				)
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

/** What the search built once before its cases (fs, base, domains, file, text, json, programs, paths, entries), now once per worker: every case on it reads them. */
export const baseNeed = {
	key: "test/unit/cli/served.fixtures.ts baseNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const base = yield* workspace("served-base")
		const drafted = yield* cliOver(base, config, ["generate", configName, "--name", "init"])
		assert.equal(drafted.code, 0, drafted.stderr)
		assert.ok(
			Str.includes(`${schemaDir}/${servedPath(login)}`)(drafted.stdout),
			`generate names the served file it writes: ${drafted.stdout}`
		)
		const passed = yield* cliOver(base, config, ["check", configName])
		assert.equal(passed.code, 0, `check passes on the first draft: ${passed.stdout}`)
		const domains = nonEmpty(
			Arr.map(
				succeeded(
					compileTestWorkload(
						[{ login, workloads: servedShop.server.workload }],
						servedShop.schema,
						testCompile
					)
				).params.domains,
				(use) => identifierOf(paramDomainIdentity(use.place, use.regex))
			),
			"the pattern domains the served parameters name"
		)
		const firstDraft = yield* firstDraftSql(fs, `${base}/${schemaDir}`)
		for (const domain of domains) {
			assert.ok(
				Str.includes(domain)(firstDraft),
				`the first draft creates the parameter's pattern domain ${domain}`
			)
		}
		const file = `${base}/${schemaDir}/${servedPath(login)}`
		const text = yield* fs.readFileString(file)
		const json = trustedJson<unknown>(text)
		const programs = nonEmpty(
			programsOf(succeeded(servedFile(json), "the served file")),
			"the served programs"
		)
		const paths = nonEmpty(memberPaths(json, []), "the served file's member paths")
		const listed = yield* fs.readDirectory(`${base}/${schemaDir}`)
		const entries = Arr.sort(listed, Order.String)
		return { fs, base, domains, file, text, json, programs, paths, entries }
	}).pipe(
		Effect.mapBoth({
			onFailure: (error) =>
				NeedFailed.make({
					need: "test/unit/cli/served.fixtures.ts baseNeed",
					message: Cause.pretty(Cause.fail(error))
				}),
			onSuccess: (made) => Effect.succeed(made)
		})
	)
} as const satisfies Need<unknown>
