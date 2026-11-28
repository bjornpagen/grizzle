/**
 * ChangeSet.over(role, cs) is `cs` taken over its role (write/changeset/value.ts overOf): the empty ChangeSet over the
 * role unioned with `cs`, one implementation with union, so its Description is that union's and it is over the role
 * itself, its strata and read-backs `cs`'s; refused, naming its rule, where `cs`'s schema is none of the role's levels, as its type refuses
 * it (types/changeset OverCheck, test/types/changeset/generic-role.test.ts); and refused as malformed where what it is
 * given is no role.
 *
 * Box: a program over Root and one over Graded, each taken over a full role over Root, one over Graded, a role over
 * Graded holding Root's relation alone, a full role over a schema apart, and Root itself; every one of the 5 × 2 cases.
 *
 * Oracle: the specification's level rule (over.fixtures.ts levelsOf), and union as a second implementation: an admitted
 * case's Description is ChangeSet.union(ChangeSet.empty(role), cs)'s.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { throwsRefused } from "#test/support/assert.ts"
import { descOf } from "#test/support/unit/write/changeset/fixtures.ts"
import {
	isOverItsRole,
	levelsOf,
	overCaseGen,
	overOf,
	unionOf
} from "#test/unit/write/changeset/over.fixtures.ts"

type OverFeature =
	| "taken over a full role"
	| "taken over a role holding a lower level whole"
	| "a program over a level below the role's base"
	| "refused: no level of the role"
	| "refused: no role"

/** A ChangeSet taken over a role is the empty ChangeSet over the role unioned with it, refused where its schema is none of the role's levels and where it is given no role. */
export const aChangeSetTakenOverARoleIsTheEmptyChangeSetOverTheRoleUnionedWithItAndIsRefusedWhereItsSchemaIsNoneOfTheRolesLevels =
	property.exhaust(finite(overCaseGen), {
		needs: {},
		situations: [
			"taken over a full role",
			"taken over a role holding a lower level whole",
			"a program over a level below the role's base",
			"refused: no level of the role",
			"refused: no role"
		] satisfies ReadonlyArray<Reached<OverFeature>>,
		check: (_, k: Case<OverFeature>) => (c) =>
			Effect.sync(() => {
				if (c.over === "Root itself") {
					throwsRefused(
						() => overOf(c),
						"MalformedDescription",
						`a program over ${c.program} taken over Root, a schema, which is no role`
					)
					k.note("refused: no role")
					return
				}
				if (!levelsOf(c.over).includes(c.program)) {
					const refused = throwsRefused(
						() => overOf(c),
						"Refused",
						`a program over ${c.program} taken over ${c.over}, of which ${c.program} is no level`
					)
					assert.equal(
						refused.reason._tag === "Refused" ? refused.reason.refusal : undefined,
						"ChangeSet.over takes a ChangeSet over a level of its role",
						`the refusal of ${c.program}'s program over ${c.over} names ChangeSet.over's rule`
					)
					k.note("refused: no level of the role")
					return
				}
				const taken = overOf(c)
				assert.deepEqual(
					descOf(taken),
					descOf(unionOf(c)),
					`${c.program}'s program taken over ${c.over} is the empty ChangeSet over ${c.over} unioned with it`
				)
				assert.ok(
					isOverItsRole(c, taken),
					`${c.program}'s program taken over ${c.over} is over ${c.over}`
				)
				k.note(
					c.over === "SittingWriter"
						? "taken over a role holding a lower level whole"
						: "taken over a full role"
				)
				if (c.over === "GradedWriter" && c.program === "Root") {
					k.note("a program over a level below the role's base")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the level rule of ChangeSet.over, and ChangeSet.union(ChangeSet.empty(role), cs) as a second implementation"
		},
		box: "a program over Root and one over Graded, each taken over RootWriter, GradedWriter, SittingWriter, ElsewhereWriter and Root itself",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/changeset/value.ts",
				original:
					'\tif (!isLevelOver(stateOf(cs, label).over, level)) {\n\t\tthrow builderRefusal(label, "ChangeSet.over takes a ChangeSet over a level of its role")\n\t}\n',
				replacement: "",
				why: "ChangeSet.over checks no level of its own: a program over Root taken over ElsewhereWriter is refused by union's level check, as malformed, naming no rule."
			},
			{
				file: "packages/engine/src/write/changeset/value.ts",
				original: "\treturn unionOf(label, emptyOf(role, []), cs, extra)",
				replacement: "\treturn unionOf(label, cs, cs, extra)",
				why: "ChangeSet.over returns its ChangeSet over its own schema, not the role's: Root's program taken over RootWriter is over Root."
			},
			{
				file: "packages/engine/src/write/changeset/value.ts",
				original: '\tif (level?.kind !== "role") {',
				replacement: "\tif (level === undefined) {",
				why: "ChangeSet.over takes a schema as its role: Root's program taken over Root itself is admitted."
			}
		]
	})
