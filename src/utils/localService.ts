import { promises as fs } from "fs";
import * as path from "path";
import { USE_LOCAL_MOCK } from "../config/localConfig";

type JSONObject = Record<string, any>;

export async function readJSON<T = any>(filePath: string): Promise<T> {
  const resolvedPath = path.resolve(filePath);
  const content = await fs.readFile(resolvedPath, "utf8");
  return JSON.parse(content) as T;
}

export async function writeJSON(filePath: string, data: any): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  const serialized = JSON.stringify(data, null, 2);
  await fs.writeFile(resolvedPath, serialized, "utf8");
}

function applyWhereFilter(rows: JSONObject[], where?: JSONObject): JSONObject[] {
  if (!where || Object.keys(where).length === 0) return rows;
  return rows.filter((row) => {
    for (const [key, expected] of Object.entries(where)) {
      if ((row as any)[key] !== expected) return false;
    }
    return true;
  });
}

function aggregateRows(
  rows: JSONObject[],
  groupBy?: string | string[],
  sumBy?: string
): JSONObject[] {
  if (!groupBy) return rows;
  const groupKeys = Array.isArray(groupBy) ? groupBy : [groupBy];
  const map = new Map<string, { key: JSONObject; rows: JSONObject[]; sum?: number }>();

  for (const row of rows) {
    const keyObj: JSONObject = {};
    for (const k of groupKeys) keyObj[k] = (row as any)[k];
    const keyStr = JSON.stringify(keyObj);
    const entry = map.get(keyStr) || { key: keyObj, rows: [], sum: 0 };
    entry.rows.push(row);
    if (sumBy && typeof (row as any)[sumBy] === "number") {
      entry.sum = (entry.sum || 0) + (row as any)[sumBy];
    }
    map.set(keyStr, entry);
  }

  const result: JSONObject[] = [];
  for (const { key, rows: groupedRows, sum } of map.values()) {
    const out: JSONObject = { ...key, rows: groupedRows };
    if (sumBy) out[`sum_${sumBy}`] = sum ?? 0;
    result.push(out);
  }
  return result;
}

async function readFromPathOrDir(dataPath: string): Promise<JSONObject[]> {
  const resolved = path.resolve(dataPath);
  const stat = await fs.stat(resolved).catch(() => undefined);
  if (!stat) throw new Error(`Path not found: ${resolved}`);
  if (stat.isDirectory()) {
    const files = await fs.readdir(resolved);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    const all: JSONObject[] = [];
    for (const file of jsonFiles) {
      const rows = await readJSON<JSONObject[]>(path.join(resolved, file));
      if (Array.isArray(rows)) all.push(...rows);
    }
    return all;
  }
  const data = await readJSON<any>(resolved);
  return Array.isArray(data) ? data : [data];
}

export async function queryAthenaMock(
  viewNameOrPath: string,
  params?: {
    pathOverride?: string;
    where?: JSONObject;
    groupBy?: string | string[];
    sumBy?: string;
  }
): Promise<any[]> {
  const dataPath = params?.pathOverride || viewNameOrPath;
  const rows = await readFromPathOrDir(dataPath);
  const filtered = applyWhereFilter(rows, params?.where);
  const aggregated = aggregateRows(filtered, params?.groupBy, params?.sumBy);
  return aggregated;
}

export async function putS3Mock(
  bucket: string,
  key: string,
  content: string | Buffer | JSONObject | JSONObject[]
): Promise<{ bucket: string; key: string; bytes: number }> {
  const baseDir = path.resolve("mock-data", bucket);
  const fullPath = path.join(baseDir, key);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  let payload: string | Buffer;
  if (Buffer.isBuffer(content)) payload = content;
  else if (typeof content === "string") payload = content;
  else payload = JSON.stringify(content, null, 2);
  await fs.writeFile(fullPath, payload);
  return {
    bucket,
    key,
    bytes: Buffer.isBuffer(payload)
      ? payload.length
      : Buffer.byteLength(payload),
  };
}

export async function invokeLambdaMock<TPayload = any, TResult = any>(
  lambdaName: string,
  payload: TPayload
): Promise<TResult> {
  const candidates = [
    // local dev outputs
    path.resolve("lambdas", lambdaName, "dist", "index.js"),
    path.resolve("lambdas", lambdaName, "src", "index.ts"),
    path.resolve("dist", "lambdas", lambdaName, "src", "index.js"),
  ];

  let mod: any | undefined;
  let usedPath: string | undefined;
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require(candidate);
      usedPath = candidate;
      break;
    } catch {}
  }

  if (!mod) {
    throw new Error(
      `Lambda module not found for "${lambdaName}". Looked in: ${candidates.join(", ")}`
    );
  }

  const handler: any = mod.handler || mod.default || mod.main;
  if (typeof handler !== "function") {
    throw new Error(`No callable handler exported by ${usedPath}`);
  }

  const result = await handler(payload);
  return result as TResult;
}

export async function safeAwsImport(moduleName: string): Promise<any> {
  if (USE_LOCAL_MOCK) return {};
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return await import(moduleName);
}
