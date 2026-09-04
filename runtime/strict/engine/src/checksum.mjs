import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function canonicalize(value, ancestors = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Value must contain only JSON values");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("Value must contain only JSON values");
  if (ancestors.has(value)) throw new TypeError("Value must contain only JSON values");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== "string" || !descriptor.enumerable || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) {
          throw new TypeError("Value must contain only JSON values");
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError("Value must contain only JSON values");
      }
      return `[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key).enumerable)) {
      throw new TypeError("Value must contain only JSON values");
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value) {
  return canonicalize(value);
}

export function sha256Value(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
