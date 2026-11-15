/** Test-only admission wrapper over the actual Cloud selector and original Native Markdown. */
import { useMemo, type ComponentProps } from 'react'
import { MarkdownText as NativeMarkdownText, type MarkdownLabels, type MarkdownCodeLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownLabels as defaultMarkdownLabels } from '../../../client/ui-primitives/tests/labels.client.ts'
import { cloudFilePresentation } from '../src/client/file-presentation.ts'

type Props = Omit<ComponentProps<typeof NativeMarkdownText>, 'labels' | 'filePresentation'> & {
  readonly labels?: MarkdownLabels
  readonly codeLabels?: MarkdownCodeLabels
  readonly standaloneFileLinks?: boolean
}
/** The legacy test admission flag now feeds the actual Cloud policy; production admission comes from the Native closing owner. */
export function MarkdownText({ labels, codeLabels, standaloneFileLinks = false, ...props }: Props) {
  const resolved = labels ?? (codeLabels === undefined ? defaultMarkdownLabels : { ...defaultMarkdownLabels, code: codeLabels })
  const filePresentation = useMemo(() => ({ select: cloudFilePresentation, active: standaloneFileLinks }), [standaloneFileLinks])
  return <NativeMarkdownText {...props} labels={resolved} filePresentation={filePresentation}/>
}
