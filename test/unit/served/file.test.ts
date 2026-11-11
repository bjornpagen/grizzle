import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, element, int, oneOf } from "@grizzle/testing/gen"
import { agree, exact, set, structuralHash } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { float } from "@grizzle/testing/values"
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
 * Over the write oracle's generated groups and ChangeSets (test/support/oracle/write), each ChangeSet as a served call
 * supplies it, its array members' facts the call's and its other members queries, compiled for reality and served
 * (write/program/served.ts servedWrite, with its read-backs, its reads decoder, its bound values, its array members,
 * served-members.ts servedMembers, and the closed relations its binding and witness read), one change member of one
 * role, where it serves: the same round trip, plant, host's read and stale file, its write, binding, statements,
 * read-backs and members read back as they were written and loaded as a layer loads them.
 *
 * Over drawn vectors bound to the Search fixture's scoring read-back (test/support/fixtures/api/search.ts), its query's
 * vector parameter closed by ChangeSet.bind over the caller's buffer, which the caller writes again after the bind: the
 * ChangeSet served, one change member of one role, and read back whole as above, its bound vector reading back as the
 * vector bound, bit for bit, -0 as 0, the one zero the codec writes (core/canonical.ts canonicalOf). A vector with a
 * component that is not finite has no canonical text, and no served file holds it: the served compile refuses it by
 * its name (served-members.ts opaqueBinding), as its bind read it, whatever the caller writes to it after.
 *
 * Essay ideas: an oracle (the forms served, compared as the runtime reads them) over generated programs, and a plant
 * that keeps it honest.
 */
import type { Isolation } from "#compiler/core/isolation.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { servedPage, servedRead, servedSession } from "#compiler/program/served.ts"
import { closedNamed } from "#compiler/runtime/write/fill.ts"
import { servedDifference } from "#compiler/served/difference.ts"
import type {
	ServedChange,
	ServedFile,
	ServedMember,
	ServedRoleForm
} from "#compiler/served/forms.ts"
import { servedFile, servedText } from "#compiler/served/json.ts"
import { servedMatchers } from "#compiler/served/matchers.ts"
import { servedReadBacks } from "#compiler/served/spine.ts"
import type { UnservedMember } from "#compiler/served/unserved.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { closedTableOf } from "#compiler/write/program/decide.ts"
import { servedMembers } from "#compiler/write/program/served-members.ts"
import { servedWrite } from "#compiler/write/program/served.ts"
import { offlineConnection } from "#test/pg/cli/support.ts"
import { assert } from "#test/support/assert.ts"
import {
	codebookFor,
	compileTemplate,
	firstCodes,
	realityWrite,
	schemaInputOf,
	testArtifacts,
	testCompile
} from "#test/support/compile.ts"
import { documentDimensions, Search, scoredDocuments } from "#test/support/fixtures/api/search.ts"
import { caseHang } from "#test/support/limits.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import type { ProgramCase } from "#test/support/oracle/public/program.ts"
import {
	buildChangeSet,
	changeSetSketchGen,
	printChangeSet,
	resolveChangeSet,
	type WChangeSet
} from "#test/support/oracle/write/changeset.ts"
import { factsSketchGen, resolveFacts } from "#test/support/oracle/write/facts.ts"
import {
	buildWSchema,
	printGroup,
	resolveSchema,
	schemaSketchGen,
	type WGroup,
	type WSchema
} from "#test/support/oracle/write/schema.ts"
import { clusterPool } from "#test/support/pg.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { checking } from "#test/support/policy.ts"
import { editedAt, firstSql, runtimeDifference } from "#test/support/served.ts"
import { testVerify } from "#test/support/worlds.ts"
import { compiledPageResult } from "#test/unit/page/fixtures.ts"
import { descOf, parsedOf } from "#test/unit/write/changeset/fixtures.ts"

type ChangeFeature =
	| "a served write"
	| "an array member"
	| "a query member"
	| "a read-back"
	| "more than one stratum"
	| "a dropped member that does not read back"
	| "a file a host reads that loads"
	| "a stale program named"

type BoundFeature =
	| "a vector served bit for bit"
	| "a vector component of -0"
	| "a vector written after it was bound"
	| "a vector that is not finite refused"
	| "a vector not finite when bound and finite after"
	| "a dropped member that does not read back"
	| "a file a host reads that loads"

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

/** The isolation level a case's role records, by the case's pick: each level for half the picks. */
const isolationAt = (pick: number): Isolation => (pick % 2 === 0 ? "serializable" : "readCommitted")

