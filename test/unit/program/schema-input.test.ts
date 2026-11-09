import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore, type Kept } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import {
	corrupted,
	corruptedFeature,
	type CorruptedFeature,
	type Corruption
} from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { formatLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { FieldDecl, SchemaDesc } from "#compiler/ir/desc.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { queryInput, querySchema } from "#compiler/program/compile.ts"
import { parseSchemaInput, schemaArtifacts } from "#compiler/program/schema.ts"
import { schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { assert, containsText, defined, refusalLoc, succeeded } from "#test/support/assert.ts"
import {
	compileTemplate,
	compileTestWorkload,
	schemaInputOf,
	testArtifacts,
	testCompile
} from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import { Employer, Payroll, Reporting } from "#test/support/fixtures/api/payroll.ts"
import { Account, Reports, Work } from "#test/support/fixtures/api/work.ts"
import { decodedSchema } from "#test/support/fixtures/ir/desc.ts"
import {
	type Admitted,
	admittedSchemaNames,
	type IdentifierFeature,
	schemaNameGen
} from "#test/support/kernel/dict.ts"
import { caseHang } from "#test/support/limits.ts"
import type { Spelling } from "#test/support/oracle/gen/domain.ts"
import {
	defaultSchemaLimits,
	fullDataSwarm,
	resolveSchema,
	schemaDesc,
	schemaSketchGen
} from "#test/support/oracle/gen/schema.ts"
import { pickGen, pickFrom } from "#test/support/pick.ts"

/**
 * The schema a compilation is given, parsed once (program/schema.ts parseSchemaInput), and the schema a query compiles
 * against (program/compile.ts querySchema).
 *
 * - A query value carries the schema it was built over, and the caller names the schema to compile it against: the
 *   Db's. The query compiles only where its schema is one of the named schema's levels, the named schema itself or one
 *   its extends chain reaches, as the type level states it (types/schema/schema.ts IsLevelOf); a query over another
 *   schema or over an extension of the named one is refused with MalformedDescription before any SQL, never compiled
 *   silently against the named schema. The space is exhaustive over pairs of the public fixtures' schemas: Work, its
 *   extension Reports, Payroll and its extension Reporting. The oracle is the extensions the fixtures build
 *   (schema.extend), stated here.
 * - A level is compared by its content, without its own name, which only places the installation: a query is admitted
 *   on a Db over its schema rebuilt from the same relations and statements under a drawn name, and its SQL is the SQL of
 *   the same query built over the renamed schema, naming the Db's schema; it is refused on a Db over its schema with a
 *   drawn change of content (a field added or removed, a field's type changed, a statement added), which installs.
 * - A schema's artifacts (program/schema.ts schemaArtifacts) are one value whichever input reaches the schema: the
 *   value its builder made, the Owned own() returned for it, or the description its builder recorded, so a schema is
 *   installed once. Each call computes them, so one value is one content: the owned schema's fingerprint and the names
 *   it installs under. They are the artifacts of that Owned, under its declared levels' PostgreSQL schemas and the
 *   installer's vector schema. The space is exhaustive over the four fixture schemas and every ordered pair of their
 *   inputs.
 * - A schema value the decoder refuses is refused with the decoder's own path, by parseSchemaInput and by a workload
 *   compiled against it, never by a generic "a schema value or SchemaDesc". The values are generated schemas (the
 *   differential oracle's, gen/schema.ts), each broken at one site of one decoder rule (a corruption,
 *   @grizzle/testing/lsw), and the path is the site's.
 *
 * The refusal a compilation answers, which a case must reach: its reason and location.
 */
const refusal = <A>(result: Result.Result<A, CompileError>, what: string): CompileError => {
	if (result.ok) {
		throw new Error(`${what} succeeded`)
	}
	return result.error
}

/** A schema of the fixtures and one query built over it, reading a relation it declares. */
interface Subject {
	readonly label: string
	readonly schema: object
	readonly query: object
}

/** The query over `value` that reads every field of `relation`. */
const readOf = (value: object, relation: { readonly name: string }): object =>
	queryOver(value).rule((r: RuleValue) => {
		const vars = varsOver(relation, "relation")
		return r.match(relation, vars).find(vars)
	})

const subject = (label: string, value: object, relation: { readonly name: string }): Subject => ({
	label,
	schema: value,
	query: readOf(value, relation)
})

const work = subject("Work", Work, Account)
const reports = subject("Reports", Reports, Account)
const payroll = subject("Payroll", Payroll, Employer)
const reporting = subject("Reporting", Reporting, Employer)

/** The extensions the fixtures build, each with the schema it extends (schema.extend). */
const extensions: ReadonlyArray<readonly [Subject, Subject]> = [
	[reports, work],
	[reporting, payroll]
]

/** A schema and every schema its extends chain reaches. */
const levelsOf = (s: Subject): ReadonlyArray<Subject> => [
	s,
	...Arr.flatMap(extensions, ([extension, base]) => (extension === s ? levelsOf(base) : []))
]

type LevelFeature = "the schema itself" | "a level" | "no level"

const subjects = element([work, reports, payroll, reporting])

describe("the schema a query compiles against", () => {
	it.effect(
		"is the named schema, where the query's own is one of its levels, and nothing else",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/program/schema-input-levels",
						/** The query's schema, then the schema the caller names: every ordered pair of the four. */
						generator: (source) => [source.draw(subjects), source.draw(subjects)] as const,
						literal: Formatter.format,
						limit: 16,
						coverage: requiredInSpace<LevelFeature>(["the schema itself", "a level", "no level"]),
						caseHang
					},
					([built, named], c) =>
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
						})
				)
			)
	)
})

