/** Read smoke-check arguments and private account credentials without logging their contents. */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

const DEFAULT_URL = 'http://127.0.0.1:32802'

function parseUrl(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('invalid URL')
    }
    return url
  } catch (_error) {
    throw new Error('网页入口必须是有效的 HTTP 或 HTTPS 地址，且不能包含凭据。')
  }
}

async function readCredentials(path) {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = await file.stat()
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error('private regular file required')
    }
    return JSON.parse(await file.readFile('utf8'))
  } catch (_error) {
    throw new Error('无法读取凭据：需要有效的 JSON 普通文件，权限为 0600。')
  } finally {
    await file?.close()
  }
}

/**
 * Resolve the candidate entry and one account from environment variables or a private JSON file.
 * @param {string[]} argv - Command arguments; account secrets are never accepted here.
 * @param {NodeJS.ProcessEnv} env - Environment containing optional smoke account credentials.
 * @returns {Promise<{url: string, email: string, password: string, mcp: boolean, research: boolean, wrongPassword: boolean, help: boolean}>} Options for one smoke run.
 */
export async function readOptions(argv = process.argv.slice(2), env = process.env) {
  const options = {
    url: DEFAULT_URL,
    email: '',
    password: '',
    mcp: false,
    research: false,
    wrongPassword: false,
    help: false,
  }
  let credentialsPath
  let accountName = 'ordinaryUserC'
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    switch (argument) {
      case '--mcp': options.mcp = true; break
      case '--research': options.research = true; break
      case '--wrong-password': options.wrongPassword = true; break
      case '--help': options.help = true; break
      case '--url':
      case '--credentials':
      case '--account': {
        const value = argv[++index]
        if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
          throw new Error('参数缺少取值。')
        }
        if (argument === '--url') options.url = value
        else if (argument === '--credentials') credentialsPath = value
        else accountName = value
        break
      }
      default: throw new Error('存在不支持的参数。')
    }
  }
  if (options.help) return options

  const url = parseUrl(options.url)
  options.url = url.href.replace(/\/$/, '')
  let account
  if (credentialsPath !== undefined) {
    const data = await readCredentials(credentialsPath)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('凭据文件未包含有效的测试账号。')
    }
    if (Object.hasOwn(data, 'publicOrigin')) {
      if (typeof data.publicOrigin !== 'string' || parseUrl(data.publicOrigin).origin !== url.origin) {
        throw new Error('凭据文件的入口与本次网页入口不一致。')
      }
    }
    account = Object.hasOwn(data, 'email') ? data : data[accountName]
  } else {
    account = { email: env.PE_CLOUD_SMOKE_EMAIL, password: env.PE_CLOUD_SMOKE_PASSWORD }
  }
  if (account === null || typeof account !== 'object'
    || typeof account.email !== 'string' || account.email.trim() === ''
    || typeof account.password !== 'string' || account.password === '') {
    throw new Error('请通过环境变量或私密文件提供完整的测试账号。')
  }
  options.email = account.email.trim()
  options.password = account.password
  if (options.wrongPassword) {
    const wrong = randomBytes(24).toString('base64url')
    options.password = wrong === account.password ? `${wrong}-wrong` : wrong
  }
  return options
}
