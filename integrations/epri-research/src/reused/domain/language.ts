/**
 * @license
 * Copyright 2026 DeepScientist (deepscientist.cc)
 * SPDX-License-Identifier: Apache-2.0
 */

const PROMPT_LANGUAGE_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  'en-US': 'English',
  'ja-JP': 'Japanese',
  'es-ES': 'Spanish',
  'zh-TW': 'Traditional Chinese',
  'ko-KR': 'Korean',
  'tr-TR': 'Turkish',
  'ru-RU': 'Russian',
  'uk-UA': 'Ukrainian',
  'pt-BR': 'Brazilian Portuguese',
  'de-DE': 'German',
};

const normalizePromptLocale = (locale?: string): string => {
  const normalized = locale?.replace(/_/gu, '-').trim();
  if (!normalized) return 'en-US';
  const exact = Object.keys(PROMPT_LANGUAGE_NAMES).find((key) => key.toLowerCase() === normalized.toLowerCase());
  if (exact) return exact;
  const language = normalized.split('-')[0]?.toLowerCase();
  if (language === 'zh') return 'zh-CN';
  if (language === 'ja') return 'ja-JP';
  if (language === 'es') return 'es-ES';
  if (language === 'ko') return 'ko-KR';
  if (language === 'tr') return 'tr-TR';
  if (language === 'ru') return 'ru-RU';
  if (language === 'uk') return 'uk-UA';
  if (language === 'pt') return 'pt-BR';
  if (language === 'de') return 'de-DE';
  return 'en-US';
};

export const getPromptLanguageName = (locale?: string): string =>
  PROMPT_LANGUAGE_NAMES[normalizePromptLocale(locale)] || PROMPT_LANGUAGE_NAMES['en-US'];

export const getPromptLanguageInstruction = (locale?: string): string =>
  `- Use the same language as the user for reasoning and responses. Detect the language of the user's latest message and use it for reasoning, headings, clarification questions, report text, and final prose. Use ${getPromptLanguageName(locale)} only when the user's language cannot be determined. Keep source titles, quoted evidence, identifiers, code, file paths, and official names in their original language when accuracy depends on it.`;
