/**
 * A declared function at a library level names a variant of that level in its body (docs/schema.md "Variants": V.of, V.code,
 * V.attribute), and every application over the library installs it under its own codes, as a column of the variant is
 * (physical/ddl/functions.ts spellingText): the body spells the variant's composite and domain alone, and the function's
 * pinned search_path finds them in the installation's types schema after its own level's (sql/ast.ts
 * CreateDeclaredFunction `namedAlone`, sql/print.ts declaredSearchPath), where a body naming a variant was refused
 * outside the installation's own schema, so qti-pie's Ledger, a level every application composes, installed nowhere.
 *
 * The box, exhausted: an integer at each edge of its type and each boolean, each made into a value of each arm by two
 * applications over one library: `one`, migrated to the library from a roster of c alone, which keeps c at code 0 and
 * appends b at 1, and `two`, installed fresh, which codes b 0 and c 1. In each, the owner stores the functions' values
 * as a direct writer, a Db reads them back and writes a value of each arm, and the functions read those as the arms
 * they are.
 *
 * Oracle: specification, the values the case makes: each application reads back exactly the tagged values its
 * functions made and its Db wrote, and the two answer alike under their two codes.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import {
	applicationCase,
	type ExactArmFeature,
	type ExactArmWrite,
	exactArmCase,
	exactArmGen,
	exactArmWrites,
	type FunctionsCase,
	functionsCases
} from "#test/pg/fields/variant-functions.fixtures.ts"
import { baseSubstrate, Substrate } from "#test/support/substrate/substrate.ts"

/** A library level's function over its variant answers alike in two applications of two codes. */
export const aLibraryLevelsFunctionNamingItsVariantAnswersAlikeUnderEveryApplicationsCodes =
	property.exhaust(finite(functionsCases), {
		box: "an integer at each edge of its type and each boolean, made into each arm by an application migrated to the library and one installed fresh",
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [],
		check:
			({ substrate }, _c: Case<never>) =>
			(k: FunctionsCase) =>
				Effect.scoped(
					Effect.provideServiceEffect(
						Effect.gen(function* () {
							const one = yield* applicationCase("one", k)
							const two = yield* applicationCase("two", k)
							assert.deepEqual(
								[one.code, two.code],
								["1", "0"],
								"the application migrated to the library codes b 1, after c, and the fresh one codes it 0"
							)
							const made = [`1 b ${k.n}`, `2 c ${k.flag}`, `3 b ${k.n}`, `4 c ${!k.flag}`]
							const read = [`1 true ${k.n}`, `3 true ${k.n}`, "4 false -"]
							for (const [application, answers] of [
								["one", one],
								["two", two]
							] as const) {
								assert.deepEqual(
									answers.made,
									made,
									`the ${application} application's Db reads back each value its functions made and it wrote, as the tagged value it is`
								)
								assert.deepEqual(
									answers.read,
									read,
									`the ${application} application's functions read each value of b as b and its integer, and one of c as no b`
								)
							}
						}),
						Substrate,
						Effect.map(substrate, (taken) => taken.substrate)
					)
				),
		oracle: {
			kind: "specification",
			name: "the values the case makes, each application's read back as its functions made them, under its own codes"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/functions.ts",
				original: "\t\t\tconst { variant } = base\n",
				replacement:
					'\t\t\tconst { variant } = base\n\t\t\tif (identifierOf(level) !== identifierOf(b.names.installation)) {\n\t\t\t\tmissing("a body names a variant in a function of the installation\'s own schema")\n\t\t\t}\n',
				why: "The refusal this lane removed: a body names a variant only in a function of the installation's own schema, so the library level's functions install in no application."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: '\t\tif (t.kind === "named" && !path.includes(t.schema)) {\n',
				replacement: "\t\tif (false) {\n",
				why: "The search_path leaves out the installation's types schema: the library level's SQL body names the variant's composite and domain alone, which its path does not find, so PostgreSQL refuses to create it (42704)."
			},
			{
				file: "packages/engine/src/physical/ddl/functions.ts",
				original:
					'\t\t\tif (type.kind === "named" && !namedAlone.some((t) => sameTypeRef(t, type))) {\n',
				replacement: '\t\t\tif (type.kind === "named" && namedAlone.length < 0) {\n',
				why: "The function records no type its body names alone, so its search_path is its own level's and the body's variant names resolve nowhere."
			}
		]
	})