/**
 * The inputs a schema reaches a compilation through: the value its builder made, the Owned own() returned for it, and
 * the description its builder recorded.
 */
type Arm = "the built value" | "the Owned" | "its description"

const arms = element<Arm>(["the built value", "the Owned", "its description"])

/** The subject's schema owned, as the boundary owns its description. */
const ownedOf = (s: Subject) =>
	succeeded(
		own(defined(schemaDescOf(s.schema), `the description of ${s.label}`)),
		`the ownership of ${s.label}`
	)

const inputOf = (s: Subject, arm: Arm): unknown => {
	switch (arm) {
		case "the built value":
			return s.schema
		case "the Owned":
			return ownedOf(s)
		case "its description":
			return defined(schemaDescOf(s.schema), `the description of ${s.label}`)
	}
}

type ArtifactsFeature = `${Arm} and ${Arm}`

describe("the artifacts of a schema", () => {
	it.effect("are one value whichever input reaches the schema, under its declared names", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					box: { kind: "unstated" },
					oracle: { kind: "unstated" },
					suite: "unit/program/schema-input-artifacts",
					/** Each fixture schema and each ordered pair of its inputs: 4 * 9. */
					generator: (source) =>
						[
							source.draw(subjects),
							source.draw((source) => [source.draw(arms), source.draw(arms)] as const)
						] as const,
					literal: Formatter.format,
					limit: 36,
					coverage: requiredInSpace<ArtifactsFeature>([
						"the built value and the Owned",
						"the built value and its description",
						"the Owned and its description"
					]),
					caseHang
				},
				([s, [first, second]], c) =>
					Effect.sync(() => {
						c.note(`${first} and ${second}`)
						const owned = ownedOf(s)
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
						const declared = installOptions(owned, undefined)
						assert.equal(a.names.schema, declared.levels[0].identifier)
						assert.equal<string>(a.names.vectorSchema, declared.vectorSchema)
					})
			)
		)
	)
})

/** The SQL of a template's two artifacts. */
const sqlOf = (template: OracleTemplate) => ({
	optimized: Arr.map(template.optimized, (s) => s.sql),
	conservative: Arr.map(template.conservative, (s) => s.sql)
})

const compiledOrThrow = (query: unknown, named: unknown, what: string): OracleTemplate => {
	const compiled = compileTemplate(query, named, testCompile)
	if (!compiled.ok) {
		throw new Error(`${what} does not compile: ${compiled.error.message}`)
	}
	return compiled.value
}

type ContentChange = "a field added" | "a field removed" | "a type changed" | "a statement added"

