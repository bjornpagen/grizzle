/**
 * A login's OpenAPI document (live/openapi.ts), over logins drawn as `grizzle generate` compiles them, with no database
 * (test/support/served-login.ts compiledLogin): roles reading a generated schema's queries, an ordered one read whole or
 * paged, writing relations through ChangeSets whose facts each call supplies, perhaps through a query entry that reads a
 * context; and writers of generated write schemas running one drawn ChangeSet, its array members the call's, its
 * read-backs delivered in its outcome.
 *
 * Properties, of each login's document, read off its served file alone as generate writes it (ServedEntry openapi):
 * - Valid: it validates against the official OpenAPI 3.2 schema, vendored with its SHA-256, and against the OAS base
 *   schema, which validates its every Schema Object under the OAS dialect, offline (test/support/openapi/validator.ts).
 * - Canonical: its text is its value's canonical JSON, a final newline after it, so check compares bytes.
 * - One operation per program: its paths are exactly `/<login>/<role>/<program>` of each member of each role, each with
 *   one POST, its operationId `<role>.<program>` and its tags the role alone, its `grizzle-wire` header the one value of
 *   its wire's digest, and its `x-grizzle-wire` its served wire.
 * - Events by shape: each operation's stream is the events of its member's shape (live/events.ts events), one component
 *   each, discriminated by `event`; a list's upsert carries `after`, a set's does not, and a write's answer is its
 *   outcome; a paged member's body takes its window.
 *
 * Oracle: the served file the document is read off, its members and their wires, and the event model's own table.
 *
 * Features: a set read, a list read, a paged read, a write, a write with an array member, a write with a read-back, a
 * role reading a context, a role reading none.
 *
 * Plants (~/.cache/grizzle-release/LIVE-OPENAPI/plants): openapi-non-program-operation (an operation for each role
 * beside its programs'), openapi-list-without-after (an ordered program's upsert from the set shape's events).
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Result as Answered, Array as Arr, Effect, Formatter, Order, Record as Rec } from "effect"
import { type Json, writeCanonicalJson } from "#compiler/core/canonical.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { type EventDescriptor, events } from "#compiler/live/events.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { login, role, wholeEntriesOf, writableNamesOf } from "#compiler/public/schema.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import type { ServedFile } from "#compiler/served/forms.ts"
import { assert, deepEquals } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { documentErrors } from "#test/support/openapi/validator.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	buildChangeSet,
	changeSetSketchGen,
	resolveChangeSet,
	type WChangeSet
} from "#test/support/oracle/write/changeset.ts"
import { factsSketchGen, resolveFacts } from "#test/support/oracle/write/facts.ts"
import { buildWSchema, resolveSchema, schemaSketchGen } from "#test/support/oracle/write/schema.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { compiledLogin, drawnLogin, drawnSchema, loginGen } from "#test/support/served-login.ts"

type Feature =
	| "a set read"
	| "a list read"
	| "a paged read"
	| "a write"
	| "a write with an array member"
	| "a write with a read-back"
	| "a role reading a context"
	| "a role reading none"

/** The member at `path` of a JSON value, none where a step finds no member. */
const at = (value: unknown, ...path: ReadonlyArray<string>): unknown => {
	let here: unknown = value
	for (const step of path) {
		here = isRecord(here) && Rec.has(here, step) ? here[step] : undefined
	}
	return here
}

/** A JSON value's own keys, none for any other value. */
const keysOf = (value: unknown): ReadonlyArray<string> => (isRecord(value) ? Rec.keys(value) : [])

/**
 * The document of a login's served file, written as generate writes it (`text`), held to every property of the header.
 */
