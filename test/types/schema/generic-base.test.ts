import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
/**
 * A level over a base parameter (test/types/schema/generic-base.ts): `<B extends SchemaOver<typeof Root>>(base: B) =>
 * schema.extend([base], ...)`, and its weakest bound, AnySchema, compile wherever the level's content keeps the rules
 * over the bound's least level, the one level the call knows (metis's G3: every level a builder over its base, refused
 * at the call by checks that could not read a type parameter); the same rules over the base itself refuse the level
 * its instantiation builds, wherever it is taken as a schema; and a level over a built base is refused at its call by
 * exactly those rules. Each bound, content and base is a cell of the box; a batch's cells are one program, checked
 * disarmed. Oracle: the engine's level rules (DeclaredOnce, StatementsWithin, a derived definition over a level below),
 * computed over the bound and over the base apart from the types.
 */
import { genericBaseBox } from "#test/types/schema/generic-base.dictionary.ts"
import { genericBaseProgram } from "#test/types/schema/generic-base.ts"

/**
 * A level over a base parameter compiles where it keeps the rules over its bound, and its instantiation is refused
 * where the base breaks one, as a level over the built base is at its call.
 */
export const genericBase = boxAgreement(finite(word(genericBaseBox)), {
	box: "every content of a level (its own relations, a containment into the bound's relation or into one above it, a relation named as the bound's or as one above it, a derived relation over the bound, the bound's relation listed again), over a base parameter bounded by SchemaOver<Root> and by AnySchema, instantiated over Root and over Graded above it, beside the same level over the built base",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: genericBaseProgram,
	oracle: {
		kind: "specification",
		name: "the engine's level rules, a name declared once across the levels, a statement naming only a declared relation and a derived definition over a level below, over the bound at the call and over the base at the instantiation"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original:
				"export type LeastOf<Base extends AnySchema, Least extends AnySchema> = [Least] extends [never]\n\t? Base\n\t: Least",
			replacement:
				"export type LeastOf<Base extends AnySchema, Least extends AnySchema> = [Least] extends [never]\n\t? Base\n\t: Base",
			why: "The call checks a level over a base parameter over the parameter itself, which no check can read, as before G3: every generic level's call is refused; the program fails."
		},
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original: "> = [Least] extends [never] ? never : RefusalOver<Base, Relations, Statements>",
			replacement: "> = [Least] extends [never] ? never : never",
			why: "A generic level's instantiation is never refused: a level over a base holding a relation of its relation's name, or lacking a relation its statement names, is admitted as a base; the program fails."
		},
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original: "\t: Level & { readonly [refused]?: Refusal<Why & Refused> }",
			replacement: "\t: Level",
			why: "A refused instantiation states no refusal, so it is taken as a schema like any level; the program fails."
		},
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original:
				"\t/** No schema is refused: a level its instantiation refuses states its refusal here (Extended), which no schema admits. */\n\treadonly [refused]?: undefined",
			replacement:
				"\t/** No schema is refused: a level its instantiation refuses states its refusal here (Extended), which no schema admits. */\n\treadonly [refused]?: unknown",
			why: "Every schema admits a refusal, so a refused instantiation is taken as a schema; the program fails."
		},
		{
			file: "packages/engine/src/schema/api.ts",
			original:
				'\t\t...ReadonlyArray<\n\t\t\tRefusal<"schema.extend takes one base: a level over several bases is not built yet">\n\t\t>',
			replacement: "\t\t...ReadonlyArray<AnySchema>",
			why: "schema.extend's list of bases admits a second base, a level over several, which the builder refuses; the program's level over two bases fails."
		},
		{
			file: "packages/engine/src/schema/api.ts",
			original: "\tbases: readonly [\n\t\tBase & LeastStated<Least>,",
			replacement:
				"\tbases: (Base & LeastStated<Least>) | readonly [\n\t\tBase & LeastStated<Least>,",
			why: "schema.extend's bases admit a bare schema beside the list, the spelling before the list, which the builder refuses; the program's level over a bare base fails."
		},
		{
			file: "packages/engine/src/schema/api.ts",
			original: "\t\tBase & LeastStated<Least>,",
			replacement: "\t\tBase,",
			why: "The call infers no least level from a base parameter's bound and checks it over the parameter itself: every generic level's call is refused; the program fails."
		}
	]
})
