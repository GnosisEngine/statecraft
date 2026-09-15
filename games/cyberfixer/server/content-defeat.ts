/**
 * games/cyberfixer/server/content-defeat.ts
 *
 * The first section extracted out of content.ts's own buildContent()
 * using the BuildContext pattern — a small, self-contained proof that
 * the shape works before larger, more interdependent sections
 * (contracts, the Reflex/Countermeasure section) get the same
 * treatment. Only `ruleTable`/`ruleHandlers` are actually used here;
 * the function's own signature destructures just those two, not the
 * full BuildContext shape, so a reader can tell what this section
 * touches without reading its body first.
 */

import { registerRule } from "../../../src/rules/register-rule.ts";
import { propertyCompare, type BuildContext } from "./content-shared.ts";

export function registerDefeat({ ruleTable, ruleHandlers }: Pick<BuildContext, "ruleTable" | "ruleHandlers">): void {
  registerRule(
    ruleTable,
    ruleHandlers,
    {
      id: "check-defeat",
      trigger: "entity:propertyChanged",
      match: (event) => event.prop === "inflow",
      subject: (event) => event.entityId,
      condition: propertyCompare("inflow", "lte", 0),
    },
    (event, api) => {
      api.entities.addTag(event.entityId, "defeated");
    },
  );
}
