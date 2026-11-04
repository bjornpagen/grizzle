import { Array as Arr, Effect, Option, Record as Rec, type Scope } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import { identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { closedId, Decimal, Money, pg, span } from "#compiler/public/fields.ts"
import {
	type AnyRelation,
	type AnySchema,
	alternatives,
	capacity,
	check,
	closed,
	contained,
	key,
	mirrors,
	on,
	ref,
	relation,
	schema,
	select,
	weigh,
	within
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import {
	describeMutability,
	type Family,
	type Mutability,
	mutables
} from "#test/pg/laws/families/families.ts"
import {
	type HostBound,
	everyFact,
	type HostFact,
	type HostLaw,
	type HostRelation,
	type HostSchema,
	hostSpan,
	type HostOp,
	type HostValue
} from "#test/pg/laws/families/model.ts"
import { openWriter, type Session } from "#test/pg/laws/families/support.ts"
import { defined } from "#test/support/assert.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import {
	type LawNames,
	lawNamesOf,
	parsedName,
	reportedLawId
} from "#test/support/kernel/naming.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { applyRuntime } from "#test/support/runtime-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * How a field's host number is given to grizzle and read back: as itself, a bigint, a Decimal, or a Money of whole
 * units; any other value as itself. An identity column is given as itself, and a direct writer's plain INSERT cannot
 * list it.
 */
type Encoding = "plain" | "identity" | "bigint" | "decimal" | "money"

/** A relation as the host sees it, with each field's encoding; its mutability is its schema's (BoxParams). */
interface Rel {
	readonly host: Omit<HostRelation, "mutable">
	readonly encodings: Readonly<Record<string, Encoding>>
}

const rel = (
	name: string,
	fields: ReadonlyArray<readonly [string, Encoding]>,
	keyFields: ReadonlyArray<string>
): Rel => ({
	host: {
		name,
		table: identity.table(parsedName(name)).identifier,
		fields: Arr.map(fields, ([field]) => ({
			name: field,
			column: identity.column(parsedName(field)).identifier
		})),
		key: keyFields
	},
	encodings: Rec.fromEntries(fields)
})

const encode = (encoding: Encoding, x: HostValue): unknown => {
	if (typeof x !== "number") {
		return x
	}
	switch (encoding) {
		case "plain":
		case "identity":
			return x
		case "bigint":
			return BigInt(x)
		case "decimal":
			return Decimal.of(BigInt(x))
		case "money":
			return Money.of(BigInt(x) * 100n)
	}
}

/** A column read back as the host spells its value: money as its whole units. */
const readColumn = (encoding: Encoding, column: string): string =>
	encoding === "money"
		? `(${quoteIdent(column)}::numeric)::int8::text`
		: `${quoteIdent(column)}::text`

/** The selector a point draws on a side: none, or a field and the value its facts hold. */
type Selection =
	| { readonly kind: "every" }
	| { readonly kind: "selected"; readonly field: string; readonly value: HostValue }
const every: Selection = { kind: "every" }
const where = (s: Selection): Readonly<Record<string, HostValue>> =>
	s.kind === "every" ? everyFact : { [s.field]: s.value }

/** The field whose conversion fills the 63 bytes a declared name may take, which selects the tagged containment's
 * target: every name derived from it is hashed, its stem cut to fit. */
const longSelector = "flaggedForReviewByTheAuditTeamDuringTheQuarterlyClose"

const stages = ["draft", "paid", "void"] as const
const Stage = closed("Stage", stages)

const label = pg.integer
const lang = str.regex("^[a-z]{2}$")
const parentFields = {
	flag: pg.boolean,
	level: pg.smallint,
	lang,
	stage: closedId(Stage),
	note: label
} as const

const childFields = {
	id: pg.integer,
	flag: pg.boolean,
	level: pg.smallint,
	lang,
	stage: closedId(Stage)
} as const

const ParentI2 = relation("Parent", { id: pg.smallint, ...parentFields }, ["id"])
const ChildI2 = relation("Child", { ...childFields, parent: pg.smallint }, ["id"])
const ParentI8 = relation("Parent", { id: pg.bigint, ...parentFields }, ["id"])
const ChildI8 = relation("Child", { ...childFields, parent: pg.bigint }, ["id"])
const ParentI4 = relation("Parent", { id: pg.integer, ...parentFields }, ["id"])
const ChildI4 = relation("Child", { ...childFields, parent: pg.integer }, ["id"])
const ParentSerial = relation("Parent", { id: pg.serial }, ["id"])
const ChildSerial = relation("Child", { ...childFields, parent: pg.integer }, ["id"])
const ParentLong = relation("Parent", { id: pg.integer, [longSelector]: pg.boolean, note: label }, [
	"id"
])
const ChildLong = relation("Child", { id: pg.integer, parent: pg.integer, note: label }, ["id"])
const Run = relation("Parent", { id: pg.bigint, stage: closedId(Stage), note: label }, ["id"])
const Paid = relation("Child", { parent: pg.bigint, note: label }, ["parent"])

const teamFields = { id: pg.integer, code: pg.integer, open: pg.boolean } as const
const memberFields = { id: pg.integer, team: pg.integer, active: pg.boolean } as const
const TeamCount = relation("Team", { ...teamFields, cap: pg.integer }, ["id"])
const TeamI2 = relation("Team", { ...teamFields, cap: pg.smallint }, ["id"])
const TeamI8 = relation("Team", { ...teamFields, cap: pg.bigint }, ["id"])
const TeamNumeric = relation("Team", { ...teamFields, cap: pg.numeric }, ["id"])
const TeamMoney = relation("Team", { ...teamFields, cap: pg.money }, ["id"])
const MemberCount = relation("Member", { ...memberFields, weight: pg.integer }, ["id"])
const MemberI2 = relation("Member", { ...memberFields, weight: pg.smallint }, ["id"])
const MemberI8 = relation("Member", { ...memberFields, weight: pg.bigint }, ["id"])
const MemberNumeric = relation("Member", { ...memberFields, weight: pg.numeric }, ["id"])

const RotaI2 = relation("Rota", { site: pg.smallint, during: span(pg.integer), open: pg.boolean }, [
	"site",
	"during"
])

const VisitI2 = relation(
	"Visit",
	{ id: pg.integer, site: pg.smallint, during: span(pg.integer), billable: pg.boolean },
	["id"]
)

const RotaI8 = relation("Rota", { site: pg.bigint, during: span(pg.integer), open: pg.boolean }, [
	"site",
	"during"
])

const VisitI8 = relation(
	"Visit",
	{ id: pg.integer, site: pg.bigint, during: span(pg.integer), billable: pg.boolean },
	["id"]
)

const Left = relation("Left", { id: pg.integer, a: pg.integer, b: pg.integer }, ["id"])
const Right = relation("Right", { id: pg.integer, a: pg.integer, b: pg.integer }, ["id"])

/** The host's view of each relation, its fields in heading order with their encodings. */
const enc = (
	fields: ReadonlyArray<string>,
	encoding: Encoding
): ReadonlyArray<readonly [string, Encoding]> => Arr.map(fields, (f) => [f, encoding] as const)
const parentRest = enc(["flag", "level", "lang", "stage", "note"], "plain")
const childRest = enc(["id", "flag", "level", "lang", "stage"], "plain")
const parentHost = (k: Encoding): Rel => rel("Parent", [["id", k], ...parentRest], ["id"])
const childHost = (k: Encoding): Rel => rel("Child", [...childRest, ["parent", k]], ["id"])
const teamHost = (cap: Encoding): Rel =>
	rel("Team", [...enc(["id", "code", "open"], "plain"), ["cap", cap]], ["id"])

const memberHost = (weight: Encoding): Rel =>
	rel("Member", [...enc(["id", "team", "active"], "plain"), ["weight", weight]], ["id"])

const rotaHost = (k: Encoding): Rel =>
	rel("Rota", [["site", k], ...enc(["during", "open"], "plain")], ["site", "during"])

const visitHost = (k: Encoding): Rel =>
	rel("Visit", [["id", "plain"], ["site", k], ...enc(["during", "billable"], "plain")], ["id"])

/** A point's laws, stated to the host over the law names of its schema. */
type HostLaws = (laws: LawNames) => ReadonlyArray<HostLaw>

/** A statement of a point's schema. */
type PointStatement = Parameters<typeof schema>[2][number]

/**
 * One point: its traits, its relations' values by name, its law statements, and the host's relations and laws. Its
 * schema is its relations and statements with the `mutable` statements of the relations its BoxParams declare mutable,
 * each written by every writer (boxSchema).
 */
interface Point {
	readonly name: string
	readonly traits: ReadonlyArray<string>
	readonly values: Readonly<Record<string, AnyRelation>>
	readonly statements: ReadonlyArray<PointStatement>
	readonly relations: ReadonlyArray<Rel>
	readonly laws: HostLaws
}

const keyLaw = (
	laws: LawNames,
	r: AnyRelation & { readonly name: string },
	fields: ReadonlyArray<string>
): HostLaw => ({
	kind: "key",
	law: laws.primaryKeyLaw(r),
	relation: r.name,
	fields
})

/** Selected-source containment points. */
const containmentI2 = contained(on(select(ChildI2, { flag: true }), "parent"), on(ParentI2, "id"))
const containmentI8 = contained(
	on(select(ChildI8, { stage: "paid" }), "parent"),
	on(ParentI8, "id")
)

const containmentSerial = contained(
	on(select(ChildSerial, { flag: false }), "parent"),
	on(ParentSerial, "id")
)
const containmentI4 = contained(on(select(ChildI4, { lang: "en" }), "parent"), on(ParentI4, "id"))
const childParentKey = key(ChildI4, ["parent"])
const taggedLong = contained(
	on(ChildLong, "parent"),
	on(select(ParentLong, { [longSelector]: true }), "id")
)
const mirrorsI2 = mirrors(on(select(ParentI2, { level: 2 }), "id"), on(ChildI2, "parent"))
const runStages = alternatives(Run, "stage", Stage, { paid: Paid })

const selectedContainment =
	(law: (laws: LawNames) => LawId, selector: Selection): HostLaws =>
	(laws) => [
		{
			kind: "contained",
			law: law(laws),
			source: { relation: "Child", fields: ["parent"], where: where(selector) },
			target: { relation: "Parent", fields: ["id"], where: everyFact },
			residual: true
		}
	]

const containmentPoints: Arr.NonEmptyReadonlyArray<Point> = [
	{
		name: "a containment over an int2 key, a boolean selector",
		traits: ["family containment", "key int2", "selector boolean"],
		statements: [containmentI2],
		values: { Parent: ParentI2, Child: ChildI2 },
		relations: [parentHost("plain"), childHost("plain")],
		laws: (laws) => [
			keyLaw(laws, ParentI2, ["id"]),
			keyLaw(laws, ChildI2, ["id"]),
			...selectedContainment((l) => l.lawOf(containmentI2), {
				kind: "selected",
				field: "flag",
				value: true
			})(laws)
		]
	},
	{
		name: "a containment over an int8 key, a closed handle selector",
		traits: ["family containment", "key int8", "selector closed"],
		statements: [containmentI8],
		values: { Parent: ParentI8, Child: ChildI8 },
		relations: [parentHost("bigint"), childHost("bigint")],
		laws: (laws) => [
			keyLaw(laws, ParentI8, ["id"]),
			keyLaw(laws, ChildI8, ["id"]),
			...selectedContainment((l) => l.lawOf(containmentI8), {
				kind: "selected",
				field: "stage",
				value: "paid"
			})(laws)
		]
	},
	{
		name: "a containment into an anchor whose every column is serial",
		traits: ["family containment", "key serial", "selector boolean", "an all-serial anchor"],
		statements: [containmentSerial],
		values: { Parent: ParentSerial, Child: ChildSerial },
		relations: [rel("Parent", [["id", "identity"]], ["id"]), childHost("plain")],
		laws: (laws) => [
			keyLaw(laws, ParentSerial, ["id"]),
			keyLaw(laws, ChildSerial, ["id"]),
			...selectedContainment((l) => l.lawOf(containmentSerial), {
				kind: "selected",
				field: "flag",
				value: false
			})(laws)
		]
	},
	{
		name: "a containment over an int4 key whose source names it by a candidate key",
		traits: ["family containment", "key int4", "selector text", "witness by a candidate key"],
		statements: [containmentI4, childParentKey],
		values: { Parent: ParentI4, Child: ChildI4 },
		relations: [parentHost("plain"), childHost("plain")],
		laws: (laws) => [
			keyLaw(laws, ParentI4, ["id"]),
			keyLaw(laws, ChildI4, ["id"]),
			{ kind: "key", law: laws.lawOf(childParentKey), relation: "Child", fields: ["parent"] },
			...selectedContainment((l) => l.lawOf(containmentI4), {
				kind: "selected",
				field: "lang",
				value: "en"
			})(laws)
		]
	},
	{
		name: "a containment into a target selected by a field of 63 bytes",
		traits: ["family tagged containment", "key int4", "a selector field of 63 bytes"],
		statements: [taggedLong],
		values: { Parent: ParentLong, Child: ChildLong },
		relations: [
			rel(
				"Parent",
				[
					["id", "plain"],
					[longSelector, "plain"],
					["note", "plain"]
				],
				["id"]
			),
			rel("Child", enc(["id", "parent", "note"], "plain"), ["id"])
		],
		laws: (laws) => [
			keyLaw(laws, ParentLong, ["id"]),
			keyLaw(laws, ChildLong, ["id"]),
			{
				kind: "contained",
				law: laws.lawOf(taggedLong),
				source: { relation: "Child", fields: ["parent"], where: everyFact },
				target: { relation: "Parent", fields: ["id"], where: { [longSelector]: true } },
				residual: false
			}
		]
	},
	{
		name: "conditional mirrors over an int2 key, an int2 selector",
		traits: ["family mirrors", "key int2", "selector int2"],
		statements: [mirrorsI2],
		values: { Parent: ParentI2, Child: ChildI2 },
		relations: [parentHost("plain"), childHost("plain")],
		laws: (laws) => {
			const halves = laws.mirrorsOf(mirrorsI2)
			return [
				keyLaw(laws, ParentI2, ["id"]),
				keyLaw(laws, ChildI2, ["id"]),
				{
					kind: "contained",
					law: halves.rightToLeft,
					source: { relation: "Child", fields: ["parent"], where: everyFact },
					target: { relation: "Parent", fields: ["id"], where: { level: 2 } },
					residual: false
				},
				{
					kind: "obliged",
					law: halves.leftToRight,
					anchor: { relation: "Parent", fields: ["id"], where: { level: 2 } },
					dependent: { relation: "Child", fields: ["parent"], where: everyFact }
				}
			]
		}
	},
	{
		name: "alternatives over an int8 key, one handle of three armed",
		traits: ["family alternatives", "key int8"],
		statements: [runStages],
		values: { Parent: Run, Child: Paid },
		relations: [
			rel(
				"Parent",
				[
					["id", "bigint"],
					["stage", "plain"],
					["note", "plain"]
				],
				["id"]
			),
			rel(
				"Child",
				[
					["parent", "bigint"],
					["note", "plain"]
				],
				["parent"]
			)
		],
		laws: (laws) => {
			const stage = laws.alternativesOf(runStages)
			const paid = stage.arms["paid"]
			if (paid === undefined) {
				throw new Error("the paid arm has no law")
			}
			return [
				keyLaw(laws, Run, ["id"]),
				keyLaw(laws, Paid, ["parent"]),
				{
					kind: "contained",
					law: paid,
					source: { relation: "Child", fields: ["parent"], where: everyFact },
					target: { relation: "Parent", fields: ["id"], where: { stage: "paid" } },
					residual: false
				},
				{
					kind: "obliged",
					law: stage.reverse,
					anchor: { relation: "Parent", fields: ["id"], where: { stage: "paid" } },
					dependent: { relation: "Child", fields: ["parent"], where: everyFact }
				}
			]
		}
	}
]

/**
 * Scalar-group capacity points: the target and source relations, the weight, the bounds, whether each side is
 * selected (a team when open, a member when active), and whether the containment of the sources into the target is
 * declared.
 */
type TeamRel =
	| typeof TeamCount
	| typeof TeamI2
	| typeof TeamI8
	| typeof TeamNumeric
	| typeof TeamMoney
type MemberRel = typeof MemberCount | typeof MemberI2 | typeof MemberI8 | typeof MemberNumeric

interface CapacityPoint {
	readonly team: TeamRel
	readonly member: MemberRel
	readonly cap: Encoding
	readonly weight:
		| { readonly kind: "count" }
		| { readonly kind: "field"; readonly encoding: Encoding }
	readonly low: bigint | "cap"
	readonly high: bigint | "cap" | "*"
	readonly openTeams: boolean
	readonly activeMembers: boolean
	readonly contained: boolean
	/** The team's grouping key: its primary key `id`, or its candidate key `code`, which Member's `team` pairs with. */
	readonly by: "id" | "code"
	readonly traits: ReadonlyArray<string>
}

const boundOf = (b: bigint | "cap") => (b === "cap" ? ref("cap") : b)
const hostBound = (b: bigint | "cap"): HostBound => (b === "cap" ? { ref: "cap" } : b)
const teamSide = (c: CapacityPoint) =>
	c.openTeams ? on(select(c.team, { open: true }), c.by) : on(c.team, c.by)

const memberSide = (c: CapacityPoint) =>
	c.activeMembers ? on(select(c.member, { active: true }), "team") : on(c.member, "team")

const capacityPoint = (c: CapacityPoint): Point => {
	const law = capacity(teamSide(c), {
		from: memberSide(c),
		...(c.weight.kind === "field" ? { weight: weigh("weight") } : {}),
		within: within(boundOf(c.low), c.high === "*" ? "*" : boundOf(c.high))
	})
	const containment = contained(on(c.member, "team"), on(c.team, c.by))
	const codeKey = key(c.team, ["code"])
	return {
		name: Arr.join(c.traits, ", "),
		traits: c.traits,
		statements: [law, ...(c.contained ? [containment] : []), ...(c.by === "code" ? [codeKey] : [])],
		values: { Team: c.team, Member: c.member },
		relations: [
			teamHost(c.cap),
			memberHost(c.weight.kind === "field" ? c.weight.encoding : "plain")
		],
		laws: (laws) => [
			keyLaw(laws, c.team, ["id"]),
			keyLaw(laws, c.member, ["id"]),
			...(c.by === "code"
				? [
						{
							kind: "key",
							law: laws.lawOf(codeKey),
							relation: "Team",
							fields: ["code"]
						} satisfies HostLaw
					]
				: []),
			...(c.contained
				? [
						{
							kind: "contained",
							law: laws.lawOf(containment),
							source: { relation: "Member", fields: ["team"], where: everyFact },
							target: { relation: "Team", fields: [c.by], where: everyFact },
							residual: false
						} satisfies HostLaw
					]
				: []),
			{
				kind: "capacity",
				law: laws.lawOf(law),
				target: {
					relation: "Team",
					fields: [c.by],
					where: c.openTeams ? { open: true } : everyFact
				},
				source: {
					relation: "Member",
					fields: ["team"],
					where: c.activeMembers ? { active: true } : everyFact
				},
				weight: c.weight.kind === "field" ? { kind: "field", field: "weight" } : { kind: "count" },
				low: hostBound(c.low),
				high: c.high === "*" ? "*" : hostBound(c.high)
			}
		]
	}
}

const capacityPoints: Arr.NonEmptyReadonlyArray<Point> = [
	capacityPoint({
		team: TeamCount,
		member: MemberCount,
		cap: "plain",
		weight: { kind: "count" },
		low: 0n,
		high: 2n,
		openTeams: false,
		activeMembers: false,
		contained: false,
		by: "id",
		traits: [
			"family capacity",
			"weight count",
			"bound literal",
			"selected neither",
			"no containment"
		]
	}),
	capacityPoint({
		team: TeamI2,
		member: MemberI2,
		cap: "plain",
		weight: { kind: "field", encoding: "plain" },
		low: 0n,
		high: "cap",
		openTeams: true,
		activeMembers: false,
		contained: true,
		by: "id",
		traits: ["family capacity", "weight int2", "bound int2", "selected target", "a containment"]
	}),
	capacityPoint({
		team: TeamMoney,
		member: MemberCount,
		cap: "money",
		weight: { kind: "field", encoding: "plain" },
		low: 0n,
		high: "cap",
		openTeams: false,
		activeMembers: true,
		contained: false,
		by: "id",
		traits: ["family capacity", "weight int4", "bound money", "selected source", "no containment"]
	}),
	capacityPoint({
		team: TeamI8,
		member: MemberI8,
		cap: "bigint",
		weight: { kind: "field", encoding: "bigint" },
		low: "cap",
		high: "*",
		openTeams: true,
		activeMembers: true,
		contained: true,
		by: "id",
		traits: ["family capacity", "weight int8", "bound int8", "selected both", "a containment"]
	}),
	capacityPoint({
		team: TeamNumeric,
		member: MemberNumeric,
		cap: "decimal",
		weight: { kind: "field", encoding: "decimal" },
		low: 1n,
		high: "cap",
		openTeams: false,
		activeMembers: false,
		contained: true,
		by: "id",
		traits: [
			"family capacity",
			"weight numeric",
			"bound numeric",
			"selected neither",
			"a containment"
		]
	}),
	capacityPoint({
		team: TeamMoney,
		member: MemberCount,
		cap: "money",
		weight: { kind: "count" },
		low: 0n,
		high: "cap",
		openTeams: true,
		activeMembers: false,
		contained: false,
		by: "code",
		traits: [
			"family capacity",
			"weight count",
			"bound money",
			"selected target",
			"no containment",
			"witness by a candidate key"
		]
	})
]

/** Span coverage points. */
const coverageI2 = contained(
	on(select(VisitI2, { billable: true }), "site", "during"),
	on(RotaI2, "site", "during")
)

const coverageI8 = contained(
	on(VisitI8, "site", "during"),
	on(select(RotaI8, { open: true }), "site", "during")
)

const coveragePoint = (
	rota: AnyRelation & { readonly name: string },
	visit: AnyRelation & { readonly name: string },
	k: Encoding,
	law: ReturnType<typeof contained>,
	visits: Selection,
	rotas: Selection,
	traits: ReadonlyArray<string>
): Point => ({
	name: Arr.join(traits, ", "),
	traits,
	statements: [law],
	values: { Rota: rota, Visit: visit },
	relations: [rotaHost(k), visitHost(k)],
	laws: (laws) => [
		{
			kind: "spanKey",
			law: laws.primaryKeyLaw(rota),
			relation: "Rota",
			scalars: ["site"],
			span: "during"
		},
		keyLaw(laws, visit, ["id"]),
		{
			kind: "covered",
			law: laws.lawOf(law),
			source: { relation: "Visit", fields: ["site"], where: where(visits) },
			target: { relation: "Rota", fields: ["site"], where: where(rotas) },
			span: { source: "during", target: "during" },
			residual: visits.kind === "selected"
		}
	]
})

const coveragePoints: Arr.NonEmptyReadonlyArray<Point> = [
	coveragePoint(
		RotaI2,
		VisitI2,
		"plain",
		coverageI2,
		{ kind: "selected", field: "billable", value: true },
		every,
		["family coverage", "key int2", "selected source"]
	),
	coveragePoint(
		RotaI8,
		VisitI8,
		"bigint",
		coverageI8,
		every,
		{ kind: "selected", field: "open", value: true },
		["family coverage", "key int8", "selected target"]
	)
]

/** Two relations, a row check of one declared name each. */
const leftDistinct = check("Distinct", Left, (x) => x.ne(x.a, x.b))
const rightDistinct = check("Distinct", Right, (x) => x.ne(x.a, x.b))
const checkPoints: Arr.NonEmptyReadonlyArray<Point> = [
	{
		name: "two relations, a row check of one declared name each",
		traits: ["family row checks", "a check name two relations declare"],
		statements: [leftDistinct, rightDistinct],
		values: { Left, Right },
		relations: [
			rel("Left", enc(["id", "a", "b"], "plain"), ["id"]),
			rel("Right", enc(["id", "a", "b"], "plain"), ["id"])
		],
		laws: (laws) => [
			keyLaw(laws, Left, ["id"]),
			keyLaw(laws, Right, ["id"]),
			{
				kind: "check",
				law: laws.lawOf(leftDistinct),
				relation: "Left",
				holds: (f: HostFact) => f["a"] !== f["b"]
			},
			{
				kind: "check",
				law: laws.lawOf(rightDistinct),
				relation: "Right",
				holds: (f: HostFact) => f["a"] !== f["b"]
			}
		]
	}
]

const points: Arr.NonEmptyReadonlyArray<Point> = Arr.appendAll(
	Arr.appendAll(Arr.appendAll(containmentPoints, capacityPoints), coveragePoints),
	checkPoints
)

/**
 * A capacity the compiler refuses (UnsupportedLawFamily): a weight whose sum is inexact or may overflow (real, double
 * precision, money), or a `ref` bound no carrier compares exactly with the exact sum (real, double precision).
 */
export interface RefusedCapacity {
	readonly name: string
	readonly schema: (name: string) => AnySchema
}

const TeamF4 = relation("Team", { ...teamFields, cap: pg.real }, ["id"])
const TeamF8 = relation("Team", { ...teamFields, cap: pg.float8 }, ["id"])
const MemberF4 = relation("Member", { ...memberFields, weight: pg.real }, ["id"])
const MemberF8 = relation("Member", { ...memberFields, weight: pg.float8 }, ["id"])
const MemberMoney = relation("Member", { ...memberFields, weight: pg.money }, ["id"])

const weighed =
	(
		team: TeamRel | typeof TeamF4 | typeof TeamF8,
		member: MemberRel | typeof MemberF4 | typeof MemberF8 | typeof MemberMoney,
		high: bigint | "cap"
	) =>
	(name: string): AnySchema =>
		schema(name, { Team: team, Member: member }, [
			capacity(on(team, "id"), {
				from: on(member, "team"),
				weight: weigh("weight"),
				within: within(0n, boundOf(high))
			})
		])

export const refusedCapacities: Arr.NonEmptyReadonlyArray<RefusedCapacity> = [
	{ name: "a real weight", schema: weighed(TeamCount, MemberF4, 4n) },
	{ name: "a double precision weight", schema: weighed(TeamCount, MemberF8, 4n) },
	{ name: "a money weight", schema: weighed(TeamCount, MemberMoney, 4n) },
	{ name: "a real ref bound", schema: weighed(TeamF4, MemberCount, "cap") },
	{ name: "a double precision ref bound", schema: weighed(TeamF8, MemberCount, "cap") }
]

/** A point of the box with the mutability of each of its relations, by the name its values give it. */
export interface BoxParams {
	readonly mutable: Mutability<string>
	readonly point: Point
}

/** The schema of a box point under a name: its relations, its statements, and its relations' `mutable` statements. */
const boxSchema = (p: BoxParams, name: string): AnySchema =>
	schema(name, { Stage, ...p.point.values }, [
		...p.point.statements,
		...mutables(p.mutable, p.point.values)
	])

const hostOf = (p: BoxParams): HostSchema => ({
	relations: Arr.map(p.point.relations, (r): HostRelation => ({
		...r.host,
		mutable: defined(p.mutable[r.host.name], `the mutability of ${r.host.name}`)
	})),
	laws: p.point.laws(lawNamesOf(boxSchema(p, "families")))
})

const encodingOf = (r: Rel, field: string): Encoding => r.encodings[field] ?? "plain"

/**
 * The session of `app` on an installation: its ChangeSets built at run time over the relation values by name, each
 * value at its field's carrier, and the state read back as the host spells it.
 */
const boxSession = (
	p: BoxParams,
	installed: Installed
): Effect.Effect<Session, OpenError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const value = boxSchema(p, installed.declared)
		const { db } = yield* openWriter({ installed, schema: value })
		const host = hostOf(p)
		const q = quoteIdent(installed.schema)
		const table = (r: Rel) => `${q}.${quoteIdent(r.host.table)}`
		const relOf = (name: string): Rel => {
			const r = Arr.findFirst(p.point.relations, (x) => x.host.name === name)
			if (Option.isNone(r)) {
				throw new Error(`no relation ${name}`)
			}
			return r.value
		}
		const apply = (ops: ReadonlyArray<HostOp>) => {
			let c = changeSetOver.empty(value)
			for (const o of ops) {
				const relationValue = p.point.values[o.relation]
				if (relationValue === undefined) {
					throw new Error(`no relation value ${o.relation}`)
				}
				const r = relOf(o.relation)
				const facts = Arr.map(o.facts, (f) =>
					Rec.fromEntries(
						Arr.map(Rec.toEntries(f), ([field, x]) => [field, encode(encodingOf(r, field), x)])
					)
				)
				c = c[o.kind](relationValue, facts)
			}
			return applyRuntime(db, c, {})
		}
		return {
			host,
			reset: s.admin.query(`TRUNCATE ${Arr.join(Arr.map(p.point.relations, table), ", ")}`, []),
			apply,
			reported: (law: Law) => reportedLawId(installed.installation.described, law),
			read: Effect.forEach(p.point.relations, (r) =>
				Effect.map(
					s.admin.queryValues(
						`SELECT ${Arr.join(
							Arr.map(r.host.fields, (f) => readColumn(encodingOf(r, f.name), f.column)),
							", "
						)} FROM ${table(r)}`,
						[]
					),
					(rows) => Arr.map(rows, (row) => Arr.map(row, (x) => String(x)))
				)
			)
		}
	})

