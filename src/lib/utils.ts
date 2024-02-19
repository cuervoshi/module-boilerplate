import debug from 'debug';
import { RequestHandler, Router } from 'express';
import { globSync, Path as gPath } from 'glob';
import NDK, { NostrEvent } from '@nostr-dev-kit/ndk';
import { v4 as uuidv4 } from 'uuid';

import Path from 'path';
import { DefaultContext } from '@type/request';
export const logger: debug.Debugger = debug(process.env['MODULE_NAME'] || '');
import LastHandledTracker from '@lib/lastHandled';
import { SubHandling } from '@type/nostr';

type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export const uuidRegex: RegExp =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const log: debug.Debugger = logger.extend('lib:utils');
const warn: debug.Debugger = logger.extend('lib:utils:warn');
const CREATED_AT_TOLERANCE: number = 2 * 180;
const sAlpha: string =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const sAlphaLength: bigint = BigInt(sAlpha.length);
let lastHandledTracker: LastHandledTracker | undefined;

export class EmptyRoutesError extends Error {}
export class DuplicateRoutesError extends Error {}

const methods: RouteMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

function getPathsByExtensions(path: string, extensions: string[]): gPath[] {
  const extensionsSet = new Set(extensions.map((e) => `.${e.toLowerCase()}`));

  return globSync('*', {
    withFileTypes: true,
    cwd: path,
    matchBase: true,
    nocase: true,
    nodir: true,
  }).filter((p) => {
    return extensionsSet.has(Path.extname(p.name).toLowerCase());
  });
}

function relativeReplacingInDirs(path: gPath, reg: RegExp, s: string): string {
  const parts = path.relative().split('/');
  let relative = '';
  for (const part of parts) {
    relative += `${part.replace(reg, s)}/`;
  }
  return relative;
}

function findDuplicates(values: gPath[]): string[] {
  const counter: { [key: string]: number } = {};
  const duplicates: string[] = [];

  values.forEach((value) => {
    counter[value.relative()] = (counter[value.relative()] ?? 0) + 1;
  });
  for (const [key, count] of Object.entries(counter)) {
    if (1 < count) {
      duplicates.push(key);
    }
  }

  return duplicates;
}

export async function setUpRoutes(
  router: Router,
  rootPath: string,
): Promise<Router> {
  const paths: gPath[] = getPathsByExtensions(rootPath, [
    'cjs',
    'mjs',
    'js',
    'ts',
  ]);
  const duplicates = findDuplicates(paths);

  if (0 === paths.length) {
    throw new EmptyRoutesError();
  }

  if (duplicates.length) {
    throw new DuplicateRoutesError(
      `Duplicate routes: ${duplicates.toString()}`,
    );
  }

  const allowedMethodsByRoute: Record<string, RouteMethod[]> = {};

  for (const path of paths) {
    const modulePath = path.relative();
    const routePath = relativeReplacingInDirs(path, /^_/, ':');
    const matches = routePath.match(
      /^(?<route>.*)\/(?<method>get|post|put|patch|delete)(?<ext>\..*)$/i,
    );

    if (matches?.groups) {
      const method: RouteMethod = matches.groups['method'] as RouteMethod;
      const route: string = `/${matches.groups['route']}`;
      const handler = (
        (await import(Path.resolve(rootPath, modulePath))) as {
          default: RequestHandler;
        }
      ).default;
      router[method](route, handler);
      log(`Created ${method.toUpperCase()} route for ${route}`);
      if (undefined === allowedMethodsByRoute[route]) {
        allowedMethodsByRoute[route] = [];
      }
      allowedMethodsByRoute[route]!.push(method);
    } else {
      warn(
        `Skipping ${modulePath} as it doesn't comply to routes conventions.`,
      );
    }
  }
  log('Allowed methods %O', allowedMethodsByRoute);
  for (const [route, allowedMethods] of Object.entries(allowedMethodsByRoute)) {
    methods
      .filter((m) => !allowedMethods.includes(m))
      .forEach((m) => {
        router[m](route, (_req, res) => {
          res
            .status(405)
            .header('Allow', `OPTIONS, ${allowedMethods.toString()}`)
            .send();
        });
        log(`Created ${m.toUpperCase()} route for ${route}`);
      });
  }

  return router;
}

export async function setUpSubscriptions<
  Context extends DefaultContext = DefaultContext,
