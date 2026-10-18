import z from '@deepseek-ai/schemastery'

const requiredCapabilities = z.array(z.union([
  z.const('argv-collect'), z.const('pipes'), z.const('control'), z.const('inherit'), z.const('terminal'),
])).required()

/** Validate only the declared modes; target evidence remains an independent requirement. */
export const executionRequirementsSchema = z.object({
  mode: z.const('closed'),
  requiredCapabilities,
})

/** Root registration capacity; the closed entry requires an explicit finite value. */
export const rootExecutionSchema = z.object({
  mode: z.const('closed'),
  requiredCapabilities,
  maxBoundAccounts: z.natural().min(1).max(Number.MAX_SAFE_INTEGER),
})
