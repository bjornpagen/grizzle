import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { corrupted, corruptedFeature, type CorruptedFeature } from "@bjornpagen/testing/lsw"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { formatLoc, formatPath } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { queryInput, querySchema } from "#compiler/program/compile.ts"
import { parseSchemaInput, schemaArtifacts } from "#compiler/program/schema.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { assert, refusalLoc, succeeded } from "#test/support/assert.ts"
import {
	compileInputTemplate,
	compileInputWorkload,
	compileTemplate,
	compileTestWorkload,
	schemaInputOf,
	testCompile
} from "#test/support/compile.ts"
import { decodedSchema } from "#test/support/fixtures/ir/desc.ts"
import { fullDataSwarm, resolveSchema, schemaDesc } from "#test/support/oracle/gen/schema.ts"
import {
	type Arm,
	arms,
	type ArtifactsFeature,
	changedCases,
	compiledOrThrow,
	contentChanges,
	type ContentFeature,
	contentGen,
	corruptions,
	type DecoderRule,
	holdsPath,
	identifierFeatures,
	inputOf,
	type LevelFeature,
	levelsOf,
	liveSketchGen,
	ownedSubjectOf,
	readOf,
	refusal,
	spelling,
	sqlOf,
	subjects
} from "#test/unit/program/schema-input.fixtures.ts"

/** The schema a query compiles against is the named schema, where the query's own is one of its levels, and nothing else. */
export const theSchemaAQueryCompilesAgainstIsTheNamedSchemaWhereTheQuerysOwnIsOneOfItsLevelsAndNothingElse =
	property.exhaust(
		finite((source) => [source.draw(subjects), source.draw(subjects)] as const),
		{
			needs: {},
			situations: ["the schema itself", "a level", "no level"] satisfies ReadonlyArray<
				Reached<LevelFeature>
			>,
			check:
				(_, c: Case<LevelFeature>) =>
				([built, named]) =>
					Effect.sync(() => {
						const what = `a query over ${built.label} named against ${named.label}`
						const chosen = Result.flatMap(queryInput(built.query), (input) =>
							querySchema(input, schemaInputOf(named.schema))
						)
						const compiled = compileTemplate(built.query, named.schema, testCompile)
						if (levelsOf(named).includes(built)) {
							c.note(built === named ? "the schema itself" : "a level")
							if (!chosen.ok) {
								throw new Error(`${what} is refused: ${chosen.error.message}`)
							}
							if (!compiled.ok) {
								throw new Error(`${what} does not compile: ${compiled.error.message}`)
							}
						} else {
							c.note("no level")
							assert.equal(refusal(chosen, what).reason._tag, "MalformedDescription")
							assert.equal(refusal(compiled, what).reason._tag, "MalformedDescription")
						}
					}),
			oracle: {
				kind: "specification",
				name: "the extensions the fixtures build (schema.extend): a query compiles exactly against a schema its own is a level of"
			},
			box: "every ordered pair of Work, Reports, Payroll and Reporting, a query over the first named against the second",
			kept: [],
			kills: []
		}
	)

/** The artifacts of a schema are one value whichever input reaches the schema, under its declared names. */
export const theArtifactsOfASchemaAreOneValueWhicheverInputReachesTheSchemaUnderItsDeclaredNames =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(subjects),
					source.draw((source) => [source.draw(arms), source.draw(arms)] as const)
				] as const
		),
		{
			needs: {},
			situations: [
				"the built value and the Owned",
				"the built value and its description",
				"the Owned and its description"
			] satisfies ReadonlyArray<Reached<ArtifactsFeature>>,
			check:
				(_, c: Case<ArtifactsFeature>) =>
				([s, [first, second]]) =>
					Effect.sync(() => {
						c.note(`${first} and ${second}`)
						const owned = ownedSubjectOf(s)
						const options = { codes: firstCodebook(rostersOf(owned)) }
						const artifactsOf = (arm: Arm) =>
							succeeded(
								Result.flatMap(parseSchemaInput(inputOf(s, arm)), (input) =>
									schemaArtifacts(input, options)
								),
								`the artifacts of ${s.label} through ${arm}`
							)
						const a = artifactsOf(first)
						const b = artifactsOf(second)
						assert.equal(
							b.fingerprint,
							a.fingerprint,
							`${s.label} through ${first} and ${second}: two installations`
						)
						assert.equal(
							b.names.schema,
							a.names.schema,
							`${s.label} through ${first} and ${second}: two schemas`
						)
						assert.equal(
							b.names.vectorSchema,
							a.names.vectorSchema,
							`${s.label}: two vector schemas`
						)
						assert.equal(
							a.owned.fingerprint,
							owned.fingerprint,
							`${s.label} through ${first}: artifacts of another Owned`
						)
						const declared = installOptions(owned)
						assert.equal(a.names.schema, declared.levels[0].identifier)
						assert.equal<string>(a.names.vectorSchema, declared.vectorSchema)
					}),
			oracle: {
				kind: "universal",
				name: "a schema's artifacts are one value whichever input reaches it, under its declared levels' names"
			},
			box: "each fixture schema through every ordered pair of its built value, its Owned and its description",
			kept: [],
			kills: []
		}
	)