/**
 * A variant's arm field of an exact type is held to its type's scale by the variant's domain, never NaN or an infinity
 * (physical/ddl/variants.ts armCheck, physical/numeric/storage.ts exactPredicate), the one predicate a stored exact
 * column's CHECK states: a direct writer's record of Amount's whole arm, an exact integer as QtiValue's integer arm is,
 * holding a fraction, an integer at another scale or NaN is refused (23514), and a declared function's value holding a
 * fraction is refused at the cast the call makes to the domain (lower/conservative/call), where before the domain cast
 * the field to plain numeric alone, so the host's bigint codec could not decode what it held; an integer at scale 0 is
 * admitted and reads back as its bigint, whoever wrote it.
 *
 * The box, exhausted: a library of Amount, installed as `grizzle generate` drafts it and held to the installed-catalog
 * posture, its writer writing a variant over a roster no column of its own types, which reads no constant of the roster
 * (physical/ddl/domains.ts carrierDomains); its whole arm written by SQL as a record holding 2.5, 3.0, NaN or -7, or
 * made by amount_of, a declared function of trim_scale(x), at 2.5 and 3.0. Oracle: specification, an exact integer is an
 * integer at scale 0, as a stored exact column's CHECK holds it, and the posture's grants exactly what the role's
 * statements evaluate.
 */
export const anExactArmIsHeldToItsScaleByItsVariantsDomain = property.exhaust(finite(exactArmGen), {
	box: "Amount's whole arm, an exact integer, written by SQL as a record holding 2.5, 3.0, NaN or -7, and made by a declared function of trim_scale(x) at 2.5 and 3.0",
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: Arr.map(exactArmWrites, (w) => w.feature) satisfies ReadonlyArray<
		Reached<ExactArmFeature>
	>,
	check:
		({ substrate }, c: Case<ExactArmFeature>) =>
		(w: ExactArmWrite) =>
			Effect.scoped(
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const read = yield* exactArmCase(w)
						assert.deepEqual(
							Option.getOrUndefined(read),
							w.read === "refused" ? undefined : [{ tag: "whole", value: w.read }],
							`${w.by} ${w.value}: ${w.read === "refused" ? "refused" : "admitted, its integer read back"}`
						)
						c.note(w.feature)
					}),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				)
			),
	oracle: {
		kind: "specification",
		name: "an exact integer is an integer at scale 0, as a stored exact column's CHECK holds it"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/physical/ddl/variants.ts",
			original:
				"\t\t\t\t\texactNumeric.holds(f.field.type)\n\t\t\t\t\t\t? [exactPredicate(valueAttribute(f.attribute), f.field.type)]\n",
			replacement: "\t\t\t\t\texactNumeric.holds(f.field.type)\n\t\t\t\t\t\t? []\n",
			why: "The variant's domain holds no exact arm field to its scale, as before: a direct writer's record holding 2.5 is accepted, and amount_of's 2.5 passes the call's cast; the property fails."
		},
		{
			file: "packages/engine/src/physical/ddl/domains.ts",
			original:
				"\t\tfor (const arm of t.variant.arms) {\n\t\t\tfor (const f of arm.fields) {\n\t\t\t\ttypeDomains(b, f.type, use)\n",
			replacement:
				"\t\tconst roster = b.names.rosterDomain(t.variant.roster.closed)\n\t\tuse.domains.set(nameKey(roster), {\n\t\t\tname: roster,\n\t\t\tidentity: b.names.rosterNamed(t.variant.roster.closed),\n\t\t\tnode: b.typeNamed(roster)\n\t\t})\n\t\tfor (const arm of t.variant.arms) {\n\t\t\tfor (const f of arm.fields) {\n\t\t\t\ttypeDomains(b, f.type, use)\n",
			why: "A variant column uses its tag's roster domain again, as before: Amounts' writer, whose writes read no constant of WholeKind, is granted EXECUTE on its live constant, which the installed-catalog checker refuses as excess, so the installation fails; the property fails."
		}
	]
})
