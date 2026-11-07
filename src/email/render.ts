import {
  exitDirections,
  livingMonsters,
  monsterInitiative,
  monsterPassivePerception,
} from "../engine/engine";
import { formatModifier } from "../engine/dice";
import { CLASS_IDS, CLASS_SUMMARIES, characterBonuses } from "../engine/rules";
import type {
  DndCampaignDefinition,
  DndCampaignNode,
  DndCharacter,
  DndPlayState,
  DndPlayerRolls,
  DndRollRecord,
} from "../engine/types";
import { REPLY_MARKER } from "../mail/reply-text";
import type { FinishedRun } from "../store/state-file";
import { COLORS, SANS, SERIF, esc, paragraphs } from "./html";
import { renderMapHtml, renderMapText } from "./map";

/** Every email the game sends. */
export type EmailKind = "welcome" | "hero" | "turn" | "unclear" | "reminder" | "victory" | "death";

export interface EmailView {
  kind: EmailKind;
  campaign: DndCampaignDefinition;
  /** The game as it stands once this email's turn has been applied. */
  play: DndPlayState;
  /** When the email goes out — for the date line. */
  date: Date;
  timeZone: string;
  /** Local "HH:MM" of the daily run that reads the next reply. */
  deliveryTime: string;
  /** The player's move as the parser understood it. */
  readAs?: string;
  /** Totals the player typed in and that were used — shown next to readAs.
   *  Present (possibly empty) only for an ordinary move. */
  yourRolls?: DndPlayerRolls;
  /** The keyword reader stood in because Gemini couldn't be reached. */
  backupReader?: boolean;
  narration?: string;
  /** The engine's own account of the turn, in order. */
  events?: string[];
  rolls?: DndRollRecord[];
  /** Why a reply couldn't be played (kind "unclear"). */
  clarification?: string;
  /** The run that just ended — summarised on end-of-run and restart emails. */
  finishedRun?: FinishedRun;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** "The Sunken Vault (Solo Edition)" → "The Sunken Vault". */
function shortCampaignName(campaign: DndCampaignDefinition): string {
  return campaign.campaignName.replace(/\s*\([^)]*\)\s*$/, "");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function longDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

export function subjectFor(view: EmailView): string {
  const ch = view.play.character;
  const room = view.campaign.nodes[view.play.gameState.currentNode].title;
  const next = view.play.gameState.turnCount + 1;
  switch (view.kind) {
    case "welcome":
      return "Daily Dungeon · Create your hero";
    case "hero":
      return `Daily Dungeon · ${ch.name} the ${ch.class} enters ${shortCampaignName(view.campaign)}`;
    case "turn":
      return `Daily Dungeon · Turn ${next} — ${room}`;
    case "unclear":
      return `Daily Dungeon · Turn ${next} — I didn't catch that`;
    case "reminder":
      return view.play.gameState.status === "active"
        ? `Daily Dungeon · Your adventure awaits — ${room}`
        : "Daily Dungeon · Your adventure awaits — create your hero";
    case "victory":
      return `Daily Dungeon · Victory! ${ch.name} cleared ${shortCampaignName(view.campaign)}`;
    case "death":
      return `Daily Dungeon · ${ch.name} has fallen`;
  }
}

function headingFor(view: EmailView): string {
  const ch = view.play.character;
  switch (view.kind) {
    case "welcome":
      return "Create your hero";
    case "hero":
      return `${ch.name} the ${ch.class}`;
    case "turn":
      return view.campaign.nodes[view.play.gameState.currentNode].title;
    case "unclear":
      return "I didn't catch that";
    case "reminder":
      return "Your adventure awaits";
    case "victory":
      return "Victory!";
    case "death":
      return `${ch.name} has fallen`;
  }
}

/** One rendered section, in both formats. */
interface Part {
  html: string;
  text: string;
}

const H2 = `margin:0 0 8px;font:bold 17px/1.3 ${SERIF};color:${COLORS.ink};`;
const BODY = `margin:0 0 10px;font:15px/1.55 ${SERIF};color:${COLORS.ink};`;
const SMALL = `margin:0 0 6px;font:13px/1.5 ${SANS};color:${COLORS.muted};`;
const LABEL = `font:bold 11px/1.4 ${SANS};letter-spacing:0.08em;text-transform:uppercase;color:${COLORS.faint};`;

function row(inner: string, extra = ""): string {
  return `<tr><td style="padding:14px 24px;border-top:1px solid ${COLORS.border};${extra}">${inner}</td></tr>`;
}

function textHeading(title: string): string {
  return `${title.toUpperCase()}\n${"-".repeat(title.length)}`;
}

const ROLL_NAMES: [keyof DndPlayerRolls, string][] = [
  ["initiative", "initiative"],
  ["toHit", "to hit"],
  ["damage", "damage"],
  ["stealth", "stealth"],
  ["perception", "perception"],
  ["heal", "healing"],
];

/** "15 to hit, 6 damage" — the player's own totals, as used this turn. */
export function describeYourRolls(rolls: DndPlayerRolls): string {
  const given = ROLL_NAMES.filter(([key]) => rolls[key] != null).map(
    ([key, name]) => `${rolls[key]} ${name}`,
  );
  return given.length > 0
    ? `${given.join(", ")}. Anything else was rolled for you.`
    : "none given, so every roll was made for you.";
}

const BACKUP_NOTE =
  "Gemini couldn't be reached, so a simpler backup reader read your reply. If it got your move wrong, that's why.";

function readAsPart(view: EmailView): Part {
  const lines: string[] = [];
  const htmlLines: string[] = [];
  if (view.readAs) {
    lines.push(`Your move, as I read it: ${view.readAs}`);
    htmlLines.push(
      `<div style="${LABEL}">Your move, as I read it</div><p style="${BODY}margin:4px 0 6px;font-style:italic;">${esc(view.readAs)}</p>`,
    );
  }
  if (view.yourRolls) {
    const used = `Your dice: ${describeYourRolls(view.yourRolls)}`;
    lines.push(used);
    htmlLines.push(`<p style="${SMALL}">${esc(used)}</p>`);
  }
  if (view.backupReader) {
    lines.push(BACKUP_NOTE);
    htmlLines.push(`<p style="${SMALL}font-style:italic;">${esc(BACKUP_NOTE)}</p>`);
  }
  return {
    html: row(htmlLines.join(""), `background:${COLORS.panel};`),
    text: lines.join("\n"),
  };
}

function narrationPart(narration: string): Part {
  return {
    html: row(paragraphs(narration, `${BODY}font-size:16px;`)),
    text: narration,
  };
}

function rollCell(r: DndRollRecord): string {
  if (r.by === "you") return "your own roll";
  return `${r.expr ?? ""}${r.dice && r.dice.length > 0 ? ` [${r.dice.join(", ")}]` : ""}`;
}

function dicePart(rolls: DndRollRecord[], events: string[]): Part {
  // Two columns that can wrap, so the table never forces the card wider
  // than a phone screen: what was rolled (and how) | the result.
  const rowsHtml = rolls
    .map(
      (r) =>
        `<tr><td style="padding:4px 10px 4px 0;font:13px/1.4 ${SANS};color:${COLORS.ink};vertical-align:top;">${esc(r.label)}` +
        `<br><span style="font-size:12px;color:${COLORS.faint};">${esc(rollCell(r))}</span></td>` +
        `<td style="padding:4px 0;font:13px/1.4 ${SANS};color:${COLORS.ink};vertical-align:top;"><b>${esc(r.total)}</b>${r.outcome ? ` <span style="color:${COLORS.muted};">${esc(r.outcome)}</span>` : ""}</td></tr>`,
    )
    .join("");
  const eventsHtml = events
    .map(
      (e) => `<li style="margin:0 0 4px;font:13px/1.5 ${SANS};color:${COLORS.ink};">${esc(e)}</li>`,
    )
    .join("");
  const html =
    (rolls.length > 0
      ? `<div style="${LABEL}margin-bottom:6px;">The dice</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:10px;">${rowsHtml}</table>`
      : "") +
    (events.length > 0
      ? `<div style="${LABEL}margin-bottom:6px;">What happened</div><ul style="margin:0;padding-left:18px;">${eventsHtml}</ul>`
      : "");
  const text = [
    ...(rolls.length > 0
      ? [
          textHeading("The dice"),
          ...rolls.map(
            (r) => `- ${r.label}: ${rollCell(r)} = ${r.total}${r.outcome ? ` (${r.outcome})` : ""}`,
          ),
          "",
        ]
      : []),
    ...(events.length > 0 ? [textHeading("What happened"), ...events.map((e) => `- ${e}`)] : []),
  ]
    .join("\n")
    .trim();
  return { html: row(html), text };
}

function exitLabel(
  campaign: DndCampaignDefinition,
  node: DndCampaignNode,
  direction: string,
  discovered: string[],
): string {
  const entry = Object.entries(node.exits).find(([k]) => k.toLowerCase() === direction);
  const dest = entry?.[1];
  return dest && discovered.includes(dest) && campaign.nodes[dest]
    ? `${direction} (${campaign.nodes[dest].title})`
    : direction;
}

function roomPart(view: EmailView): Part {
  const { campaign, play } = view;
  const gs = play.gameState;
  const node = campaign.nodes[gs.currentNode];
  const living = livingMonsters(node, gs.monsterHp);
  const exits = exitDirections(node).map((d) => exitLabel(campaign, node, d, gs.discoveredNodes));

  const monsterLine = (m: (typeof living)[number]) =>
    `${m.name} — HP ${gs.monsterHp[m.id] ?? m.hp}/${m.hp} · AC ${m.ac} · attack ${formatModifier(m.toHit)}, ${m.damage} · initiative ${monsterInitiative(m)} · spots sneaking on ${monsterPassivePerception(m)}+`;

  const enemiesHtml =
    living.length > 0
      ? `<div style="${LABEL}margin:8px 0 4px;">Enemies</div>` +
        living
          .map((m) => `<p style="${SMALL}color:${COLORS.ink};">${esc(monsterLine(m))}</p>`)
          .join("")
      : `<p style="${SMALL}">The room is clear.</p>`;
  const searched = gs.searchedNodes.includes(gs.currentNode)
    ? " You've already searched here."
    : "";

  const html =
    `<div style="${LABEL}margin-bottom:4px;">Where you are</div>` +
    `<h2 style="${H2}">${esc(node.title)}</h2>` +
    paragraphs(node.description, BODY) +
    enemiesHtml +
    `<p style="${SMALL}"><b style="color:${COLORS.ink};">Exits:</b> ${esc(exits.length > 0 ? exits.join(" · ") : "none")}${esc(searched)}</p>` +
    `<div style="${LABEL}margin:12px 0 6px;">Map</div>` +
    renderMapHtml(campaign, gs) +
    `<p style="${SMALL}margin-top:6px;"><span style="color:${COLORS.accent};">■</span> you are here · <span style="color:${COLORS.mapRoom};">■</span> explored</p>`;

  const text = [
    textHeading(`Where you are: ${node.title}`),
    node.description,
    "",
    living.length > 0
      ? ["Enemies:", ...living.map((m) => `- ${monsterLine(m)}`)].join("\n")
      : "The room is clear.",
    `Exits: ${exits.length > 0 ? exits.join(", ") : "none"}.${searched}`,
    "",
    "Map ([@] = you):",
    renderMapText(campaign, gs),
  ].join("\n");
  return { html: row(html), text };
}

function characterPart(ch: DndCharacter): Part {
  const b = characterBonuses(ch);
  const hpPct = Math.max(0, Math.min(100, Math.round((ch.currentHp / ch.maxHp) * 100)));
  const hpColor = hpPct > 50 ? COLORS.good : COLORS.accent;
  const stats = [
    `AC ${ch.ac}`,
    `to hit ${formatModifier(b.toHit)}`,
    `damage ${ch.damageDie}${b.damage ? formatModifier(b.damage) : ""} (${ch.weapon})`,
    `stealth ${formatModifier(b.stealth)}`,
    `perception ${formatModifier(b.perception)}`,
    `initiative ${formatModifier(b.initiative)}`,
  ];
  const hpBar =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;max-width:240px;margin:4px 0 8px;"><tr>` +
    (hpPct > 0
      ? `<td width="${hpPct}%" height="8" style="background:${hpColor};font-size:0;line-height:0;">&nbsp;</td>`
      : "") +
    (hpPct < 100
      ? `<td height="8" style="background:${COLORS.border};font-size:0;line-height:0;">&nbsp;</td>`
      : "") +
    `</tr></table>`;
  const html =
    `<div style="${LABEL}margin-bottom:4px;">Your hero</div>` +
    `<h2 style="${H2}">${esc(ch.name)} the ${esc(ch.class)} <span style="font:13px ${SANS};color:${COLORS.muted};">level ${ch.level}</span></h2>` +
    `<p style="${SMALL}color:${COLORS.ink};margin-bottom:0;"><b>HP ${ch.currentHp} / ${ch.maxHp}</b></p>` +
    hpBar +
    `<p style="${SMALL}">${esc(stats.join(" · "))}</p>` +
    `<p style="${SMALL}"><b style="color:${COLORS.ink};">Inventory:</b> ${esc(ch.inventory.join(", ") || "nothing")}</p>`;
  const text = [
    textHeading(`Your hero: ${ch.name} the ${ch.class} (level ${ch.level})`),
    `HP ${ch.currentHp}/${ch.maxHp} · ${stats.join(" · ")}`,
    `Inventory: ${ch.inventory.join(", ") || "nothing"}`,
  ].join("\n");
  return { html: row(html), text };
}

function moveExamples(view: EmailView): string[] {
  const { campaign, play } = view;
  const node = campaign.nodes[play.gameState.currentNode];
  const living = livingMonsters(node, play.gameState.monsterHp);
  const exits = exitDirections(node);
  const hasPotion = play.character.inventory.some((i) => i.toLowerCase().includes("potion"));
  const unsearched = !play.gameState.searchedNodes.includes(play.gameState.currentNode);
  const examples: string[] = [];
  if (living.length > 0) {
    examples.push(`Attack the ${living[0].name.toLowerCase()}.`);
    if (exits.length > 0) examples.push(`Sneak past and go ${exits[0]}.`);
    examples.push(hasPotion ? "Dodge, and drink a potion." : "Dodge.");
  } else {
    if (unsearched) examples.push("Search the room.");
    if (exits.length > 0) examples.push(`Go ${exits[exits.length - 1]}.`);
    if (hasPotion && play.character.currentHp < play.character.maxHp)
      examples.push("Drink a potion.");
  }
  return examples;
}

/** How to add your own dice, with this hero's actual bonuses, and an example
 *  that's plainly the player's own words (the old one read like a result). */
function diceGuide(view: EmailView): { intro: string; example: string; formulas: string } {
  const ch = view.play.character;
  const b = characterBonuses(ch);
  const node = view.campaign.nodes[view.play.gameState.currentNode];
  const target = livingMonsters(node, view.play.gameState.monsterHp)[0];
  const example = target
    ? `Attack the ${target.name.toLowerCase()}. 15 to hit, 6 damage.`
    : "Search the room. 14 perception.";
  const formulas = [
    `to hit d20${formatModifier(b.toHit)}`,
    `damage ${ch.damageDie}${b.damage ? formatModifier(b.damage) : ""}`,
    `stealth d20${formatModifier(b.stealth)}`,
    `perception d20${formatModifier(b.perception)}`,
    `initiative d20${formatModifier(b.initiative)}`,
    "potion 2d4+2",
  ].join(" · ");
  return {
    intro:
      "Rolling your own dice? Roll, add your bonus, and put each total next to what it's for. You could write:",
    example,
    formulas: `Your rolls: ${formulas}. Leave any out and I'll roll it for you. Monsters always roll their own attacks, and the next email lists every roll and whose it was.`,
  };
}

function howToReplyMove(view: EmailView): Part {
  const examples = moveExamples(view);
  const timing = `I play your latest reply at ${view.deliveryTime} (${view.timeZone}) each day, so you can change your mind until then.`;
  const guide = diceGuide(view);
  const dice = `${guide.intro} “${guide.example}” ${guide.formulas}`;
  const html =
    `<div style="${LABEL}margin-bottom:6px;">Your move</div>` +
    `<p style="${BODY}">Reply to this email with what you do, in your own words. For example:</p>` +
    `<ul style="margin:0 0 10px;padding-left:18px;">${examples
      .map(
        (e) =>
          `<li style="margin:0 0 4px;font:14px/1.5 ${SERIF};font-style:italic;color:${COLORS.ink};">${esc(e)}</li>`,
      )
      .join("")}</ul>` +
    `<p style="${SMALL}">${esc(dice)}</p>` +
    `<p style="${SMALL}">${esc(timing)} Reply “restart” to begin again with a new hero.</p>`;
  const text = [
    textHeading("Your move"),
    "Reply to this email with what you do, in your own words. For example:",
    ...examples.map((e) => `- ${e}`),
    "",
    dice,
    `${timing} Reply "restart" to begin again with a new hero.`,
  ].join("\n");
  return { html: row(html, `background:${COLORS.panel};`), text };
}

function howToReplyCharacter(view: EmailView): Part {
  const classesHtml = CLASS_IDS.map(
    (id) =>
      `<tr><td style="padding:4px 12px 4px 0;font:bold 14px/1.4 ${SERIF};color:${COLORS.ink};vertical-align:top;">${capitalize(id)}</td>` +
      `<td style="padding:4px 0;font:14px/1.4 ${SERIF};color:${COLORS.ink};">${esc(CLASS_SUMMARIES[id])}</td></tr>`,
  ).join("");
  const ask =
    "Reply with a name and a class, for example “Brakka, barbarian”. If you rolled your own ability scores (STR, DEX, CON, INT, WIS, CHA), include them; anything you leave out I'll roll for you (4d6, drop the lowest). Can't decide? Reply “surprise me”.";
  const timing = `I'll read your reply at ${view.deliveryTime} (${view.timeZone}) and your adventure begins.`;
  const html =
    `<div style="${LABEL}margin-bottom:6px;">Choose a class</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:10px;">${classesHtml}</table>` +
    `<p style="${BODY}">${esc(ask)}</p>` +
    `<p style="${SMALL}">${esc(timing)}</p>`;
  const text = [
    textHeading("Choose a class"),
    ...CLASS_IDS.map((id) => `- ${capitalize(id)}: ${CLASS_SUMMARIES[id]}`),
    "",
    ask,
    timing,
  ].join("\n");
  return { html: row(html, `background:${COLORS.panel};`), text };
}

function runSummaryPart(run: FinishedRun, view: EmailView): Part {
  const gs = view.play.gameState;
  const outcome =
    run.outcome === "won" ? "won the day" : run.outcome === "dead" ? "fell in the dark" : "retired";
  const line = `${run.characterName} the ${run.characterClass} ${outcome} after ${run.turns} turn${run.turns === 1 ? "" : "s"}.`;
  const details =
    run.outcome === "restarted"
      ? ""
      : ` Rooms explored: ${gs.discoveredNodes.length} of ${Object.keys(view.campaign.nodes).length}. Monsters defeated: ${gs.defeatedMonsters.length}.`;
  return {
    html: row(`<p style="${BODY}"><b>${esc(line)}</b>${esc(details)}</p>`),
    text: `${line}${details}`,
  };
}

function introPart(view: EmailView): Part {
  const start = view.campaign.nodes[view.campaign.startNode];
  const intro = `${shortCampaignName(view.campaign)}: ${start.description}`;
  const pacing =
    "This is a solo Dungeons & Dragons adventure played over email, one turn a day. Each morning I send what happened and where you stand; you reply with your next move whenever suits you.";
  return {
    html: row(
      paragraphs(intro, `${BODY}font-size:16px;`) + `<p style="${SMALL}">${esc(pacing)}</p>`,
    ),
    text: `${intro}\n\n${pacing}`,
  };
}

function clarificationPart(view: EmailView): Part {
  const note = view.clarification ?? "I couldn't work out what you want to do.";
  const after =
    "Nothing happened; your hero is waiting right where you left them. Reply again with your move.";
  return {
    html: row(
      `<p style="${BODY}">${esc(note)}</p><p style="${SMALL}">${esc(after)}</p>`,
      `background:${COLORS.panel};`,
    ),
    text: `${note}\n${after}`,
  };
}

function reminderPart(): Part {
  const note =
    "No word from you in a few days, so here's where things stand. I'll wait quietly until you reply.";
  return { html: row(`<p style="${BODY}">${esc(note)}</p>`), text: note };
}

function partsFor(view: EmailView): Part[] {
  const parts: Part[] = [];
  const events = view.events ?? [];
  const rolls = view.rolls ?? [];
  const active = view.play.gameState.status === "active";

  switch (view.kind) {
    case "welcome":
      if (view.finishedRun) parts.push(runSummaryPart(view.finishedRun, view));
      parts.push(introPart(view), howToReplyCharacter(view));
      return parts;
    case "unclear":
      if (view.readAs || view.backupReader) parts.push(readAsPart(view));
      parts.push(clarificationPart(view));
      break;
    case "reminder":
      parts.push(reminderPart());
      break;
    default:
      if (view.readAs || view.yourRolls || view.backupReader) parts.push(readAsPart(view));
      if (view.narration) parts.push(narrationPart(view.narration));
      if (rolls.length > 0 || events.length > 0) parts.push(dicePart(rolls, events));
      if (view.finishedRun) parts.push(runSummaryPart(view.finishedRun, view));
  }

  if (active) {
    parts.push(roomPart(view), characterPart(view.play.character), howToReplyMove(view));
  } else if (view.play.gameState.status === "awaiting_character") {
    // Still no hero (e.g. a reminder after the welcome went unanswered).
    parts.push(introPart(view), howToReplyCharacter(view));
  } else {
    parts.push(characterPart(view.play.character), howToReplyCharacter(view));
  }
  return parts;
}

function preheaderFor(view: EmailView): string {
  const source =
    view.narration ??
    view.clarification ??
    view.campaign.nodes[view.play.gameState.currentNode].description;
  return source.length > 140 ? `${source.slice(0, 137)}...` : source;
}

export function renderEmail(view: EmailView): RenderedEmail {
  const subject = subjectFor(view);
  const heading = headingFor(view);
  // The turn you're about to play, once there's a hero to play it.
  const turnLabel =
    view.play.gameState.status === "active" ? `Turn ${view.play.gameState.turnCount + 1} · ` : "";
  const dateLine = `${turnLabel}${longDate(view.date, view.timeZone)}`;
  const parts = partsFor(view);
  const footer = "Daily Dungeon: solo D&D by email, forked from Daily Scribe.";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${COLORS.page};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(preheaderFor(view))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page};">
<tr><td align="center" style="padding:16px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:6px;border-collapse:separate;">
<tr><td style="padding:10px 24px 0;font:11px/1.4 ${SANS};color:${COLORS.faint};">${esc(REPLY_MARKER)}</td></tr>
<tr><td style="padding:10px 24px 14px;">
<div style="${LABEL}color:${COLORS.accent};">Daily Dungeon · ${esc(dateLine)}</div>
<h1 style="margin:6px 0 0;font:bold 26px/1.2 ${SERIF};color:${COLORS.ink};">${esc(heading)}</h1>
</td></tr>
${parts.map((p) => p.html).join("\n")}
<tr><td style="padding:12px 24px;border-top:1px solid ${COLORS.border};font:11px/1.5 ${SANS};color:${COLORS.faint};">${esc(footer)}</td></tr>
</table>
</td></tr></table>
</body></html>
`;

  const text = [
    REPLY_MARKER,
    "",
    `DAILY DUNGEON · ${dateLine}`,
    heading,
    "",
    ...parts.flatMap((p) => [p.text, ""]),
    footer,
    "",
  ].join("\n");

  return { subject, html, text };
}
