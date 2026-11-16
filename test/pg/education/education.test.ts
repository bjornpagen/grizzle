/**
 * The school system's laws hold for every writer, whatever it is handed. Programs over the education installation first
 * write once through every role that writes (support.ts everyWriterApplies), then draw every action kind with live,
 * stale and wild inputs: Dbs of every role opened with live, stale and wild tokens,
 * applies of lawful and law-breaking facts, refreshes, direct SQL writers that take on roles, hand-set claims and write
 * at every isolation level, interruptions, migrations, catalog changes and wild JavaScript values. After every action
 * the stored facts are the model's, whose reality keeps every law of the base (the driver's laws-hold invariant), and
 * a witness a law shows a world names only values its caller submitted or holds whole.
 */
import { layer } from "@effect/vitest"
import { educationTests, everyWriterApplies } from "#test/pg/education/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { everyAction } from "#test/support/worlds/drive/suite.ts"
import { everyRole } from "#test/support/worlds/generate/weights.ts"

const required = [
	"invariant:laws-hold",
	"a witness was shown",
	"teacher apply applied",
	"teacher apply invariant-rejected",
	"school_admin apply applied",
	"school_admin apply invariant-rejected",
	"importer apply applied",
	"student apply applied"
] as const

layer(Substrate.layer)(
	"education: laws",
	educationTests([
		{
			suite: "pg/education/laws",
			roles: everyRole,
			lead: everyWriterApplies(required),
			name: "every educational law holds for every writer under every invalid input",
			focus: everyAction,
			steps: 16,
			cases: 24,
			realization: "per-case",
			required,
			properties: [{ kind: "witnesses" }, { kind: "reach" }]
		}
	])
)
