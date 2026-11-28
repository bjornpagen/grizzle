import { assert, defined, nonEmpty, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { ExecutionFailure, TransientFailure } from "#adapter/errors/execution.ts"
import type { ServerError } from "#adapter/errors/failures.ts"
import { classifyServerError } from "#adapter/outcomes/index.ts"
import { installationRefusals, installationWitness } from "#adapter/served/refusals.ts"
import { noLevelAbove } from "#adapter/witness/keylaw.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { type ConstraintName, type LawId } from "#compiler/core/ids.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { derivedLaw, namedLaw } from "#compiler/runtime/law-entry.ts"
import type { UniqueAbort } from "#compiler/runtime/write/steps.ts"
import type { StatementAt } from "#compiler/runtime/write/witness.ts"
import type { Law, RefusingObject, Witness } from "#compiler/types/changeset/changeset.ts"
import { parsedName, wild } from "#test/support/kernel/naming.ts"
import { resolveCase } from "#test/support/oracle/public/generate.ts"
import { lawFeatures } from "#test/support/oracle/public/laws.ts"
import { encodeRefusalDetail } from "#test/support/oracle/write/detail.ts"
import { refusedLaws, refusedEntries } from "#test/support/refused.ts"
import { drawnSchema } from "#test/support/served-login.ts"
import { nothingReported, type Reported, serverError } from "#test/support/server-error.ts"
import {
	artifactsOf,
	type ChangeAt,
	hostWitnessOf,
	isTableConstraint,
	keyValueGen,
	type Meaning,
	originOf,
	reasonOf,
	refuserText,
	usesLaws,
	witnessCases,
	type WitnessFeature
} from "#test/support/unit/adapter/witness.fixtures.ts"

/**
 * A server error at a write means what the classification rules say of the fields grizzle controls, at every origin of
 * a write's flights.
 *
 * Budget: its suite's count before the conversion (unit/adapter/witness: 1500 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const aServerErrorAtAWriteMeansWhatTheClassificationRulesSayOfTheFieldsGrizzleControlsAtEveryOriginOfAWritesFlights =
	property.explore(witnessCases, {
		needs: {},
		situations: [
			"rejected under a table constraint",
			"rejected under a domain constraint",
			"a shared domain narrowed by the relations written",
			"a shared domain's every law",
			"rejected at a refused key",
			"a refused key holding a closed id",
			"rejected under a generated column",
			"execution: a NOT NULL on no generated column",
			"a concurrent change",
			"execution: a precheck naming no entry the role writes through",
			"SerializationFailure",
			"Deadlock",
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
			"execution: a concurrent change at a name of no installation",
			"a roster with a hole",
			"a generated column",
			"a table CHECK",
			"contracts sharing one domain",
			"a code key"
		] satisfies ReadonlyArray<Reached<WitnessFeature>>,
		check:
			(_, k: Case<WitnessFeature>) =>
			([caseSketch, level, sketch]) =>
				Effect.sync(() => {
					const artifacts = artifactsOf(drawnSchema(k.draw(resolveCase(caseSketch)), level))
					k.noteAll(lawFeatures(level))
					/**
					 * The relations a refusal's DETAIL may name: each whose key every field of carries a value the suite
					 * draws, the level's holder and counter among them.
					 */
					const refusable = nonEmpty(
						Arr.filter([...artifacts.derived.schema.relations.values()], (r) =>
							Arr.every(r.primaryFields, (f) => keyValueGen(artifacts, f) !== undefined)
						),
						"the relations a refusal names"
					)
					const refused =
						sketch.detail.kind === "a refusal"
							? defined(refusable[sketch.detail.relation % refusable.length], "a relation")
							: undefined
					/** The refused key's values, drawn for the relation's primary fields. */
					const key =
						refused === undefined
							? []
							: Arr.map(refused.primaryFields, (field) => ({
									field: field.name,
									value: k.draw(
										defined(keyValueGen(artifacts, field), "a key carrier the suite draws")
									)
								}))
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
							case "a name of no installation":
								return wild.relation("absent")
						}
					}
					const constraints = artifacts.constraintLaws
					const rosters = [...names.codes.rosters.values()]
					const tables = Arr.map(relationNames, (r) => names.relation(r).name)
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
									owner: isTableConstraint(at)
										? { kind: "table", name: at.owner }
										: { kind: "domain", name: at.owner }
								}
							}
							case "a law's identity":
								return {
									name: defined(artifacts.theoryLaws[c.pick % artifacts.theoryLaws.length], "a law")
										.law,
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
												? identity.rosterDomain(parsedName(codec.roster))
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
							case "a domain the installation lacks":
								return { table: undefined, dataType: wild.domain("lacking") }
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
								return d.text
							case "a refusal": {
								const relation = defined(refusable[d.relation % refusable.length], "a relation")
								const fields = Arr.map(key, (kv) => ({
									field:
										d.foreign === "a field the relation lacks" ? `${kv.field}_lacking` : kv.field,
									text: kv.value.text
								}))
								return encodeRefusalDetail(
									{
										kind: "law",
										relation:
											d.foreign === "a relation of no installation"
												? wild.relation("absent")
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
					/** The column the report names, of the table it reports, as the sketch draws it. */
					const reportedColumn = ((): string | undefined => {
						const table = reportedOwner.table
						const relation = Arr.findFirst(
							stored,
							(r) => table !== undefined && names.relation(r.name).name === table
						).pipe(Option.getOrUndefined)
						if (relation === undefined || sketch.column === "none") {
							return undefined
						}
						const other = Arr.findFirst(relation.fields, (f) => f.writing.kind !== "generated")
						const generatedField = Arr.findFirst(
							relation.fields,
							(f) => f.writing.kind === "generated"
						)
						const chosenField =
							sketch.column === "a generated column of the table"
								? Option.orElse(generatedField, () => other)
								: other
						return Option.isSome(chosenField) ? chosenField.value.column : undefined
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
						column: reportedColumn,
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
						violation: installationWitness(artifacts, noLevelAbove).classify,
						origin,
						statement: (at) => ({
							relations: written,
							judge: (refuser) => ({
								witness:
									at.kind === "unstated"
										? { kind: "unreported" }
										: hostWitnessOf(at, refuserText(refuser)),
								laws: { kind: "object" }
							}),
							above: () => ({ own: "unjudged" })
						})
					})
					/**
					 * Where the host's witness is asked: a statement of a stratum's actions, a write step's or a single
					 * statement's parts', a family write that writes stored relations, a member's carrier fill, which
					 * casts its action's facts into its relation, or a query entry's precheck, which casts its facts into
					 * its target; none elsewhere.
					 */
					const at: StatementAt | undefined =
						origin.kind !== "statement"
							? undefined
							: origin.step.kind === "write"
								? {
										kind: "actions",
										stratum: origin.step.stratum,
										actions: [origin.step.action]
									}
								: origin.step.kind === "single"
									? {
											kind: "actions",
											stratum: origin.step.stratum,
											actions: Arr.map(origin.step.parts, (p) => p.step.action)
										}
									: origin.step.kind === "familyWrite"
										? { kind: "write", stratum: origin.step.stratum, relations: written }
										: origin.step.kind === "carrier" && origin.step.casts.kind === "member"
											? {
													kind: "write",
													stratum: origin.step.casts.stratum,
													relations: [origin.step.casts.relation]
												}
											: origin.step.kind === "check"
												? {
														kind: "precheck",
														stratum: origin.step.stratum,
														entry: origin.step.entry
													}
												: undefined
					/** The witness the rules give a native refusal by `refuser`: the host's, at a statement alone. */
					const hostWitness = (refuser: string): Witness =>
						at === undefined ? { kind: "unreported" } : hostWitnessOf(at, refuser)
					const described = (law: LawId): Law =>
						namedLaw(defined(artifacts.described.get(law), "a described law"))
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
									abort.value.reason === "PutTargetConflict" ? undefined : abort.value.constraint
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
							const entry = Arr.findFirst(
								[...installationRefusals(artifacts).entries.values()],
								(e) => e.entry === reported.constraint
							)
							return Option.isSome(entry)
								? { kind: "outside", relation: entry.value.entry }
								: { kind: "execution" }
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
						if (state === sqlstates.notNullViolation) {
							const table = owner?.kind === "table" ? owner.name : undefined
							const relation = Arr.findFirst(
								stored,
								(r) => table !== undefined && names.relation(r.name).name === table
							).pipe(Option.getOrUndefined)
							const field =
								relation === undefined
									? undefined
									: Arr.findFirst(
											relation.fields,
											(f) => f.writing.kind === "generated" && f.column === reported.column
										).pipe(Option.getOrUndefined)
							return relation === undefined || field === undefined
								? { kind: "execution" }
								: {
										kind: "rejected",
										laws: [
											derivedLaw({ kind: "generated", relation: relation.name, field: field.name })
										],
										witness: hostWitness(`generated ${table}.${field.column}`)
									}
						}
						if (reported.constraint === undefined) {
							return { kind: "execution" }
						}
						if (reported.schema !== undefined && !own) {
							return { kind: "execution" }
						}
						if (state === sqlstates.integrityConstraintViolation) {
							const law = Arr.findFirst(artifacts.theoryLaws, (l) => l.law === reported.constraint)
							const d = sketch.detail
							if (Option.isNone(law) || d.kind !== "a refusal" || d.foreign !== "none") {
								return { kind: "execution" }
							}
							const relation = defined(refusable[d.relation % refusable.length], "a relation")
							return {
								kind: "rejected",
								laws: [described(law.value.law)],
								witness: {
									kind: "key",
									relation: relation.name,
									values: Rec.fromEntries(Arr.map(key, (kv) => [kv.field, kv.value.value] as const))
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
								(isTableConstraint(c) ? owner.kind === "table" : owner.kind === "domain") &&
								c.owner === owner.name
						)
						if (Option.isNone(native)) {
							return { kind: "execution" }
						}
						const n = native.value
						const writtenTables = new Set(Arr.map(written, (r) => names.relation(r).name))
						const coercing = Arr.filter(n.kind === "domainConstraint" ? n.uses : [], (u) =>
							writtenTables.has(u.table)
						)
						return {
							kind: "rejected",
							laws: Arr.map(
								n.kind === "domainConstraint"
									? usesLaws(coercing.length > 0 ? coercing : n.uses)
									: n.laws,
								(l) => namedLaw(l.described)
							),
							witness: hostWitness(
								isTableConstraint(n)
									? `constraint ${n.owner} ${n.name}`
									: `domain ${Arr.join(
											Arr.map(coercing, (u) => `${u.table}.${u.column}`),
											","
										)}`
							)
						}
					})()
					switch (meaning.kind) {
						case "rejected": {
							assert.ok(classified.kind === "rejected", `rejected, not ${classified.kind}`)
							assert.equal(
								classified.refused.kind,
								meaning.laws.length === 1 ? "every" : "some",
								"laws the host does not narrow: the one decided, or some of several"
							)
							unorderedEqual(refusedLaws(classified.refused), meaning.laws, "the laws")
							const by: RefusingObject =
								reported.sqlstate === sqlstates.notNullViolation
									? {
											kind: "notNull",
											table: defined(reported.table, "the reported table"),
											column: defined(reported.column, "the reported column")
										}
									: reported.sqlstate === sqlstates.integrityConstraintViolation
										? { kind: "statement" }
										: reported.table !== undefined
											? {
													kind: "constraint",
													table: reported.table,
													name: defined(chosen.name, "the reported constraint")
												}
											: {
													kind: "domain",
													domain: defined(reported.dataType, "the reported data type"),
													name: defined(chosen.name, "the reported constraint")
												}
							for (const r of refusedEntries(classified.refused)) {
								assert.deepEqual(r.by, by, "each law is refused by the object the server reported")
							}
							assert.deepEqual(classified.witness, meaning.witness)
							if (reported.sqlstate === sqlstates.notNullViolation) {
								k.note("rejected under a generated column")
							} else if (reported.sqlstate === sqlstates.integrityConstraintViolation) {
								k.note("rejected at a refused key")
								if (
									Arr.some(
										key,
										(kv) => typeof kv.value.value === "string" && kv.value.text !== kv.value.value
									)
								) {
									k.note("a refused key holding a closed id")
								}
							} else {
								const entry = defined(chosen.entry, "the installed constraint")
								k.note(
									isTableConstraint(entry)
										? "rejected under a table constraint"
										: "rejected under a domain constraint"
								)
								const every = entry.kind === "domainConstraint" ? usesLaws(entry.uses) : entry.laws
								if (entry.kind === "domainConstraint" && every.length > 1) {
									k.note(
										meaning.laws.length < every.length
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
								state === sqlstates.grizzleOutsideWorld
									? "execution: a precheck naming no entry the role writes through"
									: !Str.startsWith("23")(state)
										? "execution: another class"
										: reported.schema !== undefined && reported.schema !== schemaName
											? "execution: another schema"
											: state === sqlstates.notNullViolation
												? "execution: a NOT NULL on no generated column"
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
				}),
		oracle: {
			kind: "specification",
			name: "the classification rules of outcomes/index.ts and witness/classify.ts, restated over the installation's constraints, laws and rosters"
		},
		budget: { runs: 1500, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/text.ts",
				original:
					"export const isAsciiDigit = (unit: number): boolean => unit >= 0x30 && unit <= 0x39",
				replacement:
					"export const isAsciiDigit = (unit: number): boolean => unit >= 49 && unit <= 0x39",
				why: "Operator mutant (bound) at packages/engine/src/core/sqlstate.ts:34 in parse: `0x30` becomes `49`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
