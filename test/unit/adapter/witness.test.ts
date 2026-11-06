import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { uuid as uuidValue } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Predicate,
	Record as Rec,
	String as Str
} from "effect"
import { ExecutionFailure, TransientFailure } from "#adapter/errors/execution.ts"
import type { ServerError } from "#adapter/errors/failures.ts"
import { classifyServerError, type FailureOrigin } from "#adapter/outcomes/index.ts"
import { installationWitness } from "#adapter/witness/index.ts"
import type { TransientTag } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { codeOf, draftCodebook, firstCodebook, noRenames } from "#compiler/ir/codes.ts"
import type { LawField } from "#compiler/ir/law.ts"
import {
	parseSchemaInput,
	type SchemaArtifacts,
	schemaArtifacts
} from "#compiler/program/schema.ts"
import { bits, closedId, contract, pg, uuid } from "#compiler/public/fields.ts"
import { check, closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import type { KeyHost, Law, Witness } from "#compiler/types/changeset/changeset.ts"
import type { UniqueAbort, WriteStep } from "#compiler/write/program/artifact.ts"
import { type ConcurrentChangeTag, encodeRefusalDetail } from "#compiler/write/refusal.ts"
import { awkwardCode, Clubs } from "#test/pg/laws/outcomes/schemas.ts"
import { assert, defined, nonEmpty, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { nothingReported, type Reported, serverError } from "#test/support/server-error.ts"

/**
 * What a server error at a write means (packages/grizzle/src/adapter/outcomes classifyServerError, over the
 * installation's violation classifier, packages/grizzle/src/adapter/witness), read only from the fields grizzle controls,
 * never from the server's prose.
 *
 * Over three installations (the worked example's Work; Clubs, whose key holds a code, a bigint and a refined text; and a
 * schema whose roster lost a handle, so its codes hold a hole, whose two contracts of one definition share a domain),
 * a drawn ErrorResponse: a SQLSTATE grizzle branches on or another; a constraint the installation installs, under its
 * table or domain, a law's identity, a name of no installation, or none; the schema it reports, the installation's,
 * another or none; the table or data type, the constraint's owner, another of the installation, another domain or
 * none; and a DETAIL grizzle's refusal or concurrent change encodes, prose, or none. It is raised at a drawn origin of a
 * write's flights: a stored-suffix read, a statement of each step kind writing drawn relations, with the unique aborts
 * its statement lists, a read-back, or the COMMIT.
 *
 * The oracle is the classification rules (outcomes/index.ts and witness/classify.ts) restated over the installation's
 * constraint list, its laws and its rosters: SERIALIZABLE's 40001 and 40P01, and a 23505 or 23P01 on a constraint the
 * statement lists as an abort, are TransientFailure; a 40Z01 whose DETAIL names a concurrent change at one of the
 * installation's stored relations is that change's TransientFailure, and one at any other relation (a closed relation
 * of the installation, another installation's relation, a name of none) is no outcome the installation reads; a 42Z01
 * names the entry outside which a fact fell; a 23514 on one of the installation's roster domains
 * is grizzle's own defect; a 23000 on a law's identity with grizzle's DETAIL rejects that law at the refused key, decoded
 * through its columns (a uuid as its text, an integer as its number, a closed id's code as its handle, a text as itself);
 * any other class 23 violation reported in the installation's schema rejects the laws its constraint maps to under the
 * owner it reports, a shared domain's narrowed to the columns of the relations the statement writes, its witness
 * unreported; and everything else is ExecutionFailure carrying the server's report as given. Which constraint maps to
 * which law is the installation's (the law families and the write oracle hold it to PostgreSQL's refusals).
 */

/** A schema whose roster Kind lost a handle, so its codes hold a hole, and whose two contracts share one domain. */
const Kind = closed("Kind", ["leaf", "branch", "root"])
const Seats = contract("Seats", pg.integer, (x) => x.le(500))
const Count = contract("Count", pg.integer, (x) => x.ge(0))
const Tally = contract("Tally", pg.integer, (x) => x.ge(0))
const Node = relation(
	"Node",
	{
		id: uuid,
		kind: closedId(Kind),
		marks: bits(Kind),
		seats: Seats,
		count: Count,
		label: str.regex("^.{1,20}$", "su")
	},
	["id"]
)
const Tag = relation("Tag", { id: uuid, tally: Tally }, ["id"])
const Rosters = schema("RosterDomains", { Kind, Node, Tag }, [
	check("SeatsPositive", Node, (x) => x.gt(x.seats, 0))
])
const rostersOwned = succeeded(own(defined(schemaDescOf(Rosters), "Rosters is a built schema")))
const rostersArtifacts = succeeded(
	schemaArtifacts(succeeded(parseSchemaInput(Rosters)), {
		installation: undefined,
		vectorSchema: undefined,
		codes: succeeded(
			draftCodebook(
				firstCodebook([
					{
						closed: defined(rostersOf(rostersOwned)[0], "Rosters declares Kind").closed,
						handles: ["leaf", "gone", "branch"]
					}
				]),
				noRenames,
				rostersOf(rostersOwned)
			)
		)
	})
)

type InstallationName = "Work" | "Clubs" | "RosterDomains"

const installations: Readonly<Record<InstallationName, SchemaArtifacts>> = {
	Work: succeeded(testArtifacts(W.Work, testCompile)),
	Clubs: succeeded(testArtifacts(Clubs, testCompile)),
	RosterDomains: rostersArtifacts
}

/** A key field's text as a refusal's DETAIL carries it, and the value the witness holds for it. */
interface KeyValue {
	readonly text: string
	readonly value: KeyHost
}

/**
 * Texts a text key field draws: quotes, backslashes, a comma and a bracket, which the DETAIL's encoding escapes, and
 * characters outside ASCII.
 */
const keyTexts = [
	"plain",
	'a "quoted" one',
	"a \\ backslash",
	"é 😀",
	" spaced ",
	"line\nbreak",
	awkwardCode
] as const

/**
 * A value of a key field of `type` and its text, for the carriers the installations' keys hold, or undefined for a
 * carrier none of them keys by.
 */
const keyValueGen = (artifacts: SchemaArtifacts, field: LawField): Gen<KeyValue> | undefined => {
	const type = field.type
	switch (type.carrier) {
		case "uuid":
			return (source) => {
				const text = source.draw(uuidValue(4))
				return { text, value: text }
			}
		case "int8":
			return (source) => {
				const n = source.draw(int(-1_000_000, 1_000_000))
				return { text: String(n), value: BigInt(n) }
			}
		case "int2":
		case "int4":
			return (source) => {
				const n = source.draw(int(-30_000, 30_000))
				return { text: String(n), value: n }
			}
		case "text":
			return (source) => {
				const text = source.draw(element(keyTexts))
				return { text, value: text }
			}
		case "code": {
			const codec = defined(
				artifacts.names.codes.rosters.get(type.roster.closed),
				"the roster's codes"
			)
			const live = nonEmpty(
				Arr.filter(codec.names, (name) => name !== ""),
				"a roster's live handles"
			)
			return (source) => {
				const handle = source.draw(element(live))
				return { text: String(codeOf(codec, handle)), value: handle }
			}
		}
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "date":
		case "bits":
		case "range4":
		case "range8":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}

/** Where the statement that raised a report sits in a write's flights, and what it writes. */
type OriginKind =
	| "a stored-suffix read"
	| "a write statement"
	| "a single statement"
	| "a family statement"
	| "a carrier's create"
	| "an ANALYZE"
	| "a serial advance"
	| "a read-back step"
	| "an entry's precheck"
	| "a read-back past the statements"
	| "the COMMIT"

/** A unique abort the raising statement lists: the reported constraint or another, for one of the reasons. */
interface AbortSketch {
	readonly reported: boolean
	readonly reason: UniqueAbort["reason"]
	readonly relation: number
}

interface OriginSketch {
	readonly kind: OriginKind
	readonly relations: ReadonlyArray<number>
	readonly aborts: ReadonlyArray<AbortSketch>
}

/** What the report's DETAIL holds. */
type DetailSketch =
	| { readonly kind: "none" }
	| { readonly kind: "prose" }
	| {
			readonly kind: "a refusal"
			readonly relation: number
			readonly foreign: "none" | "a relation of no installation" | "a field the relation lacks"
	  }
	| {
			readonly kind: "a concurrent change"
			readonly reason: ConcurrentChangeTag
			readonly relation: number
			readonly at: ChangeAt
	  }

/**
 * The relation a concurrent change's DETAIL names: a stored relation of the installation, which a write statement
 * raises one at, or another, which none of the installation's statements does.
 */
type ChangeAt =
	| "a stored relation"
	| "a closed relation"
	| "another installation's relation"
	| "a name of no installation"

/** The reported constraint. */
type ConstraintSketch =
	| { readonly kind: "an installed constraint"; readonly pick: number }
	| { readonly kind: "a law's identity"; readonly pick: number }
	| {
			readonly kind: "a roster domain's check"
			readonly pick: number
			readonly carrier: "code" | "bits"
	  }
	| { readonly kind: "a name of no installation" }
	| { readonly kind: "none" }

/** Where the report says the violation is: the schema, and the table or data type. */
type SchemaSketch = "the installation's" | "another" | "none"
type OwnerSketch =
	| "the constraint's own"
	| "another table of the installation"
	| "another installation's domain"
	| "a bits domain at a width the installation lacks"
	| "none"

interface ReportSketch {
	readonly installation: InstallationName
	readonly sqlstate: string
	readonly constraint: ConstraintSketch
	readonly schema: SchemaSketch
	readonly owner: OwnerSketch
	readonly detail: DetailSketch
	readonly origin: OriginSketch
}

/** The SQLSTATEs a report draws: every one the rules branch on, and others they pass on. */
const sqlstateDictionary: Arr.NonEmptyReadonlyArray<string> = [
	sqlstates.serializationFailure,
	sqlstates.deadlockDetected,
	sqlstates.uniqueViolation,
	sqlstates.exclusionViolation,
	sqlstates.checkViolation,
	sqlstates.foreignKeyViolation,
	sqlstates.integrityConstraintViolation,
	sqlstates.grizzleConcurrentChange,
	sqlstates.grizzleOutsideWorld,
	sqlstates.grizzleDeliveredType,
	sqlstates.insufficientPrivilege,
	"23502",
	"22012",
	"XX000"
]

const pick = int(0, 0xffff)

const originGen: Gen<OriginSketch> = (source) => ({
	kind: source.draw(
		element<OriginKind>([
			"a stored-suffix read",
			"a write statement",
			"a single statement",
			"a family statement",
			"a carrier's create",
			"an ANALYZE",
			"a serial advance",
			"a read-back step",
			"an entry's precheck",
			"a read-back past the statements",
			"the COMMIT"
		])
	),
	relations: source.draw(array(pick, { min: 1, max: 2 })),
	aborts: source.draw(
		array(
			(inner): AbortSketch => ({
				reported: inner.draw(boolean),
				reason: inner.draw(
					element<UniqueAbort["reason"]>([
						"GeneratedSerialUnique",
						"UnseenOccupant",
						"PutTargetConflict"
					])
				),
				relation: inner.draw(pick)
			}),
			{ min: 0, max: 2 }
		)
	)
})

const constraintGen: Gen<ConstraintSketch> = weighted<ConstraintSketch>([
	[6, (inner) => ({ kind: "an installed constraint", pick: inner.draw(pick) })],
	[3, (inner) => ({ kind: "a law's identity", pick: inner.draw(pick) })],
	[
		2,
		(inner) => ({
			kind: "a roster domain's check",
			pick: inner.draw(pick),
			carrier: inner.draw(element(["code", "bits"] as const))
		})
	],
	[1, constant({ kind: "a name of no installation" })],
	[1, constant({ kind: "none" })]
])

const schemaGen: Gen<SchemaSketch> = weighted<SchemaSketch>([
	[6, constant("the installation's")],
	[1, constant("another")],
	[1, constant("none")]
])

const ownerGen: Gen<OwnerSketch> = weighted<OwnerSketch>([
	[6, constant("the constraint's own")],
	[1, constant("another table of the installation")],
	[1, constant("another installation's domain")],
	[1, constant("a bits domain at a width the installation lacks")],
	[1, constant("none")]
])

const refusalGen: Gen<DetailSketch> = (inner) => ({
	kind: "a refusal",
	relation: inner.draw(pick),
	foreign: inner.draw(
		weighted<"none" | "a relation of no installation" | "a field the relation lacks">([
			[4, constant("none")],
			[1, constant("a relation of no installation")],
			[1, constant("a field the relation lacks")]
		])
	)
})

const changeGen: Gen<DetailSketch> = (inner) => ({
	kind: "a concurrent change",
	reason: inner.draw(element<ConcurrentChangeTag>(["PutTargetConflict", "SpanKeyChange"])),
	relation: inner.draw(pick),
	at: inner.draw(
		weighted<ChangeAt>([
			[5, constant("a stored relation")],
			[1, constant("a closed relation")],
			[1, constant("another installation's relation")],
			[1, constant("a name of no installation")]
		])
	)
})

const detailGen: Gen<DetailSketch> = oneOf<DetailSketch>([
	constant({ kind: "none" }),
	constant({ kind: "prose" }),
	refusalGen,
	changeGen
])

const installationGen = element<InstallationName>(["Work", "Clubs", "RosterDomains"])

/**
 * A report: any combination of its fields; or one shaped as a kind of report grizzle's statements meet, a native
 * violation, a write statement's refusal, a concurrent change or a unique abort, each field still drawn where the shape
 * leaves it open.
 */
const reportGen: Gen<ReportSketch> = weighted<ReportSketch>([
	[
		4,
		(source) => ({
			installation: source.draw(installationGen),
			sqlstate: source.draw(element(sqlstateDictionary)),
			constraint: source.draw(constraintGen),
			schema: source.draw(schemaGen),
			owner: source.draw(ownerGen),
			detail: source.draw(detailGen),
			origin: source.draw(originGen)
		})
	],
	[
		3,
		(source) => ({
			installation: source.draw(installationGen),
			sqlstate: source.draw(
				element([
					sqlstates.uniqueViolation,
					sqlstates.exclusionViolation,
					sqlstates.checkViolation,
					sqlstates.foreignKeyViolation
				])
			),
			constraint: { kind: "an installed constraint", pick: source.draw(pick) },
			schema: "the installation's",
			owner: "the constraint's own",
			detail: source.draw(detailGen),
			origin: source.draw(originGen)
		})
	],
	[
		2,
		(source) => ({
			installation: source.draw(installationGen),
			sqlstate: sqlstates.integrityConstraintViolation,
			constraint: { kind: "a law's identity", pick: source.draw(pick) },
			schema: source.draw(element<SchemaSketch>(["the installation's", "none"])),
			owner: "none",
			detail: source.draw(refusalGen),
			origin: source.draw(originGen)
		})
	],
	[
		1,
		(source) => ({
			installation: source.draw(installationGen),
			sqlstate: sqlstates.grizzleConcurrentChange,
			constraint: source.draw(constraintGen),
			schema: source.draw(schemaGen),
			owner: source.draw(ownerGen),
			detail: source.draw(changeGen),
			origin: source.draw(originGen)
		})
	],
	[
		1,
		(source) => ({
			installation: source.draw(installationGen),
			sqlstate: source.draw(element([sqlstates.uniqueViolation, sqlstates.exclusionViolation])),
			constraint: { kind: "an installed constraint", pick: source.draw(pick) },
			schema: source.draw(schemaGen),
			owner: source.draw(ownerGen),
			detail: constant<DetailSketch>({ kind: "none" })(source),
			origin: {
				...source.draw(originGen),
				kind: source.draw(element<OriginKind>(["a write statement", "a single statement"])),
				aborts: [
					{
						reported: true,
						reason: source.draw(
							element<UniqueAbort["reason"]>([
								"GeneratedSerialUnique",
								"UnseenOccupant",
								"PutTargetConflict"
							])
						),
						relation: source.draw(pick)
					}
				]
			}
		})
	]
])

/** A write step into `relation`, its fields the least a write step holds, listing `aborts`. */
const writeOf = (
	relation: string,
	aborts: ReadonlyArray<UniqueAbort>
): Extract<WriteStep, { readonly kind: "write" }> => ({
	kind: "write",
	stratum: 0,
	action: 0,
	relation,
	result: { kind: "spanClassify", relation },
	skipWhenEmpty: undefined,
	uniqueAborts: aborts
})

/** The origin a sketch is over an installation's stored relations, and the relations its statement writes. */
const originOf = (
	o: OriginSketch,
	relations: Arr.NonEmptyReadonlyArray<string>,
	aborts: ReadonlyArray<UniqueAbort>
): { readonly origin: FailureOrigin; readonly written: ReadonlyArray<string> } => {
	const relationAt = (n: number): string => defined(relations[n % relations.length], "a relation")
	const first = relationAt(defined(o.relations[0], "a drawn relation"))
	const statement = (step: WriteStep, written: ReadonlyArray<string>) => ({
		origin: { kind: "statement" as const, index: 1, step, chunk: 0 },
		written
	})
	switch (o.kind) {
		case "a stored-suffix read":
			return {
				origin: { kind: "read", index: 0, family: { owner: first, count: "n" } },
				written: []
			}
		case "a write statement":
			return statement(writeOf(first, aborts), [first])
		case "a single statement": {
			const written = Arr.map(o.relations, relationAt)
			return statement(
				{
					kind: "single",
					stratum: 0,
					parts: Arr.map(written, (r) => ({ step: writeOf(r, []), width: 1 })),
					uniqueAborts: aborts
				},
				written
			)
		}
		case "a family statement":
			return statement(
				{
					kind: "family",
					stratum: 0,
					target: { kind: "rows", relation: first },
					statement: "delete",
					relation: first,
					result: {
						kind: "delete",
						relation: first,
						mode: "exact",
						columns: [],
						fields: ["id"],
						key: ["id"]
					}
				},
				[first]
			)
		case "a carrier's create":
			return statement(
				{ kind: "carrier", carrier: "Carrier", step: "create", stratum: undefined },
				[]
			)
		case "an ANALYZE":
			return statement({ kind: "analyze", carriers: ["Carrier"], stratum: 0 }, [])
		case "a serial advance":
			return statement(
				{
					kind: "advance",
					stratum: 0,
					action: 0,
					relation: first,
					field: "id",
					skipWhenEmpty: undefined
				},
				[]
			)
		case "a read-back step":
			return statement({ kind: "readBack", name: "read" }, [])
		case "an entry's precheck":
			return statement({ kind: "check", stratum: 0, entry: "Entry", skipWhenEmpty: undefined }, [])
		case "a read-back past the statements":
			return { origin: { kind: "readBack", index: 2 }, written: [] }
		case "the COMMIT":
			return { origin: { kind: "commit" }, written: [] }
	}
}

/** What the rules say a report at an origin means. */
type Meaning =
	| {
			readonly kind: "rejected"
			readonly laws: ReadonlyArray<LawId>
			readonly witness: Witness
	  }
	| { readonly kind: "outside"; readonly relation: string }
	| {
			readonly kind: "transient"
			readonly reason: TransientTag
			readonly relation: string | undefined
			readonly constraint: string | undefined
	  }
	| { readonly kind: "defect" }
	| { readonly kind: "execution" }

/** A transient reason's tag and the fields it names. */
const reasonOf = (
	reason: TransientFailure["reason"]
): Extract<Meaning, { readonly kind: "transient" }> => ({
	kind: "transient",
	reason: reason._tag,
	relation: Predicate.hasProperty(reason, "relation") ? reason.relation : undefined,
	constraint: Predicate.hasProperty(reason, "constraint") ? String(reason.constraint) : undefined
})

type WitnessFeature =
	| "rejected under a table constraint"
	| "rejected under a domain constraint"
	| "a shared domain narrowed by the relations written"
	| "a shared domain's every law"
	| "rejected at a refused key"
	| "a refused key holding a closed id"
	| "a concurrent change"
	| "outside an entry"
	| "SerializationFailure"
	| "Deadlock"
	| "GeneratedSerialUnique"
	| "UnseenOccupant"
	| "PutTargetConflict"
	| "defect on a code domain"
	| "defect on a bits domain"
	| "execution: another schema"
	| "execution: no constraint"
	| "execution: a constraint its owner lacks"
	| "execution: a refusal without its DETAIL"
	| "execution: a refused key no relation holds"
	| "execution: another class"
	| "execution: a bits domain the installation lacks"
	| `execution: a concurrent change at ${Exclude<ChangeAt, "a stored relation">}`

describe("a server error at a write", () => {
	it.effect(
		"means what the classification rules say of the fields grizzle controls, at every origin of a write's flights",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/witness",
						draw: drawn((source) => {
							const sketch = source.draw(reportGen)
							const artifacts = installations[sketch.installation]
							const relations = [...artifacts.derived.schema.relations.values()]
							const refused =
								sketch.detail.kind === "a refusal"
									? defined(relations[sketch.detail.relation % relations.length], "a relation")
									: undefined
							/** The refused key's values, drawn for the relation's primary fields. */
							const key =
								refused === undefined
									? []
									: Arr.map(refused.primaryFields, (field) => ({
											field: field.name,
											value: source.draw(
												defined(keyValueGen(artifacts, field), "a key carrier the suite draws")
											)
										}))
							return { sketch, key }
						}),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the classification rules of outcomes/index.ts and witness/classify.ts, restated over the installation's constraints, laws and rosters"
						},
						coverage: required<WitnessFeature>(
							[
								"rejected under a table constraint",
								"rejected under a domain constraint",
								"a shared domain narrowed by the relations written",
								"a shared domain's every law",
								"rejected at a refused key",
								"a refused key holding a closed id",
								"a concurrent change",
								"outside an entry",
								"SerializationFailure",
								"Deadlock",
								"GeneratedSerialUnique",
								"UnseenOccupant",
								"PutTargetConflict",
								"defect on a code domain",
								"defect on a bits domain",
								"execution: another schema",
								"execution: no constraint",
								"execution: a constraint its owner lacks",
								"execution: a refusal without its DETAIL",
								"execution: a refused key no relation holds",
								"execution: another class",
								"execution: a bits domain the installation lacks",
								"execution: a concurrent change at a closed relation",
								"execution: a concurrent change at another installation's relation",
								"execution: a concurrent change at a name of no installation"
							],
							{ cases: 3000, sense: notesOnly }
						),
						kept: [],
						runs: 1500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ sketch, key }, k) =>
						Effect.sync(() => {
							const artifacts = installations[sketch.installation]
							const names = artifacts.names
							const schemaName = names.schema
							const stored = [...artifacts.derived.schema.relations.values()]
							const relationNames = Arr.map(stored, (r) => r.name)
							const relationAt = (n: number) =>
								defined(relationNames[n % relationNames.length], "a relation")
							/** The relation a concurrent change's DETAIL names, of the kind drawn. */
							const changedAt = (at: ChangeAt, n: number): string => {
								const among = (names: Arr.NonEmptyReadonlyArray<string>): string =>
									defined(names[n % names.length], "a relation name")
								switch (at) {
									case "a stored relation":
										return relationAt(n)
									case "a closed relation":
										return among(
											nonEmpty(
												[...artifacts.derived.schema.closed.keys()],
												"the installation's closed relations"
											)
										)
									case "another installation's relation":
										return among(
											nonEmpty(
												Arr.filter(
													Arr.flatMap(Rec.values(installations), (other) => [
														...other.derived.schema.relations.keys()
													]),
													(name) => !Arr.contains(relationNames, name)
												),
												"another installation's stored relations"
											)
										)
									case "a name of no installation":
										return "NoSuchRelation"
								}
							}
							const constraints = artifacts.constraintLaws
							const rosters = [...names.codes.rosters.values()]
							const tables = Arr.map(relationNames, (r) => names.relation(r).name)
							const otherDomain = Arr.flatMap(
								installations[sketch.installation === "Work" ? "Clubs" : "Work"].constraintLaws,
								(c) => (c.kind === "domainConstraint" ? [c.owner] : [])
							)
							/** The reported constraint, and the owner it is installed under, when it has one. */
							const chosen = ((): {
								readonly name: ConstraintName | undefined
								readonly entry: (typeof constraints)[number] | undefined
								readonly owner:
									| { readonly kind: "table"; readonly name: string }
									| { readonly kind: "domain"; readonly name: string }
									| undefined
							} => {
								const c = sketch.constraint
								switch (c.kind) {
									case "an installed constraint": {
										const at = defined(constraints[c.pick % constraints.length], "a constraint")
										return {
											name: at.name,
											entry: at,
											owner:
												at.kind === "constraint"
													? { kind: "table", name: at.owner }
													: { kind: "domain", name: at.owner }
										}
									}
									case "a law's identity":
										return {
											name: defined(
												artifacts.theoryLaws[c.pick % artifacts.theoryLaws.length],
												"a law"
											).law,
											entry: undefined,
											owner: undefined
										}
									case "a roster domain's check": {
										const codec = defined(rosters[c.pick % rosters.length], "a roster")
										const domain =
											c.carrier === "code"
												? names.rosterDomain(codec.roster).name
												: names.bitsDomain(codec.roster).name
										return {
											name: identifierOf(
												identity.domainCheck(
													c.carrier === "code"
														? identity.rosterDomain(codec.roster)
														: identity.bitsDomain(codec.roster, codec.width)
												)
											),
											entry: undefined,
											owner: { kind: "domain", name: domain }
										}
									}
									case "a name of no installation":
										return {
											name: wild.constraint("no_installation"),
											entry: undefined,
											owner: undefined
										}
									case "none":
										return { name: undefined, entry: undefined, owner: undefined }
								}
							})()
							/** The table or data type the report names. */
							const reportedOwner = ((): {
								table: string | undefined
								dataType: string | undefined
							} => {
								switch (sketch.owner) {
									case "the constraint's own":
										return chosen.owner === undefined
											? { table: undefined, dataType: undefined }
											: chosen.owner.kind === "table"
												? { table: chosen.owner.name, dataType: undefined }
												: { table: undefined, dataType: chosen.owner.name }
									case "another table of the installation":
										return {
											table: defined(
												Arr.findFirst(tables, (t) => t !== chosen.owner?.name).pipe(
													Option.getOrUndefined
												) ?? tables[0],
												"a table"
											),
											dataType: undefined
										}
									case "another installation's domain":
										return { table: undefined, dataType: otherDomain[0] }
									case "a bits domain at a width the installation lacks": {
										const codec = defined(rosters[0] ?? undefined, "a roster")
										return {
											table: undefined,
											dataType: identifierOf(identity.bitsDomain(codec.roster, codec.width + 1))
										}
									}
									case "none":
										return { table: undefined, dataType: undefined }
								}
							})()
							const detail = ((): string | undefined => {
								const d = sketch.detail
								switch (d.kind) {
									case "none":
										return undefined
									case "prose":
										return "Failing row contains (North, 7, secret payload, 0)."
									case "a refusal": {
										const relation = defined(stored[d.relation % stored.length], "a relation")
										const fields = Arr.map(key, (kv) => ({
											field:
												d.foreign === "a field the relation lacks"
													? `${kv.field}_lacking`
													: kv.field,
											text: kv.value.text
										}))
										return encodeRefusalDetail(
											{
												kind: "law",
												relation:
													d.foreign === "a relation of no installation"
														? "NoSuchRelation"
														: relation.name
											},
											fields
										)
									}
									case "a concurrent change":
										return encodeRefusalDetail(
											{ kind: "change", reason: d.reason, relation: changedAt(d.at, d.relation) },
											[]
										)
								}
							})()
							const reported: Reported = {
								...nothingReported,
								sqlstate: sketch.sqlstate,
								constraint: chosen.name,
								schema:
									sketch.schema === "the installation's"
										? schemaName
										: sketch.schema === "another"
											? `${schemaName}_elsewhere`
											: undefined,
								table: reportedOwner.table,
								dataType: reportedOwner.dataType,
								detail
							}
							const aborts: ReadonlyArray<UniqueAbort> = Arr.map(sketch.origin.aborts, (a) => ({
								constraint:
									a.reported && chosen.name !== undefined
										? chosen.name
										: wild.constraint("another_unique"),
								relation: relationAt(a.relation),
								reason: a.reason
							}))
							const { origin, written } = originOf(
								sketch.origin,
								[defined(relationNames[0], "a relation"), ...Arr.drop(relationNames, 1)],
								aborts
							)
							const failure: ServerError = serverError(reported)
							const classified = classifyServerError(failure, {
								violation: installationWitness(artifacts).classify,
								origin
							})
							/** The rules, restated. */
							const meaning = ((): Meaning => {
								const state = reported.sqlstate
								if (state === sqlstates.serializationFailure) {
									return {
										kind: "transient",
										reason: "SerializationFailure",
										relation: undefined,
										constraint: undefined
									}
								}
								if (state === sqlstates.deadlockDetected) {
									return {
										kind: "transient",
										reason: "Deadlock",
										relation: undefined,
										constraint: undefined
									}
								}
								const listed =
									origin.kind === "statement" &&
									(origin.step.kind === "write" || origin.step.kind === "single")
										? origin.step.uniqueAborts
										: []
								const abort = Arr.findFirst(listed, (a) => a.constraint === reported.constraint)
								if (
									(state === sqlstates.uniqueViolation || state === sqlstates.exclusionViolation) &&
									Option.isSome(abort)
								) {
									return {
										kind: "transient",
										reason: abort.value.reason,
										relation: abort.value.relation,
										constraint:
											abort.value.reason === "PutTargetConflict"
												? undefined
												: abort.value.constraint
									}
								}
								if (state === sqlstates.grizzleConcurrentChange) {
									return sketch.detail.kind === "a concurrent change" &&
										sketch.detail.at === "a stored relation"
										? {
												kind: "transient",
												reason: sketch.detail.reason,
												relation: relationAt(sketch.detail.relation),
												constraint: undefined
											}
										: { kind: "execution" }
								}
								if (state === sqlstates.grizzleOutsideWorld) {
									return reported.constraint === undefined
										? { kind: "execution" }
										: { kind: "outside", relation: reported.constraint }
								}
								if (!Str.startsWith("23")(state)) {
									return { kind: "execution" }
								}
								const own = reported.schema === schemaName
								const owner = !own
									? undefined
									: reported.table !== undefined
										? { kind: "table" as const, name: reported.table }
										: reported.dataType !== undefined
											? { kind: "domain" as const, name: reported.dataType }
											: undefined
								if (
									state === sqlstates.checkViolation &&
									owner?.kind === "domain" &&
									Arr.some(
										rosters,
										(codec) =>
											names.rosterDomain(codec.roster).name === owner.name ||
											names.bitsDomain(codec.roster).name === owner.name
									)
								) {
									return { kind: "defect" }
								}
								if (reported.constraint === undefined) {
									return { kind: "execution" }
								}
								if (reported.schema !== undefined && !own) {
									return { kind: "execution" }
								}
								if (state === sqlstates.integrityConstraintViolation) {
									const law = Arr.findFirst(
										artifacts.theoryLaws,
										(l) => l.law === reported.constraint
									)
									const d = sketch.detail
									if (Option.isNone(law) || d.kind !== "a refusal" || d.foreign !== "none") {
										return { kind: "execution" }
									}
									const relation = defined(stored[d.relation % stored.length], "a relation")
									return {
										kind: "rejected",
										laws: [law.value.law],
										witness: {
											kind: "key",
											relation: relation.name,
											values: Rec.fromEntries(
												Arr.map(key, (kv) => [kv.field, kv.value.value] as const)
											)
										}
									}
								}
								if (owner === undefined) {
									return { kind: "execution" }
								}
								const native = Arr.findFirst(
									constraints,
									(c) =>
										c.name === reported.constraint &&
										(c.kind === "constraint" ? owner.kind === "table" : owner.kind === "domain") &&
										c.owner === owner.name
								)
								if (Option.isNone(native)) {
									return { kind: "execution" }
								}
								const n = native.value
								const writtenTables = new Set(Arr.map(written, (r) => names.relation(r).name))
								const coerced =
									n.kind === "domainConstraint"
										? new Set(
												Arr.flatMap(n.uses, (u) => (writtenTables.has(u.table) ? [u.law] : []))
											)
										: new Set<LawId>()
								const narrowed = Arr.filter(n.laws, (l) => coerced.has(l.law))
								return {
									kind: "rejected",
									laws: Arr.map(narrowed.length > 0 ? narrowed : n.laws, (l) => l.law),
									witness: { kind: "unreported" }
								}
							})()
							const described = (law: LawId): Law =>
								defined(artifacts.described.get(law), "a described law")
							switch (meaning.kind) {
								case "rejected": {
									assert.ok(classified.kind === "rejected", `rejected, not ${classified.kind}`)
									unorderedEqual(classified.laws, Arr.map(meaning.laws, described), "the laws")
									assert.deepEqual(classified.witness, meaning.witness)
									if (meaning.witness.kind === "key") {
										k.note("rejected at a refused key")
										if (
											Arr.some(
												key,
												(kv) =>
													typeof kv.value.value === "string" && kv.value.text !== kv.value.value
											)
										) {
											k.note("a refused key holding a closed id")
										}
									} else {
										const entry = defined(chosen.entry, "the installed constraint")
										k.note(
											entry.kind === "domainConstraint"
												? "rejected under a domain constraint"
												: "rejected under a table constraint"
										)
										if (entry.laws.length > 1) {
											k.note(
												meaning.laws.length < entry.laws.length
													? "a shared domain narrowed by the relations written"
													: "a shared domain's every law"
											)
										}
									}
									return
								}
								case "outside":
									assert.deepEqual(classified, { kind: "outside", relation: meaning.relation })
									k.note("outside an entry")
									return
								case "transient": {
									assert.ok(classified.kind === "failed", `failed, not ${classified.kind}`)
									const error = classified.error
									assert.ok(error instanceof TransientFailure, String(error))
									assert.deepEqual(reasonOf(error.reason), meaning)
									assert.ok(error.error === failure, "it carries the server's report")
									const tag = error.reason._tag
									k.note(
										reported.sqlstate === sqlstates.grizzleConcurrentChange
											? "a concurrent change"
											: tag === "SerializationFailure" ||
												  tag === "Deadlock" ||
												  tag === "GeneratedSerialUnique" ||
												  tag === "UnseenOccupant" ||
												  tag === "PutTargetConflict"
												? tag
												: "a concurrent change"
									)
									return
								}
								case "defect":
									assert.ok(classified.kind === "defect", `a defect, not ${classified.kind}`)
									k.note(
										sketch.constraint.kind === "a roster domain's check" &&
											sketch.constraint.carrier === "bits" &&
											sketch.owner === "the constraint's own"
											? "defect on a bits domain"
											: "defect on a code domain"
									)
									return
								case "execution": {
									assert.ok(classified.kind === "failed", `failed, not ${classified.kind}`)
									const error = classified.error
									assert.ok(error instanceof ExecutionFailure, String(error))
									assert.ok(error.reason === failure, "it carries the server's report as given")
									const state = reported.sqlstate
									const detail = sketch.detail
									if (
										state === sqlstates.grizzleConcurrentChange &&
										detail.kind === "a concurrent change" &&
										detail.at !== "a stored relation"
									) {
										k.note(`execution: a concurrent change at ${detail.at}`)
										return
									}
									k.note(
										!Str.startsWith("23")(state)
											? "execution: another class"
											: reported.schema !== undefined && reported.schema !== schemaName
												? "execution: another schema"
												: reported.constraint === undefined
													? "execution: no constraint"
													: state === sqlstates.integrityConstraintViolation
														? sketch.detail.kind === "a refusal"
															? "execution: a refused key no relation holds"
															: "execution: a refusal without its DETAIL"
														: sketch.owner === "a bits domain at a width the installation lacks"
															? "execution: a bits domain the installation lacks"
															: "execution: a constraint its owner lacks"
									)
									return
								}
							}
						})
				)
			)
	)
})
