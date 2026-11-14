import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, oneOf } from "@grizzle/testing/gen"
import { agree, exact, set, structuralHash } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { float, uuid } from "@grizzle/testing/values"
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
import { served } from "#adapter/public/layer.ts"
import { roleNameOf } from "#adapter/served/served.ts"
import { appendAll } from "#compiler/core/array.ts"
import { type Json, writeCanonicalJson } from "#compiler/core/canonical.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import type * as Result from "#compiler/core/result.ts"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { login, role, wholeEntriesOf, writableNamesOf } from "#compiler/public/schema.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { servedDifference } from "#compiler/served/difference.ts"
import type { ServedFile } from "#compiler/served/forms.ts"
import { servedFile, servedText } from "#compiler/served/json.ts"
import type { UnservedMember } from "#compiler/served/unserved.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { offlineConnection } from "#test/pg/cli/support.ts"
import { assert } from "#test/support/assert.ts"
import { documentDimensions, Search, scoredDocuments } from "#test/support/fixtures/api/search.ts"
import { caseHang } from "#test/support/limits.ts"
import { offlineDecoders, servedSourcedLayer } from "#test/support/live-layer.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { type LawLevel, lawLevelGen } from "#test/support/oracle/public/laws.ts"
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
import { compiledLogin, drawnLogin, drawnSchema, loginGen } from "#test/support/served-login.ts"
import {
	editedAt,
	firstSql,
	memberPaths,
	runtimeDifference,
	without
} from "#test/support/served.ts"
import { testVerify } from "#test/support/worlds.ts"

/**
 * A served file reads back as the runtime reads it: a login's compiled file, written by servedText and read by
 * servedFile from the JSON value an import of the file yields, is the file the compile served, member by member (Maps
 * and Sets in order, canonical values by their class and payload, a record's undefined members as absent ones), and a
 * file missing any one member does not read back so.
 *
 * Every file is a real login's, compiled as `grizzle generate` compiles it (test/support/served-login.ts compiledLogin,
 * adapter/served/compile.ts snapshotCompiled then servedEntryOf), with no database:
 *
 * - Logins drawn over generated public schemas extended by their law levels (test/support/oracle/public, laws.ts),
 *   under the level's codes, holes and all: roles that read the case's queries, an ordered one whole or paged
 *   (paged(...)), write relations through ChangeSets, and perhaps a query entry reading a context.
 * - A writer of a generated write schema (test/support/oracle/write) running one drawn ChangeSet as a served call
 *   supplies it, its array members' facts the call's and its other members queries.
 * - A writer of the Search fixture (test/support/fixtures/api/search.ts) running its scoring read-back, its query's
 *   vector parameter closed by ChangeSet.bind over the caller's buffer, which the caller writes again after the bind.
 *
 * Properties, of each file:
 * - Round trip: the file read back is the file written (runtimeDifference finds no member that differs).
 * - Each shape once: no record, array, Map or Set the file's JSON value holds as a value stands at two places (its
 *   members but its rosters, the codebook's own form a load reads first, and its table's entries; within each, a
 *   record's members but its `~` marker, a revived array's items, a Map's keys and values, a Set's members) unless its
 *   canonical text is no longer than a reference to the table's next entry (`"~s:<n>"`).
 * - Plant: one member of the file's JSON value, drawn among all of them, left out; the file read back differs from the
 *   one written, or reading it is a defect: a member the encoder drops is never one the decoder makes up.
 * - A host's read: the file's bytes, written to disk, read back and parsed, as an application reads its committed file;
 *   served (adapter/served/served.ts served), which names the file's roles, its login's role read (roleNameOf), and the
 *   layer over it built with no database (DbLayer.make), which loads it (served/load.ts loadServed).
 * - A stale file: the first SQL text of one program, drawn among those stating one, edited, and the file written as
 *   generate writes one; check's difference finder (served/difference.ts servedDifference), reading both texts as a
 *   layer does, names that program.
 * - A bound vector reads back as the vector bound, bit for bit, -0 as 0, the one zero the codec writes
 *   (core/canonical.ts canonicalOf); a vector with a component that is not finite has no canonical text, and no served
 *   file holds it: the served compile refuses it by its name (served-members.ts opaqueBinding), as its bind read it,
 *   whatever the caller writes to it after.
 *
 * The oracle is the file the compile served, compared as the runtime reads it.
 *
 * Plants (~/.cache/grizzle-release/OUTPUTSIZE/plants): served-roles-unshared (the file's roles written as the writer
 * wrote them, outside the table), served-maps-unshared (no Map ever an entry of the table).
 */

