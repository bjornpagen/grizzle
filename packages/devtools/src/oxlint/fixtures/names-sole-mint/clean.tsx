import { Brand } from "effect"
type TableName = string & Brand.Brand<"TableName">
export const table = Brand.nominal<TableName>()
