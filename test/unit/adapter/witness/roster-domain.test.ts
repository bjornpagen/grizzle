/**
 * U3's ruling on a write's 23514, through the outcome mapping a write consumes (packages/grizzle/src/adapter/outcomes
 * classifyServerError, over the installation's violation classifier, packages/grizzle/src/adapter/witness): a roster's
 * domains are its codes' range proof and discharge no law, and grizzle's codec writes only live handles, so a 23514 a
 * roster's code domain or bits domain raises at any statement of grizzle's write, or at its COMMIT, is grizzle's own
 * defect, never a law outcome; a 23514 on a table CHECK, a contract's domain or a text refinement domain still reports
 * its law, with no key, since PostgreSQL states the failing row only in its DETAIL prose. A domain two contracts of
 * one definition share (W6.Q10) names the contract of each column it types in the relations the failing statement
 * writes, and both where the statement writes neither.
 *
 * The oracle is the ruling stated as a checker (`ruling`), which reads the owner a violation is reported on and, for
 * the shared domain alone, the relations the origin writes: for every other owner the verdict being the same at every
 * origin is part of what is checked. A defect explains itself from the installed constants: it names the domain, its
 * roster, where in the flight it was raised, and every code the domain admits with its handle, the hole included.
 *
 * The installation holds Kind's codes after a removal: Kind was leaf, gone, branch and is leaf, branch, root, so leaf
 * keeps 0, gone's 1 is a hole, branch keeps 2 and root takes 3, and the bits domain is over bit(4). The named invalid
 * variants: a roster's code domain reported in another schema than the installation's, and a bits domain at the size a
 * fresh installation would give Kind, 3, which this installation does not hold; neither is the installation's, so
 * neither is a defect or a law, but the server's report.
 *
 * The box, exhausted: every (owner, origin) pair, eight owners by thirteen origins: a family's stored-suffix read, which
 * a write whose plan reads sends first, in a flight of its own in the same transaction, then every step kind a write's
 * flight sends, a family step's second chunk, a read-back past the sent statements, and the COMMIT. A defect names its
 * statement by its index across both flights, the read by its family and a later chunk by its execution.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { ExecutionFailure } from "#adapter/errors/execution.ts"
import { classifyServerError, type FailureOrigin } from "#adapter/outcomes/index.ts"
import { installationWitness } from "#adapter/witness/index.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { draftCodebook, firstCodebook, noRenames } from "#compiler/ir/codes.ts"
import { parseSchemaInput, schemaArtifacts } from "#compiler/program/schema.ts"
import { bits, closedId, contract, pg, uuid } from "#compiler/public/fields.ts"
import { check, closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import type { WriteStep } from "#compiler/write/program/artifact.ts"
import {
	assert,
	assertVariant,
	containsText,
	defined,
	succeeded,
	unorderedEqual
} from "#test/support/assert.ts"
import {
	installationNamesOf,
	installationOf,
	lawIdOf,
	lawNamesOf,
	parsedName
} from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { nothingReported, type Reported, serverError } from "#test/support/server-error.ts"

const Kind = closed("Kind", ["leaf", "branch", "root"])
const Seats = contract("Seats", pg.integer, (x) => x.le(500))
/** Two contracts of one definition, which the installation types by one shared domain. */
const Count = contract("Count", pg.integer, (x) => x.ge(0))
const Tally = contract("Tally", pg.integer, (x) => x.ge(0))
const label = str.regex("^.{1,20}$", "su")
const Node = relation(
	"Node",
	{ id: uuid, kind: closedId(Kind), marks: bits(Kind), seats: Seats, count: Count, label },
	["id"]
)
const Tag = relation("Tag", { id: uuid, tally: Tally }, ["id"])
const seatsPositive = check("SeatsPositive", Node, (x) => x.gt(x.seats, 0))
const Rosters = schema("RosterDomains", { Kind, Node, Tag }, [seatsPositive])