/** The served file of one login of one role at `isolation` holding `members`, under the codes `codes`. */
const fileOf = (
	members: ReadonlyArray<ServedMember>,
	rosters: ServedFile["rosters"],
	closed: ServedFile["closed"],
	isolation: Isolation
): ServedFile => {
	const roles: ReadonlyArray<ServedRoleForm> = [
		{
			name: "reader",
			installed: "base__reader",
			isolation,
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
	return {
		login: "app",
		fingerprint: SchemaFingerprint(Str.repeat(64)("0")),
		base: "base",
		level: 0,
		role: "app_login",
		schema: "base",
		prologue: { fence: trusted("SELECT 1"), enter: trusted("SELECT 2") },
		session: servedSession,
		rosters,
		matchers: servedMatchers(roles),
		closed,
		above: { schemas: [], constraints: { tables: {}, domains: {} }, laws: new Map() },
		roles
	}
}

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

/**
 * `file` written and read back as the runtime reads it (see the header): the forms read back are the forms written; the
 * file without the member of its JSON value at `pick`, among all of them, reads back otherwise or not at all; a host's
 * read loads it; and a stale copy is named at its program. The file read back, whether a member was left out and
 * whether a program was made stale.
 */
const readsBackWhole = (file: ServedFile, pick: number, printed: () => string) =>
	Effect.gen(function* () {
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
		}
		yield* hostReads(file, text, printed)
		return { back, dropped: dropped !== undefined, stale: staleNamed(back, text, pick, printed) }
	})

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
			new Map(Arr.map([...codes.rosters], ([name, codec]) => [name, codec.codes] as const)),
			new Map(),
			isolationAt(pick)
		)
		const reached = yield* readsBackWhole(file, pick, printed)
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

/**
 * `c` as a served call supplies it: every array member's facts the call's, none written in the ChangeSet and none a
 * Stream, every other member a query, and its parameters the call's.
 */
const servedShape = (c: WChangeSet): WChangeSet => ({
	...c,
	strata: Arr.map(c.strata, (stratum) =>
		Arr.map(stratum, (m): WChangeSet["strata"][number][number] =>
			m.source.kind === "array" ? { ...m, source: { kind: "array", facts: [], stream: false } } : m
		)
	),
	binding: "passed"
})

/**
 * A drawn ChangeSet over a drawn group, as a served call supplies it (servedShape), compiled for reality and served,
 * one change member of one role, read back whole (readsBackWhole); a ChangeSet that does not compile, or that no served
 * file holds, is no case of this property.
 */
const changeTrip = (
	group: WGroup,
	schema: WSchema,
	c: WChangeSet,
	pick: number,
	note: (feature: ChangeFeature) => void
) =>
	Effect.gen(function* () {
		const printed = () => `${printGroup(group)}\n${printChangeSet(c)}`
		const built = buildWSchema(schema, "Wo")
		const artifacts = ok(testArtifacts(built.value, testCompile), "the schema's artifacts", printed)
		const { changes } = buildChangeSet(built.value, built.relations, group, c)
		const compiled = compileWrite(checking(built.value), descOf(changes), realityWrite(artifacts))
		if (!compiled.ok) {
			return
		}
		const program = compiled.value
		const parsed = parsedOf(changes)
		const write = servedWrite(program)
		const members = servedMembers(program.binding.members, parsed.opaque)
		if (!write.ok || !members.ok) {
			return
		}
		note("a served write")
		const change: ServedChange = {
			program: write.value,
			readBacks: servedReadBacks(program.artifact.readBacks),
			decoder: changes.reads.form,
			bound: parsed.values,
			members: members.value
		}
		if (members.value.length > 0) {
			note("an array member")
		}
		if (Arr.some(Arr.flatten(c.strata), (m) => m.source.kind !== "array")) {
			note("a query member")
		}
		if (change.readBacks.length > 0) {
			note("a read-back")
		}
		if (c.strata.length > 1) {
			note("more than one stratum")
		}
		const read = Arr.dedupe([
			...program.binding.evaluation.closed,
			...program.binding.witness.evaluation.closed
		])
		const file = fileOf(
			[{ name: "w", kind: "change", variants: { kind: "change", change } }],
			new Map(
				Arr.map(
					[...program.frontend.codes.rosters],
					([name, codec]) => [name, codec.codes] as const
				)
			),
			closedNamed(read, closedTableOf(program.frontend)),
			isolationAt(pick)
		)
		const reached = yield* readsBackWhole(file, pick, printed)
		if (reached.dropped) {
			note("a dropped member that does not read back")
		}
		note("a file a host reads that loads")
		if (reached.stale) {
			note("a stale program named")
		}
	})

/** The largest finite 32-bit float. */
const float32Max = 3.4028234663852886e38

/** A vector's component: a 32-bit float of any scale, -0, or one that is not finite. */
const component = oneOf<number>([
	float(-float32Max, float32Max),
	constant(-0),
	element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
])

/** The account the scoring read-back's other parameter binds. */
const account = "00000000-0000-4000-8000-000000000000"

/** Search's artifacts, which every bound vector's ChangeSet compiles under. */
const searchArtifacts = ok(testArtifacts(Search, testCompile), "Search's artifacts", () => "Search")

/** The value the first change member of `file`'s first role binds under `name`, as the file holds it. */
const boundOf = (file: ServedFile, name: string): unknown => {
	const member = file.roles[0]?.members[0]
	return member?.kind === "change" && member.variants.kind === "change"
		? member.variants.change.bound.get(name)
		: undefined
}