/** The family over `pointsOf` the box's points, each with every relation immutable and with every one mutable. */
const boxOf = (
	caseLabel: string,
	pointsOf: Arr.NonEmptyReadonlyArray<Point>
): Family<BoxParams> => ({
	label: caseLabel,
	variants: Arr.flatMap([false, true] as const, (declared) =>
		Arr.map(pointsOf, (point): BoxParams => ({
			mutable: Rec.map(point.values, () => declared),
			point
		}))
	),
	describe: (p) => `${describeMutability(p.mutable)}, ${p.point.name}`,
	traits: (p) => p.point.traits,
	/**
	 * Every relation of every point draws from these: a few keys, so a group fills past its bounds; caps around the
	 * literal bounds; spans whose adjacent pairs cover a visit only together.
	 */
	domains: {
		Parent: {
			id: [1, 2, 3],
			flag: [true, false],
			level: [1, 2],
			lang: ["en", "fr"],
			stage: stages,
			note: [1, 2],
			[longSelector]: [true, false]
		},
		Child: {
			id: [1, 2, 3, 4],
			parent: [1, 2, 3, 4],
			flag: [true, false],
			level: [1, 2],
			lang: ["en", "fr"],
			stage: stages,
			note: [1, 2]
		},
		Team: { id: [1, 2, 3], code: [1, 2, 3], open: [true, false], cap: [0, 1, 2, 4] },
		Member: {
			id: [1, 2, 3, 4, 5, 6],
			team: [1, 2, 1, 2, 4],
			active: [true, false],
			weight: [1, 2, 3]
		},
		Rota: {
			site: [1, 2],
			during: [hostSpan(0, 5), hostSpan(5, 10), hostSpan(0, 10), hostSpan(3, 7)],
			open: [true, false]
		},
		Visit: {
			id: [1, 2, 3],
			site: [1, 2],
			during: [hostSpan(3, 7), hostSpan(0, 5), hostSpan(6, 10), hostSpan(2, 4)],
			billable: [true, false]
		},
		Left: { id: [1, 2, 3], a: [1, 2], b: [1, 2] },
		Right: { id: [1, 2, 3], a: [1, 2], b: [1, 2] }
	},
	host: hostOf,
	schema: (p) => (name) => boxSchema(p, name),
	connect: boxSession
})