/** Kind's roster as the schema declares it, and as the installation's previous snapshot held it, gone still live. */
const owned = succeeded(own(defined(schemaDescOf(Rosters), "Rosters is a built schema")))
const declaredKind = defined(rostersOf(owned)[0], "Rosters declares Kind")
const codes = succeeded(
	draftCodebook(
		firstCodebook([{ closed: declaredKind.closed, handles: ["leaf", "gone", "branch"] }]),
		noRenames,
		rostersOf(owned)
	)
)

const artifacts = succeeded(
	schemaArtifacts(succeeded(parseSchemaInput(Rosters)), {
		installation: undefined,
		vectorSchema: undefined,
		codes
	})
)
const violation = installationWitness(artifacts).classify
const schemaName = artifacts.names.schema
const names = installationNamesOf(installationOf(Rosters, { kind: "declared" }))
const laws = lawNamesOf(Rosters)

/** Kind's two domains, each with its one CHECK, named through the naming door. */
const kindName = parsedName("Kind")
const codeDomain = identity.rosterDomain(kindName)
const bitsDomain = identity.bitsDomain(kindName, 4)
const freshBitsDomain = identity.bitsDomain(kindName, 3)

/** The codes the domains admit, each with its handle, and the hole: what a defect names. */
const liveCodes = ['0 "leaf"', '2 "branch"', '3 "root"'] as const

type OwnerKind =
	| "a table CHECK"
	| "a roster's code domain"
	| "a roster's bits domain"
	| "a contract's domain"
	| "a domain two contracts share"
	| "a text refinement domain"
	| "a roster's code domain in another schema"
	| "a bits domain the installation does not hold"

/** An owner a 23514 is reported on: the fields PostgreSQL reports for it. */
interface Owner {
	readonly kind: OwnerKind
	readonly reported: Reported
}

const checkLaw: LawId = lawIdOf(Rosters, seatsPositive)
const seats = laws.contract("Seats")
const count = laws.contract("Count")
const tally = laws.contract("Tally")
const labelDomain = names.textDomain(Node, "label")

/** A checked contract's CHECK, the one constraint it installs on its domain. */
const contractCheck = (c: typeof seats): string => {
	assertVariant(c, "kind", "checked", "the contract has a predicate")
	return c.constraint
}

const domainViolation = (domain: string, constraint: string, at: string): Reported => ({
	...nothingReported,
	sqlstate: "23514",
	constraint,
	schema: at,
	dataType: domain
})

const owners: Readonly<{ 0: Owner }> & ReadonlyArray<Owner> = [
	{
		kind: "a table CHECK",
		reported: {
			...nothingReported,
			sqlstate: "23514",
			constraint: laws.constraintOf(checkLaw, "TableCheck"),
			schema: schemaName,
			table: names.tableIdent(Node)
		}
	},
	{
		kind: "a roster's code domain",
		reported: domainViolation(
			identifierOf(codeDomain),
			identifierOf(identity.domainCheck(codeDomain)),
			schemaName
		)
	},
	{
		kind: "a roster's bits domain",
		reported: domainViolation(
			identifierOf(bitsDomain),
			identifierOf(identity.domainCheck(bitsDomain)),
			schemaName
		)
	},
	{
		kind: "a contract's domain",
		reported: domainViolation(seats.domain, contractCheck(seats), schemaName)
	},
	{
		kind: "a domain two contracts share",
		reported: domainViolation(count.domain, contractCheck(count), schemaName)
	},
	{
		kind: "a text refinement domain",
		reported: domainViolation(labelDomain.domain, labelDomain.constraint, schemaName)
	},
	{
		kind: "a roster's code domain in another schema",
		reported: domainViolation(
			identifierOf(codeDomain),
			identifierOf(identity.domainCheck(codeDomain)),
			`${schemaName}_elsewhere`
		)
	},
	{
		kind: "a bits domain the installation does not hold",
		reported: domainViolation(
			identifierOf(freshBitsDomain),
			identifierOf(identity.domainCheck(freshBitsDomain)),
			schemaName
		)
	}
]

/** The stored relations of the schema a step writes. */
type Written = "Node" | "Tag"

/** A write step into `relation`, its fields the least a write step holds. */
const writeOf = (relation: Written): Extract<WriteStep, { readonly kind: "write" }> => ({
	kind: "write",
	stratum: 0,
	action: 0,
	relation,
	result: { kind: "spanClassify", relation },
	skipWhenEmpty: undefined,
	uniqueAborts: []
})

