/**
 * A login's served classifier classifies every refusal its writes can raise exactly as its installation's full
 * classifier does. A served file holds each role's refusals cut to what its writes can raise (adapter/served/project.ts),
 * so the cut must lose nothing a statement of the role can meet: a refusal misread by the cut is an ExecutionFailure
 * where the installation names a law, or a law where it names another.
 *
 * Over generated public schemas (test/support/oracle/public), each extended by a drawn law level (laws.ts: a roster
 * with holes, a code key, a set, checked contracts that may share one domain, a generated column, a table CHECK), and
 * logins drawn over them (test/support/served-login.ts), each login compiled as `grizzle generate` compiles it under the
 * level's codes, for every role that writes:
 *
 * - cut: the role's refusals as its served file holds them, the file read back from the JSON value its text parses to,
 *   rebuilt as a layer rebuilds them (adapter/witness/index.ts servedWitness), under the codes the file holds;
 * - full: every refusal of the role's installation (adapter/served/refusals.ts installationWitness);
 * - Differential (R1): every refusal the role's writes can raise, as test/support/served-reach.ts computes it from the
 *   compiled program and the installation, never through program/schema.ts raisableOf, reported as PostgreSQL reports
 *   it at a statement writing some of the role's written relations: a table constraint's or rule trigger's violation;
 *   a domain's CHECK, at a statement writing a column it types; an unstored contract domain's CHECK; the CHECK of the
 *   domain a context claim is cast to, at a statement writing through the query entry that reads the context, where
 *   that domain types only stored columns of relations the role does not write; a write statement's refusal of a law,
 *   its DETAIL's key decoded through the refused relation's heading; a roster domain's CHECK, which is grizzle's
 *   defect; a generated column's NOT NULL; a concurrent change at a written relation; a fact outside a query entry the
 *   role writes through. The cut's outcome is the full classifier's, the same value as the runtime reads it
 *   (test/support/served.ts runtimeDifference), the host asked the same of the same columns; a feature is noted only
 *   where that outcome is a law outcome.
 * - Narrowing (R2): a domain shared with a relation the role does not write is classified alike at a statement writing
 *   some of its columns, its uses narrowed to the written tables as the full classifier narrows them by the statement.
 *
 * Plants (~/.cache/grizzle-release/TSERVED/plants): served-domain-narrowed-wrong.patch narrows a domain constraint's
 * uses to the tables the role does not write: a shared domain's refusal names the other relations' laws, and a domain
 * typing written columns alone is dropped, so the cut reads its refusal as no law. served-cast-contract-chain-dropped.patch
 * leaves a cast value's contract chain out of the domains it meets: a context claim of a checked contract whose domain
 * types only unwritten columns is no law of the cut.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int, map, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Result as Answered, Array as Arr, Effect, Formatter, Option } from "effect"
import { installationWitness } from "#adapter/served/refusals.ts"
import type { WrittenAt } from "#adapter/witness/classify.ts"
import { servedWitness } from "#adapter/witness/index.ts"
import { type DeclaredName, identifierOf, identity } from "#compiler/core/identity.ts"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { type Codebook, type RosterCodec, rosterCodebook } from "#compiler/ir/codes.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import type { ConcurrentChangeTag } from "#compiler/runtime/write/refusal.ts"
import type { Refuser } from "#compiler/runtime/write/witness.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import {
	type LawFeature,
	type LawLevel,
	lawFeatures,
	lawLevelGen
} from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import { encodeRefusalDetail } from "#test/support/oracle/write/detail.ts"
import {
	compiledLogin,
	drawnLogin,
	drawnSchema,
	type DrawnSchema,
	loginGen,
	type RoleShape,
	roleName,
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

type Feature =
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
const codecNamed = (codes: Codebook, roster: DeclaredName): RosterCodec =>
	defined(codes.rosters.get(roster), `the installation's codes of roster ${roster}`)

/**
 * A refused key's text for a field of `type`, as a write statement's DETAIL carries it: a closed id's code among its
 * roster's, holes included, and for any other carrier a digit, which every key carrier's conversion reads.
 */
const keyTextGen = (codes: Codebook, type: ScalarType): Gen<string> =>
	map(int(0, type.carrier === "code" ? codecNamed(codes, type.roster.closed).size - 1 : 9), String)

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
				{ domain: names.rosterDomain(roster), check: identity.rosterDomain(roster) },
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
	const contract = contractOf(type)
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

const differential = (
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
			const raised = raisedBy(artifacts, written, castBy(role.served))
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

describe("a served login's classifier", () => {
	it.effect(
		"classifies every refusal a role's writes can raise exactly as its installation's full classifier does",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the installation's full classifier (adapter/served/refusals.ts installationWitness), over the refusals test/support/served-reach.ts computes"
						},
						suite: "unit/served/refusals",
						draw: drawn(
							(source) => [source.draw(caseSketchGen), source.draw(lawLevelGen)] as const
						),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a table constraint classified alike",
								"a domain shared with a relation the role does not write, narrowed alike",
								"a law refusal decoded alike",
								"a roster domain's refusal classified alike",
								"a concurrent change classified alike",
								"a fact outside a written query entry classified alike",
								"a statement writing some of the role's written relations",
								"a write reading a context field whose contract domain types only unwritten stored columns",
								"a roster with a hole",
								"a generated column",
								"a table CHECK",
								"contracts sharing one domain",
								"a code key"
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
						Effect.suspend(() => {
							const drawn = drawnSchema(notes.draw(resolveCase(sketch)), level)
							return differential(drawn, level, notes.draw(loginGen(drawn)), notes.draw, notes.note)
						})
				)
			)
	)
})