const contentChanges: Arr.NonEmptyReadonlyArray<ContentChange> = [
	"a field added",
	"a field removed",
	"a type changed",
	"a statement added"
]

/**
 * A root schema of the fixtures the query of a case is built over: the relation its query reads, and the schema
 * rebuilt from its own relations and statements under another name.
 */
interface Root {
	readonly subject: Subject
	readonly relation: { readonly name: string }
	readonly renamed: (name: string) => object
}

const roots: Arr.NonEmptyReadonlyArray<Root> = [
	{
		subject: work,
		relation: Account,
		renamed: (name) => schema(name, Work.relations, Work.statements)
	},
	{
		subject: payroll,
		relation: Employer,
		renamed: (name) => schema(name, Payroll.relations, Payroll.statements)
	}
]

/** The Db a case opens: its schema rebuilt under a drawn name, or its description with one drawn change of content. */
type Db =
	| {
			readonly kind: "renamed"
			readonly name: string
			readonly feature: IdentifierFeature
			readonly schema: object
	  }
	| { readonly kind: "changed"; readonly change: ContentChange; readonly schema: unknown }

type ContentFeature = `renamed: ${IdentifierFeature}` | ContentChange

/** The type a changed field takes: integer, or bigint for a field that is an integer. */
const otherType = (field: FieldDecl): FieldDecl => ({
	type:
		field.type.kind === "pg" && field.type.type === "integer"
			? { kind: "pg", type: "bigint" }
			: { kind: "pg", type: "integer" },
	writing: { kind: "caller" }
})

/**
 * A description with one change of content made, or none where the picks select no site of the change: a relation
 * with no field outside its key, one that already holds the added field, or one already mutable.
 */
type Changed = { readonly kind: "changed"; readonly desc: unknown } | { readonly kind: "no site" }

const noSite: Changed = { kind: "no site" }

/** The description of `base` with `change` made at the stored relation and the non-key field the picks select. */
const changedDesc = (
	base: SchemaDesc,
	change: ContentChange,
	relationPick: number,
	fieldPick: number
): Changed => {
	const stored = Arr.flatMap(base.relations, (r, i) =>
		r.kind === "relation" ? [{ relation: r, index: i }] : []
	)
	if (!Arr.isReadonlyArrayNonEmpty(stored)) {
		throw new Error(`a stored relation of ${base.name}`)
	}
	const { relation, index } = pickFrom(stored, relationPick)
	const withFields = (fields: Readonly<Record<string, FieldDecl>>): Changed => ({
		kind: "changed",
		desc: {
			...base,
			relations: Arr.map(base.relations, (r, i) => (i === index ? { ...relation, fields } : r))
		}
	})
	const others = Arr.filter(
		Rec.toEntries(relation.fields),
		([field]) => !relation.primaryKey.includes(field)
	)
	switch (change) {
		case "a field added":
			return Rec.has(relation.fields, "extra")
				? noSite
				: withFields({
						...relation.fields,
						extra: { type: { kind: "pg", type: "integer" }, writing: { kind: "caller" } }
					})
		case "a field removed": {
			if (!Arr.isReadonlyArrayNonEmpty(others)) {
				return noSite
			}
			const [removed] = pickFrom(others, fieldPick)
			return withFields(
				Rec.fromEntries(Arr.filter(Rec.toEntries(relation.fields), ([field]) => field !== removed))
			)
		}
		case "a type changed": {
			if (!Arr.isReadonlyArrayNonEmpty(others)) {
				return noSite
			}
			const [changed, type] = pickFrom(others, fieldPick)
			return withFields({ ...relation.fields, [changed]: otherType(type) })
		}
		case "a statement added":
			return Arr.some(base.statements, (s) => s.kind === "mutable" && s.relation === relation.name)
				? noSite
				: {
						kind: "changed",
						desc: {
							...base,
							statements: [...base.statements, { kind: "mutable", relation: relation.name }]
						}
					}
	}
}

/** A case: a root of the fixtures and the Db it opens. */
interface ContentCase {
	readonly built: Root
	readonly db: Db
}

