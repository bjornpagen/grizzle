/** What the properties of file.test.ts read: its spaces, models and helpers. */

import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import type { TextChunks } from "@bjornpagen/grizzle-text/chunks"
import { assert } from "@bjornpagen/testing/assert"
import { constant, element, type Gen, oneOf } from "@bjornpagen/testing/gen"
import { agree, exact, set, structuralHash } from "@bjornpagen/testing/oracle"
import type { ScratchDir } from "@bjornpagen/testing/resources"
import { float } from "@bjornpagen/testing/values"
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
import { served } from "#adapter/public/layer.ts"
import { roleNameOf } from "#adapter/served/served.ts"
import { type Json, writeCanonicalJson } from "#compiler/core/canonical.ts"
import { formatOf, type RecordedFormat } from "#compiler/core/format.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { login, role, wholeEntriesOf, wholeWritesOf } from "#compiler/public/schema.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { servedDifference } from "#compiler/served/difference.ts"
import type { ServedFile } from "#compiler/served/forms.ts"
import { servedFile, servedText } from "#compiler/served/json.ts"
import type { UnservedMember } from "#compiler/served/unserved.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { offlineConnection } from "#test/pg/cli/support.ts"
import { artifactRefusal, failed } from "#test/support/assert.ts"
import { joined, jsonOf } from "#test/support/chunked.ts"
import { Search, scoredDocuments } from "#test/support/fixtures/api/search.ts"
import { offlineDecoders, servedSourcedLayer } from "#test/support/live-layer.ts"
import type { LawLevel } from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import type { ProgramCase } from "#test/support/oracle/public/program.ts"
import {
	buildChangeSet,
	printChangeSet,
	type WChangeSet
} from "#test/support/oracle/write/changeset.ts"
import {
	buildWSchema,
	printGroup,
	type WGroup,
	type WSchema
} from "#test/support/oracle/write/schema.ts"
import { clusterPool } from "#test/support/pg.ts"
import { compiledLogin, drawnLogin, drawnSchema, loginGen } from "#test/support/served-login.ts"
import {
	editedAt,
	firstSql,
	memberPaths,
	runtimeDifference,
	without
} from "#test/support/served.ts"
import { testVerify } from "#test/support/worlds.ts"

export type Feature =
	| "a shape shared"
	| "a file without its table refused"
	| "a table cut short refused"
	| "a read"
	| "a paged read"
	| "an attachment"
	| "a change"
	| "a roster with a hole"
	| "an unordered roster served"
	| "a dropped member that does not read back"
	| "a file a host reads that loads"
	| "a stale program named"
	| "a list holding a Map"

export type ChangeFeature =
	| "a shape shared"
	| "a file without its table refused"
	| "a table cut short refused"
	| "a served write"
	| "an array member"
	| "a query member"
	| "a read-back"
	| "more than one stratum"
	| "a dropped member that does not read back"
	| "a file a host reads that loads"
	| "a stale program named"

export type BoundFeature =
	| "a vector served bit for bit"
	| "a vector component of -0"
	| "a vector written after it was bound"
	| "a vector that is not finite refused"
	| "a vector not finite when bound and finite after"
	| "a dropped member that does not read back"
	| "a file a host reads that loads"

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

/** A JSON value's canonical text. */
const canonicalText = (value: unknown): string => {
	const text = writeCanonicalJson(trusted<Json>(value))
	if (!text.ok) {
		throw new Error(`a served file's value with a canonical text: ${text.error.message}`)
	}
	return text.value
}

/**
 * Every record, array, Map and Set at and under a value of a served file's JSON form, as the file's grammar reads its
 * values (served/json.ts): a record's members but its `~` marker list, a revived array's items, a Map's keys and values
 * (its entry pairs are the format's), a Set's members.
 */
const servedValues = (value: unknown): ReadonlyArray<unknown> => {
	if (isList(value)) {
		return [value, ...Arr.flatMap(value, servedValues)]
	}
	if (!isRecord(value)) {
		return []
	}
	const entries = value["~map"]
	if (isList(entries)) {
		return [
			value,
			...Arr.flatMap(entries, (entry) => (isList(entry) ? Arr.flatMap(entry, servedValues) : []))
		]
	}
	const members = value["~set"] ?? value["~a"]
	if (isList(members)) {
		return [value, ...Arr.flatMap(members, servedValues)]
	}
	return [
		value,
		...Arr.flatMap(Rec.toEntries(value), ([key, member]) =>
			key === "~" ? [] : servedValues(member)
		)
	]
}

/**
 * The canonical texts, cut short, of the values a served file's JSON form holds at two places or more that are longer
 * than a reference to its table's next entry: every value of its members but its rosters and its table, and of each
 * entry of its table.
 */
