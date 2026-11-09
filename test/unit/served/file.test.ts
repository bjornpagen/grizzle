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
 *
 * Essay ideas: an oracle (the forms served, compared as the runtime reads them) over generated programs, and a plant
 * that keeps it honest.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Result as Answered,
	Array as Arr,
	Effect,
	Formatter,
	Record as Rec,
	String as Str
} from "effect"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { servedPage, servedRead, servedSession } from "#compiler/program/served.ts"
import type { ServedFile, ServedMember } from "#compiler/served/forms.ts"
import { servedFile, servedText } from "#compiler/served/json.ts"
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
import { runtimeDifference } from "#test/support/served.ts"
import { compiledPageResult } from "#test/unit/page/fixtures.ts"

type Feature =
	| "a read"
	| "a paged read"
	| "an attachment"
	| "a dropped member that does not read back"

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
	c: ProgramCase
): A => {
	if (!r.ok) {
		throw new Error(`${what}: ${r.error.message}\n${printCase(c)}`)
	}
	return r.value
}

/** The file `json` reads back as, or none where reading it throws: a file missing a member its reader needs. */
const readsBack = (json: unknown): ServedFile | undefined => {
	const read = Answered.try(() => servedFile(json))
	return Answered.isSuccess(read) ? read.success : undefined
}

const roundTrip = (c: ProgramCase, pick: number, note: (feature: Feature) => void): void => {
	const built = buildSchema(c.schema)
	const value = built.schema
	const codes = ok(codebookFor(schemaInputOf(value), firstCodes), "the schema's codes", c)
	const members: Array<ServedMember> = []
	for (const read of c.reads) {
		if (read.kind !== "query") {
			continue
		}
		const query = buildRoot(built, value, read.query)
		const template = ok(compileTemplate(query, value, testCompile), "a generated query compiles", c)
		const desc = ok(queryInput(query), "the builder takes a generated query", c).desc
		const served = servedRead(template, desc, query.rows)
		const name = `q${members.length}`
		const compiledPage =
			read.query.delivery.kind === "ordered"
				? compiledPageResult(query, testCompile)
				: Answered.fail(undefined)
		if (Answered.isSuccess(compiledPage)) {
			const page = ok(
				servedPage(compiledPage.success.page, codes, name, { schema: "served", extensions: {} }),
				"a compiled page's specs emit",
				c
			)
			members.push({ name, kind: "paged", read: served, page })
			note("a paged read")
		} else {
			members.push({ name, kind: "read", read: served })
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
	const text = ok(servedText(file), "the served file's text", c)
	const json = trustedJson<unknown>(text)
	const back = servedFile(json)
	const differs = runtimeDifference(file, back)
	assert.equal(differs, undefined, `the file reads back otherwise at ${differs}\n${printCase(c)}`)
	const paths = memberPaths(json, [])
	const dropped = paths[pick % paths.length]
	if (dropped === undefined) {
		return
	}
	const planted = readsBack(without(json, dropped))
	assert.ok(
		planted === undefined || runtimeDifference(file, planted) !== undefined,
		`the file without ${Arr.join(Arr.map(dropped, String), ".")} reads back as the file\n${printCase(c)}`
	)
	note("a dropped member that does not read back")
}

describe("a served file", () => {
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
								"a dropped member that does not read back"
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
						Effect.sync(() => roundTrip(notes.draw(resolveCase(sketch)), pick, notes.note))
				)
			)
	)
})
