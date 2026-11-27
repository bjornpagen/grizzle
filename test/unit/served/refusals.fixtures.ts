/** What the properties of refusals.test.ts read: its spaces, models and helpers. */

import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, int, map, subarray } from "@bjornpagen/testing/gen"
import { Result as Answered, Array as Arr, Effect, Formatter, Option } from "effect"
import { installationWitness } from "#adapter/served/refusals.ts"
import type { WrittenAt } from "#adapter/witness/classify.ts"
import { servedWitness } from "#adapter/witness/index.ts"
import { identifierOf, identity, type HeldName } from "#compiler/core/identity.ts"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { type Codebook, rosterCodebook, type RosterCodec } from "#compiler/ir/codes.ts"
import { rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import type { ConcurrentChangeTag } from "#compiler/runtime/write/refusal.ts"
import type { Refuser } from "#compiler/runtime/write/witness.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { type CaseSketch, caseSketchGen } from "#test/support/oracle/public/generate.ts"
import {
	type LawFeature,
	lawFeatures,
	type LawLevel,
	lawLevelGen
} from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import { encodeRefusalDetail } from "#test/support/oracle/write/detail.ts"
import {
	compiledLogin,
	contractClaimRoleGen,
	drawnLogin,
	type DrawnSchema,
	loginGen,
	roleName,
	type RoleShape,
	rolesOf
} from "#test/support/served-login.ts"
import {
	castBy,
	type Raised,
	raisedBy,
	typeRosters,
	writtenBy
} from "#test/support/served-reach.ts"
import { runtimeDifference } from "#test/support/served.ts"
import { nothingReported, type Reported, serverError } from "#test/support/server-error.ts"

export type Feature =
	| LawFeature
	| "a table constraint classified alike"
	| "a domain shared with a relation the role does not write, narrowed alike"
	| "a law refusal decoded alike"
	| "a roster domain's refusal classified alike"
	| "a concurrent change classified alike"
	| "a fact outside a written query entry classified alike"
	| "a statement writing some of the role's written relations"
	| "a write reading a context field whose contract domain types only unwritten stored columns"
	| "a write reading a context field whose pattern domain types only unwritten stored columns"

/**
 * One refusal a role's writes can raise, as PostgreSQL reports it, beside the relations a statement that raises it
 * writes one of (none: any statement, or the COMMIT), and the feature it reaches.
 */
interface Refusal {
	readonly reported: Reported
	readonly at: ReadonlyArray<StoredRelationName>
	readonly feature: Feature | undefined
}

/** The class 23 SQLSTATEs a native constraint's violation reports besides a domain's CHECK and a NOT NULL. */
const nativeStates: Arr.NonEmptyReadonlyArray<string> = [
	sqlstates.uniqueViolation,
	sqlstates.foreignKeyViolation,
	sqlstates.checkViolation,
	sqlstates.exclusionViolation
]

/** The reasons a write statement raises a concurrent change for. */
const changeReasons: Arr.NonEmptyReadonlyArray<ConcurrentChangeTag> = [
	"PutTargetConflict",
	"SpanKeyChange"
]

/** The codes the installation holds for `roster`, every roster a column or a cast value of it holds among them. */
const codecNamed = (codes: Codebook, roster: HeldName): RosterCodec =>
	defined(codes.rosters.get(roster), `the installation's codes of roster ${roster}`)

/**
 * A refused key's text for a field of `type`, as a write statement's DETAIL carries it: a closed id's code, one of its
 * roster's live codes, since a stored code is a live one and a hole names no handle; and for any other carrier a digit,
 * which every key carrier's conversion reads.
 */
const keyTextGen = (codes: Codebook, type: ScalarType): Gen<string> =>
	type.carrier === "code"
		? map(
				element(
					nonEmpty(
						Arr.flatMap(
							codecNamed(codes, defined(rosterOf(type), "a closed id's roster").closed).names,
							(name, code) => (name === "" ? [] : [code])
						),
						"a roster's live codes"
					)
				),
				String
			)
		: map(int(0, 9), String)

/** What refused a statement, as the host is asked about it: its kind and every object it names. */
const refuserText = (refuser: Refuser): string => {
	switch (refuser.kind) {
		case "constraint":
			return `constraint ${refuser.owner} ${refuser.name}`
		case "domain":
			return `domain ${refuser.domain} ${refuser.name} ${Arr.join(
				Arr.map(refuser.uses, (u) => `${u.table}.${u.column}=${u.law.law}`),
				","
			)}`
		case "generated":
			return `generated ${refuser.table}.${refuser.column}`
	}
}

/**
 * A statement writing `relations`, whose host judges every refuser by a witness naming it whole: each classifier's
 * question of the host shows in its outcome.
 */
const statementAt = (relations: ReadonlyArray<StoredRelationName>): WrittenAt => ({
	relations,
	judge: (refuser) => ({
		witness: { kind: "key", relation: "host", values: { refuser: refuserText(refuser) } },
		laws: { kind: "object" }
	}),
	above: () => ({ own: "unjudged" })
})

/** The relations a statement raising a refusal writes: one of `at` where it names some, and any of `written` beside. */
const statementGen =
	(
		at: ReadonlyArray<StoredRelationName>,
		written: ReadonlySet<StoredRelationName>
	): Gen<ReadonlyArray<StoredRelationName>> =>
	(source) => {
		const beside = source.draw(subarray([...written]))
		const [first, ...rest] = at
		return first === undefined
			? beside
			: Arr.dedupe([source.draw(element([first, ...rest])), ...beside])
	}

/** The stored relations of `written` whose table is one of `tables`. */
const writingTables = (
	artifacts: SchemaArtifacts,
	written: ReadonlySet<StoredRelationName>,
	tables: ReadonlySet<string>
): ReadonlyArray<StoredRelationName> =>
	Arr.filter([...written], (r) => tables.has(artifacts.names.relation(r).name))

/**
 * Every refusal the writes of `written` can raise (Raised), as PostgreSQL reports each (see the header), its free values
 * drawn: a native state, a refused key's texts, a concurrent change's reason.
 */
const refusalsOf = (
	artifacts: SchemaArtifacts,
	shape: RoleShape,
	raised: Raised,
	draw: <A>(generator: Gen<A>) => A
): ReadonlyArray<Refusal> => {
	const names = artifacts.names
	const schema = names.schema
	const written = raised.relations
	const writtenTables = new Set<string>(Arr.map([...written], (r) => names.relation(r).name))
	const constraints = Arr.flatMap(raised.constraints, (c): ReadonlyArray<Refusal> => {
		switch (c.kind) {
			case "constraint":
			case "trigger":
				return [
					{
						reported: {
							...nothingReported,
							sqlstate: draw(element(nativeStates)),
							constraint: c.name,
							schema,
							table: c.owner
						},
						at: [],
						feature: "a table constraint classified alike"
					}
				]
			case "domainConstraint": {
				const full = Arr.findFirst(
					artifacts.constraintLaws,
					(f) => f.kind === "domainConstraint" && f.owner === c.owner && f.name === c.name
				).pipe(Option.getOrUndefined)
				const shared =
					full?.kind === "domainConstraint" &&
					Arr.some(full.uses, (u) => writtenTables.has(u.table)) &&
					Arr.some(full.uses, (u) => !writtenTables.has(u.table))
				return [
					{
						reported: {
							...nothingReported,
							sqlstate: sqlstates.checkViolation,
							constraint: c.name,
							schema,
							dataType: c.owner
						},
						at: writingTables(artifacts, written, new Set(Arr.map(c.uses, (u) => u.table))),
						feature: shared
							? "a domain shared with a relation the role does not write, narrowed alike"
							: undefined
					}
				]
			}
			case "unstoredDomainConstraint":
				return [
					{
						reported: {
							...nothingReported,
							sqlstate: sqlstates.checkViolation,
							constraint: c.name,
							schema,
							dataType: c.owner
						},
						at: [...written],
						feature: undefined
					}
				]
		}
	})
	const relations = Arr.filter([...artifacts.derived.schema.relations.values()], (r) =>
		written.has(r.name)
	)
	const laws = Arr.flatMap(raised.theoryLaws, (l): ReadonlyArray<Refusal> => {
		const reads = Arr.findFirst(artifacts.laws.theory.laws, (t) => t.id === l.law).pipe(
			Option.match({ onNone: () => [], onSome: (t) => t.reads })
		)
		const refused = Arr.filter(relations, (r) => Arr.contains(reads, r.name))
		const [first, ...rest] = refused
		if (first === undefined) {
			return []
		}
		const relation = draw(element([first, ...rest]))
		const key = Arr.map(relation.primaryFields, (field) => ({
			field: field.name,
			text: draw(keyTextGen(names.codes, field.type))
		}))
		return [
			{
				reported: {
					...nothingReported,
					sqlstate: sqlstates.integrityConstraintViolation,
					constraint: l.law,
					schema: draw(element([schema, undefined])),
					detail: encodeRefusalDetail({ kind: "law", relation: relation.name }, key)
				},
				at: [relation.name],
				feature: "a law refusal decoded alike"
			}
		]
	})
	const rosters = Arr.flatMap([...raised.rosters], (roster): ReadonlyArray<Refusal> => {
		const holding = Arr.flatMap(relations, (r) =>
			Arr.some(r.fields, (f) => Arr.contains(typeRosters(f.type), roster)) ? [r.name] : []
		)
		const codec = codecNamed(names.codes, roster)
		return Arr.map(
			[
				{ domain: names.rosterDomain(roster), check: identity.rosterDomain(parsedName(roster)) },
				{ domain: names.bitsDomain(roster), check: identity.bitsDomain(roster, codec.width) }
			],
			({ domain, check }): Refusal => ({
				reported: {
					...nothingReported,
					sqlstate: sqlstates.checkViolation,
					constraint: identifierOf(identity.domainCheck(check)),
					schema: domain.schema,
					dataType: domain.name
				},
				at: holding,
				feature: "a roster domain's refusal classified alike"
			})
		)
	})
	const generated = Arr.flatMap(raised.generated, (g): ReadonlyArray<Refusal> => [
		{
			reported: {
				...nothingReported,
				sqlstate: sqlstates.notNullViolation,
				schema,
				table: g.table,
				column: g.column
			},
			at: writingTables(artifacts, written, new Set([g.table])),
			feature: undefined
		}
	])
	const changes = Arr.map([...written], (relation): Refusal => ({
		reported: {
			...nothingReported,
			sqlstate: sqlstates.grizzleConcurrentChange,
			detail: encodeRefusalDetail(
				{ kind: "change", reason: draw(element(changeReasons)), relation },
				[]
			)
		},
		at: [relation],
		feature: "a concurrent change classified alike"
	}))
	const outside = Arr.map([...raised.entries.values()], (entry): Refusal => ({
		reported: {
			...nothingReported,
			sqlstate: sqlstates.grizzleOutsideWorld,
			constraint: entry,
			schema
		},
		at: [],
		feature: "a fact outside a written query entry classified alike"
	}))
	return [
		...constraints,
		...laws,
		...rosters,
		...generated,
		...changes,
		...outside,
		...claimsOf(artifacts, shape, writtenTables, schema)
	]
}

/**
 * The CHECK of the domain a written query entry's `held` claim is cast to (served-login.ts EntryShape), its stored
 * field's domain, a contract's or a pattern's, where it types only stored columns of relations the role does not write:
 * a statement writing through the entry reads its context and casts each claim to its domain.
 */
const claimsOf = (
	artifacts: SchemaArtifacts,
	shape: RoleShape,
	writtenTables: ReadonlySet<string>,
	schema: string
): ReadonlyArray<Refusal> => {
	if (
		Option.isNone(shape.entry) ||
		!Arr.some(shape.changes, (change) => change.target.kind === "entry")
	) {
		return []
	}
	const { target, held } = shape.entry.value
	const writes = artifacts.derived.schema.relations.get(target)
	const heldBy = artifacts.derived.schema.relations.get(held.relation)
	const type = Arr.findFirst(heldBy?.fields ?? [], (f) => f.name === held.field).pipe(
		Option.map((f) => f.type),
		Option.getOrUndefined
	)
	if (writes === undefined || type === undefined) {
		return []
	}
	const table = artifacts.names.relation(held.relation).name
	const column = artifacts.names.column(held.relation, held.field)
	const { contract } = type
	return Arr.flatMap(artifacts.constraintLaws, (c): ReadonlyArray<Refusal> =>
		c.kind === "domainConstraint" &&
		Arr.some(c.uses, (u) => u.table === table && u.column === column) &&
		!Arr.some(c.uses, (u) => writtenTables.has(u.table))
			? [
					{
						reported: {
							...nothingReported,
							sqlstate: sqlstates.checkViolation,
							constraint: c.name,
							schema,
							dataType: c.owner
						},
						at: [writes.name],
						feature:
							contract !== undefined &&
							c.owner === artifacts.names.contractDomain(contract.name).name
								? "a write reading a context field whose contract domain types only unwritten stored columns"
								: "a write reading a context field whose pattern domain types only unwritten stored columns"
					}
				]
			: []
	)
}

export const differential = (
	drawn: DrawnSchema,
	level: LawLevel,
	shapes: Arr.NonEmptyReadonlyArray<RoleShape>,
	draw: <A>(generator: Gen<A>) => A,
	note: (feature: Feature) => void
) =>
	Effect.gen(function* () {
		const printed = () =>
			`${printCase(drawn.case)}\n${Formatter.format(level)}\n${Formatter.format(shapes)}`
		const compiled = yield* Effect.result(
			compiledLogin(drawnLogin(drawn, shapes), drawn.laws.codes)
		)
		if (Answered.isFailure(compiled)) {
			return
		}
		const { back } = compiled.success
		const codes = rosterCodebook(back.rosters)
		for (const [place, shape] of shapes.entries()) {
			const role = Arr.findFirst(
				rolesOf(compiled.success),
				(r) => r.served.name === roleName(place)
			).pipe(Option.getOrUndefined)
			const written = role === undefined ? new Set<StoredRelationName>() : writtenBy(role.served)
			if (role === undefined || written.size === 0) {
				continue
			}
			const { artifacts } = role.compiled
			const cut = servedWitness(role.served.refusals, back.above, codes).classify
			const full = installationWitness(artifacts, back.above).classify
			const raised = raisedBy(artifacts, written, castBy(role.served, role.compiled))
			const writes = new Set<string>(written)
			if (Arr.some(drawn.laws.relations, (r) => writes.has(r.name))) {
				for (const feature of lawFeatures(level)) {
					note(feature)
				}
			}
			for (const refusal of refusalsOf(artifacts, shape, raised, draw)) {
				const relations = draw(statementGen(refusal.at, written))
				const failure = serverError(refusal.reported)
				const at = statementAt(relations)
				const expected = full(failure, at)
				const what = `${Formatter.format(refusal.reported)} at a statement writing ${Formatter.format(relations)} of role ${role.served.name}`
				const differs = runtimeDifference(cut(failure, at), expected)
				assert.equal(
					differs,
					undefined,
					`the served classifier reads ${what} otherwise, at ${differs}\n${printed()}`
				)
				if (refusal.feature !== undefined && expected !== undefined) {
					note(refusal.feature)
				}
				if (relations.length > 0 && relations.length < written.size) {
					note("a statement writing some of the role's written relations")
				}
			}
		}
	})

/** The requirement a drawn login seldom meets, which a case whose turn aims at it is constructed to meet. */
export const contractClaim: Feature =
	"a write reading a context field whose contract domain types only unwritten stored columns"

/** How a case draws its login: as drawn, or aimed at a write casting a context claim to a checked contract's domain. */
type Login = "drawn" | "contract claim"

/** A case's sketch: its schema's, its law level, and how it draws its login. */
type Sketch = readonly [CaseSketch, LawLevel, Login]

/** A sketch whose login is drawn as `login` says. */
export const sketchGen =
	(login: Login): Gen<Sketch> =>
	(source) => [source.draw(caseSketchGen), source.draw(lawLevelGen), login]

/**
 * The login a case's roles are, as its sketch says: drawn ones, or the one role constructed to cast a context claim to
 * a checked contract's domain that types only unwritten columns (served-login.ts contractClaimRoleGen), where the
 * schema holds such a claim and an entry target apart from it.
 */
export const loginOf = (
	drawn: DrawnSchema,
	login: Login,
	draw: <A>(generator: Gen<A>) => A
): Arr.NonEmptyReadonlyArray<RoleShape> => {
	switch (login) {
		case "drawn":
			return draw(loginGen(drawn))
		case "contract claim":
			return Option.match(draw(contractClaimRoleGen(drawn)), {
				onNone: () => draw(loginGen(drawn)),
				onSome: (role): Arr.NonEmptyReadonlyArray<RoleShape> => [role]
			})
	}
}