/** A level is its content, not its name admits a query on its schema renamed and naming the Db's schema, and refuses it on one of other content. Its budget is its suite's before it was a property (test/unit/program/schema-input.test.ts at 4ca3036a): 100 runs and 100 steered cases. */
export const aLevelIsItsContentNotItsNameAdmitsAQueryOnItsSchemaRenamedAndNamingTheDbsSchemaAndRefusesItOnOneOfOtherContent =
	property.explore(contentGen, {
		needs: { changed: changedCases },
		budget: { runs: 100, steered: 100 },
		situations: [
			...Arr.map(identifierFeatures, (feature) => `renamed: ${feature}` as const),
			...contentChanges
		] satisfies ReadonlyArray<Reached<ContentFeature>>,
		check: (resources, c: Case<ContentFeature>) => (content) =>
			Effect.map(resources.changed, (changed) => {
				if (content.kind === "renamed") {
					const { built } = content
					const query = built.subject.query
					c.note(`renamed: ${content.feature}`)
					const what = `a query over ${built.subject.label} on a Db over it renamed ${content.name}`
					const chosen = Result.flatMap(queryInput(query), (input) =>
						querySchema(input, schemaInputOf(content.schema))
					)
					if (!chosen.ok) {
						throw new Error(`${what} is refused: ${chosen.error.message}`)
					}
					assert.deepEqual(
						sqlOf(compiledOrThrow(query, content.schema, what)),
						sqlOf(
							compiledOrThrow(
								readOf(content.schema, built.relation),
								content.schema,
								`${what}, rebuilt over it`
							)
						)
					)
					return
				}
				const db = c.draw(element(changed))
				const query = db.built.subject.query
				c.note(db.change)
				const what = `a query over ${db.built.subject.label} on a Db over it with ${db.change}`
				assert.equal(
					refusal(
						Result.flatMap(queryInput(query), (input) =>
							Result.flatMap(parseSchemaInput(db.schema), (schema) => querySchema(input, schema))
						),
						what
					).reason._tag,
					"MalformedDescription"
				)
				assert.equal(
					refusal(
						Result.flatMap(parseSchemaInput(db.schema), (input) =>
							compileInputTemplate(query, input, testCompile)
						),
						what
					).reason._tag,
					"MalformedDescription"
				)
			}),
		oracle: {
			kind: "specification",
			name: "a level is compared by its content: renamed, its SQL is the renamed schema's own; changed, it is MalformedDescription"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/program/schema-input.test.ts#aLevelIsItsContentNotItsNameAdmitsAQueryOnItsSchemaRenamedAndNamingTheDbsSchemaAndRefusesItOnOneOfOtherContent:-:0.0.0.0"
				),
				reason: "a root renamed to a name of kind alias",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/program/schema-input.test.ts#aLevelIsItsContentNotItsNameAdmitsAQueryOnItsSchemaRenamedAndNamingTheDbsSchemaAndRefusesItOnOneOfOtherContent:-:0.0.2.0"
				),
				reason: "a root renamed to a name of kind digit boundary",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/program/schema-input.test.ts#aLevelIsItsContentNotItsNameAdmitsAQueryOnItsSchemaRenamedAndNamingTheDbsSchemaAndRefusesItOnOneOfOtherContent:-:0.0.3.0"
				),
				reason: "a root renamed to a name of kind long, at the limit",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/program/schema-input.test.ts#aLevelIsItsContentNotItsNameAdmitsAQueryOnItsSchemaRenamedAndNamingTheDbsSchemaAndRefusesItOnOneOfOtherContent:-:0.0.5.0"
				),
				reason: "a root renamed to a name of kind reserved word",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/program/schema-input.test.ts#aLevelIsItsContentNotItsNameAdmitsAQueryOnItsSchemaRenamedAndNamingTheDbsSchemaAndRefusesItOnOneOfOtherContent:-:0.0.1.0"
				),
				reason: "a root renamed to a name of kind catalog type",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/program/schema-input.test.ts#aLevelIsItsContentNotItsNameAdmitsAQueryOnItsSchemaRenamedAndNamingTheDbsSchemaAndRefusesItOnOneOfOtherContent:-:0.0.4.0"
				),
				reason: "a root renamed to a name of kind plain",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/program/schema-input.test.ts#aLevelIsItsContentNotItsNameAdmitsAQueryOnItsSchemaRenamedAndNamingTheDbsSchemaAndRefusesItOnOneOfOtherContent:-:1.0"
				),
				reason: "a root's description with a field added",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/program/schema-input.test.ts#aLevelIsItsContentNotItsNameAdmitsAQueryOnItsSchemaRenamedAndNamingTheDbsSchemaAndRefusesItOnOneOfOtherContent:-:1.1"
				),
				reason: "a root's description with a field removed",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/program/schema-input.test.ts#aLevelIsItsContentNotItsNameAdmitsAQueryOnItsSchemaRenamedAndNamingTheDbsSchemaAndRefusesItOnOneOfOtherContent:-:1.2"
				),
				reason: "a root's description with a type changed",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/program/schema-input.test.ts#aLevelIsItsContentNotItsNameAdmitsAQueryOnItsSchemaRenamedAndNamingTheDbsSchemaAndRefusesItOnOneOfOtherContent:-:1.3"
				),
				reason: "a root's description with a statement added",
				since: "2026-10-29"
			}
		],
		kills: [
			{
				file: "packages/engine/src/schema/levels.ts",
				original: "\t\t\t\treturn other !== undefined && sameContent(desc, other)",
				replacement: "\t\t\t\treturn other !== undefined",
				why: "A level is compared by its relations' names alone."
			}
		]
	})

