// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PublishAction } from '../src/client/PublishAction.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it('publishes the selected native file explicitly and reuses the request ID after a failure', async () => {
  const publish = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce({})
  const onPublished = vi.fn()
  render(<PublishAction {...{
    absolutePath: '/workspace/out/report.txt', sessionId: '598f346b-178c-4ef3-80ef-3a68f4cb4888',
    client: { publish }, onPublished, t: (key: keyof typeof en) => en[key],
  } as never} />)
  fireEvent.click(screen.getByRole('button', { name: 'Publish artifact' }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Publish artifact' }))
  await waitFor(() => expect(onPublished).toHaveBeenCalledOnce())
  expect(publish).toHaveBeenCalledTimes(2)
  expect(publish.mock.calls[0]?.slice(0, 3)).toEqual(publish.mock.calls[1]?.slice(0, 3))
  expect(screen.getByRole('button', { name: 'Published' }).hasAttribute('disabled')).toBe(true)
})
