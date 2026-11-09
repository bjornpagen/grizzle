/**
 * A served file reads back as the runtime reads it: a login's compiled reads, written by servedText and read by
 * servedFile from the JSON value an import of the file yields, are the forms the compile served, member by member
 * (Maps and Sets in order, canonical values by their class and payload, a record's undefined members as absent ones),
 * and a file missing any one member does not read back so.
 *
 * Over generated public programs (test/support/oracle/public), each query and ordered query compiled as the runtime
 * compiles it and served (program/served.ts servedRead), an ordered one that pages with its page served beside it
 * (servedPage), one role of one login holding them all:
 *
 * - Round trip: the forms read back are the forms written (runtimeDifference finds no member that differs).
 * - Plant: one member of the file's JSON value, drawn among all of them, left out; the forms read back differ from the
 *   ones written, or reading them is a defect: a member the encoder drops is never one the decoder makes up.
 * - A host's read: the file's bytes, written to disk, read back and parsed, as an application reads its committed file;
 *   served (adapter/served/served.ts served), which names the file's roles, its login's role read (roleNameOf), and the
 *   layer over it built with no database (DbLayer.make), which loads it (served/load.ts loadServed). Every reader of
 *   the file reads it through servedFile, so a value its JSON form holds as no JSON value holds it, a Map, a Set, a
 *   bigint, a type, in a list or a record, reads as the runtime's own: its roles, a list whose records hold Maps, are
 *   what served names.
 * - A stale file: the first SQL text of one program, drawn among those stating one, edited, and the file written as
 *   generate writes one; check's difference finder (served/difference.ts servedDifference), reading both texts as a
 *   layer does, names that program.
 *
 * Essay ideas: an oracle (the forms served, compared as the runtime reads them) over generated programs, and a plant
 * that keeps it honest.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { int } from "@grizzle/testing/gen"
import { agree, exact, set, structuralHash } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Result as Answered,
	Array as Arr,
	Effect,
	Exit,
	FileSystem,
	Formatter,
	Layer,
	Record as Rec,
	String as Str
} from "effect"
import { DbLayer, served } from "#adapter/public/layer.ts"
import { roleNameOf } from "#adapter/served/served.ts"
import { appendAll } from "#compiler/core/array.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { servedPage, servedRead, servedSession } from "#compiler/program/served.ts"
import { servedDifference } from "#compiler/served/difference.ts"
import type { ServedFile, ServedMember } from "#compiler/served/forms.ts"
import { servedFile, servedText } from "#compiler/served/json.ts"
import { offlineConnection } from "#test/pg/cli/support.ts"
import { assert } from "#test/support/assert.ts"
import {
	codebookFor,
	compileTemplate,
	firstCodes,
	schemaInputOf,
	testCompile
} from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import type { ProgramCase } from "#test/support/oracle/public/program.ts"
import { clusterPool } from "#test/support/pg.ts"
import { editedAt, firstSql, runtimeDifference } from "#test/support/served.ts"
import { testVerify } from "#test/support/worlds.ts"
import { compiledPageResult } from "#test/unit/page/fixtures.ts"

type Feature =
	| "a read"
	| "a paged read"
	| "an attachment"
	| "a dropped member that does not read back"
	| "a file a host reads that loads"
	| "a stale program named"
	| "a list holding a Map"

/** Every member path of a JSON value, a record's keys and an array's indices, outermost first. */
const memberPaths = (
	json: unknown,
	at: ReadonlyArray<string | number>
): ReadonlyArray<ReadonlyArray<string | number>> => {
	if (isList(json)) {
		return Arr.flatMap(json, (item, i) => [[...at, i], ...memberPaths(item, [...at, i])])
	}
	if (isRecord(json)) {
		return Arr.flatMap(Rec.toEntries(json), ([key, item]) => [
			[...at, key],
			...memberPaths(item, [...at, key])
		])
	}
	return []
}

