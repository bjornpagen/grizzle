/**
 * A login list's type cost at metis's login count (schema/budget/login-lists.ts): a tuple of logins of two roles and two
 * workloads each, `satisfies ReadonlyArray<AnyLogin>`, passed to defineConfig and mapped with roleNameOf, checked alone
 * at 8, 16 and 24 logins, the longest past metis's 23.
 *
 * Properties: every program typechecks with no diagnostic, so no statement of the list instantiates past what the
 * checker allows one (TS2589); its instantiations grow no faster than linearly; and each login the longer lists add
 * costs at most its measured instantiations, its roles carrying no programs (login-lists.ts addedAtMost). Oracle: the
 * compiler's own counts, step against step and against a login's measured bound.
 */
import { costGate } from "#test/support/types/batch/measured.ts"
import { loginLists } from "#test/types/schema/budget/login-lists.dictionary.ts"
import { loginListCost, loginListName } from "#test/types/schema/budget/login-lists.ts"

/** The list typechecks at each length with no diagnostic, growing linearly, each login at its measured cost. */
export const loginList = costGate(loginLists, {
	box: "a list of logins checked against AnyLogin, configured and named, at three lengths",
	name: loginListName,
	measure: loginListCost,
	oracle: {
		kind: "universal",
		name: "the compiler's own counts, step against step and against a login's measured bound"
	},
	kills: [
		{
			file: "packages/engine/src/types/schema/world.ts",
			original: '\treadonly [R in Roles[number] as R["name"]]: LoginRole<R, Ws>\n',
			replacement:
				'\treadonly [R in Roles[number] as R["name"]]: LoginRole<R, ProgramsOf<R, Ws>>\n',
			why: "Each role of a login carries its programs, a walk of the login's every workload against its levels, in the login's own type, read at each relation of the login: AnyLogin's, the list's and every parameter's it is passed to, metis's TS2589 and TS5114 over its 23 logins at c8cf6d6fb; a login costs 2,237 instantiations against its bound of 1,709."
		},
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original: "type LevelsBelow<B> = [B] extends [never] ? never : LevelsOf<B>\n",
			replacement: "type LevelsBelow<B> = [B] extends [never] ? EmptyLevel : LevelsOf<B>\n",
			why: "The empty level is a member of every level's levels (LevelsOf), where the reader of queries alone admitted it (types/query/query.ts QueryOver), so each reader distributing over a role's levels, a workload's programs and a login's workloads, reads one level more for every role and login: a login costs 1,737 instantiations against its bound of 1,710, as rlxvqonm's EmptyLevel below the root did at 40efdaff with the rest of its cost (REPLAYFIX)."
		}
	]
})
