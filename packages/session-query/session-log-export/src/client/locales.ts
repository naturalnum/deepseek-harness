/** Locale namespace owned by Session export browser feedback. */
export const NS = 'session-log-download'

/** Simplified-Chinese Session export strings. */
export const zh = {
  'menu.copyMarkdown': '复制会话为 Markdown',
  'menu.download': '下载 Session 日志',
  'menu.feedback': '反馈',
  'toast.copied': 'Session 已复制为 Markdown',
  'toast.preparationFailed': '无法读取 Session 进行复制，请重试',
  'toast.clipboardFailed': '无法写入剪贴板，请检查剪贴板权限后重试',
  'dialog.session': 'Session：{sessionId}',
  'dialog.preparingTitle': '正在导出 Session',
  'dialog.preparingDescription': '正在准备包含指定 Session、子 Session 和附件的 ZIP 文件',
  'dialog.successTitle': '已请求下载 Session',
  'dialog.successDescription': '请查看浏览器的下载记录；如果下载未开始，可点击下方链接。',
  'dialog.manualDownload': '下载 Session ZIP',
  'dialog.errorTitle': 'Session 导出失败',
  'dialog.close': '关闭',
  'dialog.commandFailed': '无法启动 Session 导出。',
} as const

/** English Session export strings. */
export const en: Record<keyof typeof zh, string> = {
  'menu.copyMarkdown': 'Copy Session as Markdown',
  'menu.download': 'Download session log',
  'menu.feedback': 'Feedback',
  'toast.copied': 'Session copied as Markdown.',
  'toast.preparationFailed': 'Could not read the Session for copying. Try again.',
  'toast.clipboardFailed': 'Could not write to the clipboard. Check clipboard permission and try again.',
  'dialog.session': 'Session: {sessionId}',
  'dialog.preparingTitle': 'Exporting Session',
  'dialog.preparingDescription': 'Preparing a ZIP containing the selected Session, its sub-Sessions, and attachments.',
  'dialog.successTitle': 'Session download requested',
  'dialog.successDescription': 'Check your browser downloads. If the download did not start, use the link below.',
  'dialog.manualDownload': 'Download Session ZIP',
  'dialog.errorTitle': 'Session export failed',
  'dialog.close': 'Close',
  'dialog.commandFailed': 'Could not start the Session export.',
}

/** Stable locale keys consumed by the shared modal. */
export type SessionLogDownloadKey = keyof typeof zh