const holds = (
	file: ServedFile,
	text: string,
	note: (feature: Feature) => void,
	printed: () => string
) =>
	Effect.gen(function* () {
		const document = trustedJson<unknown>(text)
		const errors = yield* documentErrors(document)
		assert.deepEqual(errors, [], `the document validates against OpenAPI 3.2\n${printed()}`)
		const canonical = writeCanonicalJson(trusted<Json>(document))
		assert.ok(
			canonical.ok && `${canonical.value}\n` === text,
			`the document's text is canonical\n${printed()}`
		)
		const expected = Arr.flatMap(file.roles, (r) =>
			Arr.map(r.members, (member) => ({
				role: r,
				member,
				path: `/${file.login}/${r.name}/${member.name}`
			}))
		)
		const paths = at(document, "paths")
		assert.deepEqual(
			Arr.sort(keysOf(paths), Order.String),
			Arr.sort(
				Arr.map(expected, (e) => e.path),
				Order.String
			),
			`one path per program\n${printed()}`
		)
		for (const { role: r, member, path } of expected) {
			note(r.contexts.length === 0 ? "a role reading none" : "a role reading a context")
			assert.deepEqual(keysOf(at(paths, path)), ["post"], `${path}: one POST\n${printed()}`)
			const operation = at(paths, path, "post")
			assert.equal(
				at(operation, "operationId"),
				`${r.name}.${member.name}`,
				`${path}: its operationId`
			)
			assert.deepEqual(at(operation, "tags"), [r.name], `${path}: its tags, its role alone`)
			assert.deepEqual(
				at(operation, "parameters"),
				[
					{
						in: "header",
						name: "grizzle-wire",
						required: true,
						schema: { type: "string", const: member.wire.digest }
					}
				],
				`${path}: its grizzle-wire header, its digest's one value`
			)
			assert.ok(
				deepEquals<unknown>(at(operation, "x-grizzle-wire"), member.wire),
				`${path}: its x-grizzle-wire, its served wire\n${printed()}`
			)
			const shape = member.wire.member.shape
			note(shape === "set" ? "a set read" : shape === "list" ? "a list read" : "a write")
			if (member.kind === "paged") {
				note("a paged read")
			}
			const body = at(operation, "requestBody", "content", "application/json", "schema", "required")
			assert.deepEqual(
				body,
				member.kind === "paged" ? ["params", "facts", "window"] : ["params", "facts"],
				`${path}: its body's members`
			)
			const stream = at(operation, "responses", "200", "content", "text/event-stream", "itemSchema")
			const shapeEvents: { readonly [name: string]: EventDescriptor } = events[shape]
			const named = Rec.keys(shapeEvents)
			const branches = at(stream, "oneOf")
			assert.ok(
				isList(branches) && branches.length === named.length,
				`${path}: one branch per event`
			)
			assert.deepEqual(
				Arr.sort(keysOf(at(stream, "discriminator", "mapping")), Order.String),
				Arr.sort(named, Order.String),
				`${path}: the events of its shape, ${shape}`
			)
			for (const name of named) {
				const component = at(document, "components", "schemas", `${r.name}.${member.name}.${name}`)
				assert.equal(
					at(component, "properties", "event", "const"),
					name,
					`${path}: the event ${name}`
				)
				const data = at(component, "properties", "data", "contentSchema", "required")
				if (name === "upsert") {
					assert.deepEqual(
						data,
						shape === "list" ? ["row", "after"] : ["row"],
						`${path}: a ${shape}'s upsert ${shape === "list" ? "carries" : "carries no"} after\n${printed()}`
					)
				}
			}
			if (member.kind === "change" && member.variants.kind === "change") {
				if (member.variants.change.members.length > 0) {
					note("a write with an array member")
				}
				if (member.variants.change.readBacks.length > 0) {
					note("a write with a read-back")
				}
			}
		}
	})

/** A fresh installation's codes: each roster's first. */
const firstCodes = (owned: Parameters<typeof rostersOf>[0]) => firstCodebook(rostersOf(owned))

/** `c` as a served call supplies it: every array member's facts the call's, every other member a query. */
const servedShape = (c: WChangeSet): WChangeSet => ({
	...c,
	strata: Arr.map(c.strata, (stratum) =>
		Arr.map(stratum, (m): WChangeSet["strata"][number][number] =>
			m.source.kind === "array" ? { ...m, source: { kind: "array", facts: [], stream: false } } : m
		)
	),
	binding: "passed"
})

layer(NodeServices.layer, { excludeTestServices: true })("a login's OpenAPI document", (it) => {
	it.effect(
		"validates, is canonical, and holds one operation per program, its events its shape's",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the served file the document is read off and the event model's own table"
						},
						suite: "unit/live/openapi-logins",
						draw: drawn(
							(source) => [source.draw(caseSketchGen), source.draw(lawLevelGen)] as const
						),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a set read",
								"a list read",
								"a paged read",
								"a write",
								"a role reading a context",
								"a role reading none"
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
					([sketch, level], notes) =>
						Effect.gen(function* () {
							const c = notes.draw(resolveCase(sketch))
							const schema = drawnSchema(c, level)
							const shapes = notes.draw(loginGen(schema))
							const printed = () =>
								`${printCase(c)}\n${Formatter.format(level)}\n${Formatter.format(shapes)}`
							const compiled = yield* Effect.result(
								compiledLogin(drawnLogin(schema, shapes), schema.laws.codes)
							)
							if (Answered.isFailure(compiled)) {
								return
							}
							const entry = compiled.success.entry
							yield* holds(entry.file, entry.openapi, notes.note, printed)
						}).pipe(Effect.scoped, Effect.orDie)
				)
			)
	)

	it.effect(
		"documents every served ChangeSet's facts and outcome, valid and one operation per program",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the served file the document is read off and the event model's own table"
						},
						suite: "unit/live/openapi-changes",
						draw: drawn(
							(source) =>
								[
									source.draw(schemaSketchGen),
									source.draw(pickGen),
									source.draw(factsSketchGen(5)),
									source.draw(changeSetSketchGen)
								] as const
						),
						literal: Formatter.format,
						coverage: required<Feature>(
							["a write", "a write with an array member", "a write with a read-back"],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([schemaSketch, groupPick, factsSketch, changesSketch], notes) =>
						Effect.gen(function* () {
							const schema = notes.draw(resolveSchema(schemaSketch))
							const [first, ...rest] = Arr.filter(schema.groups, (g) => g.role === "drawn")
							if (first === undefined) {
								return
							}
							const group = pickFrom([first, ...rest], groupPick)
							const c = servedShape(
								notes.draw(resolveChangeSet(group, resolveFacts(group, factsSketch), changesSketch))
							)
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
							const entry = compiled.success.entry
							yield* holds(entry.file, entry.openapi, notes.note, () => Formatter.format(c))
						}).pipe(Effect.scoped, Effect.orDie)
				)
			)
	)
})
