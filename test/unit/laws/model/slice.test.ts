import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { agree, exact, set, structuralHash } from "@bjornpagen/testing/oracle"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { installationWitness } from "#adapter/served/refusals.ts"
import { noLevelAbove } from "#adapter/witness/keylaw.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import type { RelationIdent } from "#compiler/core/ids.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { type ScalarType, textOf } from "#compiler/ir/scalar.ts"
import { selectionKeysOf } from "#compiler/physical/ddl/names.ts"
import { installBasis, unserved, planBasis } from "#compiler/physical/install/plan.ts"
import { parseSchemaInput } from "#compiler/program/input.ts"
import { baseArtifacts, raisableOf } from "#compiler/program/schema.ts"
import { type OwnedRole, rostersOf } from "#compiler/schema/own.ts"
import { everySlice, sliceOf, writesOf } from "#compiler/schema/reach.ts"
import type { CompiledWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	caseSpace,
	rootName,
	topName,
	ordinaryName,
	roleName,
	loginOf,
	programOf,
	expectedSlice,
	labelFreeText,
	sameApartFromLabels,
	sameLabelFree,
	sameNatives,
	sharesLoweredTarget,
	raisableOver,
	nativeName,
	installedForm,
	plannedOver,
	heldOver,
	type SliceFeature,
	features,
	compiledChange,
	compiledQuery,
	ran
} from "#test/unit/laws/model/slice.fixtures.ts"

