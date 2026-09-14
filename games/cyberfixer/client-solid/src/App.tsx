/**
 * client-solid/src/App.tsx
 *
 * Deliberately NOT full feature parity with the hand-rolled
 * games/cyberfixer/client/main.js yet — no deploy/hand UI, no chat. The
 * point of this pass is proving the SDK (connection, ClientWorld,
 * typed actions, the Solid reactive bridge) actually works end to end
 * against the real server, with a real playable slice: draft, ready
 * through the lobby, watch the board update reactively, shakedown, end
 * turn. Deploy/hand/chat are a straightforward next increment — the SDK
 * primitives they'd need (sendAction, useWorld, onChat) already exist.
 */

import { createSignal, For, Show } from "solid-js";
import { connectToCyberFixer, findMySeatId } from "./sdk/connection.ts";
import { ClientWorld } from "./sdk/entity-view.ts";
import { onActionResult, onChat, onPhaseResult, sendAction, sendChat, sendPhaseAdvance } from "./sdk/actions.ts";
import { useWorld } from "./solid/use-world.ts";
import { boardZoneIdFor, deckZoneIdFor, discardZoneIdFor, handZoneIdFor, CONTRACTOR_TAG } from "../../server/content.ts";
import type { Entity } from "../../../../src/core/entity.ts";
import type { Room } from "@colyseus/sdk";
import type { CyberFixerRoomState } from "./sdk/connection.ts";
import type { ChatMessage } from "../../../../src/network/table-room.ts";

type CardEntity = Entity & { name: string };

function isCard(e: Entity): e is CardEntity {
  return e.kind === "card";
}

export function App() {
  const [room, setRoom] = createSignal<Room<CyberFixerRoomState> | null>(null);
  const [mySeatId, setMySeatId] = createSignal<string | null>(null);
  const [world, setWorld] = createSignal<ClientWorld | null>(null);
  const [log, setLog] = createSignal<string[]>([]);
  const [chatLog, setChatLog] = createSignal<ChatMessage[]>([]);
  const [draftSelection, setDraftSelection] = createSignal<string[]>([]);
  const [shakedownTarget, setShakedownTarget] = createSignal<string | null>(null);
  const [chatInput, setChatInput] = createSignal("");

  const appendLog = (line: string) => setLog((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 30));

  async function connect() {
    const identity = window.prompt("Your name (use a different name in each browser tab):", `fixer-${Math.floor(Math.random() * 1000)}`);
    if (!identity) return;
    const r = await connectToCyberFixer(identity);
    setRoom(r);
    setWorld(new ClientWorld(r));

    r.onStateChange(() => {
      if (!mySeatId()) {
        const seatId = findMySeatId(r, identity);
        if (seatId) setMySeatId(seatId);
      }
    });
    onActionResult(r, (result) => {
      appendLog(result.ok ? "Action succeeded." : `Action failed: ${result.reason ?? "unknown reason"}`);
      if (result.ok) setDraftSelection([]);
      setShakedownTarget(null);
    });
    onPhaseResult(r, (result) => appendLog(result.ok ? "Turn ended." : `End turn failed: ${result.reason ?? "unknown reason"}`));
    onChat(r, (message) => setChatLog((prev) => [...prev, message].slice(-50)));
  }

  return (
    <div style={{ "font-family": "monospace", padding: "1rem", background: "#0b0e14", color: "#d8e0f0", "min-height": "100vh" }}>
      <h1>Cyber Fixer (Solid)</h1>
      <Show when={!room()}>
        <button onClick={connect}>Connect</button>
      </Show>
      <Show when={room() && world()}>
        <Board world={world()!} room={room()!} mySeatId={mySeatId()} draftSelection={draftSelection()} setDraftSelection={setDraftSelection} shakedownTarget={shakedownTarget()} setShakedownTarget={setShakedownTarget} />
      </Show>
      <div style={{ "margin-top": "1rem" }}>
        <h3>Chat</h3>
        <div style={{ "max-height": "150px", "overflow-y": "auto", "font-size": "0.85rem" }}>
          <For each={chatLog()}>{(m) => <div>{m.identity}: {m.text}</div>}</For>
        </div>
        <input value={chatInput()} onInput={(e) => setChatInput(e.currentTarget.value)} />
        <button
          onClick={() => {
            const r = room();
            if (r && chatInput().trim()) {
              sendChat(r, chatInput().trim());
              setChatInput("");
            }
          }}
        >
          Send
        </button>
      </div>
      <pre style={{ "font-size": "0.8rem", opacity: 0.8 }}>{log().join("\n")}</pre>
    </div>
  );
}

