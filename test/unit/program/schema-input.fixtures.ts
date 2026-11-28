/** What the properties of schema-input.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { constant, element, type Gen, oneOf } from "@bjornpagen/testing/gen"
import type { Corruption } from "@bjornpagen/testing/lsw"
import type { Need } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { FieldDecl, SchemaDesc } from "#compiler/ir/desc.ts"
import { parseSchemaInput } from "#compiler/program/input.ts"
import { schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { own } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import {
	compileTemplate,
	type FixtureSchema,
	inputArtifacts,
	testCompile
} from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import { Employer, Payroll, Reporting } from "#test/support/fixtures/api/payroll.ts"
import { Account, Reports, Work } from "#test/support/fixtures/api/work.ts"
import { type IdentifierFeature, schemaNameGenOtherThan } from "#test/support/kernel/dict.ts"
import type { Spelling } from "#test/support/oracle/gen/domain.ts"
import { defaultSchemaLimits, schemaSketchGen } from "#test/support/oracle/gen/schema.ts"
import { upTo } from "#test/support/up-to.ts"

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
 *   @bjornpagen/testing/lsw), and the path is the site's, held segment by segment, never as printed text.
 *
 * A changed Db is drawn from every site of every change of content that installs, the finite space cut once, when a
 * worker readies the property (changedCases); a rename draws a schema name other than the root's own. No case is
 * discarded.
 *
 * Features: the schema itself, a level, no level; each pair of inputs; a rename to each kind of name, each change of
 * content; a live schema and each decoder rule broken.
 */

/** The refusal a compilation answers, which a case must reach: its reason and location. */
export const refusal = <A>(result: Result.Result<A, CompileError>, what: string): CompileError => {
	if (result.ok) {
		throw new Error(`${what} succeeded`)
	}
	return result.error
}

/** A schema of the fixtures and one query built over it, reading a relation it declares. */
interface Subject {
	readonly label: string
	readonly schema: FixtureSchema
	readonly query: object
}

/** The query over `value` that reads every field of `relation`. */
export const readOf = (value: object, relation: { readonly name: string }): object =>
	queryOver(value).rule((r: RuleValue) => {
		const vars = varsOver(relation, "relation")
		return r.match(relation, vars).find(vars)
	})

