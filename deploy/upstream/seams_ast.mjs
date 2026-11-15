/** Read TypeScript imports, inheritance and Loader registrations without executing plugins. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ownPath = /^(?:packages\/(?:cloud|community)\/|integrations\/epri-research\/|deploy\/)/u
const nativeModule = name => /^@deepseek-ai\/(?:cordis(?:-|$)|dsh-)/u.test(name)
  && !/^@deepseek-ai\/dsh-(?:pe-|remote-server(?:\/|$))/u.test(name)
const input = JSON.parse(readFileSync(0, 'utf8'))
const output = { imports: [], inheritance: [], mounts: [] }

for (const file of input.files) {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true,
    file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const aliases = new Map()
  const lineOf = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const moduleIsNative = name => nativeModule(name) || (name.startsWith('.')
    && !ownPath.test(path.posix.normalize(path.posix.join(path.posix.dirname(file.path), name))))
  const recordMount = (key, value, node) => {
    const modules = new Set()
    const references = child => {
      if (ts.isIdentifier(child) && aliases.has(child.text)) modules.add(aliases.get(child.text))
      ts.forEachChild(child, references)
    }
    references(value)
    output.mounts.push({ path: file.path, line: lineOf(node), entry: key,
      modules: [...modules].sort(), expression: value.getText(source).replace(/\s+/gu, ' ').slice(0, 240) })
  }
  const visit = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text
      if (moduleIsNative(module)) {
        const names = []
        const clause = node.importClause
        if (clause?.name) { names.push(`default as ${clause.name.text}`); aliases.set(clause.name.text, module) }
        if (clause?.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            names.push(`* as ${clause.namedBindings.name.text}`)
            aliases.set(clause.namedBindings.name.text, module)
          } else for (const name of clause.namedBindings.elements) {
            names.push(name.propertyName ? `${name.propertyName.text} as ${name.name.text}` : name.name.text)
            aliases.set(name.name.text, module)
          }
        }
        output.imports.push({ path: file.path, line: lineOf(node), module,
          names: names.length ? names : ['(augmentation)'], typeOnly: clause?.isTypeOnly === true })
      }
    }
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.heritageClauses) {
      for (const clause of node.heritageClauses) if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
        for (const parent of clause.types) {
          const base = parent.expression.getText(source), imported = aliases.get(base.split('.')[0])
          if (!imported) continue
          const methods = node.members.filter(ts.isMethodDeclaration).map(member => member.name.getText(source))
          const overrides = node.members.filter(ts.isMethodDeclaration)
            .filter(member => member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.OverrideKeyword))
            .map(member => member.name.getText(source))
          output.inheritance.push({ path: file.path, line: lineOf(node), name: node.name?.text ?? '(anonymous)',
            base, module: imported, methods, overrides })
        }
      }
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'Object.assign'
      && /(?:\.builtins|^builtins)$/u.test(node.arguments[0]?.getText(source) ?? '')) {
      for (const argument of node.arguments.slice(1)) if (ts.isObjectLiteralExpression(argument)) {
        for (const property of argument.properties) if (ts.isPropertyAssignment(property)) {
          recordMount(property.name.getText(source), property.initializer, property)
        }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && /\.builtins(?:\[|\.)/u.test(node.left.getText(source))) {
      recordMount(node.left.getText(source), node.right, node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
process.stdout.write(JSON.stringify(output))
