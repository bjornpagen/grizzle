import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, Record as Rec } from "effect"
import { maxIdentifierBytes, conversionOf, identifierOf } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { expandAlternatives } from "#compiler/ir/desc.ts"
import { type ConstraintOwner, lawsOfConstraint } from "#compiler/ir/products.ts"
import { constraintLawMap } from "#compiler/laws/model/model.ts"
import { schema } from "#compiler/public/schema.ts"
import {
	constraintOwner,
	installationNamesOf,
	installationOf,
	lawIdOf,
	lawNamesOf
} from "#test/support/kernel/naming.ts"
import {
	alternativesStatements,
	bytesOf,
	checkOf,
	declaredColumn,
	foreignKeysInto,
	handlesOf,
	hashedName,
	judged,
	Item,
	levelStatements,
	type NamingFeature,
	namingCaseGen,
	type ShapeFeature,
	shapeFeatures,
	shapeGen,
	subjectOf
} from "#test/unit/kernel/naming.fixtures.ts"

/**
 * Production names from src agree with src's records at every named native, key, alternatives expansion, checked
 * contract and text domain, each named by the door's rule.
 *
 * Budget: its suite's count before the conversion (unit/kernel/naming: 40 independent cases and 32 steered, Vitest at
 * grizzle 4ca3036a). At those counts its required situations went unreached at TEST_SEED=1 (a readable row check;
 * toolchain-test run of 2026-11-16 08:21Z), so its steered phase keeps the runner's cap of 200, which it stops short
 * of once every situation is reached.
 */
