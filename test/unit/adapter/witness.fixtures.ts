/** What the properties of witness.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	aimed,
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	unicodeScalar,
	weighted
} from "@bjornpagen/testing/gen"
import { bigint, uuid as uuidValue } from "@bjornpagen/testing/values"
import { Array as Arr, Predicate, String as Str } from "effect"
import { TransientFailure } from "#adapter/errors/execution.ts"
import { type FailureOrigin } from "#adapter/outcomes/index.ts"
import type { TransientTag } from "#compiler/core/errors.ts"
import { EntryName, type StoredRelationName } from "#compiler/core/ids.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import type { LawField } from "#compiler/ir/law.ts"
import { always } from "#compiler/ir/needs.ts"
import { rosterOf } from "#compiler/ir/scalar.ts"
import { strataAt } from "#compiler/ir/stratum.ts"
import type { ConstraintLaw, ConstraintLawOf, DomainUse } from "#compiler/laws/model/model.ts"
import { parseSchemaInput } from "#compiler/program/input.ts"
import { type SchemaArtifacts, schemaArtifacts } from "#compiler/program/schema.ts"
import { changeTag, type ConcurrentChangeTag, keyTag } from "#compiler/runtime/write/refusal.ts"
import type { UniqueAbort, WriteStep } from "#compiler/runtime/write/steps.ts"
import type { Refuser, StatementAt } from "#compiler/runtime/write/witness.ts"
import { own } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import type { KeyHost, Law, Witness } from "#compiler/types/changeset/changeset.ts"
import { succeeded } from "#test/support/assert.ts"
import { type CaseSketch, caseSketchGen } from "#test/support/oracle/public/generate.ts"
import { type LawFeature, type LawLevel, lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { type DrawnSchema } from "#test/support/served-login.ts"

/**
 * What a server error at a write means (packages/grizzle/src/adapter/outcomes classifyServerError, over the
 * installation's violation classifier, packages/grizzle/src/adapter/witness), read only from the fields grizzle controls,
 * never from the server's prose.
 *
 * Over generated installations, a public schema (test/support/oracle/public) extended by its law level (laws.ts: a roster
 * whose codes hold holes, a code key, a set, checked contracts that may share one domain, a generated column, a table
 * CHECK) and installed under the level's codes, a drawn ErrorResponse: a SQLSTATE grizzle branches on or another; a constraint the installation installs, under its
 * table or domain, a law's identity, a name of no installation, or none; the schema it reports, the installation's,
 * another or none; the table or data type, the constraint's owner, another of the installation, another domain or
 * none; and a DETAIL grizzle's refusal or concurrent change encodes, prose, or none. It is raised at a drawn origin of a
 * write's flight: a statement of each step kind writing drawn relations, with the unique aborts its statement lists, a
 * read-back, or the COMMIT.
 *
 * The oracle is the classification rules (outcomes/index.ts and witness/classify.ts) restated over the installation's
 * constraint list, its laws and its rosters: SERIALIZABLE's 40001 and 40P01, and a 23505 or 23P01 on a constraint the
 * statement lists as an abort, are TransientFailure; a 40Z01 whose DETAIL names a concurrent change at one of the
 * installation's stored relations is that change's TransientFailure, and one at any other relation (a closed relation
 * of the installation, a name of none) is no outcome the installation reads; a 42Z01
 * names the entry outside which a fact fell where its constraint is a query entry the installation's role writes
 * through, and is no outcome otherwise (a schema's installation writes through none); a 23514 on one of the
 * installation's roster domains
 * is grizzle's own defect; a 23000 on a law's identity with grizzle's DETAIL rejects that law at the refused key, decoded
 * through its columns (a uuid as its text, an integer as its number, a closed id's code as its handle, a text as itself);
 * any other class 23 violation reported in the installation's schema rejects the laws its constraint maps to under the
 * owner it reports, a shared domain's (a text pattern's, or one definition's contracts', typing several columns, each
 * its own law) narrowed to the columns of the relations the statement writes, the host asked about those columns alone, the one law
 * decided and several `some`, where the host decides none; and everything else is ExecutionFailure carrying the server's
 * report as given. Which constraint maps to
 * which law is the installation's (the law families and the write oracle hold it to PostgreSQL's refusals).
 */

/** The artifacts of a drawn installation: its schema extended by its law level, under the level's codes. */
export const artifactsOf = (drawn: DrawnSchema): SchemaArtifacts =>
	succeeded(
		schemaArtifacts(succeeded(parseSchemaInput(drawn.laws.schema)), {
			codes: drawn.laws.codes(
				succeeded(own(defined(schemaDescOf(drawn.laws.schema), "the extended schema is built")))
			)
		})
	)