/** A copy of a JSON value without the member at `path`: an array's element taken out, a record's key left out. */
const without = (json: unknown, path: ReadonlyArray<string | number>): unknown => {
	const [first, ...rest] = path
	if (first === undefined) {
		return json
	}
	if (isList(json)) {
		return rest.length === 0
			? Arr.filter(json, (_, i) => i !== first)
			: Arr.map(json, (item, i) => (i === first ? without(item, rest) : item))
	}
	if (isRecord(json)) {
		return Rec.fromEntries(
			Arr.flatMap(Rec.toEntries(json), ([key, item]): ReadonlyArray<readonly [string, unknown]> =>
				key !== first ? [[key, item]] : rest.length === 0 ? [] : [[key, without(item, rest)]]
			)
		)
	}
	return json
}

/** The served file of one login of one role holding `members`, under the codes `codes`. */
const fileOf = (
	members: ReadonlyArray<ServedMember>,
	rosters: ServedFile["rosters"]
): ServedFile => ({
	login: "app",
	fingerprint: SchemaFingerprint(Str.repeat(64)("0")),
	base: "base",
	level: 0,
	role: "app_login",
	schema: "base",
	prologue: { fence: trusted("SELECT 1"), enter: trusted("SELECT 2") },
	session: servedSession,
	rosters,
	above: { schemas: [], constraints: { tables: {}, domains: {} }, laws: new Map() },
	roles: [
		{
			name: "reader",
			installed: "base__reader",
			contexts: [],
			refusals: {
				laws: {
					schemas: [],
					constraintLaws: [],
					theoryLaws: [],
					tables: new Map(),
					rosterDomains: [],
					generated: []
				},
				relations: new Map(),
				entries: new Map()
			},
			members
		}
	]
})

const ok = <A, E extends { readonly message: string }>(
	r: Result.Result<A, E>,
	what: string,
	printed: () => string
): A => {
	if (!r.ok) {
		throw new Error(`${what}: ${r.error.message}\n${printed()}`)
	}
	return r.value
}

/** The file `json` reads back as, or none where reading it throws: a file missing a member its reader needs. */
const readsBack = (json: unknown): ServedFile | undefined => {
	const read = Answered.try(() => servedFile(json))
	return Answered.isSuccess(read) ? read.success : undefined
}

/** Whether a served value holds a Map at some depth: a value a load rebuilds, not one it reads as it is. */
const holdsMap = (value: unknown): boolean => {
	const pending: Array<unknown> = [value]
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		if (next instanceof Map) {
			return true
		}
		if (isList(next)) {
			appendAll(pending, next)
		} else if (isRecord(next)) {
			appendAll(pending, Rec.values(next))
		}
	}
	return false
}

/**
 * `text`, the file `file` was written as, read as a host reads it (see the header): written to disk, and its bytes read
 * and parsed; served, its roles named and its login's role read, and the layer over it built with no database, which
 * loads it.
 */
const hostReads = (file: ServedFile, text: string, printed: () => string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const dir = yield* fs.makeTempDirectoryScoped()
		const path = `${dir}/${file.login}.json`
		yield* fs.writeFileString(path, text)
		const bytes = yield* fs.readFileString(path)
		const login = served(trustedJson<unknown>(bytes), file.login)
		yield* agree(
			[
				["the file's roles", Arr.map(file.roles, (role) => role.name)],
				["the roles served names", Rec.keys(login.roles)]
			],
			set(structuralHash, exact)
		)
		assert.equal(roleNameOf(login), file.role, `roleNameOf reads the file's role\n${printed()}`)
		const built = yield* Effect.exit(
			Effect.scoped(
				Layer.build(
					DbLayer.make({ ...offlineConnection, pool: clusterPool, login, verify: testVerify })
				)
			)
		)
		assert.ok(
			Exit.isSuccess(built),
			`the layer over the file a host reads builds and loads it: ${Formatter.format(built)}\n${printed()}`
		)
	})

/**
 * A stale copy of `file`, written as `text`: the first SQL text of the program at `pick` among those stating one edited,
 * and the file written as generate writes one, which check's difference finder names at that program. Whether `file`
 * holds a program to edit.
 */
