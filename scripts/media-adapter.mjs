import {lstat, mkdir, readFile, unlink} from "node:fs/promises";
import path from "node:path";

export async function prepareMediaJob(input, output) {
  const source = path.resolve(input);
  const target = path.resolve(output);
  const sourceStat = await lstat(source).catch(() => null);
  if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) throw new Error("Input must be an existing regular file");
  if (await lstat(target).then(() => true, () => false)) throw new Error("Output must not already exist");
  await mkdir(path.dirname(target), {recursive: true});
  return {source, target};
}

export async function readJsonOutput(output, validate, label) {
  try {
    const outputStat = await lstat(output).catch(() => null);
    if (!outputStat?.isFile() || outputStat.isSymbolicLink() || outputStat.size < 2) throw new Error(`${label} did not create a nonempty regular JSON output`);
    const value = JSON.parse(await readFile(output, "utf8"));
    validate(value);
    return value;
  } catch (error) {
    await unlink(output).catch(() => {});
    if (error instanceof SyntaxError) throw new Error(`${label} output is not valid JSON`);
    throw error;
  }
}
