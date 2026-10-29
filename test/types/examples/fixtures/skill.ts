import { defineConfig } from "@bjornpagen/grizzle"
import { Blog, EtlJob, Web } from "#test/types/examples/fixtures/readme.ts"

/**
 * packages/grizzle/skills/grizzle/SKILL.md's grizzle.config.ts example, checked: test/types/examples/blocks.test.ts holds each line of
 * the block here, in order. Its "./src/db.ts" is the README's program. Typechecked, never executed.
 */
export default defineConfig({
	/** Required: each declared schema, in its own PostgreSQL schema. */
	schemas: [Blog],
	/** Required: every login, and through them every role a Db opens and every workload whose access paths earn indexes. */
	logins: [Web, EtlJob]
})
