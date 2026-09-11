import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ERROR_TYPES, type ErrorSlug } from '../../../src/public-api/errors/error-types';
import { Errors, PublicApiError } from '../../../src/public-api/errors/public-api-error';

const CONTROLLERS_ROOT = 'src/public-api';
const ERRORS_OBJECT = 'Errors';
const UNTYPED_FACTORIES = new Set(['fromForeignStatus']);

export function slugByFactoryName(): Map<string, ErrorSlug> {
  const entries = Object.entries(Errors).filter(([name]) => !UNTYPED_FACTORIES.has(name));
  return new Map(
    entries.map(([name, factory]) => {
      const build = factory as (...args: never[]) => PublicApiError;
      return [name, build([] as never, '' as never).slug];
    })
  );
}

function controllerFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return controllerFiles(path);
    return entry.name.endsWith('.controller.ts') ? [path] : [];
  });
}

function factoryNamesIn(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (current: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === ERRORS_OBJECT
    ) {
      names.push(current.name.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

function calleeNamesIn(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) names.add(current.expression.text);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

export function errorsRaisedByHandlers(): Map<string, Set<ErrorSlug>> {
  const slugs = slugByFactoryName();
  const raised = new Map<string, Set<ErrorSlug>>();

  for (const file of controllerFiles(CONTROLLERS_ROOT)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const localFunctions = new Map<string, ts.FunctionDeclaration>();
    source.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node) && node.name) localFunctions.set(node.name.text, node);
    });

    for (const node of source.statements) {
      if (!ts.isClassDeclaration(node) || !node.name) continue;
      const className = node.name.text;
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name) || !member.body) continue;
        const names = factoryNamesIn(member.body);
        for (const callee of calleeNamesIn(member.body)) {
          const local = localFunctions.get(callee);
          if (local?.body) names.push(...factoryNamesIn(local.body));
        }
        const found = new Set(
          names.flatMap((name) => {
            const slug = slugs.get(name);
            return slug ? [slug] : [];
          })
        );
        raised.set(`${className}_${member.name.text}`, found);
      }
    }
  }

  return raised;
}

export function isErrorSlug(value: string): value is ErrorSlug {
  return value in ERROR_TYPES;
}
