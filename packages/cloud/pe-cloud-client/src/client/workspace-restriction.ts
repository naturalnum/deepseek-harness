/** Cloud deletion copy retained by the original Native page root. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { WorkspaceDeleteDisabledReason } from '@deepseek-ai/dsh-client-ui-workspace/client'

/** Original deployment message in every supported language. */
export const workspaceDeletionCopy = Object.freeze({
  en: 'Workspace deletion is unavailable in this deployment',
  zh: '此部署暂不支持删除工作区',
  ja: 'この環境ではワークスペースを削除できません',
  es: 'La eliminación de espacios de trabajo no está disponible en este despliegue',
  fr: 'La suppression d’espaces de travail n’est pas disponible dans ce déploiement',
  de: 'Das Löschen von Arbeitsbereichen ist in dieser Bereitstellung nicht verfügbar',
  ru: 'Удаление рабочих пространств недоступно в этом развёртывании',
  pt: 'A eliminação de espaços de trabalho não está disponível nesta instalação',
})

/**
 * Keep restriction text usable through Cloud-entry withdrawal and Native locale changes.
 * @param root - Original Native page root, which owns the provided restriction until graph disposal.
 * @returns Plain display callback; it grants no deletion capability and performs no I/O.
 */
export function createWorkspaceDeleteRestriction(root: Context): WorkspaceDeleteDisabledReason {
  return { message: () => root.get('locale')?.resolveText(workspaceDeletionCopy) ?? workspaceDeletionCopy.en }
}
