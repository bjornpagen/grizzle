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
 *   its wire's digest, and its `x-grizzle-wire`, as the client reads it (live/document.ts documentWire), its served
 *   wire; and the document's root `x-grizzle-wire` holds each role's served witness, by the role's name.
 * - Each shape once: no Schema Object stands at two places in the document (every position JSON Schema 2020-12 reads a
 *   schema at, from each component, each request body, each event stream's item schema and each parameter's schema)
 *   unless its canonical text is no longer than the reference to the component of its digest
 *   (`{"$ref":"#/components/schemas/shared.<its SHA-256 in base32>"}`), and no record or array stands at two places in
 *   the document's wire (the root's roles and table, each operation's member) unless its text is no longer than a
 *   reference to the table's next entry (`{"$ref":"#/x-grizzle-wire/shared/<n>"}`). Every reference is read through as
 *   a reader does, so the properties above read the document as its readers do.
 * - Events by shape: each operation's stream is the events of its member's shape (live/events.ts events), one component
 *   each, discriminated by `event`; a list's upsert carries `after`, a set's does not, and a write's answer is its
 *   outcome; a paged member's body takes its window. An instant read's `ready` says in its `x-stream` that `end`
 *   follows it, and no other's does.
 * - Described, each name once: one tag per role, in the login's order, whose description names every context the role
 *   reads and says its calls need a bearer token exactly where it reads one; each operation's summary says what its
 *   program is (live or at its call's instant, ordered, paged by window, a write or a refresh); each operation's
 *   description names every relation its program writes or refreshes, its key's fields and its parameters; and its
 *   `grizzle-wire` header's description names what a call naming no digest and one naming another are answered
 *   (live/events.ts wireRefusals).
 * - Short: what each text may depend on bounds it, whatever the program's size. A summary depends on its program's
 *   kind and shape alone; a body's description on its input's kind, its parameters' count and its facts' count by op;
 *   a tag's description on its role's name, its programs' count by what they do, and its contexts. Each is held to
 *   that within each document and, by a property whose case is two or three logins, across the documents of a case:
 *   two operations or roles alike in what it may depend on have the same text, so no summary grows with its program's
 *   relations.
 * - Bearer exactly where used: the document declares its bearer scheme exactly when some role reads a context, and an
 *   operation's security names it exactly when its role reads one.
 * - Exact errors: each operation's error event admits exactly the kinds of CallError its call over HTTP may end with:
 *   those the classification's tables (adapter live/call-error.ts readings) read the failures of the HTTP door and of
 *   the Db's opening as, and of its answer's sources: a live read's run and subscription, a read's at its call's
 *   instant run alone, a ChangeSet's run and its refusing outcome, a refresh's run alone.
 *
 * Oracle: the served file the document is read off, its members and their wires, the event model's own table, and the
 * classification's tables.
 *
 * Features: a set read, a list read, a paged read, an instant read, a write, a refresh, a write with an array member, a
 * write with a read-back, a role reading a context, a role reading none, a login no role of which reads a context, a
 * schema shared, a wire node shared.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Result as Answered, Array as Arr, Effect, Formatter } from "effect"
import { workload } from "#compiler/program/workload/value.ts"
import { login, role, wholeEntriesOf, writableNamesOf } from "#compiler/public/schema.ts"
import { caseSketchGen } from "#test/support/oracle/public/generate.ts"
import { lawLevelGen } from "#test/support/oracle/public/laws.ts"
import {
	buildChangeSet,
	changeSetSketchGen,
	resolveChangeSet
} from "#test/support/oracle/write/changeset.ts"
import { factsSketchGen, resolveFacts } from "#test/support/oracle/write/facts.ts"
import { buildWSchema, resolveSchema, schemaSketchGen } from "#test/support/oracle/write/schema.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { compiledLogin } from "#test/support/served-login.ts"
import {
	documentHolds,
	type Feature,
	firstCodes,
	holds,
	servedShape,
	unseen,
	documentsGen
} from "#test/unit/live/openapi.fixtures.ts"

