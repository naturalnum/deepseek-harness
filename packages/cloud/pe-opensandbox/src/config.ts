import z from '@deepseek-ai/schemastery'

const requiredCapabilities = z.array(z.union([
  z.const('argv-collect'), z.const('pipes'), z.const('control'), z.const('inherit'), z.const('terminal'),
])).required()

/** Validate only the declared modes; target evidence remains an independent requirement. */
export const executionRequirementsSchema = z.object({
  mode: z.union([z.const('closed'), z.const('session-collect')]),
  requiredCapabilities,
})

/** Root registration capacity; the closed entry requires an explicit finite value. */
const closedRootExecutionSchema = z.object({
  mode: z.const('closed'),
  requiredCapabilities,
  maxBoundAccounts: z.natural().min(1).max(Number.MAX_SAFE_INTEGER),
})

/** Managed limits are validated by the strict parser before a Root owner or resource can be created. */
export const rootExecutionSchema = z.union([
  closedRootExecutionSchema,
  z.object({ mode: z.const('session-collect'), requiredCapabilities, managed: z.any<unknown>().required(),
    rootDeployment: z.object({ path: z.string().required(), sha256: z.string().required() }).default(undefined as never) }),
])