>(
  ctx: Context,
  readNdk: NDK,
  writeNDK: NDK,
  path: string,
): Promise<NDK | null> {
  const paths: gPath[] = getPathsByExtensions(path, ['cjs', 'mjs', 'js', 'ts']);
  const duplicates = findDuplicates(paths);

  if (duplicates.length) {
    duplicates.forEach((duplicate) => {
      warn(`Found duplicate subscription ${duplicate}`);
    });
    return null;
  }
  const allFiles: string[] = paths.map((p) => p.relative());

  if (!lastHandledTracker && 0 < paths.length) {
    lastHandledTracker = new LastHandledTracker(writeNDK, allFiles);
    await lastHandledTracker.fetchLastHandled();
  }

  for (const file of allFiles) {
    const matches = file.match(/^(?<name>[^/]*)$/i);
    const lastHandled: number = lastHandledTracker!.get(file);

    if (matches?.groups) {
      const { filter, getHandler } = (await import(
        Path.resolve(path, file)
      )) as SubHandling<Context>;
      if (lastHandled) {
        filter.since = lastHandled - CREATED_AT_TOLERANCE;
      } else {
        delete filter.since;
      }
      readNdk
        .subscribe(filter, {
          closeOnEose: false,
        })
        .on('event', async (nostrEvent: NostrEvent): Promise<void> => {
          try {
            const handler: (nostrEvent: NostrEvent) => Promise<void> =
              getHandler(ctx, 0);
            await handler(nostrEvent);
            lastHandledTracker!.hit(file, nostrEvent.created_at);
          } catch (e) {
            warn(
              `Unexpected exception found when handling ${matches.groups?.['name']}: %O`,
              e,
            );
          }
        });

      log(`Created ${matches.groups['name']} subscription`);
    } else {
      warn(
        `Skipping ${file} as it doesn't comply to subscription conventions.`,
      );
    }
  }

  return readNdk;
}

export function requiredEnvVar(key: string): string {
  const envVar = process.env[key];
  if (undefined === envVar) {
    throw new Error(`Environment process ${key} must be defined`);
  }
  return envVar;
}

export function requiredProp<T extends object, V>(obj: T, key: keyof T): V {
  if (!Object.hasOwn(obj, key)) {
    throw new Error(
      `Expected ${String(key)} of ${JSON.stringify(obj)} to be defined`,
    );
  }
  return obj[key] as V;
}

export function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function isEmpty(obj: object): boolean {
  for (const _ in obj) {
    return false;
  }
  return true;
}

export function shuffled<T>(array: Array<T>): Array<T> {
  const result: Array<T> = Array.from(array);
  for (let i = result.length - 1; 0 < i; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export function uuid2suuid(uuid: string): string | null {
  if (!uuid.match(uuidRegex)) {
    return null;
  }

  let n: bigint = uuid
    .replace(/-/g, '')
    .match(/../g)!
    .map((hexPair: string) => BigInt(parseInt(hexPair, 16)))
    .reduce((acc: bigint, curr: bigint) => acc * 256n + curr);
  let suuid: string = '';
  do {
    [suuid, n] = [sAlpha[Number(n % sAlphaLength)] + suuid, n / sAlphaLength];
  } while (n);
  return suuid.padStart(22, sAlpha[0]);
}

export function suuid2uuid(suuid: string): string | null {
  const chars: string[] | null = suuid.match(/./g);
  if (!chars || !chars.every((c) => sAlpha.includes(c))) {
    return null;
  }

  const n: bigint = chars
    .map((char: string) => BigInt(sAlpha.indexOf(char)))
    .reduce((acc: bigint, curr: bigint) => acc * sAlphaLength + curr, 0n);
  if (0xffffffffffffffffffffffffffffffffn < n) {
    return null;
  }
  const uuid: string = n.toString(16).padStart(32, '0');

  return (
    uuid.substring(0, 8) +
    '-' +
    uuid.substring(8, 12) +
    '-' +
    uuid.substring(12, 16) +
    '-' +
    uuid.substring(16, 20) +
    '-' +
    uuid.substring(20, 32)
  );
}

export function generateSuuid(): string {
  return uuid2suuid(uuidv4()) as string;
}

export function jsonParseOrNull<T>(
  text: string,
  reviver?: (this: T, key: string, value: unknown) => T,
): T | null {
  try {
    return JSON.parse(text, reviver) as T;
  } catch (_e) {
    return null;
  }
}

export function jsonStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_, v) => (typeof v === 'bigint' ? String(v) : v) as unknown,
  );
}