/**
 * The scoring read-back bound to `components`, the caller's buffer written at `at` with `later` after the bind, compiled
 * for reality and served, one change member of one role, and read back whole (readsBackWhole): its bound vector is the
 * vector bound, bit for bit, -0 as 0; or, where a component is not finite, refused by name.
 */
const boundTrip = (
	components: ReadonlyArray<number>,
	at: number,
	later: number,
	pick: number,
	note: (feature: BoundFeature) => void
) =>
	Effect.gen(function* () {
		const printed = () => Formatter.format({ components, at, later })
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
		const program = ok(
			compileWrite(checking(Search), descOf(changes), realityWrite(searchArtifacts)),
			"the scoring read-back compiles",
			printed
		)
		const parsed = parsedOf(changes)
		const members = servedMembers(program.binding.members, parsed.opaque)
		if (!Arr.every(components, Number.isFinite)) {
			if (Arr.every(Arr.fromIterable(buffer), Number.isFinite)) {
				note("a vector not finite when bound and finite after")
			}
			const refusal: UnservedMember = {
				_tag: "UnservedMember",
				reasons: [{ kind: "opaqueBinding", name: "vector" }]
			}
			assert.deepEqual(
				members,
				Result.err(refusal),
				`a vector that is not finite is refused by name\n${printed()}`
			)
			note("a vector that is not finite refused")
			return
		}
		const write = servedWrite(program)
		if (!members.ok || !write.ok) {
			return assert.fail(`the bound vector's read-back serves\n${printed()}`)
		}
		const change: ServedChange = {
			program: write.value,
			readBacks: servedReadBacks(program.artifact.readBacks),
			decoder: changes.reads.form,
			bound: parsed.values,
			members: members.value
		}
		const read = Arr.dedupe([
			...program.binding.evaluation.closed,
			...program.binding.witness.evaluation.closed
		])
		const file = fileOf(
			[{ name: "scored", kind: "change", variants: { kind: "change", change } }],
			new Map(
				Arr.map(
					[...program.frontend.codes.rosters],
					([name, codec]) => [name, codec.codes] as const
				)
			),
			closedNamed(read, closedTableOf(program.frontend)),
			isolationAt(pick)
		)
		const reached = yield* readsBackWhole(file, pick, printed)
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

	it.effect(
		"reads back every served ChangeSet as the runtime reads it, and no member is dropped unseen",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the served change forms, compared as the runtime reads them"
						},
						suite: "unit/served/change",
						draw: drawn(
							(source) =>
								[
									source.draw(schemaSketchGen),
									source.draw(pickGen),
									source.draw(factsSketchGen(5)),
									source.draw(changeSetSketchGen),
									source.draw(int(0, 1_000_000))
								] as const
						),
						literal: Formatter.format,
						coverage: required<ChangeFeature>(
							[
								"a served write",
								"an array member",
								"a query member",
								"a read-back",
								"more than one stratum",
								"a dropped member that does not read back",
								"a file a host reads that loads",
								"a stale program named"
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
					([schemaSketch, groupPick, factsSketch, changesSketch, pick], notes) =>
						Effect.gen(function* () {
							const schema = notes.draw(resolveSchema(schemaSketch))
							const [first, ...rest] = Arr.filter(schema.groups, (g) => g.role === "drawn")
							if (first === undefined) {
								return
							}
							const group = pickFrom([first, ...rest], groupPick)
							const c = notes.draw(
								resolveChangeSet(group, resolveFacts(group, factsSketch), changesSketch)
							)
							yield* changeTrip(group, schema, servedShape(c), pick, notes.note)
						}).pipe(Effect.scoped, Effect.orDie)
				)
			)
	)

	it.effect(
		"reads back every vector a served ChangeSet binds bit for bit as it was bound, and refuses one that is not finite by name",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the vector bound, bit for bit with -0 as 0, or its refusal by name where it is not finite"
						},
						suite: "unit/served/bound-vector",
						draw: drawn(
							(source) =>
								[
									source.draw(
										array(component, { min: documentDimensions, max: documentDimensions })
									),
									source.draw(int(0, documentDimensions - 1)),
									source.draw(float(-float32Max, float32Max)),
									source.draw(int(0, 1_000_000))
								] as const
						),
						literal: Formatter.format,
						coverage: required<BoundFeature>(
							[
								"a vector served bit for bit",
								"a vector component of -0",
								"a vector written after it was bound",
								"a vector that is not finite refused",
								"a vector not finite when bound and finite after",
								"a dropped member that does not read back",
								"a file a host reads that loads"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept: [
							{
								note: "a vector bound with NaN and written finite after: its bind read it with no text",
								sketch: [[Number.NaN, 0, 0, 0], 0, 0, 0],
								draws: "",
								reaches: [
									"a vector that is not finite refused",
									"a vector not finite when bound and finite after"
								]
							}
						],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([components, at, later, pick], notes) =>
						boundTrip(components, at, later, pick, notes.note).pipe(Effect.scoped, Effect.orDie)
				)
			)
	)
})
