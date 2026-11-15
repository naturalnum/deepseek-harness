// @vitest-environment jsdom
/** Original Assistant Markdown and public Cloud policy; no synthetic file service or alternate renderer. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownDelegateProvider } from '@deepseek-ai/dsh-client-ui-primitives'
import { AssistantMarkdown } from '../../../client/ui-chat/src/client/chat/AssistantMarkdown.tsx'
import { useDetailedPresentation } from '../../../client/ui-chat/tests/presentation-fixture.client.ts'
import { unusedImageLoader } from '../../../client/ui-chat/tests/reasoning-component-fixture.tsx'
import { useDisclosure } from '../../../client/ui-chat/src/client/chat/use-disclosure.ts'
import { useSearchableHidden } from '../../../client/ui-chat/src/client/chat/searchable-hidden.ts'
import type { ChatViewSlotProps } from '../../../client/ui-chat/src/client/contract/slots.ts'
import type { AssistantBlock } from '../../../client/ui-chat/src/client/contract/snapshot.ts'
import { cloudFilePresentation } from '../src/client/file-presentation.ts'

afterEach(cleanup)
const t = ((_key: string) => 'label') as ChatViewSlotProps['t']
function textBlock(text: string): AssistantBlock { return { kind: 'text', text } }
describe('Cloud file presentation through the original Assistant', () => {
  it('offers the session file opener for plain output filenames in a settled reply', () => {
    const openFile = vi.fn()
    const view = render(
      <MarkdownDelegateProvider openFile={openFile}>
        <AssistantMarkdown renderSlot={() => null} useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
          usePresentation={useDetailedPresentation} blocks={[textBlock('Downloads:\n\n- model.json\n- predictions.csv')]}
          streaming={false} filePresentation={{ select: cloudFilePresentation, active: true }} loadImage={unusedImageLoader} t={t} />
      </MarkdownDelegateProvider>,
    )
    fireEvent.click(view.getByRole('button', { name: 'predictions.csv' }))
    expect(openFile).toHaveBeenCalledExactlyOnceWith('predictions.csv', undefined)
  })

  it.each([
    { streaming: true, enabled: true, text: '- predictions.csv' },
    { streaming: false, enabled: false, text: '- predictions.csv' },
    { streaming: false, enabled: true, text: '- ../private.csv\n- report.csv --flag\n- javascript:alert(1)' },
  ])('keeps filenames inert outside an opted-in settled filename item: %j', ({ streaming, enabled, text }) => {
    const openFile = vi.fn()
    const view = render(
      <MarkdownDelegateProvider openFile={openFile}>
        <AssistantMarkdown renderSlot={() => null} useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
          usePresentation={useDetailedPresentation} blocks={[textBlock(text)]}
          streaming={streaming} filePresentation={{ select: cloudFilePresentation, active: enabled }} loadImage={unusedImageLoader} t={t} />
      </MarkdownDelegateProvider>,
    )
    expect(view.queryAllByRole('button')).toHaveLength(0)
    expect(openFile).not.toHaveBeenCalled()
  })

})