const repeatedShapes = (json: unknown): ReadonlyArray<string> => {
	if (!isRecord(json)) {
		return ["a served file's JSON form is a record"]
	}
	const table = json["shared"]
	const entries = isList(table) ? table : []
	const bound = `"~s:${entries.length}"`.length
	const counts = new Map<string, number>()
	const values = [
		...Arr.flatMap(Rec.toEntries(json), ([key, member]) =>
			key === "rosters" || key === "shared" || key === "~" ? [] : servedValues(member)
		),
		...Arr.flatMap(entries, servedValues)
	]
	for (const value of values) {
		const text = canonicalText(value)
		counts.set(text, (counts.get(text) ?? 0) + 1)
	}
	return Arr.map(
		Arr.filter(Arr.fromIterable(counts), ([text, count]) => count > 1 && text.length > bound),
		([text]) => Str.slice(0, 200)(text)
	)
}

/** The file `json` reads back as, or none where the reader refuses it: a file missing a member its reader needs. */
const readsBack = (json: unknown): ServedFile | undefined => {
	const read = servedFile(json)
	return read.ok ? read.value : undefined
}

/**
 * The reader's refusal of `json`, a served file's JSON value it must not read (see the header), as a malformed served
 * file: where in the file it refused.
 */
const unreadAt = (
	json: unknown,
	what: string,
	printed: () => string
): ReadonlyArray<string | number> => {
	const refusal = artifactRefusal(
		failed(servedFile(json), `${what} does not read back\n${printed()}`)
	)
	assert.equal(
		refusal.artifact,
		"served",
		`${what} is refused as a malformed served file\n${printed()}`
	)
	return refusal.at
}

/**
 * The format a served file's refusal names, as servedFile refuses a file of another format than this grizzle's: the
 * format it records against this grizzle's (ArtifactFormat), at its format member; the case fails for any other refusal.
 */