/**
 * The law-family box: one family whose schemas range over the coordinates where grizzle's laws have broken, every
 * point a small schema stated twice, to grizzle through the public builders and to the host (model.ts) as its laws'
 * violation queries. The family suite (suites/family.ts) and the direct-writer suite (suites/direct.ts) draw from it;
 * every point's coordinates are its traits, each of which must meet a refusal by every kind of residual law of a point
 * that holds it.
 *
 * The coordinates (family, side, selector, carrier, bound) and the dictionary they are drawn from:
 *
 * - selected-source containment `contained(on(select(Child, sel), "parent"), on(Parent, "id"))`, a residual law, over
 *   a key of int2, int8 or text, a selector of boolean, int2, text or a closed handle; one point whose anchor's every
 *   column is serial (`Parent(id: serial)`), which installs and enforces its law; one whose paired field is a
 *   candidate key of the source, so the witness names the source by that key, not by its primary key;
 * - a containment into a selected target, a tagged native foreign key, selected by a field whose converted name fills
 *   the 63 bytes a declared name may take, so the tag column and the foreign key derived from it are hashed with their
 *   stems cut to fit, and its law's identity must name its constraint;
 * - conditional mirrors over an int2 key and an int2 selector: the tagged foreign key and the residual obligation;
 * - alternatives over an int8 key with one handle armed of three;
 * - scalar-group capacity `capacity(on([select(]Team[)], "id" | "code"), { from: on([select(]Member[)], ...), weight?,
 *   within })`: a count or a weight of int2, int4, int8 or numeric; literal bounds or a `ref` bound of int2, int8,
 *   numeric or money; a selector on neither side, the source, the target or both; with and without the declared
 *   containment of the sources into the target (orphan sources are lawful without it); and one point whose target is
 *   grouped by its candidate key `code`, so the witness names the team by `code`;
 * - span coverage `contained(on([select(]Visit[)], "site", "during"), on([select(]Rota[)], "site", "during"))` over an
 *   int2 or int8 site: a selected source, a residual law that never judges a source outside its selection, or a
 *   selected target, a tagged PERIOD foreign key;
 * - two relations each declaring a row check of one name, each refused under its own law.
 *
 * A float or money weight and a float `ref` bound are refused when the schema is compiled (UnsupportedLawFamily), the
 * named invalid points of generated.test.ts, never members of the box.
 *
 * A value is drawn on the host as a number and given to grizzle and read back at its field's carrier: a bigint for
 * int8, a Decimal for numeric, a Money of whole units for money.
 */
export const lawBox: Family<BoxParams> = boxOf("the law-family box", points)

/**
 * The points a direct SQL writer's statements reach as the family's direct suite writes them (direct.ts): an integer
 * literal for every number and each column read back as text, so no money column and no identity column a plain
 * INSERT lists.
 */
export const directLawBox: Family<BoxParams> = boxOf(
	"the law-family box, direct",
	nonEmptyList(
		Arr.filter(points, (point) =>
			Arr.every(point.relations, (r) =>
				Arr.every(Rec.values(r.encodings), (e) => e !== "money" && e !== "identity")
			)
		),
		"the direct law-family box"
	)
)
