// games/cyberfixer/client/main.js
//
// Deliberately minimal: connects, renders a raw view of synced entities
// (whatever this client's StateView allows it to see — the server
// enforces that, this file has no say in it), and offers hardcoded
// actions (draft, deploy, shakedown, end turn) enough to prove the whole
// path works end to end. Not a polished game UI — but whose turn it is
// and what's clickable should be obvious at a glance.
//
// IMPORTANT: every button/click-gate here is a UI CONVENIENCE, not the
// actual rule enforcement — the server (games/cyberfixer/server/room.ts)
// independently checks turn order, performer ownership, and cost on
// every submitted action regardless of what this file lets the user
// click. "Whose turn is it" is read directly off the "active-turn" tag
// the server puts on the active fixer's own entity — already-synced
// data, not something this file infers or guesses.

const statusEl = document.getElementById("status");
const turnBannerEl = document.getElementById("turn-banner");
const hintEl = document.getElementById("hint");
const boardEl = document.getElementById("board");
const logEl = document.getElementById("log");
const shakedownBtn = document.getElementById("shakedown-btn");
const endTurnBtn = document.getElementById("end-turn-btn");
const readyBtn = document.getElementById("ready-btn");
const chatLogEl = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

let selectedTargetId = null;
let draftSelection = []; // up to 3 card ids chosen from your own deck
let mySeatId = null;

// Same naming convention as content.ts's boardZoneIdFor/deckZoneIdFor/
// handZoneIdFor/discardZoneIdFor — this file has no import access to
// that module (plain browser JS), so the convention is duplicated here.
const boardZoneId = (fixerId) => `${fixerId}-board`;
const deckZoneId = (fixerId) => `${fixerId}-deck-zone`;
const handZoneId = (fixerId) => `${fixerId}-hand-zone`;

function log(line) {
  logEl.textContent = `${new Date().toLocaleTimeString()}  ${line}\n${logEl.textContent}`;
}

function entityArray(state) {
  const out = [];
  state.entities.forEach((entity, id) => out.push({ id, ...entity }));
  return out;
}

function describeResult(kind, result) {
  if (result.ok) return `${kind} succeeded.`;
  return `${kind} failed: ${result.reason ?? "unknown reason"}`;
}

function renderCard(card, opts) {
  const { extraClass = "", onClick = null, footer = "" } = opts;
  const cardDiv = document.createElement("div");
  const tags = [...card.tags];
  cardDiv.className = `card ${extraClass}`.trim();
  cardDiv.innerHTML = `<strong>${card.name}</strong><br/>
    ${tags.map((t) => `<span class="tag">${t}</span>`).join("")}<br/>
    <span class="metric">inflow ${card.properties.get("inflow") ?? 0} · outflow grant ${card.properties.get("outflowGrant") ?? 0}</span>
    ${footer}`;
  if (onClick) cardDiv.onclick = onClick;
  return cardDiv;
}