type Feature =
	| "a shape shared"
	| "a read"
	| "a paged read"
	| "an attachment"
	| "a change"
	| "a roster with a hole"
	| "a dropped member that does not read back"
	| "a file a host reads that loads"
	| "a stale program named"
	| "a list holding a Map"

type ChangeFeature =
	| "a shape shared"
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
		assert.deepEqual(
			repeatedShapes(json),
			[],
			`no shape longer than a reference into the file's table stands at two places\n${printed()}`
		)
		const table = isRecord(json) ? json["shared"] : undefined
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
		return {
			back,
			dropped: dropped !== undefined,
			stale: staleNamed(back, text, pick, printed),
			shared: isList(table) && table.length > 0
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

/** The largest finite 32-bit float. */
const float32Max = 3.4028234663852886e38

/** A vector's component: a 32-bit float of any scale, -0, or one that is not finite. */
const component = oneOf<number>([
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
 * back whole (readsBackWhole); a login the served compile refuses is no case of this property.
 */
const loginTrip = (
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
		const file = compiled.success.entry.file
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
		const reached = yield* readsBackWhole(file, pick, printed)
		if (reached.shared) {
			note("a shape shared")
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
 * schema in a login of its own and compiled as generate compiles it, its file read back whole (readsBackWhole); a
 * ChangeSet that does not compile, or that no served file holds, is no case of this property.
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
		const { changes } = buildChangeSet(built.value, built.relations, group, c)
		const writer = role(built.value, "writer", wholeEntriesOf(built.value), {
			write: writableNamesOf(built.value)
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
		const file = compiled.success.entry.file
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
		const reached = yield* readsBackWhole(file, pick, printed)
		if (reached.shared) {
			note("a shape shared")
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
 * bind, served by Search's writer in a login of its own and compiled as generate compiles it: read back whole
 * (readsBackWhole), its bound vector the vector bound, bit for bit, -0 as 0; or, where a component is not finite, the
 * compile's refusal of it by name.
 */
const boundTrip = (
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
			write: writableNamesOf(Search)
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
		const reached = yield* readsBackWhole(compiled.success.entry.file, pick, printed)
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
		"reads back every drawn login's file as the runtime reads it, and no member is dropped unseen",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the file the compile served, compared as the runtime reads it"
						},
						suite: "unit/served/file",
						draw: drawn(
							(source) =>
								[
									source.draw(caseSketchGen),
									source.draw(lawLevelGen),
									source.draw(int(0, 1_000_000))
								] as const
						),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a shape shared",
								"a read",
								"a paged read",
								"an attachment",
								"a change",
								"a roster with a hole",
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
					([sketch, level, pick], notes) =>
						Effect.suspend(() =>
							loginTrip(notes.draw(resolveCase(sketch)), level, pick, notes.draw, notes.note)
						).pipe(Effect.scoped, Effect.orDie)
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
								"a shape shared",
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
									source.draw(int(0, 1_000_000)),
									source.draw(uuid(4))
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
								sketch: [[Number.NaN, 0, 0, 0], 0, 0, 0, "00000000-0000-4000-8000-000000000000"],
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
					([components, at, later, pick, account], notes) =>
						boundTrip(components, at, later, pick, account, notes.note).pipe(
							Effect.scoped,
							Effect.orDie
						)
				)
			)
	)
})
