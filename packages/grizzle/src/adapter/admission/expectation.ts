import { Option } from "effect"
import { BlockSizeMismatched } from "#adapter/migrate/errors.ts"
import { blockSize } from "#compiler/core/page.ts"
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
 * measured at (maxStackDepth). A setting the server cannot report as kilobytes is below it.
 */
export const stackTooShallow = (reported: string): boolean => {
	const kilobytes = Number(reported)
	return !Number.isSafeInteger(kilobytes) || kilobytes < maxStackDepth
}

/** What a server's max_stack_depth must be at least, as a refusal states it. */
export const stackDepthRequired = `${maxStackDepth} kB, the default PostgreSQL's regex compiler was measured at`

/**
 * The server's block size, BLCKSZ, as current_setting reports it, in bytes, the unit it has none of: a column of grizzle
 * migrate's first read.
 */
export const blockSizeColumn: C.CatalogExpr = C.catalogCall("current_setting", [
	C.text("block_size")
])

/**
 * The refusal of a server whose block size, as blockSizeColumn reads it, is not the one every page bound grizzle holds a
 * key, a row and an index entry to was derived from (core/page.ts blockSize: BTMaxItemSize, MaxHeapTupleSize, the key
 * texts' bounds): a server built with smaller pages refuses keys and rows grizzle admits, one built with larger pages
 * admits what grizzle refuses. None at that size.
 */
export const blockSizeRefusal = (reported: string): Option.Option<BlockSizeMismatched> =>
	reported === String(blockSize)
		? Option.none()
		: Option.some(new BlockSizeMismatched({ observed: reported, required: blockSize }))