/**
 * What a case is drawn from: a root, whether it is renamed, the name it takes, and the change its content takes with
 * the picks of the relation and the field it is made at.
 */
interface ContentSketch {
	readonly built: Root
	readonly renamed: boolean
	readonly name: Admitted
	readonly change: ContentChange
	readonly relation: number
	readonly field: number
}

const contentSketchGen: Gen<ContentSketch> = (source) => ({
	built: source.draw(element(roots)),
	renamed: source.draw(boolean),
	name: source.draw(schemaNameGen),
	change: source.draw(element(contentChanges)),
	relation: source.draw(pickGen),
	field: source.draw(pickGen)
})

/**
 * The case of a sketch, or none. A draw that renames a root to its own name, or whose change has no site or does not
 * install, is no case: a changed description is drawn only where it installs, so its one refusal is the level's.
 */
const contentOf = ({
	built,
	renamed,
	name,
	change,
	relation,
	field
}: ContentSketch): Option.Option<ContentCase> => {
	if (renamed) {
		return name.declared === built.subject.label
			? Option.none()
			: Option.some({
					built,
					db: {
						kind: "renamed",
						name: name.declared,
						feature: name.feature,
						schema: built.renamed(name.declared)
					}
				})
	}
	const base = defined(
		schemaDescOf(built.subject.schema),
		`the description of ${built.subject.label}`
	)
	const changed = changedDesc(base, change, relation, field)
	return changed.kind === "changed" && testArtifacts(changed.desc, testCompile).ok
		? Option.some({ built, db: { kind: "changed", change, schema: changed.desc } })
		: Option.none()
}

/**
 * Planted: a rename to a name of each of the dictionary's kinds, and each change of content at the first relation and
 * field of the first root.
 */
const identifierFeatures: Arr.NonEmptyReadonlyArray<IdentifierFeature> = [
	"alias",
	"digit boundary",
	"long, at the limit",
	"reserved word",
	"catalog type",
	"plain"
]

const keptContent: ReadonlyArray<Kept<ContentSketch, ContentFeature>> = (() => {
	const [built] = roots
	const nameOf = (feature: IdentifierFeature): Admitted =>
		Option.getOrThrow(
			Arr.findFirst(
				admittedSchemaNames,
				(n) => n.feature === feature && n.declared !== built.subject.label
			)
		)
	const base = {
		built,
		renamed: false,
		name: nameOf("plain"),
		change: contentChanges[0],
		relation: 0,
		field: 0
	}
	return [
		...Arr.map(identifierFeatures, (feature) => ({
			note: `a root renamed to a name of kind ${feature}`,
			sketch: { ...base, renamed: true, name: nameOf(feature) },
			draws: "",
			reaches: [`renamed: ${feature}` as const] as const
		})),
		...Arr.map(contentChanges, (change) => ({
			note: `a root's description with ${change}`,
			sketch: { ...base, change },
			draws: "",
			reaches: [change] as const
		}))
	]
})()

describe("a level is its content, not its name", () => {
	it.effect(
		"admits a query on its schema renamed and naming the Db's schema, and refuses it on one of other content",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/program/schema-input-content",
						draw: drawn(contentSketchGen),
						literal: Formatter.format,
						coverage: required<ContentFeature>(
							[
								...Arr.map(identifierFeatures, (feature) => `renamed: ${feature}` as const),
								...contentChanges
							],
							{ cases: 100, sense: notesOnly }
						),
						kept: keptContent,
						/**
						 * The rotating stream's sample: half the cases rename over a dictionary of five kinds of name, half change
						 * one of four parts of the content.
						 */
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, c) =>
						Effect.gen(function* () {
							const content = contentOf(sketch)
							if (Option.isNone(content)) {
								return yield* c.assume(false)
							}
							const { built, db } = content.value
							const query = built.subject.query
							if (db.kind === "renamed") {
								c.note(`renamed: ${db.feature}`)
								const what = `a query over ${built.subject.label} on a Db over it renamed ${db.name}`
								const chosen = Result.flatMap(queryInput(query), (input) =>
									querySchema(input, schemaInputOf(db.schema))
								)
								if (!chosen.ok) {
									throw new Error(`${what} is refused: ${chosen.error.message}`)
								}
								assert.deepEqual(
									sqlOf(compiledOrThrow(query, db.schema, what)),
									sqlOf(
										compiledOrThrow(
											readOf(db.schema, built.relation),
											db.schema,
											`${what}, rebuilt over it`
										)
									)
								)
								return
							}
							c.note(db.change)
							const what = `a query over ${built.subject.label} on a Db over it with ${db.change}`
							assert.equal(
								refusal(
									Result.flatMap(queryInput(query), (input) =>
										querySchema(input, schemaInputOf(db.schema))
									),
									what
								).reason._tag,
								"MalformedDescription"
							)
							assert.equal(
								refusal(compileTemplate(query, db.schema, testCompile), what).reason._tag,
								"MalformedDescription"
							)
						})
				)
			)
	)
})

