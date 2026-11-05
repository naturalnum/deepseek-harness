/** Public deployment validation performs no Root, SDK or allocation construction. */
import { expect, it } from 'vitest'
import { parseRootDeploymentInput } from '@deepseek-ai/dsh-pe-opensandbox'
import { REMOTE_CLIENT_SERVER_IMAGE_DIGEST } from '../src/bootstrap/deployment-input.ts'
import { sharedPathDeploymentFixture } from './fixtures/root-deployment.ts'

it('validates through the public library entry and rejects a mismatched workload/server pair', () => {
  const input = sharedPathDeploymentFixture()
  const parsed = parseRootDeploymentInput(input)
  expect(parsed.schema).toBe('pe-opensandbox-root-deployment-v2')
  expect(parsed.lifecycle.imageDigest).toBe(input.lifecycle.imageDigest)
  expect(() => parseRootDeploymentInput({ ...input, selection: {
    ...input.selection, serverImageDigest: REMOTE_CLIENT_SERVER_IMAGE_DIGEST,
  } })).toThrow('selection.workloadImagePair')
})