/** A compile's law model is the whole schema's restricted to its slice's writes and names. Its budget is its suite's before it was a property (test/unit/laws/model/slice.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const aCompilesLawModelIsTheWholeSchemasRestrictedToItsSlicesWritesAndNames =
	property.explore(caseSpace, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: features satisfies ReadonlyArray<Reached<SliceFeature>>,
		check: (_, k: Case<SliceFeature>) => (c) =>
			Effect.gen(function* () {
				const login = loginOf(c)
				const owned = login.base
				const roles = new Map<string, OwnedRole>(Arr.map(login.roles, (r) => [r.name, r] as const))
				const slice = sliceOf(
					owned,
					Arr.map(c.uses, (u) => ({
						role: defined(roles.get(roleName(u.role)), "the use's role"),
						program: programOf(c, u)
					}))
				)
				const { writes, names } = expectedSlice(c)
				yield* agree(
					[
						["the relations the draw's programs write", [...writes]],
						["the slice's writes", [...slice.writes]]
					],
					set(structuralHash, exact)
				)
				yield* agree(
					[
						["the relations the draw's programs name", [...names]],
						["the slice's names", [...slice.names]]
					],
					set(structuralHash, exact)
				)

				const codes = firstCodebook(rostersOf(owned))
				const installed = succeeded(
					installBasis(owned, codes, everySlice(owned)),
					"the installation's basis"
				)
				const wholeArtifacts = succeeded(
					baseArtifacts(installed, unserved),
					"the installation's artifacts"
				)
				const whole = wholeArtifacts.laws
				const sliced = succeeded(
					Result.flatMap(
						planBasis(
							owned,
							codes,
							slice,
							installed.closed,
							installed.textDomains,
							installed.library,
							{
								kind: "recorded",
								cycles: whole.fkCycles,
								references: whole.references,
								judged: whole.judged
							}
						),
						(basis) => baseArtifacts(basis, unserved)
					),
					"the slice's artifacts, as a Db plans them from its snapshot"
				)
				const model = sliced.laws

				assert.deepEqual(model.fkCycles, whole.fkCycles, "the foreign key graph's cycles")
				assert.deepEqual(
					model.judged,
					whole.judged,
					"the relations the installation's judge captures"
				)
				const planned = plannedOver(whole, names, writes)
				const read = (from: string, to: string): boolean =>
					writes.has(from) || writes.has(to) || (names.has(from) && names.has(to))
				sameApartFromLabels(
					model.existence,
					Arr.filter(whole.existence, (e) => read(e.from.relation, e.to.relation)),
					"the existence evidence of the containments reading a written relation or only named ones"
				)
				const evidence = whole.theory.evidence
				const containments = Arr.filter(evidence.containments, (e) => planned.has(e.law))
				sameApartFromLabels(
					model.theory.evidence,
					{
						keys: Arr.filter(evidence.keys, (e) => planned.has(e.law)),
						checks: Arr.filter(evidence.checks, (e) => planned.has(e.law)),
						containments
					},
					"the evidence of the planned laws, each containment under the whole model's context"
				)
				yield* agree(
					[
						[
							"the whole model's immediate laws among the planned",
							Arr.filter([...whole.immediate], (l) => planned.has(l))
						],
						["the slice's model's immediate laws", [...model.immediate]]
					],
					set(structuralHash, exact)
				)
				const selectionKeys = selectionKeysOf(model.natives)
				const wholeKeys = selectionKeysOf(whole.natives)
				for (const name of names) {
					sameApartFromLabels(
						selectionKeys.get(name) ?? [],
						wholeKeys.get(name) ?? [],
						`${name}'s selection keys`
					)
				}

				const installedForms = new Set(
					Arr.flatMap(whole.natives, (m) => Option.toArray(labelFreeText(installedForm(m))))
				)
				for (const n of model.natives) {
					const form = labelFreeText(installedForm(n))
					assert.ok(
						Option.isSome(form) && installedForms.has(form.value),
						`${nativeName(n)}, a native of the slice's model, is one the installation holds, by its name and definition`
					)
				}
				const held = heldOver(wholeArtifacts, planned, writes)
				sameNatives(
					model.natives,
					Arr.map(held, (h) => h.held)
				)
				const raisable = raisableOver(writes)
				sameApartFromLabels(
					Arr.filter(model.natives, raisable),
					Arr.flatMap(held, (h) => (raisable(h.whole) ? [h.whole] : [])),
					"the natives a write of the slice can raise, as the whole model orders, names and describes them"
				)
				const rules = Arr.filter(whole.rules, (r) => !r.law.reads.isDisjointFrom(writes))
				assert.deepEqual(
					Arr.map(model.rules, (r) => r.law.id),
					Arr.map(rules, (r) => r.law.id),
					"the rules over queries that read a written relation"
				)
				yield* agree(
					[
						[
							"the whole model's written relations",
							Arr.filter([...whole.relations.keys()], (r) => writes.has(r))
						],
						["the relations the slice's model serves", [...model.relations.keys()]]
					],
					set(structuralHash, exact)
				)
				for (const [name, laws] of model.relations) {
					sameApartFromLabels(laws, whole.relations.get(name), `${name}'s keys and unique objects`)
				}

				const tables = new Map(
					Arr.map([...whole.relations.values()], (r) => [r.relation.ident, r.relation.name])
				)
				const written = (ident: RelationIdent): boolean => {
					const name = tables.get(ident)
					return name !== undefined && writes.has(name)
				}
				const intoWrites = new Set(
					Arr.flatMap(whole.natives, (n) =>
						n.namespace === "constraint" &&
						(n.object.kind === "ForeignKey" || n.object.kind === "PeriodForeignKey") &&
						writes.has(n.object.target.name)
							? [`${n.owner} ${identifierOf(n.named)}`]
							: []
					)
				)
				const witness = installationWitness(sliced, noLevelAbove).laws
				for (const e of wholeArtifacts.constraintLaws) {
					switch (e.kind) {
						case "constraint":
						case "trigger": {
							if (!written(e.owner) && !intoWrites.has(`${e.owner} ${e.name}`)) {
								break
							}
							const raised = defined(
								witness.lawsOf(e.name, { kind: "table", name: e.owner }),
								`${e.name} on ${e.owner} names a law`
							)
							assertVariant(raised, "kind", "object", `${e.name} on ${e.owner} types no column`)
							assert.deepEqual(
								raised.laws,
								e.laws,
								`the laws ${e.name} on ${e.owner} reports, described as the whole model does`
							)
							break
						}
						case "domainConstraint": {
							const uses = Arr.filter(e.uses, (u) => written(u.table))
							if (!Arr.isReadonlyArrayNonEmpty(uses)) {
								break
							}
							const raised = defined(
								witness.lawsOf(e.name, { kind: "domain", name: e.owner }),
								`the domain ${e.owner} names its laws`
							)
							assertVariant(raised, "kind", "domain", `the domain ${e.owner} types stored columns`)
							for (const u of uses) {
								assert.ok(
									Arr.some(
										raised.uses,
										(r) =>
											r.table === u.table && r.column === u.column && sameLabelFree(r.law, u.law)
									),
									`the domain ${e.owner} names ${u.table}.${u.column}'s law`
								)
							}
							break
						}
						case "unstoredDomainConstraint":
							break
					}
				}

				const wholeRaised = installationWitness(wholeArtifacts, noLevelAbove).laws.raised
				for (const law of whole.theory.laws) {
					if (law.reads.isDisjointFrom(writes)) {
						continue
					}
					const raised = witness.raised.get(law.id)
					assert.ok(
						raised !== undefined && sameLabelFree(raised, wholeRaised.get(law.id)),
						`the law ${law.id} over a written relation, which a write statement of the slice refuses, raised as the whole model describes it`
					)
				}

				const schema = succeeded(parseSchemaInput(owned.desc), "the base as a schema input")
				const compiledWrites: Array<CompiledWrite> = []
				const refusedWrites: Array<string> = []
				for (const u of c.uses) {
					const program = programOf(c, u)
					const role = defined(roles.get(roleName(u.role)), "the use's role")
					if (program.kind === "query") {
						for (const context of ["snapshot", "transaction"] as const) {
							const overWhole = compiledQuery(wholeArtifacts, role, schema, program.query, context)
							const overSlice = compiledQuery(sliced, role, schema, program.query, context)
							assert.deepEqual(
								overSlice.ok,
								overWhole.ok,
								`the query compiles over the slice in ${context} exactly when over the whole schema`
							)
							if (!overWhole.ok || !overSlice.ok) {
								continue
							}
							sameApartFromLabels(
								ran(overSlice.value),
								ran(overWhole.value),
								`the query's ${context} template, its statements and certificates, as over the whole schema`
							)
							k.note("a query compiled over the slice")
							if (Arr.some(u.reads, (r) => r.kind === "derived" || r.kind === "chained")) {
								k.note("a query of a derived relation compiled over the slice")
							}
							if (
								u.casts &&
								u.reads[0]?.kind === "root" &&
								!Arr.some(upTo(c.tops, topName), (t) => names.has(t))
							) {
								k.note("a query casting into a refinement no named relation declares")
							}
						}
						continue
					}
					const overWhole = compiledChange(wholeArtifacts, role, program.changeSet)
					const overSlice = compiledChange(sliced, role, program.changeSet)
					assert.deepEqual(
						overSlice.ok,
						overWhole.ok,
						"the ChangeSet compiles over the slice exactly when it compiles over the whole schema"
					)
					if (overWhole.ok && overSlice.ok) {
						sameApartFromLabels(
							ran(overSlice.value),
							ran(overWhole.value),
							"the ChangeSet's statements and certificates, as over the whole schema"
						)
						k.note("a ChangeSet compiled over the slice")
						compiledWrites.push(overWhole.value)
					} else {
						refusedWrites.push(Formatter.format(u))
					}
				}

				if (refusedWrites.length === 0) {
					const changed = writesOf(
						owned,
						Arr.flatMap(compiledWrites, (w) => Arr.map(w.frontend.written, (r) => r.name))
					)
					if (Arr.isReadonlyArrayNonEmpty(compiledWrites)) {
						yield* agree(
							[
								["the relations the draw's programs write", [...writes]],
								["the relations the compiled writes change", [...changed]]
							],
							set(structuralHash, exact)
						)
					}
					const cast = Arr.flatMap(compiledWrites, (w) =>
						Arr.flatMap(w.params, (p) => (p.kind === "scalar" ? [p.type] : []))
					)
					const names = wholeArtifacts.names
					const chainOf = (t: ScalarType): ReadonlyArray<string> => {
						const { contract } = t
						return contract === undefined
							? []
							: [names.contractDomain(contract.name).name, ...chainOf(contract.base)]
					}
					const castDomains = new Set(
						Arr.flatMap(cast, (t) => {
							const text = textOf(t)
							const pattern =
								text === undefined || typeof text === "string" ? undefined : names.textDomain(text)
							return [...chainOf(t), ...(pattern === undefined ? [] : [pattern.name])]
						})
					)
					const narrowed = raisableOf(wholeArtifacts, {
						written: changed,
						cast
					})
					const constraintOf = (e: {
						readonly kind: string
						readonly owner: string
						readonly name: string
					}) => `${e.kind} ${e.owner} ${e.name}`
					const held = new Set(Arr.map(sliced.constraintLaws, constraintOf))
					const wholeLaws = new Map(
						Arr.map(wholeArtifacts.constraintLaws, (c) => [constraintOf(c), c] as const)
					)
					for (const e of narrowed.constraintLaws) {
						assert.ok(
							held.has(constraintOf(e)),
							`${constraintOf(e)}, which the served refusals keep, is the slice model's`
						)
					}
					const kept = new Set(Arr.map(narrowed.constraintLaws, constraintOf))
					for (const e of sliced.constraintLaws) {
						if (kept.has(constraintOf(e))) {
							continue
						}
						switch (e.kind) {
							case "constraint":
							case "trigger":
								assert.ok(
									!written(e.owner) && !intoWrites.has(`${e.owner} ${e.name}`),
									`${constraintOf(e)}, which the served refusals drop, is on no relation a write changes and no foreign key into one`
								)
								break
							case "domainConstraint": {
								const whole = defined(
									wholeLaws.get(constraintOf(e)),
									`${constraintOf(e)}, which the slice's model holds, is the whole schema's`
								)
								assert.ok(
									whole.kind === "domainConstraint" &&
										!Arr.some(whole.uses, (u) => written(u.table)) &&
										!castDomains.has(e.owner),
									`${constraintOf(e)}, which the served refusals drop, types columns of the whole schema, none a write writes, and no value a write casts`
								)
								break
							}
							case "unstoredDomainConstraint":
								assert.ok(
									!castDomains.has(e.owner),
									`${constraintOf(e)}, which the served refusals drop, types no value a write casts`
								)
								break
						}
					}
					const slicedLaws = new Set(Arr.map(sliced.theoryLaws, (l) => l.law))
					const keptLaws = new Set(Arr.map(narrowed.theoryLaws, (l) => l.law))
					for (const l of narrowed.theoryLaws) {
						assert.ok(
							slicedLaws.has(l.law),
							`${l.law}, which the served refusals keep, is the slice model's`
						)
					}
					for (const law of model.theory.laws) {
						if (!keptLaws.has(law.id)) {
							assert.ok(
								law.reads.isDisjointFrom(writes),
								`${law.id}, which the served refusals drop, reads no relation a write changes`
							)
						}
					}
					for (const r of narrowed.relations) {
						assert.ok(
							writes.has(r.name),
							`${r.name}, whose heading the served refusals keep, is written`
						)
					}
				}

				const all = Rec.keys(owned.relations)
				if (Arr.some(all, (r) => !names.has(r))) {
					k.note("a relation outside the names")
				}
				const seeded = new Set(
					Arr.flatMap(c.uses, (u) => Arr.map(u.writes, (i) => ordinaryName(c, i)))
				)
				if (writes.size > seeded.size) {
					k.note("a family coupling widens the writes")
				}
				if (
					Arr.some(
						[...writes],
						(w) =>
							!seeded.has(w) &&
							!Arr.some(c.families, (d) => {
								const pair = [rootName(d.owner), rootName(d.member)]
								return pair.includes(w) && Arr.some(pair, (p) => seeded.has(p))
							})
					)
				) {
					k.note("a family chain widens the writes")
				}
				if (
					Arr.some(c.uses, (u) =>
						Arr.some(u.reads, (r) => r.kind === "derived" || r.kind === "chained")
					)
				) {
					k.note("a derived relation's definition named")
				}
				if (Arr.some(c.uses, (u) => Arr.some(u.reads, (r) => r.kind === "world"))) {
					k.note("a world entry names its relation")
				}
				const cycleOf = (r: string) => Arr.findFirst(whole.fkCycles, (cycle) => cycle.includes(r))
				if (
					Arr.some(whole.natives, (n) => {
						if (n.object.kind !== "ForeignKey") {
							return false
						}
						const from = n.object.relation.name
						const to = n.object.target.name
						return (
							!names.has(from) &&
							!names.has(to) &&
							Option.exists(cycleOf(from), (cycle) => cycle.includes(to))
						)
					})
				) {
					k.note("a foreign-key cycle through a key between two relations outside the names")
				}
				if (
					Arr.some(containments, (e) => !names.has(e.from.relation) || !names.has(e.to.relation))
				) {
					k.note("evidence of a containment reading a relation outside the names")
				}
				if (
					Arr.some(
						[...selectionKeys.keys()],
						(r) => names.has(r) && !writes.has(r) && (selectionKeys.get(r)?.length ?? 0) > 0
					)
				) {
					k.note("a selection key on a named relation outside the writes")
				}
				if (model.rules.length > 0) {
					k.note("a rule reading the writes")
				}
				if (
					Arr.some(
						model.theory.laws,
						(l) =>
							l.detail.kind === "rule" &&
							l.detail.lowering.kind === "foreignKeys" &&
							!l.reads.isDisjointFrom(writes)
					)
				) {
					k.note("a lowered rule reading the writes")
				}
				if (sharesLoweredTarget(whole.theory.laws, writes)) {
					k.note("a lowered rule reading the writes beside one outside them, into one relation")
				}
				if (
					Arr.some(whole.natives, (n) => n.object.kind === "Domain") &&
					Arr.some(
						c.families,
						(d) => !names.has(rootName(d.owner)) || !names.has(rootName(d.member))
					)
				) {
					k.note("a contract's domain used outside the names")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the whole schema's law model restricted by a slice computed from the draw"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/laws/model/slice.test.ts#aCompilesLawModelIsTheWholeSchemasRestrictedToItsSlicesWritesAndNames:-:0.1.1.1.0.1.1.0.0.1.1.2.0.1.1.1.0.0.1.1.0.1.0.0"
				),
				reason:
					"the level above written alone, its rule over a derived relation of a family member below",
				since: "2026-11-09"
			},
			{
				token: ReplayToken(
					"test/unit/laws/model/slice.test.ts#aCompilesLawModelIsTheWholeSchemasRestrictedToItsSlicesWritesAndNames:-:1.0.0.0.1.1.1.0.1.1.1.0.0.1.0.0.0.1.0.2.1.0.1.2.1"
				),
				reason: "a family's member written alone, its owner reached through the family",
				since: "2026-11-09"
			},
			{
				token: ReplayToken(
					"test/unit/laws/model/slice.test.ts#aCompilesLawModelIsTheWholeSchemasRestrictedToItsSlicesWritesAndNames:-:1.0.0.0.1.1.0.0.1.1.1.0.0.0.3.1.0.2.1.0.2.0.0"
				),
				reason: "a foreign key cycle through a relation the programs never name",
				since: "2026-11-09"
			},
			{
				token: ReplayToken(
					"test/unit/laws/model/slice.test.ts#aCompilesLawModelIsTheWholeSchemasRestrictedToItsSlicesWritesAndNames:-:2.0.0.2.0.0.1.0.2.0.0.0.0.2.0.1.0.0.0.1.7.0.0.0.0.2.0.0.1.0"
				),
				reason: "a roster's domain discharging a named relation's containment and an unnamed one's",
				since: "2026-11-09"
			},
			{
				token: ReplayToken(
					"test/unit/laws/model/slice.test.ts#aCompilesLawModelIsTheWholeSchemasRestrictedToItsSlicesWritesAndNames:-:0.1.0.0.0.0.2.2.1.1.0.0.0.3.0.0.1.0.0.0.0.1.1.0.0.1.1.1.0.0.1.0.0.0.0"
				),
				reason:
					"a role writing R1, a member of R0's family, and T0, whose one ChangeSet writes T0 alone: the slice's law model holds no R0, whose grants the role holds all the same (rotating seed 0x27587f65, case 25)",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original: "\t\tholdOn(families[0].owner, families, fullyWrittenBy(written))",
				replacement:
					"\t\tholdOn(model.relations.get(families[0].owner.name)!.relation, families, fullyWrittenBy(written))",
				why: "A role's hold on a family's owner read off the law model's relations, which hold only what its slice writes (physical/ddl/roles.ts ownerHolds), so a role writing a member the slice does not write finds no owner and the ChangeSet compiled over the slice dies; the slice fails."
			},
			{
				file: "packages/engine/src/schema/reach.ts",
				original: "\tfor (const relation of out) {",
				replacement: "\tfor (const relation of new Set(written)) {",
				why: "A slice's writes closed under family coupling one step only (schema/reach.ts writesOf), so a chain's far end is left out; the slice fails."
			},
			{
				file: "packages/engine/src/laws/model/model.ts",
				original:
					'\t\t\treturn d.lowering.kind === "foreignKeys" ? d.lowering.parts.map((part) => part.to) : []',
				replacement: "\t\t\treturn []",
				why: "A rule over a query lowered to foreign keys into a named relation's selected side left unplanned (laws/model/model.ts referencedSides), so the slice lacks that relation's selection key; the slice fails."
			},
			{
				file: "packages/engine/src/laws/model/model.ts",
				original:
					'\t\t\tcycles.kind === "planned"\n\t\t\t\t? referenceChoice(theory.laws, theory.relations, discharge, theory.regionFacts)\n\t\t\t\t: cycles.references',
				replacement:
					"\t\t\treferenceChoice(theory.laws, theory.relations, discharge, theory.regionFacts)",
				why: "A slice compile chooses each fixed target's reference over its own closure in place of the whole schema's recorded choice (laws/model/model.ts), so it plans a native the installation lacks; the slice fails."
			}
		]
	})