const formatRefusalOf = (
	json: unknown,
	what: string,
	printed: () => string
): Readonly<{
	at: ReadonlyArray<string | number>
	recorded: RecordedFormat
	expected: string
}> => {
	const reason = failed(servedFile(json), `${what} does not read back\n${printed()}`).reason
	if (reason._tag !== "ArtifactFormat" || reason.artifact !== "served") {
		return assert.fail(
			`${what} is refused as a served file of another format, not ${reason._tag}\n${printed()}`
		)
	}
	return { at: reason.at, recorded: reason.recorded, expected: reason.expected }
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
 * `text`, the file `file` was written as, read as a host reads it (see the header): written to disk in `dir`, the
 * case's own directory, and its bytes read and parsed; served, its roles named and its login's role read, and the layer
 * over it built with no database, which loads it.
 */
const hostReads = (dir: ScratchDir, file: ServedFile, text: TextChunks, printed: () => string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = `${dir}/${file.login}.json`
		yield* fs.writeFileString(path, joined(text))
		const bytes = yield* fs.readFileString(path)
		const login = served(trustedJson<unknown>(bytes), file.login)
		yield* agree(
			[
				["the file's roles", Arr.map(file.roles, (role) => role.name)],
				["the roles served names", Rec.keys(login.roles)]
			],
			set(structuralHash, exact)
		)
		assert.equal(roleNameOf(login, {}), file.role, `roleNameOf reads the file's role\n${printed()}`)
		const built = yield* Effect.exit(
			Effect.scoped(
				Layer.build(
					servedSourcedLayer(offlineDecoders, {
						...offlineConnection,
						pool: clusterPool,
						login,
						verify: testVerify
					})
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
	text: TextChunks,
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

/**
 * `file` written and read back as the runtime reads it (see the header): the forms read back are the forms written; the
 * file without the member of its JSON value at `pick`, among all of them, reads back otherwise or not at all; a host's
 * read, in `dir`, loads it; and a stale copy is named at its program. The file read back, whether a member was left out
 * and whether a program was made stale.
 */
const readsBackWhole = (dir: ScratchDir, file: ServedFile, pick: number, printed: () => string) =>
	Effect.gen(function* () {
		const text = ok(servedText(file), "the served file's text", printed)
		const json = jsonOf(text)
		const back = ok(servedFile(json), "the served file read back", printed)
		const differs = runtimeDifference(file, back)
		assert.equal(differs, undefined, `the file reads back otherwise at ${differs}\n${printed()}`)
		assert.deepEqual(
			repeatedShapes(json),
			[],
			`no shape longer than a reference into the file's table stands at two places\n${printed()}`
		)
		const table = isRecord(json) ? json["shared"] : undefined
		assert.deepEqual(
			formatRefusalOf(without(json, ["format"]), "the file without its format", printed),
			{ at: ["format"], recorded: { kind: "none" }, expected: formatOf.served },
			`the file without its format is refused at its format, recording none\n${printed()}`
		)
		assert.deepEqual(
			formatRefusalOf(
				isRecord(json) ? { ...json, format: 0 } : json,
				"the file of another format",
				printed
			),
			{ at: ["format"], recorded: { kind: "recorded", text: "0" }, expected: formatOf.served },
			`the file of another format is refused at its format, recording it\n${printed()}`
		)
		assert.deepEqual(
			unreadAt(without(json, ["shared"]), "the file without its table", printed),
			["shared"],
			`the file without its table is refused at its table\n${printed()}`
		)
		const cut = isList(table) && table.length > 0
		if (cut) {
			unreadAt(
				without(json, ["shared", table.length - 1]),
				"the file with its table cut short",
				printed
			)
		}
		const paths = memberPaths(json, [])
		const dropped = paths[pick % paths.length]
		if (dropped !== undefined) {
			const planted = readsBack(without(json, dropped))
			assert.ok(
				planted === undefined || runtimeDifference(file, planted) !== undefined,
				`the file without ${Arr.join(Arr.map(dropped, String), ".")} reads back as the file\n${printed()}`
			)
		}
		yield* hostReads(dir, file, text, printed)
		return {
			back,
			dropped: dropped !== undefined,
			stale: staleNamed(back, text, pick, printed),
			shared: cut
		}
	})

/**
 * `c` as a served call supplies it: every array member's facts the call's, none written in the ChangeSet and none a
 * Stream, every other member a query, and its parameters the call's.
 */
export const servedShape = (c: WChangeSet): WChangeSet => ({
	...c,
	strata: Arr.map(c.strata, (stratum) =>
		Arr.map(stratum, (m): WChangeSet["strata"][number][number] =>
			m.source.kind === "array" ? { ...m, source: { kind: "array", facts: [], stream: false } } : m
		)
	),
	binding: "passed"
})

/** The largest finite 32-bit float. */
export const float32Max = 3.4028234663852886e38

/** A vector's component: a 32-bit float of any scale, -0, or one that is not finite. */
export const component = oneOf<number>([
	float(-float32Max, float32Max),
	constant(-0),
	element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
])

/** The value the first change member of `file`'s first role binds under `name`, as the file holds it. */
const boundOf = (file: ServedFile, name: string): unknown => {
	const member = file.roles[0]?.members[0]
	return member?.kind === "change" && member.variants.kind === "change"
		? member.variants.change.bound.get(name)
		: undefined
}

/**
 * A drawn login over the case `c`'s schema extended by its law level, compiled under the level's codes, its file read
 * back whole in `dir` (readsBackWhole); a login the served compile refuses is no case of this property.
 */
export const loginTrip = (
	dir: ScratchDir,
	c: ProgramCase,
	level: LawLevel,
	pick: number,
	draw: <A>(generator: Gen<A>) => A,
	note: (feature: Feature) => void
) =>
	Effect.gen(function* () {
		const schema = drawnSchema(c, level)
		const shapes = draw(loginGen(schema))
		const printed = () => `${printCase(c)}\n${Formatter.format(level)}\n${Formatter.format(shapes)}`
		const compiled = yield* Effect.result(
			compiledLogin(drawnLogin(schema, shapes), schema.laws.codes)
		)
		if (Answered.isFailure(compiled)) {
			return
		}
		const file = compiled.success.back
		for (const member of Arr.flatMap(file.roles, (r) => r.members)) {
			note(
				member.kind === "paged" ? "a paged read" : member.kind === "change" ? "a change" : "a read"
			)
		}
		if (Arr.some(shapes, (s) => Arr.some(s.reads, (r) => r.query.attachments.length > 0))) {
			note("an attachment")
		}
		if (
			Arr.some([...file.rosters.values()], (codes) =>
				Arr.some(codes, (slot) => slot.kind === "hole")
			)
		) {
			note("a roster with a hole")
		}
		const text = servedText(file)
		if (text.ok && Str.includes("~unorderedroster:")(joined(text.value))) {
			note("an unordered roster served")
		}
		const reached = yield* readsBackWhole(dir, file, pick, printed)
		note("a file without its table refused")
		if (reached.shared) {
			note("a shape shared")
			note("a table cut short refused")
		}
		if (reached.dropped) {
			note("a dropped member that does not read back")
		}
		if (holdsMap(reached.back.roles)) {
			note("a list holding a Map")
		}
		note("a file a host reads that loads")
		if (reached.stale) {
			note("a stale program named")
		}
	})

/** A fresh installation's codes: each roster's first. */
const firstCodes = (owned: Parameters<typeof rostersOf>[0]) => firstCodebook(rostersOf(owned))

/**
 * A drawn ChangeSet over a drawn group, as a served call supplies it (servedShape), served by the full writer of its
 * schema in a login of its own and compiled as generate compiles it, its file read back whole in `dir`
 * (readsBackWhole); a ChangeSet that does not compile, or that no served file holds, is no case of this property.
 */
export const changeTrip = (
	dir: ScratchDir,
	group: WGroup,
	schema: WSchema,
	c: WChangeSet,
	pick: number,
	note: (feature: ChangeFeature) => void
) =>
	Effect.gen(function* () {
		const printed = () => `${printGroup(group)}\n${printChangeSet(c)}`
		const built = buildWSchema(schema, "Wo")
		const { changes } = buildChangeSet(built.value, built.relations, group, c)
		const writer = role(built.value, "writer", wholeEntriesOf(built.value), {
			...wholeWritesOf(built.value)
		})
		const compiled = yield* Effect.result(
			compiledLogin(
				login(built.value, "server", [writer], {
					workload: [workload(built.value, { w: changes })]
				}),
				firstCodes
			)
		)
		if (Answered.isFailure(compiled)) {
			return
		}
		const file = compiled.success.back
		const change = Arr.flatMap(file.roles, (r) =>
			Arr.flatMap(r.members, (m) =>
				m.kind === "change" && m.variants.kind === "change" ? [m.variants.change] : []
			)
		)
		note("a served write")
		if (Arr.some(change, (ch) => ch.members.length > 0)) {
			note("an array member")
		}
		if (Arr.some(Arr.flatten(c.strata), (m) => m.source.kind !== "array")) {
			note("a query member")
		}
		if (Arr.some(change, (ch) => ch.readBacks.length > 0)) {
			note("a read-back")
		}
		if (c.strata.length > 1) {
			note("more than one stratum")
		}
		const reached = yield* readsBackWhole(dir, file, pick, printed)
		note("a file without its table refused")
		if (reached.shared) {
			note("a shape shared")
			note("a table cut short refused")
		}
		if (reached.dropped) {
			note("a dropped member that does not read back")
		}
		note("a file a host reads that loads")
		if (reached.stale) {
			note("a stale program named")
		}
	})

/**
 * The scoring read-back bound to `components` and `account`, the caller's buffer written at `at` with `later` after the
 * bind, served by Search's writer in a login of its own and compiled as generate compiles it: read back whole in `dir`
 * (readsBackWhole), its bound vector the vector bound, bit for bit, -0 as 0; or, where a component is not finite, the
 * compile's refusal of it by name.
 */
export const boundTrip = (
	dir: ScratchDir,
	components: ReadonlyArray<number>,
	at: number,
	later: number,
	pick: number,
	account: string,
	note: (feature: BoundFeature) => void
) =>
	Effect.gen(function* () {
		const printed = () => Formatter.format({ components, at, later, account })
		const buffer = Float32Array.from(components)
		const bound = Float32Array.from(components, (x) => (x === 0 ? 0 : x))
		const changes = changeSetOver
			.empty(Search)
			.read("scored", () => scoredDocuments)
			.bind({ account, vector: buffer })
		buffer[at % buffer.length] = later
		if (Arr.some(components, (x) => Object.is(x, -0))) {
			note("a vector component of -0")
		}
		if (!Arr.every(Arr.fromIterable(buffer), (x, i) => Object.is(x, bound[i]))) {
			note("a vector written after it was bound")
		}
		const writer = role(Search, "writer", wholeEntriesOf(Search), {
			...wholeWritesOf(Search)
		})
		const compiled = yield* Effect.result(
			compiledLogin(
				login(Search, "server", [writer], { workload: [workload(Search, { scored: changes })] }),
				firstCodes
			)
		)
		if (!Arr.every(components, Number.isFinite)) {
			if (Arr.every(Arr.fromIterable(buffer), Number.isFinite)) {
				note("a vector not finite when bound and finite after")
			}
			const refusal: UnservedMember = {
				_tag: "UnservedMember",
				reasons: [{ kind: "opaqueBinding", name: "vector" }]
			}
			assert.ok(
				Answered.isFailure(compiled),
				`a vector that is not finite is refused\n${printed()}`
			)
			assert.deepEqual<unknown>(
				Answered.isFailure(compiled) ? compiled.failure.error : undefined,
				refusal,
				`a vector that is not finite is refused by name\n${printed()}`
			)
			note("a vector that is not finite refused")
			return
		}
		if (Answered.isFailure(compiled)) {
			return assert.fail(`the bound vector's read-back serves\n${printed()}`)
		}
		const reached = yield* readsBackWhole(dir, compiled.success.back, pick, printed)
		assert.deepEqual<unknown>(
			boundOf(reached.back, "vector"),
			bound,
			`the bound vector reads back as bound, bit for bit\n${printed()}`
		)
		note("a vector served bit for bit")
		if (reached.dropped) {
			note("a dropped member that does not read back")
		}
		note("a file a host reads that loads")
	})
