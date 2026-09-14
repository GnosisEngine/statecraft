/**
 * Event Bus: the shared event vocabulary.
 *
 * GameEvent is the one closed union the whole engine emits through. It
 * started as entity-mutation events only; Layer 3 (Modifier) is the first
 * layer above Layer 2 to contribute its own variants, and later layers
 * (Action, Rule, Phase) will do the same. Keeping it one closed union
 * (rather than one open/extensible type per layer) is deliberate: it's
 * what lets EventBus.on/emit stay fully type-checked, and it's the same
 * exhaustiveness-checking style as Query's op union (see the ALL_QUERY_OPS
 * meta-test) — add a variant here, TypeScript will point at every switch
 * that needs a matching case.
 */

import type { Entity, EntityKind, OwnershipStack } from "../core/entity.ts";
import type { EntityId } from "../core/id.ts";
import type { Modifier } from "../properties/modifier.ts";
import type { PerformerCapability } from "../actions/action-definition.ts";

export type GameEvent =
  | { type: "entity:created"; entity: Entity }
  | { type: "entity:removed"; entityId: EntityId; kind: EntityKind }
  | { type: "entity:tagAdded"; entityId: EntityId; tag: string }
  | { type: "entity:tagRemoved"; entityId: EntityId; tag: string }
  | { type: "entity:propertyChanged"; entityId: EntityId; prop: string; oldValue: number; newValue: number }
  | { type: "entity:zoneChanged"; entityId: EntityId; oldZoneId: EntityId | null; newZoneId: EntityId | null }
  | { type: "entity:ownershipChanged"; entityId: EntityId; ownership: OwnershipStack }
  | { type: "hierarchy:parentChanged"; hierarchy: string; childId: EntityId; parentId: EntityId | null | undefined; siblingIndex?: number }
  | { type: "stack:pushed"; stack: string; itemId: EntityId; parentId: EntityId | null }
  | { type: "stack:resolved"; stack: string; itemId: EntityId }
  | { type: "stack:countered"; stack: string; itemId: EntityId }
  | { type: "stack:reparented"; stack: string; itemId: EntityId; oldParentId: EntityId | null; newParentId: EntityId | null }
  | { type: "stack:exposedAfterResolution"; stack: string; itemId: EntityId }
  | { type: "stack:exposedAfterCounter"; stack: string; itemId: EntityId }
  | { type: "stack:exposedAfterReparent"; stack: string; itemId: EntityId }
  | { type: "modifier:added"; modifier: Modifier }
  | { type: "modifier:removed"; modifier: Modifier }
  | { type: "action:proposed"; actionId: string; performerId: EntityId; actingFixerId: EntityId; targetIds: EntityId[] }
  | { type: "action:rejected"; actionId: string; performerId: EntityId; actingFixerId: EntityId; reason: string }
  | {
      type: "action:resolved";
      actionId: string;
      performerId: EntityId;
      actingFixerId: EntityId;
      targetIds: EntityId[];
      capability: PerformerCapability;
      adjustedCost: number;
    }
  | { type: "action:fizzled"; actionId: string; performerId: EntityId; actingFixerId: EntityId; targetIds: EntityId[]; reason: string }
  | { type: "phase:started"; phaseId: string; subjectId: EntityId }
  | { type: "phase:ended"; phaseId: string; subjectId: EntityId }
  | { type: "phase:gateChanged"; phaseId: string; subjectId: EntityId; satisfied: boolean };

export type GameEventType = GameEvent["type"];
