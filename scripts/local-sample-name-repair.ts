import { personDisplayName } from "../src/data/person-name";
import {
  developmentStateOrganizerId,
  developmentStateProvider,
  manualAccountPresets,
} from "../src/dev/accounts";
import { manualProfileFixture } from "./manual-profile-fixtures";
import { sampleProfileFixtures } from "./sample-profile-fixtures";

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Name-only upgrade for known local seeds, not a migration or account reset. */
export function localSampleNameRepair() {
  const samples = sampleProfileFixtures("local", 0);
  const manual = manualAccountPresets
    .filter(({ draft }) => !draft)
    .map((preset) => manualProfileFixture(preset, 0));
  // Historical manual identities used the shared sample names, not the v2 names.
  const legacy = [
    ["applied", "casey"],
    ["awaiting-review", "casey"],
    ["accepted", "alex"],
    ["orientation-booked", "alex"],
    ["orientation-completed", "alex"],
    ["medic-orientee", "dana"],
    ["medic-new-volunteer", "dana"],
    ["patrol", "alex"],
    ["medic", "dana"],
    ["inactive", "jamie"],
    ["organizer", "robin"],
  ].map(([key, sampleKey]) => ({
    ...samples.find((sample) => sample.key === sampleKey)!,
    id: `local-account-user-${key}`,
    email: `${key}.local@example.org`,
  }));
  const identities = [...manual, ...legacy, ...samples].map((person) => ({
    person,
    identity: `u.id=${quote(person.id)} AND u.email=${quote(person.email)}`,
  }));
  // A reserved-looking ID/email alone never proves a sandbox is synthetic.
  const sandbox = `u.email=u.id||'@example.invalid'
    AND (u.id=${quote(developmentStateOrganizerId)} OR
      (length(u.id)=48 AND substr(u.id,1,12)='local-state-' AND substr(u.id,13) NOT GLOB '*[^0-9a-f-]*'))
    AND EXISTS(SELECT 1 FROM account a WHERE a.user_id=u.id
      AND a.id='state-marker:'||u.id AND a.account_id=u.id
      AND a.provider_id=${quote(developmentStateProvider)})`;
  identities.push(
    ...[...manual, ...samples].map((person) => ({ person, identity: sandbox })),
  );

  const inventory: string[] = [];
  const statements: string[] = [];
  for (const { person, identity } of identities) {
    const a = person.answers;
    const name = quote(personDisplayName(a));
    // Match original fixture name fields in BOTH current data and the immutable
    // submission. Other edits/activity need not be undone to fix this one field.
    const candidates = `SELECT u.id FROM user u JOIN profile p ON p.user_id=u.id
      WHERE ${identity} AND u.deleted_at IS NULL
      AND p.first_name=${quote(a.firstName)} AND p.last_name=${quote(a.lastName)}
      AND p.preferred_name=${quote(person.name)}
      AND CASE WHEN json_valid(p.submitted_application) THEN
        json_extract(p.submitted_application,'$.email')=u.email
        AND json_extract(p.submitted_application,'$.answers.firstName')=p.first_name
        AND json_extract(p.submitted_application,'$.answers.lastName')=p.last_name
        AND json_extract(p.submitted_application,'$.answers.preferredName')=${quote(person.name)}
        ELSE 0 END
      AND (p.preferred_name<>p.first_name OR u.name<>${name})`;
    inventory.push(`SELECT u.id,p.first_name,p.last_name,p.preferred_name,u.name,
      ${name} AS repaired_name FROM user u JOIN profile p ON p.user_id=u.id
      WHERE u.id IN (${candidates})`);
    // Synchronize the presentation name first, while the old preferred value
    // still identifies the seed. Do not touch timestamps, drafts or snapshots.
    statements.push(
      `UPDATE user SET name=${name} WHERE id IN (${candidates}) AND name<>${name}`,
      `UPDATE profile SET preferred_name=first_name
        WHERE user_id IN (${candidates}) AND preferred_name<>first_name`,
    );
  }
  return { inventory, statements };
}