function Board(props: {
  world: ClientWorld;
  room: Room<CyberFixerRoomState>;
  mySeatId: string | null;
  draftSelection: string[];
  setDraftSelection: (v: string[]) => void;
  shakedownTarget: string | null;
  setShakedownTarget: (v: string | null) => void;
}) {
  const entities = useWorld(props.world);
  const all = () => Object.values(entities).filter((e): e is Entity => e !== undefined);
  const fixerIds = () => all().filter((e) => e.kind === "hand").map((e) => e.id);
  const activeFixer = () => all().find((e) => e.kind === "hand" && e.tags.has("active-turn"));
  const isMyTurn = () => !!props.mySeatId && activeFixer()?.id === props.mySeatId;
  const matchStarted = () => !!activeFixer();

  return (
    <div>
      <div>
        {!matchStarted() ? "Waiting in the lobby…" : isMyTurn() ? "Your turn" : `Waiting on ${activeFixer()?.id}…`}
      </div>
      <For each={fixerIds()}>
        {(fixerId) => (
          <Fixer
            fixerId={fixerId}
            all={all()}
            isMe={fixerId === props.mySeatId}
            isMyTurn={isMyTurn()}
            room={props.room}
            draftSelection={props.draftSelection}
            setDraftSelection={props.setDraftSelection}
            shakedownTarget={props.shakedownTarget}
            setShakedownTarget={props.setShakedownTarget}
          />
        )}
      </For>
      <button disabled={!isMyTurn()} onClick={() => sendPhaseAdvance(props.room)}>
        End turn
      </button>
    </div>
  );
}

function Fixer(props: {
  fixerId: string;
  all: Entity[];
  isMe: boolean;
  isMyTurn: boolean;
  room: Room<CyberFixerRoomState>;
  draftSelection: string[];
  setDraftSelection: (v: string[]) => void;
  shakedownTarget: string | null;
  setShakedownTarget: (v: string | null) => void;
}) {
  const fixer = () => props.all.find((e) => e.id === props.fixerId)!;
  const inPlay = () => props.all.filter(isCard).filter((e) => e.tags.has(CONTRACTOR_TAG) && e.zoneId === boardZoneIdFor(props.fixerId));
  const iHaveDrafted = () => fixer()?.tags.has("drafted") ?? false;
  const iAmReady = () => fixer()?.tags.has("ready") ?? false;
  const myDeckCards = () => props.all.filter(isCard).filter((e) => e.zoneId === deckZoneIdFor(props.fixerId));

  return (
    <div style={{ border: "1px solid #334", padding: "0.5rem", "margin-bottom": "0.5rem" }}>
      <h2>
        {props.fixerId}
        {props.isMe ? " (you)" : ""}
      </h2>
      <div>
        inflow: {fixer()?.properties.inflow ?? 0} · outflow: {fixer()?.properties.outflow ?? 0}
      </div>
      <div>
        <h4>In play</h4>
        <For each={inPlay()}>
          {(card) => (
            <span
              style={{ border: props.shakedownTarget === card.id ? "2px solid orange" : "1px solid #556", padding: "0.25rem", "margin-right": "0.25rem", cursor: !props.isMe && props.isMyTurn ? "pointer" : "default" }}
              onClick={() => {
                if (!props.isMe && props.isMyTurn) props.setShakedownTarget(card.id);
              }}
            >
              {card.name}
            </span>
          )}
        </For>
      </div>
      <Show when={props.isMe && !iHaveDrafted()}>
        <div>
          <h4>Your deck — choose 3 ({props.draftSelection.length}/3)</h4>
          <For each={myDeckCards()}>
            {(card) => (
              <span
                style={{ border: props.draftSelection.includes(card.id) ? "2px solid lime" : "1px solid #556", padding: "0.25rem", "margin-right": "0.25rem", cursor: "pointer" }}
                onClick={() => {
                  const sel = props.draftSelection;
                  if (sel.includes(card.id)) props.setDraftSelection(sel.filter((id) => id !== card.id));
                  else if (sel.length < 3) props.setDraftSelection([...sel, card.id]);
                }}
              >
                {card.name}
              </span>
            )}
          </For>
          <button disabled={props.draftSelection.length !== 3} onClick={() => sendAction(props.room, "draft", props.fixerId, props.draftSelection)}>
            Draft
          </button>
        </div>
      </Show>
      <Show when={props.isMe && iHaveDrafted() && !iAmReady()}>
        <button onClick={() => sendAction(props.room, "ready", props.fixerId, [])}>Ready</button>
      </Show>
      <Show when={props.isMe && props.isMyTurn && props.shakedownTarget}>
        <button
          onClick={() => {
            const myContractor = inPlay().find((c) => (c as Entity).ownership?.includes(props.fixerId));
            if (myContractor) sendAction(props.room, "activate", myContractor.id, [props.shakedownTarget!], { abilityId: "shakedown" });
          }}
        >
          Shakedown selected target
        </button>
      </Show>
    </div>
  );
}