type DecoderRule = "an unnamed relation" | "a field of no kind" | "a statement of no kind"

/** The relations of `live` with the one at `index` replaced. */
const withRelation = (live: SchemaDesc, index: number, relation: unknown): unknown => ({
	...live,
	relations: Arr.map(live.relations, (r, i) => (i === index ? relation : r))
})

/**
 * Each rule's sites in a live schema, with the path the decoder refuses each at (ir/desc.ts schema shapes): a field is
 * named by its key, which every fixture's field names spell as a plain path segment.
 */
const corruptions: Arr.NonEmptyReadonlyArray<Corruption<SchemaDesc, string, DecoderRule>> = [
	{
		rule: "an unnamed relation",
		from: "wild",
		weight: 1,
		sites: (live) =>
			Arr.map(live.relations, (r, i) => ({
				value: withRelation(live, i, { ...r, name: "" }),
				refusal: `relations[${i}].name`,
				at: `relation ${r.name}`
			}))
	},
	{
		rule: "a field of no kind",
		from: "wild",
		weight: 1,
		sites: (live) =>
			Arr.flatMap(live.relations, (r, i) =>
				r.kind === "relation"
					? Arr.map(Rec.keys(r.fields), (field) => ({
							value: withRelation(live, i, {
								...r,
								fields: { ...r.fields, [field]: { kind: "nothing" } }
							}),
							refusal: `relations[${i}].fields.${field}.kind`,
							at: `field ${r.name}.${field}`
						}))
					: []
			)
	},
	{
		rule: "a statement of no kind",
		from: "wild",
		weight: 1,
		sites: (live) =>
			Arr.map(live.statements, (s, i) => ({
				value: {
					...live,
					statements: Arr.map(live.statements, (t, j) => (j === i ? { ...t, kind: "nothing" } : t))
				},
				refusal: `statements[${i}].kind`,
				at: `statement ${s.kind}`
			}))
	}
]

/**
 * The live schemas a corruption breaks: the differential oracle's generated schemas, relations, rosters, keys, mutable
 * relations and containments, each the Description its public constructors record (gen/schema.ts schemaDesc).
 */
const liveSketchGen = schemaSketchGen({ ...defaultSchemaLimits, containments: "often" })

/** The spelling a live schema's rosters and fields are drawn under. */
const spelling: Spelling = { mode: "drawn", edge: false }

describe("a schema the decoder refuses", () => {
	it.effect(
		"is refused at the decoder's path, by the schema parser and by a workload compiled against it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/program/schema-input-decoder",
						draw: drawn(liveSketchGen),
						literal: Formatter.format,
						coverage: required<CorruptedFeature<DecoderRule>>(
							[
								"live",
								"wild an unnamed relation",
								"wild a field of no kind",
								"wild a statement of no kind"
							],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						/**
						 * Five cases in six break one of three rules: a hundred cases break each rule more than twenty times.
						 */
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, c) =>
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
								refusal(compileTestWorkload(logins, value, testCompile), `a workload over ${what}`)
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
								containsText(
									formatLoc(refusalLoc(error)),
									broken.refusal,
									`${what} is refused at ${formatLoc(refusalLoc(error))}, not at ${broken.refusal}`
								)
							}
						})
				)
			)
	)
})