/** A schema the decoder refuses is refused at the decoder's path, by the schema parser and by a workload compiled against it. Its budget is its suite's before it was a property (test/unit/program/schema-input.test.ts at 4ca3036a): 100 runs and 100 steered cases. */
export const aSchemaTheDecoderRefusesIsRefusedAtTheDecodersPathByTheSchemaParserAndByAWorkloadCompiledAgainstIt =
	property.explore(liveSketchGen, {
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: [
			"live",
			"wild an unnamed relation",
			"wild a field of no kind",
			"wild a statement of no kind"
		] satisfies ReadonlyArray<Reached<CorruptedFeature<DecoderRule>>>,
		check: (_, c: Case<CorruptedFeature<DecoderRule>>) => (sketch) =>
			Effect.sync(() => {
				const live = decodedSchema(
					schemaDesc(c.draw(resolveSchema(sketch, spelling, fullDataSwarm)))
				)
				const broken = c.draw(corrupted(live, corruptions))
				c.note(corruptedFeature(broken))
				/** A login's workload of no program over the schema: its one question is the schema. */
				const logins = [{ login: "server", workloads: [{ schema: live.name, programs: {} }] }]
				/** A broken schema's refusals, by the schema parser and by the workload compiled against it. */
				const refusalsOf = (value: unknown, what: string): ReadonlyArray<CompileError> => [
					refusal(parseSchemaInput(value), `parsing ${what}`),
					refusal(
						Result.flatMap(parseSchemaInput(value), (input) =>
							compileInputWorkload(logins, input, testCompile)
						),
						`a workload over ${what}`
					)
				]
				if (broken.kind === "live") {
					const parsed = parseSchemaInput(broken.value)
					if (!parsed.ok) {
						throw new Error(
							`the schema ${live.name} is refused: ${formatLoc(refusalLoc(parsed.error))}`
						)
					}
					const planned = compileTestWorkload(logins, broken.value, testCompile)
					if (!planned.ok) {
						throw new Error(
							`a workload over ${live.name} is refused: ${formatLoc(refusalLoc(planned.error))}`
						)
					}
					return
				}
				const what = `${live.name} broken at ${broken.at}`
				for (const error of refusalsOf(broken.value, what)) {
					assert.equal(error.reason._tag, "MalformedDescription")
					assert.ok(
						holdsPath(refusalLoc(error).path, broken.refusal),
						`${what} is refused at ${formatLoc(refusalLoc(error))}, not at ${formatPath(broken.refusal)}`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the decoder's own path of each broken site, by the parser and by a workload compiled against it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/shape.ts",
				original:
					"\t\t\treturn Result.err(malformedAt(path.subject, keysTo(refused.place), refused.capability))",
				replacement: "\t\t\treturn Result.err(malformedAt(path.subject, [], refused.capability))",
				why: "A decoder refusal is placed at the root of the value, with no path."
			}
		]
	})