const staleNamed = (
	file: ServedFile,
	text: string,
	pick: number,
	printed: () => string
): boolean => {
	const programs = Arr.flatMap(file.roles, (role, i) =>
		Arr.flatMap(role.members, (member, j) => {
			const sql = firstSql(member, ["roles", i, "members", j])
			return sql === undefined ? [] : [{ role: role.name, program: member.name, sql }]
		})
	)
	const target = programs[pick % Math.max(programs.length, 1)]
	if (target === undefined) {
		return false
	}
	const stale = trusted<ServedFile>(editedAt(file, target.sql, (sql) => `${sql} `))
	const staleText = ok(servedText(stale), "the stale file's text", printed)
	assert.deepEqual(
		servedDifference(text, staleText),
		{ kind: "program", role: target.role, program: target.program },
		`check names the stale program ${target.program}\n${printed()}`
	)
	return true
}

const roundTrip = (c: ProgramCase, pick: number, note: (feature: Feature) => void) =>
	Effect.gen(function* () {
		const printed = () => printCase(c)
		const built = buildSchema(c.schema)
		const value = built.schema
		const codes = ok(codebookFor(schemaInputOf(value), firstCodes), "the schema's codes", printed)
		const members: Array<ServedMember> = []
		for (const read of c.reads) {
			if (read.kind !== "query") {
				continue
			}
			const query = buildRoot(built, value, read.query)
			const template = ok(
				compileTemplate(query, value, testCompile),
				"a generated query compiles",
				printed
			)
			const desc = ok(queryInput(query), "the builder takes a generated query", printed).desc
			const form = servedRead(template, desc, query.rows)
			const name = `q${members.length}`
			const compiledPage =
				read.query.delivery.kind === "ordered"
					? compiledPageResult(query, testCompile)
					: Answered.fail(undefined)
			if (Answered.isSuccess(compiledPage)) {
				const page = ok(
					servedPage(compiledPage.success.page, codes, name, { schema: "served", extensions: {} }),
					"a compiled page's specs emit",
					printed
				)
				members.push({ name, kind: "paged", read: form, page })
				note("a paged read")
			} else {
				members.push({ name, kind: "read", read: form })
				note("a read")
			}
			if (read.query.attachments.length > 0) {
				note("an attachment")
			}
		}
		const file = fileOf(
			members,
			new Map(Arr.map([...codes.rosters], ([name, codec]) => [name, codec.codes] as const))
		)
		const text = ok(servedText(file), "the served file's text", printed)
		const json = trustedJson<unknown>(text)
		const back = servedFile(json)
		const differs = runtimeDifference(file, back)
		assert.equal(differs, undefined, `the file reads back otherwise at ${differs}\n${printed()}`)
		const paths = memberPaths(json, [])
		const dropped = paths[pick % paths.length]
		if (dropped !== undefined) {
			const planted = readsBack(without(json, dropped))
			assert.ok(
				planted === undefined || runtimeDifference(file, planted) !== undefined,
				`the file without ${Arr.join(Arr.map(dropped, String), ".")} reads back as the file\n${printed()}`
			)
			note("a dropped member that does not read back")
		}
		if (holdsMap(back.roles)) {
			note("a list holding a Map")
		}
		yield* hostReads(file, text, printed)
		note("a file a host reads that loads")
		if (staleNamed(back, text, pick, printed)) {
			note("a stale program named")
		}
	})

layer(NodeServices.layer, { excludeTestServices: true })("a served file", (it) => {
	it.effect(
		"reads back every compiled read as the runtime reads it, and no member is dropped unseen",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the served forms, compared as the runtime reads them"
						},
						suite: "unit/served/file",
						draw: drawn(
							(source) => [source.draw(caseSketchGen), source.draw(int(0, 1_000_000))] as const
						),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a read",
								"a paged read",
								"an attachment",
								"a dropped member that does not read back",
								"a file a host reads that loads",
								"a stale program named",
								"a list holding a Map"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([sketch, pick], notes) =>
						roundTrip(notes.draw(resolveCase(sketch)), pick, notes.note).pipe(
							Effect.scoped,
							Effect.orDie
						)
				)
			)
	)
})