/** Japanese copy, checked against the English keys. */
export const ja = {
  'menu.copyMarkdown': 'セッションを Markdown としてコピー',
  'menu.download': 'セッションログをダウンロード',
  'menu.feedback': 'フィードバック',
  'toast.copied': 'セッションを Markdown としてコピーしました',
  'toast.preparationFailed': 'コピーするセッションを読み取れませんでした。再試行してください。',
  'toast.clipboardFailed': 'クリップボードに書き込めませんでした。クリップボードの権限を確認して再試行してください。',
  'dialog.session': 'セッション: {sessionId}',
  'dialog.preparingTitle': 'セッションをエクスポート中',
  'dialog.preparingDescription': '指定のセッション、そのサブセッション、添付ファイルを含むZIPを準備しています。',
  'dialog.successTitle': 'Session のダウンロードを要求しました',
  'dialog.successDescription': 'ブラウザーのダウンロード履歴を確認してください。開始されていない場合は下のリンクを使用してください。',
  'dialog.errorTitle': 'セッションのエクスポートに失敗しました',
  'dialog.close': '閉じる',
  'dialog.commandFailed': 'セッションのエクスポートを開始できませんでした。',
  'dialog.manualDownload': 'Session ZIP をダウンロード',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'menu.copyMarkdown': 'Copiar sesión como Markdown',
  'menu.download': 'Descargar registro de sesión',
  'menu.feedback': 'Comentarios',
  'toast.copied': 'Sesión copiada como Markdown.',
  'toast.preparationFailed': 'No se pudo leer la sesión para copiarla. Intentar otra vez.',
  'toast.clipboardFailed': 'No se pudo escribir en el portapapeles. Verifique los permisos del portapapeles e inténtelo nuevamente.',
  'dialog.session': 'Sesión: {sessionId}',
  'dialog.preparingTitle': 'Sesión de exportación',
  'dialog.preparingDescription': 'Preparar un ZIP que contenga la sesión seleccionada, sus subsesiones y archivos adjuntos.',
  'dialog.successTitle': 'Descarga de la sesión solicitada',
  'dialog.successDescription': 'Comprueba las descargas del navegador. Si la descarga no comenzó, usa el enlace de abajo.',
  'dialog.errorTitle': 'Error al exportar la sesión',
  'dialog.close': 'Cerrar',
  'dialog.commandFailed': 'No se pudo iniciar la exportación de la sesión.',
  'dialog.manualDownload': 'Descargar ZIP de la sesión',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'menu.copyMarkdown': 'Copier la session sous Markdown',
  'menu.download': 'Télécharger le journal de session',
  'menu.feedback': 'Commentaires',
  'toast.copied': 'Session copiée sous le nom Markdown.',
  'toast.preparationFailed': 'Impossible de lire la session pour la copier. Essayer à nouveau.',
  'toast.clipboardFailed': "Impossible d'écrire dans le presse-papiers. Vérifiez l'autorisation du presse-papiers et réessayez.",
  'dialog.session': 'Session : {sessionId}',
  'dialog.preparingTitle': "Session d'exportation",
  'dialog.preparingDescription': "Préparation d'un ZIP contenant la session sélectionnée, ses sous-sessions et les pièces jointes.",
  'dialog.successTitle': 'Téléchargement de la session demandé',
  'dialog.successDescription': 'Consultez les téléchargements du navigateur. Si le téléchargement n’a pas commencé, utilisez le lien ci-dessous.',
  'dialog.errorTitle': "Échec de l'exportation de la session",
  'dialog.close': 'Fermer',
  'dialog.commandFailed': "Impossible de démarrer l'exportation de session.",
  'dialog.manualDownload': 'Télécharger le ZIP de la session',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'menu.copyMarkdown': 'Kopieren Sie die Sitzung als Markdown',
  'menu.download': 'Sitzungsprotokoll herunterladen',
  'menu.feedback': 'Rückmeldung',
  'toast.copied': 'Sitzung als Markdown kopiert.',
  'toast.preparationFailed': 'Die Sitzung zum Kopieren konnte nicht gelesen werden. Versuchen Sie es erneut.',
  'toast.clipboardFailed': 'Es konnte nicht in die Zwischenablage geschrieben werden. Überprüfen Sie die Berechtigung für die Zwischenablage und versuchen Sie es erneut.',
  'dialog.session': 'Sitzung: {sessionId}',
  'dialog.preparingTitle': 'Sitzung exportieren',
  'dialog.preparingDescription': 'Vorbereiten einer ZIP-Datei mit der ausgewählten Sitzung, ihren Untersitzungen und Anhängen.',
  'dialog.successTitle': 'Session-Download angefordert',
  'dialog.successDescription': 'Prüfe die Downloads deines Browsers. Falls der Download nicht begonnen hat, nutze den folgenden Link.',
  'dialog.errorTitle': 'Der Sitzungsexport ist fehlgeschlagen',
  'dialog.close': 'Schließen',
  'dialog.commandFailed': 'Der Sitzungsexport konnte nicht gestartet werden.',
  'dialog.manualDownload': 'Session-ZIP herunterladen',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'menu.copyMarkdown': 'Скопировать сеанс как Markdown',
  'menu.download': 'Скачать журнал сеанса',
  'menu.feedback': 'Обратная связь',
  'toast.copied': 'Сессия скопирована как Markdown.',
  'toast.preparationFailed': 'Не удалось прочитать сеанс для копирования. Попробуйте еще раз.',
  'toast.clipboardFailed': 'Не удалось записать в буфер обмена. Проверьте разрешение буфера обмена и повторите попытку.',
  'dialog.session': 'Сеанс: {sessionId}',
  'dialog.preparingTitle': 'Экспорт сеанса',
  'dialog.preparingDescription': 'Подготовка ZIP-файла, содержащего выбранный сеанс, его подсеансы и вложения.',
  'dialog.successTitle': 'Запрошено скачивание сессии',
  'dialog.successDescription': 'Проверьте загрузки браузера. Если скачивание не началось, воспользуйтесь ссылкой ниже.',
  'dialog.errorTitle': 'Экспорт сеанса не удался',
  'dialog.close': 'Закрыть',
  'dialog.commandFailed': 'Не удалось начать экспорт сеанса.',
  'dialog.manualDownload': 'Скачать ZIP сессии',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'menu.copyMarkdown': 'Copiar sessão como Markdown',
  'menu.download': 'Baixar registro da sessão',
  'menu.feedback': 'Comentários',
  'toast.copied': 'Sessão copiada como Markdown.',
  'toast.preparationFailed': 'Não foi possível ler a sessão para cópia. Tente novamente.',
  'toast.clipboardFailed': 'Não foi possível gravar na área de transferência. Verifique a permissão da área de transferência e tente novamente.',
  'dialog.session': 'Sessão: {sessionId}',
  'dialog.preparingTitle': 'Exportando Sessão',
  'dialog.preparingDescription': 'Preparando um ZIP contendo a sessão selecionada, suas subsessões e anexos.',
  'dialog.successTitle': 'Transferência da sessão solicitada',
  'dialog.successDescription': 'Verifique as transferências do navegador. Se a transferência não começou, use a ligação abaixo.',
  'dialog.errorTitle': 'Falha na exportação da sessão',
  'dialog.close': 'Fechar',
  'dialog.commandFailed': 'Não foi possível iniciar a exportação da sessão.',
  'dialog.manualDownload': 'Transferir ZIP da sessão',
} satisfies Record<keyof typeof en, string>
