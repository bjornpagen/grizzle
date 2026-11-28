import { constant, oneOf } from "@bjornpagen/testing/gen"
import { claimsRequired } from "#test/pg/world-model/isolation-claims.fixtures.ts"
import {
	dbSession,
	docsInstalls,
	docsTenantRealities,
	noCheck,
	programProperty
} from "#test/support/worlds/drive/suite.ts"
import { docsProfileInstall } from "#test/support/worlds/model/bases/docs.ts"

/** The worlds model: isolation, claims: a Db's contexts hold exactly the facts its verified claims decode to. */
export const isolationClaims = programProperty({
	installs: oneOf([docsInstalls, constant(docsProfileInstall)]),
	focus: ["open-db", "read", "close", "wild"],
	steps: 8,
	required: claimsRequired,
	realities: docsTenantRealities,
	lead: dbSession(claimsRequired),
	check: noCheck,
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/pool/served.ts",
			original:
				"\tconst read = readCaller(value, tokenKeys)\n\tif (!read.ok) {\n\t\treturn Result.fail(noToken())\n\t}\n\tconst { kind, base, login, role } = read.value.data\n",
			replacement: "\tconst { kind, base, login, role } = Object(value)\n",
			why: "Db.open reads the role a caller hands it straight off the caller's value, where it reads it once at the boundary (readCaller), so a hostile proxy's trap runs and its throw escapes openServed as a defect where Db.open owes OpenError at `schema`: the defect this suite met at the 26e3c15f pin (WildTouched, \"a Db's contexts hold exactly the facts its verified claims decode to\"), which b542bbd66 and 61885272b fixed."
		},
		{
			file: "packages/engine/src/program/workload/compile.ts",
			original: "\t\tappendAll(views, types.value)\n",
			replacement: "",
			why: "The workload plan serves no role's world views' types, so the artifacts a role's compile lowers its views under name no domain only a view's body casts to: docsProfileInstall's member's ProfileFiltered casts the Profile context's badge claim to its refinement, which no artifact of the base types a value by, and generate refuses the installation as UninstalledDomain (main's red at 29a4d30c, from 3a53e9d9's world views)."
		}
	]
})
