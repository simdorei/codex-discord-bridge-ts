import type { DatabaseSync } from "node:sqlite";
import { windowsNativePathToStringLossy } from "../core/windows-native-path.ts";
import { serializeSerdeValue } from "../core/serde-json.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";

function isScalarString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  for (const char of value) {
    const cp = char.codePointAt(0);
    if (cp !== undefined && cp >= 0xd800 && cp <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const SEED_IN_SQL =
  "UPDATE discord_ingress_journal SET outcome_json=json_set(outcome_json,'$.new_reply_seed',json(?))\n" +
  "         WHERE ingress_id=? AND owner_kind='prompt' AND owner_id=?\n" +
  "         AND json_extract(outcome_json,'$.new_creation.version')=1\n" +
  "         AND json_type(outcome_json,'$.new_reply_seed') IS NULL";

export function seedIn(
  connection: DatabaseSync,
  ingress: string,
  job: string,
  stateDb: unknown,
  acknowledgement: string
): void {
  const stateDbLossy = windowsNativePathToStringLossy(stateDb);

  if (!isScalarString(acknowledgement)) {
    throw new TypeError("Expected acknowledgement to be a valid Unicode scalar string");
  }

  const seedJson = serializeSerdeValue({
    state_db: stateDbLossy,
    acknowledgement,
  });

  if (!isScalarString(ingress)) {
    throw new TypeError("Expected ingress to be a valid Unicode scalar string");
  }

  if (!isScalarString(job)) {
    throw new TypeError("Expected job to be a valid Unicode scalar string");
  }

  const statement = connection.prepare(SEED_IN_SQL);
  const result = statement.run(seedJson, ingress, job);

  if (result.changes !== 1 && result.changes !== 1n) {
    throw new StoreIntegrityError(
      "new acknowledgement seed has no unique original owner"
    );
  }
}
