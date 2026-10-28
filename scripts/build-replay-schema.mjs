// Generate the import validator from the same types consumed by physics/rendering.
// Run after changing GameState, then commit the generated schema with the change.
import ts from 'typescript';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { format } from 'prettier';
const declarations = new Map();
for (const name of ['core/types.ts', 'core/environment-types.ts', 'core/math.ts']) {
  const path = resolve('src', name);
  const file = ts.createSourceFile(
    path,
    await readFile(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of file.statements)
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
      declarations.set(statement.name.text, statement);
}
const definitions = {};
const config = ts.createSourceFile(
  'config.ts',
  await readFile('src/core/config.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
let powers;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(config) === 'POWERUPS') {
    let init = node.initializer;
    while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
    powers = init.properties.map((p) => p.name.text);
  }
  ts.forEachChild(node, visit);
}
visit(config);
function object(members) {
  const fields = {},
    optional = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member)) throw new Error('Unsupported schema member');
    const key = member.name.text;
    fields[key] = schema(member.type);
    if (member.questionToken) optional.push(key);
  }
  return { fields, optional };
}
function reference(name) {
  if (!Object.hasOwn(definitions, name)) {
    definitions[name] = null;
    if (name === 'PowerupKind') definitions[name] = { enum: powers };
    else {
      const decl = declarations.get(name);
      if (!decl) throw new Error(`Unknown type ${name}`);
      definitions[name] = ts.isInterfaceDeclaration(decl)
        ? object(decl.members)
        : schema(decl.type);
    }
  }
  return { ref: name };
}
function schema(node) {
  if (
    [
      ts.SyntaxKind.StringKeyword,
      ts.SyntaxKind.NumberKeyword,
      ts.SyntaxKind.BooleanKeyword,
    ].includes(node.kind)
  )
    return { type: ts.tokenToString(node.kind) };
  if (ts.isLiteralTypeNode(node)) {
    if (node.literal.kind === ts.SyntaxKind.NullKeyword) return { enum: [null] };
    if (ts.isStringLiteral(node.literal)) return { enum: [node.literal.text] };
  }
  if (ts.isUnionTypeNode(node)) return { any: node.types.map(schema) };
  if (ts.isArrayTypeNode(node)) return { array: schema(node.elementType) };
  if (ts.isTypeLiteralNode(node)) return object(node.members);
  if (ts.isIndexedAccessTypeNode(node)) {
    const decl = declarations.get(node.objectType.typeName.text);
    return schema(
      decl.members.find((member) => member.name.text === node.indexType.literal.text).type,
    );
  }
  if (ts.isTypeReferenceNode(node)) {
    if (node.typeName.text === 'Record') return { record: schema(node.typeArguments[1]) };
    return reference(node.typeName.text);
  }
  if (ts.isTemplateLiteralTypeNode(node) && node.head.text === 'original-')
    return { prefix: 'original-' };
  throw new Error(`Unsupported schema type ${ts.SyntaxKind[node.kind]}`);
}
reference('GameState');
const output = await format(JSON.stringify({ root: 'GameState', definitions }), {
  parser: 'json',
  printWidth: 100,
});
const path = 'src/sdk/replay-schema.json';
if (process.argv.includes('--check')) {
  if ((await readFile(path, 'utf8')).replaceAll('\r\n', '\n') !== output)
    throw new Error('Replay schema is stale: node scripts/build-replay-schema.mjs');
} else await writeFile(path, output);