/**
 * A login's OpenAPI document validates, is canonical, and holds one operation per program, its events its shape's.
 *
 * Budget: its suite's count before the conversion (unit/live/openapi-logins: 60 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const aLoginsOpenAPIDocumentValidatesIsCanonicalAndHoldsOneOperationPerProgramItsEventsItsShapes =
	property.explore((source) => [source.draw(caseSketchGen), source.draw(lawLevelGen)] as const, {
		needs: {},
		situations: [
			"a set read",
			"a list read",
			"a paged read",
			"an instant read",
			"a write",
			"a refresh",
			"a role reading a context",
			"a role reading none",
			"a login no role of which reads a context",
			"a schema shared",
			"a wire node shared"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			(_, notes: Case<Feature>) =>
			([sketch, level]) =>
				documentHolds(notes, unseen(), sketch, level),
		oracle: {
			kind: "specification",
			name: "the served file the document is read off and the event model's own table"
		},
		budget: { runs: 60, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/live/openapi.ts",
				original: "\t\tevents[shape.shape]",
				replacement: '\t\tevents[shape.shape === "list" ? "set" : shape.shape]',
				why: "An ordered program's upsert is drawn from the set shape's events, with no `after`."
			},
			{
				file: "packages/engine/src/live/openapi.ts",
				original:
					'\t\t\t\t["x-stream", descriptor.next === undefined ? { role } : { role, next: descriptor.next }]',
				replacement: '\t\t\t\t["x-stream", { role }]',
				why: "An instant read's ready does not say that `end` follows it."
			},
			{
				file: "packages/engine/src/live/openapi.ts",
				original: '\t\t\t\t? "A set read at the call\'s instant"',
				replacement: '\t\t\t\t? "A live set read at the call\'s instant"',
				why: "An instant read's summary says live."
			},
			{
				file: "packages/engine/src/live/events.ts",
				original: '\trefresh: ["apply"]',
				replacement: '\trefresh: ["apply", "outcome"]',
				why: "The event model gives a refresh a ChangeSet's refusing outcome too."
			},
			{
				file: "packages/engine/src/live/openapi.ts",
				original: "\t\tappendAll(operations, own)",
				replacement: `\t\tappendAll(operations, own.length > 0 ? [...own, { ...own[0], path: \`/\${file.login}/\${role.name}\` }] : own)`,
				why: "An operation for each role beside its programs'."
			},
			{
				file: "packages/engine/src/live/openapi.ts",
				original: `\t\t\t: [\`It \${deed.kind} \${listed(deed.relations)}.\`]),`,
				replacement: `\t\t\t: [\`It \${deed.kind} \${listed(deed.relations.slice(0, -1))}.\`]),`,
				why: "An operation's description names all its written relations but its last."
			},
			{
				file: "packages/engine/src/live/openapi.ts",
				original: `\t\t\tdescription: \`The digest of the program's wire form, as x-grizzle-wire states it: a call naming none is answered \${wireRefusals.absent}, and one naming another form \${wireRefusals.other}, so no client decodes by a form the server no longer serves.\`,`,
				replacement: `\t\t\tdescription: \`The digest of the program's wire form, as x-grizzle-wire states it: a call naming none is answered \${wireRefusals.absent}, and one naming another form refused, so no client decodes by a form the server no longer serves.\`,`,
				why: "The `grizzle-wire` header's description names no stale answer."
			},
			{
				file: "packages/engine/src/live/openapi.ts",
				original: "\tfile.roles.some(readsContext)",
				replacement: "\tfile.roles.some(readsContext) || file.roles.length > 0",
				why: "The bearer scheme is declared for every login."
			},
			{
				file: "packages/engine/src/live/shape.ts",
				original: "\t\t.filter(([kind]) => kinds.has(kind))\n",
				replacement: "",
				why: "Every error event admits every kind, as before."
			},
			{
				file: "packages/engine/src/live/openapi.ts",
				original:
					"\t\t\t\t\tpost: operationJson(o, operationSchemas(at), rootAt(wires.roots, file.roles.length + at))",
				replacement:
					"\t\t\t\t\tpost: operationJson(\n\t\t\t\t\t\to,\n\t\t\t\t\t\t{ ...operationSchemas(at), body: o.body },\n\t\t\t\t\t\trootAt(wires.roots, file.roles.length + at)\n\t\t\t\t\t)",
				why: "Each request body is written as its operation built it, every schema in it inline."
			},
			{
				file: "packages/engine/src/live/openapi.ts",
				original:
					"\t\t\t\t\tpost: operationJson(o, operationSchemas(at), rootAt(wires.roots, file.roles.length + at))",
				replacement: "\t\t\t\t\tpost: operationJson(o, operationSchemas(at), o.wire.member)",
				why: "Each operation's wire member is written whole."
			}
		]
	})

/**
 * A login's OpenAPI document documents every served ChangeSet's facts and outcome, valid and one operation per
 * program.
 *
 * Budget: its suite's count before the conversion (unit/live/openapi-changes: 60 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const aLoginsOpenAPIDocumentDocumentsEveryServedChangeSetsFactsAndOutcomeValidAndOneOperationPerProgram =
	property.explore(
		(source) =>
			[
				source.draw(schemaSketchGen),
				source.draw(pickGen),
				source.draw(factsSketchGen(5)),
				source.draw(changeSetSketchGen)
			] as const,
		{
			needs: {},
			situations: [
				"a write",
				"a write with an array member",
				"a write with a read-back",
				"a schema shared"
			] satisfies ReadonlyArray<Reached<Feature>>,
			check:
				(_, notes: Case<Feature>) =>
				([schemaSketch, groupPick, factsSketch, changesSketch]) =>
					Effect.gen(function* () {
						const seen = unseen()
						return yield* Effect.gen(function* () {
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
							yield* holds(entry.file, entry.openapi, seen, notes.note, () => Formatter.format(c))
						}).pipe(Effect.scoped, Effect.orDie)
					}),
			oracle: {
				kind: "specification",
				name: "the served file the document is read off and the event model's own table"
			},
			budget: { runs: 60, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/core/canonical.ts",
					original: '\t\t\t\tthis.#read(top.value[i], "")',
					replacement: "\t\t\t\t{}",
					why: 'Operator mutant (statement) at packages/engine/src/core/canonical.ts:1350 in <module>: `this.#read(top.value[i], "")` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6).'
				}
			]
		}
	)

/**
 * A login's OpenAPI documents are short: a summary, a body's description and a tag's description depend on what each
 * may depend on alone, across the two or three documents of a case as within each.
 *
 * Budget: openapi-logins's count (unit/live/openapi-logins, 60 independent cases and none steered), the claim it held
 * across those cases before the conversion. Every case holds one login's document at two law levels (documentsGen), so
 * every text is seen again under what it may depend on in each case; two logins whose roles coincide in name, contexts
 * and deed counts but write different relations are kept (its kept token, found by the kill's mutant at the runner's
 * budget and shrunk): at TEST_SEED=1 to 5 every situation is reached and every kill is killed.
 */