type OriginKind =
	| "a family's stored-suffix read"
	| "a write statement"
	| "a single statement"
	| "a carrier's create"
	| "a carrier's fill"
	| "an ANALYZE"
	| "a serial advance"
	| "a read-back step"
	| "an entry's precheck"
	| "a family's statement"
	| "a family statement's later chunk"
	| "a read-back past the sent statements"
	| "the COMMIT"

/**
 * A statement origin, the stored relations it writes, and the words a defect names it by: its statement's index across
 * the write's flights, and what the statement is where its index alone cannot say.
 */
interface Origin {
	readonly kind: OriginKind
	readonly origin: FailureOrigin
	readonly writes: ReadonlyArray<Written>
	readonly named: ReadonlyArray<string>
}

/** The `chunk`th execution of `step`, sent at `index`. */
const statementAt = (
	kind: OriginKind,
	index: number,
	step: WriteStep,
	writes: ReadonlyArray<Written>,
	chunk: number
): Origin => ({
	kind,
	origin: { kind: "statement", index, step, chunk },
	writes,
	named: chunk === 0 ? [`statement ${index}`] : [`statement ${index}`, `execution ${chunk + 1}`]
})

/** A delete step of the family that counts Tag's n over Node. */
const familyDelete: WriteStep = {
	kind: "family",
	stratum: 0,
	target: { kind: "rows", relation: "Node" },
	statement: "delete",
	relation: "Node",
	result: {
		kind: "delete",
		relation: "Node",
		mode: "exact",
		columns: [],
		fields: ["id"],
		key: ["id"]
	}
}

const origins: Readonly<{ 0: Origin }> & ReadonlyArray<Origin> = [
	{
		kind: "a family's stored-suffix read",
		origin: { kind: "read", index: 0, family: { owner: "Tag", count: "n" } },
		writes: [],
		named: ["statement 0", "stored-suffix read of family Tag.n"]
	},
	statementAt("a write statement", 1, writeOf("Node"), ["Node"], 0),
	statementAt(
		"a single statement",
		2,
		{
			kind: "single",
			stratum: 0,
			parts: [
				{ step: writeOf("Node"), width: 1 },
				{ step: writeOf("Tag"), width: 1 }
			],
			uniqueAborts: []
		},
		["Node", "Tag"],
		0
	),
	statementAt(
		"a carrier's create",
		3,
		{ kind: "carrier", carrier: "NodeCarrier", step: "create", stratum: undefined },
		[],
		0
	),
	statementAt(
		"a carrier's fill",
		4,
		{ kind: "carrier", carrier: "NodeCarrier", step: "fill", stratum: 0 },
		[],
		0
	),
	statementAt("an ANALYZE", 5, { kind: "analyze", carriers: ["NodeCarrier"], stratum: 0 }, [], 0),
	statementAt(
		"a serial advance",
		6,
		{
			kind: "advance",
			stratum: 0,
			action: 0,
			relation: "Node",
			field: "seats",
			skipWhenEmpty: undefined
		},
		[],
		0
	),
	statementAt("a read-back step", 7, { kind: "readBack", name: "nodes" }, [], 0),
	statementAt(
		"an entry's precheck",
		8,
		{ kind: "check", stratum: 0, entry: "Nodes", skipWhenEmpty: undefined },
		[],
		0
	),
	statementAt("a family's statement", 9, familyDelete, ["Node"], 0),
	statementAt("a family statement's later chunk", 10, familyDelete, ["Node"], 1),
	{
		kind: "a read-back past the sent statements",
		origin: { kind: "readBack", index: 11 },
		writes: [],
		named: ["statement 11"]
	},
	{ kind: "the COMMIT", origin: { kind: "commit" }, writes: [], named: ["COMMIT"] }
]

/** What U3 rules a 23514 on an owner at an origin means. */
type Verdict =
	| { readonly kind: "defect"; readonly domain: string }
	| { readonly kind: "rejected"; readonly laws: Arr.NonEmptyReadonlyArray<LawId> }
	| { readonly kind: "failed" }

