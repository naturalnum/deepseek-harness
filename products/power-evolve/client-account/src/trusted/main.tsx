/** Standalone trusted entry; the Host module loader and credentials are absent. */
import { createRoot } from 'react-dom/client'
import { AccountPage } from './AccountPage.tsx'
import { TrustedAccountHttpClient } from './http-client.ts'
import { en, zh } from '../client/locales.ts'

const dictionary = navigator.language.toLowerCase().startsWith('zh') ? zh : en
document.documentElement.lang = dictionary === zh ? 'zh' : 'en'
document.title = dictionary.account
const root = document.getElementById('account-root')
if (!root) throw new Error('Missing trusted account mount')
createRoot(root).render(<AccountPage client={new TrustedAccountHttpClient(window.location.origin)}
  initialView={window.location.hash === '#admin' ? 'admin' : 'password'} t={key => dictionary[key]} />)
