import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
/**
 * A ChangeSet over a level taken over a role (test/types/changeset/generic-role.ts): ChangeSet.over(role, program), the
 * role built, or a parameter of a library's program, `<W extends RoleOver<typeof Level>>(role: W) =>
 * ChangeSet.over(role, program)`, compiles wherever the program's schema is a level of the bound's least level, the one
 * level the call knows, where ChangeSet.union(ChangeSet.empty(role), program) waited on the parameter and was refused
 * (edullm's KEYDIGEST-LEDGER L7); its instantiation admits exactly the roles holding that level whole; a built role is
 * checked itself, so a role of which the program's schema is no level is refused; and every admitted ChangeSet is over
 * the role itself. Each way of giving the role, program level and role is a cell of the box; a batch's cells are one
 * program, checked disarmed. Oracle: the engine's level rule for ChangeSet.over (write/changeset/value.ts overOf,
 * schema/level.ts isLevelOver), computed over the bound and over the role apart from the types.
 */
import { genericRoleBox } from "#test/types/changeset/generic-role.dictionary.ts"
import { genericRoleProgram } from "#test/types/changeset/generic-role.ts"

/**
 * A ChangeSet over a level is taken over a role parameter bounded by that level, and over a built role exactly where its
 * schema is one of the role's levels.
 */
export const genericRole = boxAgreement(finite(word(genericRoleBox)), {
	box: "a program over Root and one over Graded, each taken over RootWriter, GradedWriter, SittingWriter (a role over Graded holding Root's relation alone) and ElsewhereWriter, the role built, or a parameter bounded by RoleOver<Root>, RoleOver<Graded> or AnyRole",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: genericRoleProgram,
	oracle: {
		kind: "specification",
		name: "the engine's level rule for ChangeSet.over, a program over one of the role's levels, over the bound at the call and over the role at the instantiation"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original:
				'\t\t? unknown\n\t\t: Refusal<"ChangeSet.over takes a ChangeSet over a level of its role">',
			replacement: "\t\t? unknown\n\t\t: unknown",
			why: "ChangeSet.over checks no level: a program over Root or Graded is taken over ElsewhereWriter, and one over Graded over RootWriter; the program fails."
		},
		{
			file: "packages/engine/src/types/schema/world.ts",
			original: "export type RoleLeastOf<W, Least> = [Least] extends [never] ? W : Least",
			replacement: "export type RoleLeastOf<W, Least> = [Least] extends [never] ? W : W",
			why: "The call checks a role parameter over the parameter itself, which no check can read, as union did: every generic call is refused; the program fails."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original: "\t\trole: W & RoleLeastStated<Least>,",
			replacement: "\t\trole: W & RoleLeastStated<never>,",
			why: "The call infers no least level from a role parameter's bound and checks it over the parameter itself: every generic call is refused; the program fails."
		},
		{
			file: "packages/engine/src/types/schema/world.ts",
			original:
				'export interface RoleOver<L extends AnySchema | AnyFragment> extends AnyRole {\n\treadonly relations: WholeEntries<L["relations"]>\n',
			replacement:
				"export interface RoleOver<L extends AnySchema | AnyFragment> extends AnyRole {\n",
			why: "RoleOver bounds a parameter by no relation: a generic program over Root is instantiated over ElsewhereWriter, of which Root is no level; the program fails."
		}
	]
})
