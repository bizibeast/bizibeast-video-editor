import {sha256Value} from "./checksum.mjs";

export function observed(locator, value, expected) {
  const copy = (item) => JSON.parse(JSON.stringify(item ?? null));
  return {locator, observed: copy(value), expected: copy(expected)};
}

export function qcCheck(id, pass, severity, ownerStage, evidence) {
  return {
    id,
    pass: Boolean(pass),
    severity,
    ownerStage,
    findingSignature: sha256Value({id, ownerStage, locator: evidence.map(({locator}) => locator)}),
    evidence,
  };
}
