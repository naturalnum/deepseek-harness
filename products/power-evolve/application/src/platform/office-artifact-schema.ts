/** Adjacent reader version for Office requests and immutable artifact source bindings. */

/** Preserve V32 rows and their request digests; stopped V32 binaries refuse this newer version at startup. */
export const schemaV33 = `
UPDATE pe_schema SET version=33 WHERE version=32;
`