/**
 * U3's ruling, as a checker: the owner alone decides, but for a shared domain, whose laws are its columns' in the
 * relations the origin writes, and every one of them where it writes neither.
 */
const ruling = (owner: Owner, origin: Origin): Verdict => {
	switch (owner.kind) {
		case "a roster's code domain":
			return { kind: "defect", domain: identifierOf(codeDomain) }
		case "a roster's bits domain":
			return { kind: "defect", domain: identifierOf(bitsDomain) }
		case "a table CHECK":
			return { kind: "rejected", laws: [checkLaw] }
		case "a contract's domain":
			return { kind: "rejected", laws: [seats.law] }
		case "a domain two contracts share": {
			const coerced = Arr.map(origin.writes, (r) => (r === "Node" ? count.law : tally.law))
			return {
				kind: "rejected",
				laws: Arr.isReadonlyArrayNonEmpty(coerced) ? coerced : [count.law, tally.law]
			}
		}
		case "a text refinement domain":
			return { kind: "rejected", laws: [labelDomain.law] }
		case "a roster's code domain in another schema":
		case "a bits domain the installation does not hold":
			return { kind: "failed" }
	}
}

type Situation = OwnerKind | OriginKind

const pairs: Gen<readonly [Owner, Origin]> = (source) => [
	element(owners)(source),
	element(origins)(source)
]

describe("a 23514 at a write", () => {
	it.effect(
		"is grizzle's defect on a roster's domain at every origin, and its laws on a table CHECK or another domain",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/adapter/witness/roster-domain",
						generator: pairs,
						literal: ([owner, origin]) => Formatter.format([owner.kind, origin.kind]),
						limit: owners.length * origins.length,
						coverage: requiredInSpace<Situation>([
							"a family's stored-suffix read",
							"a table CHECK",
							"a roster's code domain",
							"a roster's bits domain",
							"a contract's domain",
							"a domain two contracts share",
							"a text refinement domain",
							"a roster's code domain in another schema",
							"a bits domain the installation does not hold",
							"a write statement",
							"a single statement",
							"a carrier's create",
							"a carrier's fill",
							"an ANALYZE",
							"a serial advance",
							"a read-back step",
							"an entry's precheck",
							"a family's statement",
							"a family statement's later chunk",
							"a read-back past the sent statements",
							"the COMMIT"
						]),
						caseHang,
						box: "every (owner, origin) pair: eight owners of a 23514 by thirteen origins in a write's two flights",
						oracle: {
							kind: "specification",
							name: "U3's ruling, stated as a checker of the owner and the relations the origin writes"
						}
					},
					([owner, origin], c) =>
						Effect.sync(() => {
							c.note(owner.kind)
							c.note(origin.kind)
							const failure = serverError(owner.reported)
							const classified = classifyServerError(failure, {
								violation,
								origin: origin.origin
							})
							const verdict = ruling(owner, origin)
							switch (verdict.kind) {
								case "defect": {
									assertVariant(classified, "kind", "defect", "a roster domain's 23514 is a defect")
									const message = classified.defect.message
									containsText(message, verdict.domain, "the defect names the domain")
									containsText(message, "roster Kind", "the defect names its roster")
									for (const words of origin.named) {
										containsText(message, words, "the defect names where it was raised")
									}
									for (const code of liveCodes) {
										containsText(message, code, "the defect names each code the domain admits")
									}
									containsText(message, "holes 1", "the defect names the hole")
									return
								}
								case "rejected":
									assertVariant(classified, "kind", "rejected", "a law's 23514 reports its laws")
									assert.deepEqual(classified.witness, { kind: "unreported" })
									unorderedEqual(
										classified.laws,
										Arr.map(verdict.laws, (law) =>
											defined(artifacts.described.get(law), "the law is described")
										),
										"exactly the laws the ruling names"
									)
									return
								case "failed":
									assertVariant(classified, "kind", "failed", "another installation's domain")
									assert.ok(classified.error instanceof ExecutionFailure)
									assert.equal(classified.error.reason, failure, "it carries the server's report")
									return
							}
						})
				)
			)
	)
})