export const productionNamesFromSrcAgreeWithSrcsRecordsAtEveryNamedNativeKeyAlternativesExpansionCheckedContractAndTextDomainEachNamedByTheDoorsRule =
	property.explore(namingCaseGen, {
		needs: {},
		situations: [
			"named native",
			"alternatives expansion",
			"checked contract",
			"text domain",
			"a key statement",
			"a readable row check",
			"a hashed law column",
			"an empty level above",
			"a rule's trigger"
		] satisfies ReadonlyArray<Reached<NamingFeature>>,
		check: (_, k: Case<NamingFeature>) => (c) =>
			Effect.sync(() => {
				const { base, subject } = subjectOf(c)
				if (c.extended) {
					k.note("an empty level above")
				}
				const L = lawNamesOf(subject)
				const N = installationNamesOf(installationOf(subject, { kind: "declared" }))
				const theory = new Set<LawId>(Arr.map(L.model.theory.laws, (l) => l.id))
				const named: Array<readonly [string, string]> = []
				for (const native of L.model.natives) {
					if (native.namespace !== "constraint" && native.namespace !== "column") {
						continue
					}
					const id = native.named
					named.push([`${native.namespace} ${native.owner}`, identifierOf(id)])
					assert.ok(
						bytesOf(identifierOf(id)) <= maxIdentifierBytes,
						`${identifierOf(id)} fits an identifier`
					)
					if (id.kind === "check") {
						k.note("a readable row check")
						assert.equal(id.form, "readable")
						const declared = id.parts[1]
						assert.ok(
							typeof declared === "string",
							"a row check's identity holds its declared name"
						)
						assert.equal<string>(identifierOf(id), conversionOf(declared))
					} else {
						if (id.kind === "lawColumn") {
							k.note("a hashed law column")
						}
						assert.equal(id.form, "hashed", `${id.display} is hashed`)
						assert.equal<string>(identifierOf(id), hashedName(id.stem, id.canonical))
					}
					if (native.namespace !== "constraint") {
						continue
					}
					k.note("named native")
					const owner: ConstraintOwner = { kind: "table", name: native.owner }
					const ident = identifierOf(native.named)
					for (const law of L.lawsOfConstraint(owner, ident)) {
						assert.ok(theory.has(law), `${ident} reports ${law}, which is no law of the theory`)
						assert.ok(
							L.constraintsOf(law, native.object.kind).includes(ident),
							`${ident} is among the ${native.object.kind} constraints reporting ${law}`
						)
					}
				}
				assert.equal(
					new Set(Arr.map(named, ([space, ident]) => `${space} ${ident}`)).size,
					named.length,
					"no two natives of one namespace share a name"
				)
				const constraintLaws = constraintLawMap(L.model.constraints)
				for (const entry of L.model.constraints) {
					if (entry.kind === "trigger") {
						k.note("a rule's trigger")
					}
					const laws = Arr.map(entry.laws, (l) => l.law)
					const found = lawsOfConstraint(constraintLaws, constraintOwner(entry), entry.name)
					assert.ok(
						found !== undefined && Arr.every(laws, (law) => Arr.contains(found, law)),
						`${entry.name} of ${entry.owner} is found under the owner the kit names it by, naming every one of its laws`
					)
				}
				for (const statement of Arr.filter(base.statements, (s) => s.kind === "key")) {
					k.note("a key statement")
					const law = lawIdOf(subject, statement)
					const reporting = Arr.filter(L.model.constraints, (entry) =>
						Arr.contains(
							lawsOfConstraint(
								constraintLawMap(L.model.constraints),
								constraintOwner(entry),
								entry.name
							) ?? [],
							law
						)
					)
					assert.ok(reporting.length > 0, `a constraint reports the key's law ${law}`)
				}
				for (const statement of alternativesStatements(levelStatements(L.model.owned.desc))) {
					k.note("alternatives expansion")
					const laws = L.alternativesOfDesc([statement])
					const expansion = expandAlternatives(statement)
					const all = [...new Set(Rec.values(laws.arms)), ...Rec.values(laws.reverse)]
					assert.equal(new Set(all).size, all.length, "arm and reverse laws are distinct")
					for (const forward of Arr.filter(
						expansion,
						(s) => s.right.selection.conjuncts.length > 0
					)) {
						const parent = forward.right.relation
						const fks = foreignKeysInto(L.model, forward.left.relation, parent)
						for (const handle of handlesOf(forward.right)) {
							const arm = defined(laws.arms[handle], `${handle}'s arm law`)
							assert.ok(
								Arr.some(fks, (fk) => Arr.contains(L.lawsOfConstraint(fk.owner, fk.ident), arm)) !==
									judged(L.model, arm),
								`${handle}'s arm is contained in its parents one way: through a foreign key into them, or by the rule judge`
							)
						}
					}
					for (const reverse of Arr.filter(
						expansion,
						(s) => s.left.selection.conjuncts.length > 0
					)) {
						const handle = Arr.headNonEmpty(handlesOf(reverse.left))
						const law = defined(laws.reverse[handle], `${handle}'s reverse law`)
						assert.ok(theory.has(law), `${handle}'s reverse is a law of the theory`)
						if (judged(L.model, law)) {
							assert.deepEqual(
								L.constraintsOf(law, "ForeignKey"),
								[],
								`${handle}'s reverse, held by the rule judge, installs no foreign key`
							)
							continue
						}
						assert.ok(
							Arr.contains(
								L.lawsOfConstraint(
									{ kind: "table", name: N.tableIdent({ name: reverse.left.relation }) },
									L.constraintOf(law, "ForeignKey")
								),
								law
							),
							`${handle}'s reverse is its own native foreign key`
						)
					}
				}
				for (const contractName of Rec.keys(N.model.owned.contracts)) {
					const contract = N.contract(contractName)
					if (contract.kind === "brand") {
						continue
					}
					k.note("checked contract")
					const stored = Arr.flatMap(N.installation.constraintLaws, (c) =>
						c.kind === "domainConstraint" &&
						c.owner === contract.domain &&
						c.name === contract.constraint
							? c.uses
							: []
					)
					const unstored = Arr.flatMap(N.installation.constraintLaws, (c) =>
						c.kind === "unstoredDomainConstraint" &&
						c.owner === contract.domain &&
						c.name === contract.constraint
							? c.laws
							: []
					)
					const reported = N.lawsOfConstraint(
						{ kind: "domain", name: contract.domain },
						contract.constraint
					)
					const [first] = stored
					if (first === undefined) {
						assert.ok(
							Arr.some(unstored, (l) => l.law === contract.law),
							`${contractName}'s domain, typing no stored column, carries its law`
						)
						assert.ok(
							Arr.every(reported, (law) => Arr.some(unstored, (l) => l.law === law)),
							`${contractName}'s domain names only laws it carries`
						)
					} else {
						for (const use of stored) {
							const typed = declaredColumn(N.model.owned, use.table, use.column)
							if (typed.desc.kind !== "contract") {
								return assert.fail(
									`${typed.relation}.${typed.field} uses ${contract.domain} with no contract`
								)
							}
							const owner = N.contract(typed.desc.name)
							assert.equal(owner.domain, contract.domain, `${typed.relation}.${typed.field}`)
							assert.equal(
								use.law.law,
								owner.law,
								`${typed.relation}.${typed.field} states its own contract's law under the domain's CHECK`
							)
						}
						assert.deepEqual<ReadonlyArray<LawId>>(
							reported,
							Arr.sort(Arr.dedupe(Arr.map(stored, (use) => use.law.law)), Order.String),
							`${contractName}'s domain names every law its uses state, ${first.law.law} among them, each once, in code point order`
						)
					}
				}
				for (const domain of N.installation.textDomains) {
					for (const use of domain.uses) {
						k.note("text domain")
						const { relation: owner, field } = declaredColumn(N.model.owned, use.table, use.column)
						const textNames = N.textDomain({ name: owner }, field)
						assert.equal(textNames.domain, domain.name, `${owner}.${field}`)
						const law = N.patternLaw({ name: owner }, field)
						/** The law src's installation records for the column under the domain's CHECK. */
						const recorded = Arr.flatMap(N.installation.constraintLaws, (c) =>
							c.kind === "domainConstraint" &&
							c.owner === textNames.domain &&
							c.name === textNames.constraint
								? Arr.filter(c.uses, (u) => u.table === use.table && u.column === use.column)
								: []
						)
						assert.deepEqual(
							Arr.map(recorded, (u) => u.law.law),
							[law],
							`${owner}.${field}'s column states its own pattern law under its domain's CHECK`
						)
						const described = N.described(law)
						assert.ok(
							described.kind === "pattern" &&
								described.relation === owner &&
								described.field === field,
							`${owner}.${field}'s law names its relation and field`
						)
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "src's law model and installation records, and the naming door's rule restated: readable a row check's conversion, hashed __stem_digest of its identity"
		},
		budget: { runs: 40, steered: 200 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/kernel/naming.test.ts#productionNamesFromSrcAgreeWithSrcsRecordsAtEveryNamedNativeKeyAlternativesExpansionCheckedContractAndTextDomainEachNamedByTheDoorsRule:-:1.2.1.0.0.1.1.0"
				),
				reason:
					"two contracts of one definition, the first column's named after the second's: the domain's CHECK names both contracts' laws, in code point order, never the first use's alone",
				since: "2026-11-11"
			}
		],
		kills: [
			{
				file: "packages/engine/src/core/identity.ts",
				original: `\t\tBigInt(\`0x\${sha256Hex(wellFormed(canonical)).slice(0, digestHexChars)}\`) >> digestDropped`,
				replacement: `\t\tBigInt(\`0x\${sha256Hex(wellFormed(canonical)).slice(0, digestHexChars)}\`)`,
				why: "A hashed name's digest is read from the low bits of its hex digits, none dropped, so it is not the first 5 * digestChars bits of the SHA-256; the production-names property fails."
			}
		]
	})

/** Production names from src name a row check's law by a statement rebuilt in its written operand order, which ownership reorders. */
export const productionNamesFromSrcNameARowChecksLawByAStatementRebuiltInItsWrittenOperandOrderWhichOwnershipReorders =
	property.exhaust(finite(shapeGen), {
		needs: {},
		situations: ["and under or", "singleton and"] satisfies ReadonlyArray<Reached<ShapeFeature>>,
		check: (_, c: Case<ShapeFeature>) => (shape) =>
			Effect.sync(() => {
				c.noteAll(shapeFeatures(shape, false))
				const L = lawNamesOf(schema("S", [Item], [checkOf(shape)]))
				const theory = Arr.filter(
					L.model.theory.laws,
					(l) => l.detail.kind === "check" && l.detail.name === "H"
				)
				const [declared, ...more] = theory
				if (declared === undefined || more.length > 0) {
					return assert.fail("the schema's one row check is one law")
				}
				assert.equal(L.lawOf(checkOf(shape)), declared.id)
			}),
		oracle: {
			kind: "specification",
			name: "the one law of the schema's one row check"
		},
		box: "every predicate over the two leaves of at most two levels of connectives, each of one or two operands",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/model.ts",
				original:
					'\t\t\t\t\tdesc.kind === "field" ? r.fields.find((f) => f.name === desc.field) : undefined',
				replacement: '\t\t\t\t\tdesc.kind === "field" ? r.fields.find((f) => true) : undefined',
				why: "Operator mutant (boolean-return) at packages/engine/src/laws/model/model.ts:1070 in <module>: `f.name === desc.field` becomes `true`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