/** A key field's text as a refusal's DETAIL carries it, and the value the witness holds for it. */
interface KeyValue {
	readonly text: string
	readonly value: KeyHost
}

/**
 * The characters a DETAIL's encoding (write/refusal.ts) escapes or delimits its key texts by: a JSON string's quote,
 * escape and control characters, and the list's comma and brackets.
 */
const delimiters: Arr.NonEmptyReadonlyArray<string> = ['"', "\\", "\n", "\t", ",", "[", "]"]

/**
 * A text a DETAIL carries: any scalar values, the encoding's delimiters among them as often as any other, its length a
 * search budget.
 */
const detailText: Gen<string> = string(oneOf([unicodeScalar, element(delimiters)]), {
	min: 0,
	max: 8
})

/**
 * A value of a key field of `type` and its text, for the carriers the installations' keys hold, or undefined for a
 * carrier none of them keys by.
 */
export const keyValueGen = (
	artifacts: SchemaArtifacts,
	field: LawField
): Gen<KeyValue> | undefined => {
	const type = field.type
	switch (type.carrier) {
		case "uuid":
			return (source) => {
				const text = source.draw(uuidValue(4))
				return { text, value: text }
			}
		case "int8":
			return (source) => {
				const n = source.draw(bigint(-(2n ** 63n), 2n ** 63n - 1n))
				return { text: String(n), value: n }
			}
		case "int2":
			return (source) => {
				const n = source.draw(int(-(2 ** 15), 2 ** 15 - 1))
				return { text: String(n), value: n }
			}
		case "int4":
			return (source) => {
				const n = source.draw(int(-(2 ** 31), 2 ** 31 - 1))
				return { text: String(n), value: n }
			}
		case "text":
			return (source) => {
				const text = source.draw(detailText)
				return { text, value: text }
			}
		case "code": {
			const codec = defined(
				artifacts.names.codes.rosters.get(defined(rosterOf(type), "a closed id's roster").closed),
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
		case "variant":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "sha256":
		case "bytes":
		case "date":
		case "inet":
		case "cidr":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}

/** Where the statement that raised a report sits in a write's flights, and what it writes. */
type OriginKind =
	| "a write statement"
	| "a single statement"
	| "a family write"
	| "a member's carrier fill"
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
	| { readonly kind: "prose"; readonly text: string }
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
export type ChangeAt = "a stored relation" | "a closed relation" | "a name of no installation"

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
	| "a domain the installation lacks"
	| "a bits domain at a width the installation lacks"
	| "none"

/** The column a report names, of the table it reports: a generated field's, another field's, or none. */
type ColumnSketch = "a generated column of the table" | "another column of the table" | "none"

interface ReportSketch {
	readonly sqlstate: string
	readonly constraint: ConstraintSketch
	readonly schema: SchemaSketch
	readonly owner: OwnerSketch
	readonly column: ColumnSketch
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
	sqlstates.notNullViolation,
	"22012",
	"XX000"
]

const pick = int(0, 0xffff)

const originGen: Gen<OriginSketch> = (source) => ({
	kind: source.draw(
		element<OriginKind>([
			"a write statement",
			"a single statement",
			"a family write",
			"a member's carrier fill",
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
				reason: inner.draw(element<UniqueAbort["reason"]>(["UnseenOccupant", "PutTargetConflict"])),
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
	[1, constant("a domain the installation lacks")],
	[1, constant("a bits domain at a width the installation lacks")],
	[1, constant("none")]
])

const columnGen: Gen<ColumnSketch> = element<ColumnSketch>([
	"a generated column of the table",
	"another column of the table",
	"none"
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
			[1, constant("a name of no installation")]
		])
	)
})

/** A DETAIL: none, prose, which a leading space keeps from opening as grizzle's encoding, or a refusal's or a change's. */
const detailGen: Gen<DetailSketch> = oneOf<DetailSketch>([
	constant({ kind: "none" }),
	map(detailText, (text): DetailSketch => ({
		kind: "prose",
		text:
			Str.startsWith(`${keyTag}[`)(text) || Str.startsWith(`${changeTag}[`)(text)
				? ` ${text}`
				: text
	})),
	refusalGen,
	changeGen
])

/**
 * A report: any combination of its fields; or one shaped as a kind of report grizzle's statements meet, a native
 * violation, a write statement's refusal, a concurrent change or a unique abort, each field still drawn where the shape
 * leaves it open.
 */
const reportGen: Gen<ReportSketch> = weighted<ReportSketch>([
	[
		4,
		(source) => ({
			sqlstate: source.draw(element(sqlstateDictionary)),
			constraint: source.draw(constraintGen),
			schema: source.draw(schemaGen),
			owner: source.draw(ownerGen),
			column: source.draw(columnGen),
			detail: source.draw(detailGen),
			origin: source.draw(originGen)
		})
	],
	[
		2,
		(source) => ({
			sqlstate: sqlstates.notNullViolation,
			constraint: { kind: "none" },
			schema: source.draw(element<SchemaSketch>(["the installation's", "another"])),
			owner: "another table of the installation",
			column: source.draw(columnGen),
			detail: { kind: "none" },
			origin: source.draw(originGen)
		})
	],
	[
		3,
		(source) => ({
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
			column: "none",
			detail: source.draw(detailGen),
			origin: source.draw(originGen)
		})
	],
	[
		2,
		(source) => ({
			sqlstate: sqlstates.integrityConstraintViolation,
			constraint: { kind: "a law's identity", pick: source.draw(pick) },
			schema: source.draw(element<SchemaSketch>(["the installation's", "none"])),
			owner: "none",
			column: "none",
			detail: source.draw(refusalGen),
			origin: source.draw(originGen)
		})
	],
	[
		1,
		(source) => ({
			sqlstate: sqlstates.grizzleConcurrentChange,
			constraint: source.draw(constraintGen),
			schema: source.draw(schemaGen),
			owner: source.draw(ownerGen),
			column: "none",
			detail: source.draw(changeGen),
			origin: source.draw(originGen)
		})
	],
	[
		1,
		(source) => ({
			sqlstate: source.draw(element([sqlstates.uniqueViolation, sqlstates.exclusionViolation])),
			constraint: { kind: "an installed constraint", pick: source.draw(pick) },
			schema: source.draw(schemaGen),
			owner: source.draw(ownerGen),
			column: "none",
			detail: constant<DetailSketch>({ kind: "none" })(source),
			origin: {
				...source.draw(originGen),
				kind: source.draw(element<OriginKind>(["a write statement", "a single statement"])),
				aborts: [
					{
						reported: true,
						reason: source.draw(
							element<UniqueAbort["reason"]>(["UnseenOccupant", "PutTargetConflict"])
						),
						relation: source.draw(pick)
					}
				]
			}
		})
	]
])

/** The position of the one stratum the steps below run in. */
const firstStratum = defined(strataAt(["the one stratum"])[0], "the one stratum's position")[0]

/** A write step into `relation`, its fields the least a write step holds, listing `aborts`. */
const writeOf = (
	relation: StoredRelationName,
	aborts: ReadonlyArray<UniqueAbort>
): Extract<WriteStep, { readonly kind: "write" }> => ({
	kind: "write",
	stratum: firstStratum,
	action: 0,
	relation,
	result: { kind: "delete", relation, mode: "exact", columns: [], fields: [], key: [] },
	needs: always,
	uniqueAborts: aborts
})

/** The origin a sketch is over an installation's stored relations, and the relations its statement writes. */
export const originOf = (
	o: OriginSketch,
	relations: Arr.NonEmptyReadonlyArray<StoredRelationName>,
	aborts: ReadonlyArray<UniqueAbort>
): {
	readonly origin: FailureOrigin
	readonly written: ReadonlyArray<StoredRelationName>
} => {
	const relationAt = (n: number): StoredRelationName =>
		defined(relations[n % relations.length], "a relation")
	const first = relationAt(defined(o.relations[0], "a drawn relation"))
	const statement = (step: WriteStep, written: ReadonlyArray<StoredRelationName>) => ({
		origin: { kind: "statement" as const, index: 1, step, chunk: 0 },
		written
	})
	switch (o.kind) {
		case "a write statement":
			return statement(writeOf(first, aborts), [first])
		case "a single statement": {
			const written = Arr.map(o.relations, relationAt)
			return statement(
				{
					kind: "single",
					stratum: firstStratum,
					parts: Arr.map(written, (r) => ({ step: writeOf(r, []), width: 1 })),
					uniqueAborts: aborts
				},
				written
			)
		}
		case "a family write":
			return statement(
				{
					kind: "familyWrite",
					stratum: firstStratum,
					statement: "removals",
					parts: [
						{
							relation: first,
							result: {
								kind: "delete",
								relation: first,
								mode: "exact",
								columns: [],
								fields: ["id"],
								key: ["id"]
							},
							rows: "facts",
							width: 1
						}
					]
				},
				[first]
			)
		case "a member's carrier fill":
			return statement(
				{
					kind: "carrier",
					carrier: "Carrier",
					stratum: firstStratum,
					casts: { kind: "member", relation: first, stratum: firstStratum }
				},
				[first]
			)
		case "a read-back step":
			return statement({ kind: "readBack", name: "read" }, [])
		case "an entry's precheck":
			return statement(
				{
					kind: "check",
					stratum: firstStratum,
					entry: EntryName("Entry"),
					needs: always
				},
				[first]
			)
		case "a read-back past the statements":
			return { origin: { kind: "readBack", index: 2 }, written: [] }
		case "the COMMIT":
			return { origin: { kind: "commit" }, written: [] }
	}
}

/** What the rules say a report at an origin means. */
export type Meaning =
	| {
			readonly kind: "rejected"
			readonly laws: ReadonlyArray<Law>
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
export const reasonOf = (
	reason: TransientFailure["reason"]
): Extract<Meaning, { readonly kind: "transient" }> => ({
	kind: "transient",
	reason: reason._tag,
	relation: Predicate.hasProperty(reason, "relation") ? reason.relation : undefined,
	constraint: Predicate.hasProperty(reason, "constraint") ? String(reason.constraint) : undefined
})

export type WitnessFeature =
	| LawFeature
	| "rejected under a table constraint"
	| "rejected under a domain constraint"
	| "a shared domain narrowed by the relations written"
	| "a shared domain's every law"
	| "rejected at a refused key"
	| "a refused key holding a closed id"
	| "rejected under a generated column"
	| "execution: a NOT NULL on no generated column"
	| "a concurrent change"
	| "outside an entry"
	| "execution: a precheck naming no entry the role writes through"
	| "SerializationFailure"
	| "Deadlock"
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

/** What refused a statement, as the host's witness is asked about it: its kind and the objects it names. */
export const refuserText = (refuser: Refuser): string => {
	switch (refuser.kind) {
		case "constraint":
			return `constraint ${refuser.owner} ${refuser.name}`
		case "domain":
			return `domain ${Arr.join(
				Arr.map(refuser.uses, (u) => `${u.table}.${u.column}`),
				","
			)}`
		case "generated":
			return `generated ${refuser.table}.${refuser.column}`
	}
}

/** Where a statement stands, as text: a write's stratum and relations, or a precheck's stratum and entry. */
const atText = (at: StatementAt): string => {
	switch (at.kind) {
		case "actions":
			return `${at.stratum}:actions ${Arr.join(Arr.map(at.actions, String), ",")}`
		case "write":
			return `${at.stratum}:${Arr.join(at.relations, ",")}`
		case "precheck":
			return `${at.stratum}:precheck ${at.entry}`
		case "unstated":
			return "unstated"
	}
}

/**
 * The host's witness as the classifier is handed it: a key naming where it was asked, the statement's stratum and
 * actions, relations or entry, and what refused, so every call the classifier makes of it shows in the outcome.
 */
export const hostWitnessOf = (at: StatementAt, refuser: string): Witness => ({
	kind: "key",
	relation: "Host",
	values: { at: atText(at), refuser }
})

/** Whether an installed constraint is a table's, a constraint or a rule's trigger, rather than a domain's CHECK. */
export const isTableConstraint = (
	c: ConstraintLaw
): c is Extract<ConstraintLaw, { readonly kind: "constraint" | "trigger" }> =>
	c.kind === "constraint" || c.kind === "trigger"

/** The laws of a domain's uses, each once, in the order of the first use stating it. */
export const usesLaws = (uses: ReadonlyArray<DomainUse>): ReadonlyArray<ConstraintLawOf> =>
	Arr.dedupeWith(
		Arr.map(uses, (u) => u.law),
		(a, b) => a.law === b.law
	)

/**
 * A report aimed at a defect on a roster's domain of `carrier`: a CHECK violation in the installation's schema whose
 * constraint is that carrier's domain CHECK of a drawn roster and whose data type is the domain itself, which the rules
 * call grizzle's defect; its column, DETAIL and origin as drawn.
 * A drawn report is one only as a CHECK violation among fourteen SQLSTATEs, naming a roster domain's check among five
 * constraint kinds, of that carrier, in the installation's schema, owned by the constraint's own domain, and the
 * streams the suite's label fixes held none on the bits carrier.
 */
const defectReportGen =
	(carrier: "code" | "bits"): Gen<ReportSketch> =>
	(source) => ({
		...source.draw(reportGen),
		sqlstate: sqlstates.checkViolation,
		constraint: { kind: "a roster domain's check", pick: source.draw(pick), carrier },
		schema: "the installation's",
		owner: "the constraint's own"
	})

/** A case: a public case's sketch, its law level, and the report it classifies. */
type WitnessSketch = readonly [CaseSketch, LawLevel, ReportSketch]

/** A case whose law level `level` draws and whose report `report` draws. */
const witnessOf =
	(level: Gen<LawLevel>, report: Gen<ReportSketch>): Gen<WitnessSketch> =>
	(source) => [source.draw(caseSketchGen), source.draw(level), source.draw(report)]

/** A case whose report `report` draws. */
const witnessGen = (report: Gen<ReportSketch>): Gen<WitnessSketch> => witnessOf(lawLevelGen, report)

/**
 * A NOT NULL violation the installation's schema reports at a column of the table of an installed constraint, its
 * generated column where the table holds one, under a law level whose counter holds a generated column and a table CHECK:
 * a rejection under the generated column whenever the constraint drawn is one of the counter's. A drawn report is one
 * only as a NOT NULL violation among fourteen SQLSTATEs, of the counter's own table, at its generated column.
 */
const generatedColumnCase: Gen<WitnessSketch> = witnessOf(
	map(lawLevelGen, (level): LawLevel => ({ ...level, generated: true, check: true })),
	(source) => ({
		...source.draw(reportGen),
		sqlstate: sqlstates.notNullViolation,
		constraint: { kind: "an installed constraint", pick: source.draw(pick) },
		schema: "the installation's",
		owner: "the constraint's own",
		column: "a generated column of the table"
	})
)

/**
 * A CHECK violation the installation's schema reports under an installed constraint's own owner, raised by a write
 * statement into one drawn relation, under a law level whose two contracts share one domain: a shared domain's law
 * narrowed to the relation written whenever the constraint drawn is the shared domain's and the relation one of the two
 * its domain types.
 */
const sharedDomainCase: Gen<WitnessSketch> = witnessOf(
	map(lawLevelGen, (level): LawLevel => ({ ...level, least: [level.least[0], level.least[0]] })),
	(source) => ({
		...source.draw(reportGen),
		sqlstate: sqlstates.checkViolation,
		constraint: { kind: "an installed constraint", pick: source.draw(pick) },
		schema: "the installation's",
		owner: "the constraint's own",
		origin: { ...source.draw(originGen), kind: "a write statement", aborts: [] }
	})
)

/**
 * A violation the installation's schema reports under an installed constraint and a domain the installation lacks: a
 * constraint its owner lacks, which the rules read as no outcome.
 */
const lackingOwnerCase: Gen<WitnessSketch> = witnessGen((source) => ({
	...source.draw(reportGen),
	sqlstate: source.draw(element([sqlstates.checkViolation, sqlstates.foreignKeyViolation])),
	constraint: { kind: "an installed constraint", pick: source.draw(pick) },
	schema: "the installation's",
	owner: "a domain the installation lacks"
}))

/** A concurrent change whose DETAIL names a closed relation of the installation, which no statement of it raises. */
const closedChangeCase: Gen<WitnessSketch> = witnessGen((source) => ({
	...source.draw(reportGen),
	sqlstate: sqlstates.grizzleConcurrentChange,
	detail: {
		kind: "a concurrent change",
		reason: source.draw(element<ConcurrentChangeTag>(["PutTargetConflict", "SpanKeyChange"])),
		relation: source.draw(pick),
		at: "a closed relation"
	}
}))

/**
 * A case, drawn: its report a drawn one, or, where its turn aims at a situation a drawn report seldom is, a report
 * shaped to reach it: a defect on a roster's domain of each carrier (defectReportGen), a rejection under a generated
 * column, a shared domain narrowed by the relations written, a constraint its owner lacks, and a concurrent change at a
 * closed relation.
 */
export const witnessCases = aimed<WitnessSketch, WitnessFeature>(witnessGen(reportGen), [
	["defect on a code domain", witnessGen(defectReportGen("code"))],
	["defect on a bits domain", witnessGen(defectReportGen("bits"))],
	["rejected under a generated column", generatedColumnCase],
	["a shared domain narrowed by the relations written", sharedDomainCase],
	["execution: a constraint its owner lacks", lackingOwnerCase],
	["execution: a concurrent change at a closed relation", closedChangeCase]
])
