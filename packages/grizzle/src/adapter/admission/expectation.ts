import { C } from "#compiler/plan/catalog.ts"
import { maxStackDepth } from "#compiler/plan/common.ts"

const settings = C.from("pg_settings", "s")

/** The server's max_stack_depth as pg_settings reports it, in kilobytes, its unit: a column of grizzle migrate's first read. */
export const stackDepthColumn: C.CatalogExpr = C.asText(
	C.scalar(
		C.query(
			[settings.col("setting")],
			[settings.item],
			C.eq(settings.col("name"), C.text("max_stack_depth"))
		)
	)
)

/**
 * Whether a server's max_stack_depth, as stackDepthColumn reads it, is below the default the pattern limits were
 * measured at (core/limits.ts maxStackDepth). A setting the server cannot report as kilobytes is below it.
 */
export const stackTooShallow = (reported: string): boolean => {
	const kilobytes = Number(reported)
	return !Number.isSafeInteger(kilobytes) || kilobytes < maxStackDepth.value
}

/** What a server's max_stack_depth must be at least, as a refusal states it. */
export const stackDepthRequired = `${maxStackDepth.value} kB, the default PostgreSQL's regex compiler was measured at`
