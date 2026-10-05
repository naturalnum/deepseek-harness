#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, readdir, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../../../../../package.json', import.meta.url))
const { zipSync } = require('fflate')
const root = dirname(fileURLToPath(import.meta.url))
const outputRoot = join(root, 'generated')
const definitions = [
  {
    directory: 'word', extensionId: 'builtin.word', version: '1.0.2', name: 'Word 文档',
    summary: '创建、读取和修改 Word 文档。',
    description: '使用获授权执行镜像预装的 OfficeCLI 统一入口处理 .docx 文件，详细指南由程序按需返回。',
    targets: ['cloud', 'desktop'],
    category: 'office', publisher: 'PowerEvolve',
  },
  {
    directory: 'excel', extensionId: 'builtin.excel', version: '1.0.2', name: 'Excel 表格',
    summary: '创建、读取和修改 Excel 工作簿。',
    description: '使用获授权执行镜像预装的 OfficeCLI 统一入口处理 .xlsx 文件，详细指南由程序按需返回。',
    targets: ['cloud', 'desktop'],
    category: 'office', publisher: 'PowerEvolve',
  },
  {
    directory: 'powerpoint', extensionId: 'builtin.powerpoint', version: '1.0.2', name: 'PowerPoint 演示文稿',
    summary: '创建、读取和修改 PowerPoint 演示文稿。',
    description: '使用获授权执行镜像预装的 OfficeCLI 统一入口处理 .pptx 文件，详细指南由程序按需返回。',
    targets: ['cloud', 'desktop'],
    category: 'office', publisher: 'PowerEvolve',
  },
  {
    directory: 'pdf', extensionId: 'builtin.pdf', version: '1.0.0', name: 'PDF',
    summary: '读取、生成并渲染检查 PDF 文件。',
    description: '固定版本的 OpenAI 公开 PDF 技能，配合沙盒内 Poppler 和 Python PDF 工具链使用。',
    category: 'office', publisher: 'OpenAI',
  },
  {
    directory: 'latex-report-writer', extensionId: 'builtin.latex-report-writer', version: '1.0.5',
    name: 'LaTeX 技术报告',
    summary: '使用 XeLaTeX 编写、校验并渲染中文电力技术报告。',
    description: '包含中国电力技术报告 LaTeX 类、版式规范、转换脚本、编译脚本和逐页渲染工具。',
    category: 'writing-office', publisher: 'PowerEvolve',
  },
  {
    directory: 'power-grid-technical-report-writer',
    extensionId: 'builtin.power-grid-technical-report-writer', version: '1.1.41',
    name: '电网技术报告写作',
    summary: '渐进式编写电网科技项目结题技术报告。',
    description: '提供项目档案、论证架构、目录、分章正文、摘要证据包和全文组装规则及确定性校验脚本。',
    targets: ['cloud', 'desktop'],
    category: 'writing-office', publisher: 'PowerEvolve',
  },
  {
    directory: 'report-reviewer', extensionId: 'builtin.report-reviewer', version: '1.1.1',
    name: '技术报告审核',
    summary: '审核技术报告目录、章节和全文。',
    description: '检查任务完成度、内容完整性、逻辑结构、证据引用、术语一致性和中文长文表达，并输出结构化审核结论。',
    targets: ['cloud', 'desktop'],
    category: 'writing-office', publisher: 'PowerEvolve',
  },
  {
    directory: 'report-workflow-orchestrator',
    extensionId: 'builtin.report-workflow-orchestrator', version: '1.1.30',
    name: '技术报告工作流',
    summary: '编排技术报告写作、审核、排版和逐页验收。',
    description: '通过文件化状态机连接电网报告生成、结构化审核、Word 排版、格式修复与视觉验收。',
    targets: ['cloud', 'desktop'],
    category: 'writing-office', publisher: 'PowerEvolve',
  },
  {
    directory: 'tech-report-writer', extensionId: 'builtin.tech-report-writer', version: '1.1.45',
    name: '技术报告 Word 排版',
    summary: '生成、重排和校验中国电科院技术报告 Word 文件。',
    description: '包含 Word 模板、结构化数据校验、DOCX 生成、格式修复、目录域处理、PDF 转换与逐页视觉验收脚本。',
    targets: ['cloud', 'desktop'],
    category: 'writing-office', publisher: 'PowerEvolve',
  },
]

await rm(outputRoot, { recursive: true, force: true })
const items = []
for (const definition of definitions) {
  const { version } = definition
  const targets = definition.targets ?? ['cloud']
  const entries = await sourceEntries(join(root, definition.directory))
  const artifact = Buffer.from(zipSync(entries, { level: 9, mtime: '2020-01-01T00:00:00.000Z' }))
  const artifactDigest = sha256(artifact)
  const artifactPath = `extensions/${definition.extensionId}/${version}.zip`
  const downloadPath = `/api/v1/catalog/extensions/${definition.extensionId}/releases/${version}/artifact`
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    extensionId: definition.extensionId,
    version,
    targets,
    componentKinds: ['skill'],
    artifact: { sha256: artifactDigest, size: artifact.length },
  })}\n`)
  const release = {
    version,
    state: 'PUBLISHED',
    manifestDigest: `sha256:${sha256(manifest)}`,
    targets,
    componentKinds: ['skill'],
    permissions: [],
    artifactDigest,
    artifactSize: artifact.length,
    artifactDownloadUrl: downloadPath,
    artifactPath,
  }
  const extension = {
    id: definition.extensionId,
    name: definition.name,
    summary: definition.summary,
    description: definition.description,
    category: definition.category,
    publisher: definition.publisher,
  }
  await mkdir(join(outputRoot, dirname(artifactPath)), { recursive: true })
  await writeFile(join(outputRoot, artifactPath), artifact)
  await writeFile(join(outputRoot, `extensions/${definition.extensionId}/${version}.manifest.json`), manifest)
  items.push({ extension, release })
}

await mkdir(outputRoot, { recursive: true })
await writeFile(join(outputRoot, 'catalog.json'), `${JSON.stringify({ schemaVersion: 1, items }, null, 2)}\n`)

async function sourceEntries(directory) {
  const files = await walk(directory)
  if (!files.includes('SKILL.md')) throw new Error(`${directory} has no SKILL.md`)
  return Object.fromEntries(await Promise.all(files.map(async path => [
    path,
    new Uint8Array(await readFile(join(directory, path))),
  ])))
}

async function walk(rootDirectory, current = rootDirectory) {
  const paths = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name)
    if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) {
      throw new Error(`unsupported built-in Skill entry: ${absolute}`)
    }
    if (entry.isDirectory()) paths.push(...await walk(rootDirectory, absolute))
    else {
      const path = relative(rootDirectory, absolute).split(sep).join('/')
      if (path.startsWith('../') || path.includes('/../')) throw new Error(`unsafe built-in Skill path: ${path}`)
      paths.push(path)
    }
  }
  return paths.sort((left, right) => left.localeCompare(right))
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