export const aLoginsOpenAPIDocumentIsShortEachTextDependingOnWhatItMayDependOnAloneAcrossDocuments =
	property.explore(documentsGen, {
		needs: {},
		situations: [
			"a summary seen again under what it may depend on",
			"a body's description seen again under what it may depend on",
			"a tag's description seen again under what it may depend on"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, notes: Case<Feature>) => (documents) =>
			Effect.gen(function* () {
				const seen = unseen()
				for (const [sketch, level] of documents) {
					yield* documentHolds(notes, seen, sketch, level)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the served file each document is read off: what each text may depend on"
		},
		budget: { runs: 60, steered: 0 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/live/openapi.test.ts#aLoginsOpenAPIDocumentIsShortEachTextDependingOnWhatItMayDependOnAloneAcrossDocuments:-:9.0.1.0.1.0.1.0.1.0.1.0.1.0.1.2.0.1.0.1.0.1.2.1.0.1.0.1.0.1.0.1.2.1.0.1.0.1.0.0.1.0.0.1.0.0.1.0.1.0.1.2.1.0.1.0.0.1.2.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.1.0.0.0.0.0.0.1.0.0.0.0.0.0.1.0.0.0.0.0.2.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.1.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.1.0.0.1.0.0.1.0.0.1.0.0.0"
				),
				reason:
					"two logins whose roles share a name, contexts and deed counts but write different relations, so a role's description that named its relations would differ under what it may depend on",
				since: "2026-11-16"
			}
		],
		kills: [
			{
				file: "packages/engine/src/live/openapi.ts",
				original: '\t\t\treturn "A write"',
				replacement: `\t\t\treturn member.wire.member.shape === "write" && member.wire.member.outcome.kind === "change"\n\t\t\t\t? \`A write of \${listed(member.wire.member.outcome.relations)}\`\n\t\t\t\t: "A write"`,
				why: "A write's summary names the relations it writes."
			},
			{
				file: "packages/engine/src/live/openapi.ts",
				original: `\t\treturn count === 0 ? [] : [\`\${count} \${deedWords[kind]}\`]`,
				replacement: `\t\treturn count === 0\n\t\t\t? []\n\t\t\t: [\n\t\t\t\t\t\`\${count} \${deedWords[kind]} \${listed(\n\t\t\t\t\t\tprograms.flatMap((program) =>\n\t\t\t\t\t\t\tprogram.deed.kind === kind && program.deed.kind !== "reads" ? program.deed.relations : []\n\t\t\t\t\t\t)\n\t\t\t\t\t)}\`\n\t\t\t\t]`,
				why: "A role's description names the relations its programs write."
			},
			{
				file: "packages/engine/src/live/openapi.ts",
				original: `\t\t\treturn \`The call's input: \${params}; \${factsWords(input.facts)}.\``,
				replacement: `\t\t\treturn \`The call's input: \${params}; \${factsWords(input.facts)}, \${listed(input.facts.map((f) => f.relation))}.\``,
				why: "A body's description names the relations of its facts."
			}
		]
	})
