/**
 * A check the compile proves emits nothing (physical/ddl/column-checks.ts ColumnCheckKind generationProves): a closed id
 * column PostgreSQL generates, or a key generation its row CHECK holds to its generation, carries no CHECK of its
 * subset, since the analysis admits its generation only of a type within the subset (analysis/schema.ts
 * generatedTypeRule, ir/scalar.ts subsetWithin), and a term's subset is a proof: a written field's of its own CHECK, a
 * variant's tag of its domain's, a literal branch of its own handle (scalar/compute/typing.ts subsetBranchHandle), a
 * literal of a subset's type of a handle of it (ir/expr.ts literalProblem), a made value's field of a value within its
 * subset, and no cast narrows one. A generation its type does not prove within the column's subset is refused where the
 * schema compiles, so no generated column is left whose CHECK the compile cannot prove.
 *
 * The box, exhausted over a four-handle roster: into a column of p, of p and q, and of every handle, a key's field and
 * not, each generation: a variant of arms p and q's tag, a copy of a written field of p, a conditional, a guard's
 * otherwise and a case of the other arm taking a literal at each handle beside that field, a named handle, and a cast of
 * a field of every handle into the column's type; and a value of a variant made with its field of p a literal at each
 * handle, the field of p, or the field of every handle. The oracle is the handles each generation can be, read here
 * apart from the engine: V's arms', the field's, the branches' together, every handle for a named one, whose type is
 * the roster's; a generation is admitted exactly where they are within the column's, its column then carrying no
 * subset CHECK where the written field of p carries one, and a cast exactly where it narrows nothing.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	canBe,
	type GeneratedCase,
	generatedCases,
	heldBy,
	type Installed,
	installedCase,
	madeHolds,
	within
} from "#test/unit/scalar/generated-subset.fixtures.ts"

type Feature =
	| "a proved generation carries no CHECK"
	| "a proved key generation carries no CHECK"
	| "an unproved generation refused"
	| "a narrowing cast refused"
	| "a made field outside its subset refused"

/** What a case's installation must be: admitted, its generated column of no subset CHECK, or refused. */
const expect = (installed: Installed, admitted: boolean, what: string): void => {
	if (!admitted) {
		assert.equal(installed.kind, "refused", `${what} is refused where the schema compiles`)
		return
	}
	if (installed.kind === "refused") {
		return assert.fail(`${what} is admitted: ${installed.error.message}`)
	}
	assert.equal(
		installed.subsetChecks("g"),
		0,
		`${what}: its column carries no CHECK the compile proves`
	)
	assert.equal(
		installed.subsetChecks("src"),
		1,
		"the written field of p carries its subset's CHECK"
	)
}

/** A generated closed id carries no CHECK its generation proves, and a generation that proves none is refused. */
export const aGeneratedClosedIdCarriesNoCheckItsGenerationProves = property.exhaust(
	finite(generatedCases),
	{
		box: "into a column of p, of p and q and of every handle, keyed and not: a variant's tag, a copy, a conditional's, a guard's and a case's literal branch at each handle, a named handle and a cast; and a made value's field of p at each handle, the field of p and the field of every handle",
		needs: {},
		situations: [
			"a proved generation carries no CHECK",
			"a proved key generation carries no CHECK",
			"an unproved generation refused",
			"a narrowing cast refused",
			"a made field outside its subset refused"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (k: GeneratedCase) =>
			Effect.sync(() => {
				const installed = installedCase(k)
				if (k.door === "made") {
					const holds = madeHolds(k.made)
					if (!holds) {
						c.note("a made field outside its subset refused")
					}
					expect(installed, holds, `a value made with its field of p ${k.made.kind}`)
					return
				}
				const held = heldBy[k.column]
				const can = canBe(k.generation)
				const admitted = can === undefined ? held.length === 4 : within(can, held)
				if (!admitted) {
					c.note(can === undefined ? "a narrowing cast refused" : "an unproved generation refused")
				} else {
					c.note(
						k.keyed
							? "a proved key generation carries no CHECK"
							: "a proved generation carries no CHECK"
					)
				}
				expect(
					installed,
					admitted,
					`a ${k.generation.kind} generation into a column of ${Arr.join(held, ", ")}${k.keyed ? ", keyed" : ""}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the handles each generation can be, within its column's subset or not"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/closed/storage.ts",
				original: "\tgenerationProves: true,\n",
				replacement: "\tgenerationProves: false,\n",
				why: "A generated closed id of a subset carries the CHECK of its subset its generation proves: a check the compile proves emits a judge again."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					"\t\tconst handle = subsetBranchHandle(desc, t.nominal)\n\t\tif (handle !== undefined) {\n\t\t\treturn this.literal(handle.value, handle.type, at)\n\t\t}\n",
				replacement: "",
				why: "A literal branch beside a closed id of a subset adopts the whole roster: a conditional of src and its own handle p is of every handle, and its generation into p's column is refused."
			},
			{
				file: "packages/engine/src/ir/expr.ts",
				original: "\t\t\t\t: type.only !== undefined && !type.only.includes(literal.handle)\n",
				replacement: "\t\t\t\t: false\n",
				why: "A literal of a subset's type may be a handle outside it: a made value's field of p holds q, which no CHECK of the column the value is generated into refuses."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: "\t\t\t\t\tif (!subsetWithin(f.type, term.nominal)) {\n",
				replacement: "\t\t\t\t\tif (false) {\n",
				why: "A made value's field of p takes the field of every handle, a value its subset does not hold."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: "\t\tif (!subsetWithin(to, arg.nominal)) {\n",
				replacement: "\t\tif (false) {\n",
				why: "A cast narrows a closed id of every handle into a subset with no proof: its generation into the subset's column is admitted, and the column carries no CHECK of it."
			},
			{
				file: "packages/engine/src/ir/scalar.ts",
				original: "\treturn held === undefined || given?.every((h) => held.includes(h)) === true\n",
				replacement: "\treturn true\n",
				why: "A generation of handles outside its column's subset is admitted, a named handle of every handle into p's column among them, and its column carries no CHECK of it."
			}
		]
	}
)