const subject = (
	label: string,
	value: FixtureSchema,
	relation: { readonly name: string }
): Subject => ({
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
export const levelsOf = (s: Subject): ReadonlyArray<Subject> => [
	s,
	...Arr.flatMap(extensions, ([extension, base]) => (extension === s ? levelsOf(base) : []))
]

export type LevelFeature = "the schema itself" | "a level" | "no level"

export const subjects = element([work, reports, payroll, reporting])

/**
 * The inputs a schema reaches a compilation through: the value its builder made, the Owned own() returned for it, and
 * the description its builder recorded.
 */
export type Arm = "the built value" | "the Owned" | "its description"

export const arms = element<Arm>(["the built value", "the Owned", "its description"])

/** The subject's schema owned, as the boundary owns its description. */
export const ownedSubjectOf = (s: Subject) =>
	succeeded(
		own(defined(schemaDescOf(s.schema), `the description of ${s.label}`)),
		`the ownership of ${s.label}`
	)

export const inputOf = (s: Subject, arm: Arm): unknown => {
	switch (arm) {
		case "the built value":
			return s.schema
		case "the Owned":
			return ownedSubjectOf(s)
		case "its description":
			return defined(schemaDescOf(s.schema), `the description of ${s.label}`)
	}
}

export type ArtifactsFeature = `${Arm} and ${Arm}`

/** The SQL of a template's two artifacts. */
export const sqlOf = (template: OracleTemplate) => ({
	optimized: Arr.map(template.optimized, (s) => s.sql),
	conservative: Arr.map(template.conservative, (s) => s.sql)
})

export const compiledOrThrow = (
	query: unknown,
	named: FixtureSchema,
	what: string
): OracleTemplate => {
	const compiled = compileTemplate(query, named, testCompile)
	if (!compiled.ok) {
		throw new Error(`${what} does not compile: ${compiled.error.message}`)
	}
	return compiled.value
}

type ContentChange = "a field added" | "a field removed" | "a type changed" | "a statement added"

export const contentChanges: Arr.NonEmptyReadonlyArray<ContentChange> = [
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
	readonly renamed: (name: string) => FixtureSchema
}

const roots: Arr.NonEmptyReadonlyArray<Root> = [
	{
		subject: work,
		relation: Account,
		renamed: (name) => schema(name, Rec.values(Work.relations), Work.statements)
	},
	{
		subject: payroll,
		relation: Employer,
		renamed: (name) => schema(name, Rec.values(Payroll.relations), Payroll.statements)
	}
]

/** A case that renames a root: its schema rebuilt from its own relations and statements under a drawn name. */
type Renamed = Readonly<{
	kind: "renamed"
	built: Root
	name: string
	feature: IdentifierFeature
	schema: FixtureSchema
}>

/** A case that changes a root's content: its description with one change of content, at one site. */
export type Changed = Readonly<{ built: Root; change: ContentChange; schema: unknown }>

export type ContentFeature = `renamed: ${IdentifierFeature}` | ContentChange

/** The type a changed field takes: integer, or bigint for a field that is an integer. */
const otherType = (field: FieldDecl): FieldDecl => ({
	type:
		field.type.kind === "pg" && field.type.type === "int4"
			? { kind: "pg", type: "int8" }
			: { kind: "pg", type: "int4" },
	writing: { kind: "caller" }
})

/** A change of content and the description it makes. */
interface Change {
	readonly change: ContentChange
	readonly desc: unknown
}

/**
 * Every site of every change of content in `base`, each the description it makes: at each stored relation, an integer
 * field added where it holds no `extra`, each field outside its key removed, each such field's type changed, and the
 * relation made mutable where no statement makes it so.
 */
const changesOf = (base: SchemaDesc): ReadonlyArray<Change> =>
	Arr.flatMap(base.relations, (relation, index): ReadonlyArray<Change> => {
		if (relation.kind !== "relation") {
			return []
		}
		const withFields = (
			change: ContentChange,
			fields: Readonly<Record<string, FieldDecl>>
		): Change => ({
			change,
			desc: {
				...base,
				relations: Arr.map(base.relations, (r, i) => (i === index ? { ...relation, fields } : r))
			}
		})
		const others = Arr.filter(
			Rec.toEntries(relation.fields),
			([field]) => !relation.primaryKey.includes(field)
		)
		return [
			...(Rec.has(relation.fields, "extra")
				? []
				: [
						withFields("a field added", {
							...relation.fields,
							extra: { type: { kind: "pg", type: "int4" }, writing: { kind: "caller" } }
						})
					]),
			...Arr.map(others, ([removed]) =>
				withFields(
					"a field removed",
					Rec.fromEntries(
						Arr.filter(Rec.toEntries(relation.fields), ([field]) => field !== removed)
					)
				)
			),
			...Arr.map(others, ([changed, type]) =>
				withFields("a type changed", { ...relation.fields, [changed]: otherType(type) })
			),
			...(Arr.some(base.statements, (s) => s.kind === "mutable" && s.relation === relation.name)
				? []
				: [
						{
							change: "a statement added" as const,
							desc: {
								...base,
								statements: [
									...base.statements,
									{ kind: "mutable" as const, relation: relation.name }
								]
							}
						}
					])
		]
	})

/**
 * Every change of content of every root that installs, at each of its sites, so its one refusal is the level's. Whether
 * a change installs is its compilation's to say, about 50 ms each over 151 sites (94 install), so the finite space is
 * cut once per worker, when the worker readies the property (the need's open, outside every case's deadline), never
 * when the module loads: the runner's parent imports every test module and runs none of its cases. A case draws its
 * change from the whole cut space (contentGen's "changed"): no draw is discarded.
 */
export const changedCases: Need<Arr.NonEmptyReadonlyArray<Changed>> = {
	key: "test/unit/program/schema-input.fixtures.ts changedCases",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() =>
		Effect.succeed(
			nonEmpty(
				Arr.flatMap(roots, (built) =>
					Arr.flatMap(
						changesOf(
							defined(
								schemaDescOf(built.subject.schema),
								`the description of ${built.subject.label}`
							)
						),
						({ change, desc }): ReadonlyArray<Changed> =>
							Result.flatMap(parseSchemaInput(desc), (input) => inputArtifacts(input, testCompile))
								.ok
								? [{ built, change, schema: desc }]
								: []
					)
				),
				"a change of content that installs"
			)
		)
	)
}

/** Each root with the schema names other than its own, which a rename draws from: no draw renames it to itself. */
const renamings = Object.freeze(
	Arr.map(roots, (built) => ({
		built,
		names: schemaNameGenOtherThan(new Set([built.subject.label]))
	}))
)

/** A root renamed to a schema name other than its own, which no change of content touches. */
const renamedCase: Gen<Renamed> = (source) => {
	const { built, names } = source.draw(element(renamings))
	const name = source.draw(names)
	return {
		kind: "renamed",
		built,
		name: name.declared,
		feature: name.feature,
		schema: built.renamed(name.declared)
	}
}

/**
 * What the space draws of a case: a rename whole, or that the case changes a root's content, which change the case then
 * draws from those a worker cut once (changedCases), the next draw on its tape.
 */
export type Content = Renamed | Readonly<{ kind: "changed" }>

/** A case: a rename or a change of content, each as often as the other. */
export const contentGen: Gen<Content> = oneOf<Content>([
	renamedCase,
	constant({ kind: "changed" } as const)
])

/** The kinds of name a rename must reach: every kind a schema name is admitted of. */
export const identifierFeatures: Arr.NonEmptyReadonlyArray<IdentifierFeature> = [
	"alias",
	"digit boundary",
	"long, at the limit",
	"reserved word",
	"catalog type",
	"plain"
]

export type DecoderRule = "an unnamed relation" | "a field of no kind" | "a statement of no kind"

/** The relations of `live` with the one at `index` replaced. */
const withRelation = (live: SchemaDesc, index: number, relation: unknown): unknown => ({
	...live,
	relations: Arr.map(live.relations, (r, i) => (i === index ? relation : r))
})

/** A location's path, as the decoder's segments: a key, or an index. */
type Path = ReadonlyArray<string | number>

/** Whether `path` holds `site`'s segments in a row: the site is where the decode refused, under whatever it nests in. */
export const holdsPath = (path: Path, site: Path): boolean =>
	Arr.some(
		upTo(path.length - site.length + 1, (i) => i),
		(from) => Arr.every(site, (segment, i) => path[from + i] === segment)
	)

/**
 * Each rule's sites in a live schema, with the path the decoder refuses each at (ir/desc.ts schema shapes), as its
 * segments: a relation by its index, a field by its key.
 */
export const corruptions: Arr.NonEmptyReadonlyArray<Corruption<SchemaDesc, Path, DecoderRule>> = [
	{
		rule: "an unnamed relation",
		from: "wild",
		weight: 1,
		sites: (live) =>
			Arr.map(live.relations, (r, i) => ({
				value: withRelation(live, i, { ...r, name: "" }),
				refusal: ["relations", i, "name"],
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
							refusal: ["relations", i, "fields", field, "kind"],
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
				refusal: ["statements", i, "kind"],
				at: `statement ${s.kind}`
			}))
	}
]

/**
 * The live schemas a corruption breaks: the differential oracle's generated schemas, relations, rosters, keys, mutable
 * relations and containments, each the Description its public constructors record (gen/schema.ts schemaDesc).
 */
export const liveSketchGen = schemaSketchGen({ ...defaultSchemaLimits, containments: "often" })

/** The spelling a live schema's rosters and fields are drawn under. */
export const spelling: Spelling = { mode: "drawn", edge: false }