function render(state) {
  const entities = entityArray(state);
  const fixerIds = entities.filter((e) => e.kind === "hand").map((e) => e.id);
  const activeFixer = entities.find((e) => e.kind === "hand" && e.tags.has("active-turn"));
  const isMyTurn = !!mySeatId && !!activeFixer && activeFixer.id === mySeatId;
  const matchStarted = !!activeFixer; // no active-turn tag exists anywhere until the lobby closes

  turnBannerEl.textContent = !matchStarted ? "Waiting in the lobby…" : isMyTurn ? "Your turn" : `Waiting on ${activeFixer.id}…`;
  turnBannerEl.className = "turn-banner " + (isMyTurn ? "my-turn" : "their-turn");
  boardEl.className = "board " + (isMyTurn ? "" : "not-my-turn");
  endTurnBtn.disabled = !isMyTurn;
  shakedownBtn.disabled = !isMyTurn || !selectedTargetId;

  const me = entities.find((e) => e.id === mySeatId);
  const iHaveDrafted = me?.tags.has("drafted") ?? false;
  const iAmReady = me?.tags.has("ready") ?? false;
  readyBtn.disabled = matchStarted || !iHaveDrafted || iAmReady;
  readyBtn.textContent = iAmReady ? "Waiting on opponent…" : "Ready";

  hintEl.textContent = matchStarted
    ? isMyTurn
      ? "Deploy a card from your hand, or click an opponent's in-play contractor to shakedown, then click Shakedown. Click End turn when done."
      : "It's not your turn — the board updates live as your opponent acts."
    : !iHaveDrafted
      ? "Pick exactly 3 cards from your deck (below), then click Draft."
      : iAmReady
        ? "You're ready — waiting on your opponent to draft and ready up too."
        : "Click Ready when you're set — the match begins once everyone has.";

  boardEl.innerHTML = "";
  for (const fixerId of fixerIds) {
    const fixer = entities.find((e) => e.id === fixerId);
    const isMe = fixerId === mySeatId;
    const inPlay = entities.filter((e) => e.kind === "card" && e.zoneId === boardZoneId(fixerId));

    const fixerDiv = document.createElement("div");
    fixerDiv.className = "fixer" + (fixerId === activeFixer?.id ? " active-fixer" : "");
    fixerDiv.innerHTML = `<h2>${fixerId}${isMe ? " (you)" : ""}${fixerId === activeFixer?.id ? " ⚡ active" : ""}</h2>
      <div class="metric">inflow: ${fixer.properties.get("inflow") ?? 0} · outflow (spendable this turn): ${fixer.properties.get("outflow") ?? 0}</div>`;

    const boardSection = document.createElement("div");
    boardSection.innerHTML = "<h3>In play</h3>";
    for (const card of inPlay) {
      const defeated = card.tags.has("defeated");
      const targetable = !isMe && isMyTurn && !defeated;
      const div = renderCard(card, {
        extraClass: [defeated && "defeated", targetable && "targetable", card.id === selectedTargetId && "selected"].filter(Boolean).join(" "),
        onClick: targetable
          ? () => {
              selectedTargetId = card.id;
              render(state);
            }
          : null,
      });
      boardSection.appendChild(div);
    }
    fixerDiv.appendChild(boardSection);

    if (isMe && !iHaveDrafted) {
      const deckCards = entities.filter((e) => e.kind === "card" && e.zoneId === deckZoneId(fixerId));
      const draftSection = document.createElement("div");
      draftSection.innerHTML = `<h3>Your deck — choose 3 (${draftSelection.length}/3)</h3>`;
      for (const card of deckCards) {
        const selected = draftSelection.includes(card.id);
        const div = renderCard(card, {
          extraClass: selected ? "selected" : "targetable",
          onClick: () => {
            if (selected) {
              draftSelection = draftSelection.filter((id) => id !== card.id);
            } else if (draftSelection.length < 3) {
              draftSelection = [...draftSelection, card.id];
            }
            render(state);
          },
        });
        draftSection.appendChild(div);
      }
      const draftBtn = document.createElement("button");
      draftBtn.textContent = "Draft";
      draftBtn.disabled = draftSelection.length !== 3;
      draftBtn.onclick = () => {
        room?.send("action", { actionId: "draft", performerId: mySeatId, targetIds: draftSelection });
      };
      draftSection.appendChild(draftBtn);
      fixerDiv.appendChild(draftSection);
    }

    if (isMe && iHaveDrafted) {
      const handCards = entities.filter((e) => e.kind === "card" && e.zoneId === handZoneId(fixerId));
      const deckCards = entities.filter((e) => e.kind === "card" && e.zoneId === deckZoneId(fixerId));
      const handSection = document.createElement("div");
      handSection.innerHTML = `<h3>Your hand (${deckCards.length} left in deck)</h3>`;
      for (const card of handCards) {
        const div = renderCard(card, {
          footer: `<button ${isMyTurn ? "" : "disabled"} data-deploy="${card.id}">Deploy</button>`,
        });
        div.querySelector("[data-deploy]").onclick = (ev) => {
          ev.stopPropagation();
          room?.send("action", { actionId: "deploy", performerId: card.id, targetIds: [] });
        };
        handSection.appendChild(div);
      }
      fixerDiv.appendChild(handSection);
    }

    boardEl.appendChild(fixerDiv);
  }
}

let room = null;

async function main() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const endpoint = `${protocol}://${window.location.host}`;
  const client = new Colyseus.Client(endpoint);

  const identity = window.prompt("Your name (use a different name in each browser tab):", `fixer-${Math.floor(Math.random() * 1000)}`);

  statusEl.textContent = "joining…";
  room = await client.joinOrCreate("cyberfixer", { identity });
  statusEl.textContent = `connected as "${identity}" — session ${room.sessionId}`;
  log(`joined as "${identity}"`);

  room.onStateChange((state) => {
    if (!mySeatId) {
      state.seatIdentities.forEach((seatIdentity, seatId) => {
        if (seatIdentity === identity) mySeatId = seatId;
      });
    }
    render(state);
  });

  room.onMessage("action-result", (result) => {
    log(describeResult("Action", result));
    selectedTargetId = null;
    if (result.ok) draftSelection = [];
  });

  room.onMessage("phase-result", (result) => {
    log(describeResult("End turn", result));
  });

  room.onMessage("chat", (msg) => {
    const line = document.createElement("div");
    const time = new Date(msg.at).toLocaleTimeString();
    line.innerHTML = `<span class="who">${msg.identity}:</span> ${msg.text} <span style="color:#556;font-size:0.75em">${time}</span>`;
    chatLogEl.appendChild(line);
    chatLogEl.scrollTop = chatLogEl.scrollHeight;
  });

  chatForm.onsubmit = (ev) => {
    ev.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    room.send("chat", { text });
    chatInput.value = "";
  };

  readyBtn.onclick = () => {
    if (!mySeatId) return;
    room.send("action", { actionId: "ready", performerId: mySeatId, targetIds: [] });
  };

  shakedownBtn.onclick = () => {
    if (!mySeatId || !selectedTargetId) return;
    const entities = entityArray(room.state);
    const myContractor = entities.find(
      (e) => e.kind === "card" && e.zoneId === boardZoneId(mySeatId) && [...e.ownership].includes(mySeatId) && !e.tags.has("defeated"),
    );
    if (!myContractor) {
      log("No available in-play contractor to act through.");
      return;
    }
    room.send("action", { actionId: "activate", performerId: myContractor.id, targetIds: [selectedTargetId], params: { abilityId: "shakedown" } });
  };

  endTurnBtn.onclick = () => {
    room.send("phaseAdvance", {});
  };
}

main().catch((err) => {
  console.error(err);
  statusEl.textContent = `error: ${err.message}`;
});
