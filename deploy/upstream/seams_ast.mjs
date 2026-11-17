/** Read TypeScript imports, inheritance and Loader registrations without executing plugins. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ownPath = /^(?:packages\/(?:cloud|community)\/|integrations\/epri-research\/|deploy\/)/u
const nativeModule = name => /^@deepseek-ai\/(?:cordis(?:-|$)|dsh-)/u.test(name)
  && !/^@deepseek-ai\/dsh-(?:pe-|remote-server(?:\/|$))/u.test(name)
const input = JSON.parse(readFileSync(0, 'utf8'))
const output = { imports: [], inheritance: [], mounts: [], unresolvedImports: [] }

for (const file of input.files) {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true,
    file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const aliases = new Map()
  const declarations = new Map()
  const lineOf = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const moduleIsNative = name => nativeModule(name) || (name.startsWith('.')
    && !ownPath.test(path.posix.normalize(path.posix.join(path.posix.dirname(file.path), name))))
  const scopeOf = node => {
    while (node && !ts.isBlock(node) && !ts.isSourceFile(node)) node = node.parent
    return node
  }
  const index = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const list = declarations.get(node.name.text) ?? []
      list.push(node)
      declarations.set(node.name.text, list)
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause, module = node.moduleSpecifier.text
      if (clause?.name) aliases.set(clause.name.text, module)
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) aliases.set(clause.namedBindings.name.text, module)
        else for (const item of clause.namedBindings.elements) aliases.set(item.name.text, module)
      }
    }
    ts.forEachChild(node, index)
  }
  index(source)
  const initializer = node => {
    for (let scope = scopeOf(node); scope; scope = scopeOf(scope.parent)) {
      const found = declarations.get(node.text)?.find(item => scopeOf(item) === scope)
      if (found) return found.initializer
    }
  }
  const recordMount = (key, value, node, unresolved = false) => {
    const modules = new Set()
    const references = child => {
      if (ts.isIdentifier(child) && aliases.has(child.text) && moduleIsNative(aliases.get(child.text))) modules.add(aliases.get(child.text))
      ts.forEachChild(child, references)
    }
    references(value)
    output.mounts.push({ path: file.path, line: lineOf(node), entry: key,
      modules: [...modules].sort(), expression: value.getText(source).replace(/\s+/gu, ' ').slice(0, 240),
      ...(unresolved ? { unresolved: true } : {}) })
  }
  const recordObject = (node, seen = new Set()) => {
    if (!node) return
    if (seen.has(node)) { recordMount('(unresolved registration)', node, node, true); return }
    seen = new Set(seen).add(node)
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      recordObject(node.expression, seen)
    } else if (ts.isIdentifier(node) && initializer(node)) {
      recordObject(initializer(node), seen)
    } else if (ts.isConditionalExpression(node)) {
      recordObject(node.whenTrue, seen)
      recordObject(node.whenFalse, seen)
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) recordMount(property.name.getText(source), property.initializer, property)
        else if (ts.isShorthandPropertyAssignment(property)) recordMount(property.name.text, property.name, property)
        else if (ts.isSpreadAssignment(property)) recordObject(property.expression, seen)
      }
    } else recordMount('(unresolved registration)', node, node, true)
  }
  const recordImport = (node, module, names, typeOnly, kind) => {
    if (moduleIsNative(module)) output.imports.push({ path: file.path, line: lineOf(node), module, names, typeOnly, kind })
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
        const elements = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : []
        const typeNames = elements.filter(item => item.isTypeOnly).map(item => item.getText(source).replace(/^type /u, ''))
        const values = names.filter(name => !typeNames.includes(name))
        if (values.length || !names.length) recordImport(node, module, values.length ? values : ['(augmentation)'], clause?.isTypeOnly === true, 'import')
        if (typeNames.length) recordImport(node, module, typeNames, true, 'import')
      }
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      recordImport(node, node.argument.literal.text, [node.qualifier?.getText(source) ?? '*'], true, 'import-type')
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      recordImport(node, node.arguments[0].text, ['*'], false, 'dynamic-import')
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && !ts.isStringLiteralLike(node.arguments[0])) {
      output.unresolvedImports.push({ path: file.path, line: lineOf(node), expression: node.arguments[0].getText(source) })
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const item of node.exportClause.elements) recordImport(node, node.moduleSpecifier.text,
          [item.getText(source).replace(/^type /u, '')], node.isTypeOnly || item.isTypeOnly, 'export-from')
      } else recordImport(node, node.moduleSpecifier.text, [node.exportClause?.getText(source) ?? '*'], node.isTypeOnly, 'export-from')
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      recordImport(node, node.moduleReference.expression.text, [node.name.text], node.isTypeOnly, 'import-equals')
    }
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.heritageClauses) {
      for (const clause of node.heritageClauses) if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
        for (const parent of clause.types) {
          const base = parent.expression.getText(source), imported = aliases.get(base.split('.')[0])
          if (!imported || !moduleIsNative(imported)) continue
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
      for (const argument of node.arguments.slice(1)) recordObject(argument)
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'nativeInstallBuiltins') {
      recordObject(node.arguments[1])
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
