import {
  formatIsoDate,
  getOrCreateDndCampaign,
  proficiencyBonus,
  SUNKEN_VAULT_CAMPAIGN,
  type Asset,
  type DndCampaign,
  type DndCampaignDefinition,
  type DndCampaignNode,
  type DndCharacter,
  type DndTurnLogEntry,
  type RunContext,
  type ServicePlugin,
} from "@dailyscribe/core";
import { Document, Line, Link, Page, Rect, StyleSheet, Svg, Text, View, renderToBuffer } from "@react-pdf/renderer";
import {
  DND_MOVE_CHECKBOXES,
  DND_MOVE_EXIT_SLOTS,
  DND_MOVE_FILL_INS,
  moveExitOptions,
  type DndFieldBox,
} from "@/lib/dnd/layout";
import { BUY_ME_A_COFFEE_URL } from "@/lib/site";

const MAIL_BACK_ADDRESS = "my@dailyscribe.ca";
const CELL_SIZE = 30;
const CHECKBOX_SIZE = 10;
const FILL_LINE_WIDTH = 70;

const styles = StyleSheet.create({
  page: { paddingVertical: 40, paddingHorizontal: 48, fontFamily: "Helvetica", color: "#111111" },
  masthead: { fontSize: 22, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  date: { fontSize: 11, color: "#444444", marginBottom: 12 },
  mailBack: { fontSize: 9, color: "#555555", marginBottom: 14 },
  mailBackAddr: { fontFamily: "Helvetica-Bold", color: "#222222" },
  h2: { fontSize: 13, fontFamily: "Helvetica-Bold", marginTop: 14, marginBottom: 6 },
  body: { fontSize: 10.5, lineHeight: 1.4, color: "#222222" },
  echoBox: {
    marginTop: 10,
    padding: 10,
    border: "0.5pt solid #cccccc",
    backgroundColor: "#f7f7f5",
  },
  echoLabel: { fontSize: 8, fontFamily: "Helvetica-Bold", color: "#888888", marginBottom: 3, textTransform: "uppercase" },
  echoText: { fontSize: 9.5, color: "#333333", lineHeight: 1.4 },
  monsterRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 3 },
  monsterName: { fontSize: 10, fontFamily: "Helvetica-Bold" },
  monsterMeta: { fontSize: 9, color: "#555555" },
  hint: { fontSize: 8.5, color: "#777777", marginTop: 6, lineHeight: 1.35 },
  coffee: { fontSize: 9, color: "#888888", marginBottom: 10 },
  checkboxRow: { flexDirection: "row", alignItems: "center", marginBottom: 7, width: "50%" },
  checkboxLabel: { fontSize: 9.5, marginLeft: 6 },
  fillRow: { flexDirection: "row", alignItems: "flex-end", marginBottom: 8, width: "50%" },
  fillLabel: { fontSize: 9.5, marginRight: 6 },
  sheetLabel: { fontSize: 9, color: "#666666" },
  sheetValue: { fontSize: 11, fontFamily: "Helvetica-Bold" },
  sheetRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 10, width: "60%" },
  abilityCell: { width: "16%", alignItems: "center" },
  footer: { position: "absolute", bottom: 24, left: 48, right: 48, fontSize: 8, color: "#888888", textAlign: "center" },
  footerRef: { position: "absolute", bottom: 12, left: 48, right: 48, fontSize: 7.5, color: "#888888", textAlign: "center" },
});

function formatLongDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function MailBackNote({ verb }: { verb: string }) {
  return (
    <Text style={styles.mailBack}>
      {verb}, then email this page to <Text style={styles.mailBackAddr}>{MAIL_BACK_ADDRESS}</Text> — Daily Scribe
      reads your handwriting and advances the campaign.
    </Text>
  );
}

/** A tickable box: an empty square the player pen-marks by hand. */
function Checkbox({ label }: { label: string }) {
  return (
    <View style={styles.checkboxRow}>
      <Svg width={CHECKBOX_SIZE} height={CHECKBOX_SIZE} viewBox={`0 0 ${CHECKBOX_SIZE} ${CHECKBOX_SIZE}`}>
        <Rect x={0.5} y={0.5} width={CHECKBOX_SIZE - 1} height={CHECKBOX_SIZE - 1} fill="none" stroke="#333333" strokeWidth={1} />
      </Svg>
      <Text style={styles.checkboxLabel}>{label}</Text>
    </View>
  );
}

/** A fill-in-the-blank line: a label followed by a ruled box for a written number/word. */
function FillInBox({ label, width = FILL_LINE_WIDTH }: { label: string; width?: number }) {
  return (
    <View style={styles.fillRow}>
      <Text style={styles.fillLabel}>{label}</Text>
      <Svg width={width} height={16} viewBox={`0 0 ${width} 16`}>
        <Rect x={0.5} y={0.5} width={width - 1} height={15} fill="none" stroke="#999999" strokeWidth={1} />
      </Svg>
    </View>
  );
}

/** The fog-of-war dungeon map: only discovered rooms are drawn, connected by
 *  lines only where both ends are discovered — undiscovered rooms and the
 *  passages leading to them stay hidden. */
function MapSvg({ campaign, gameState }: { campaign: DndCampaignDefinition; gameState: { currentNode: string; discoveredNodes: string[] } }) {
  const cols = campaign.grid.cols;
  const rows = campaign.grid.rows;
  const width = cols * CELL_SIZE;
  const height = rows * CELL_SIZE;
  const discovered = new Set(gameState.discoveredNodes);
  const center = (id: string) => {
    const n = campaign.nodes[id];
    return { cx: n.x * CELL_SIZE + CELL_SIZE / 2, cy: n.y * CELL_SIZE + CELL_SIZE / 2 };
  };

  const edges: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  for (const id of gameState.discoveredNodes) {
    const node = campaign.nodes[id];
    for (const dest of Object.values(node.exits)) {
      if (!discovered.has(dest)) continue;
      const key = [id, dest].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: id, to: dest });
    }
  }

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {edges.map((e, i) => {
        const a = center(e.from);
        const b = center(e.to);
        return <Line key={i} x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} stroke="#bbbbbb" strokeWidth={2} />;
      })}
      {gameState.discoveredNodes.map((id) => {
        const { cx, cy } = center(id);
        const isCurrent = id === gameState.currentNode;
        const r = CELL_SIZE * 0.32;
        return (
          <Rect
            key={id}
            x={cx - r}
            y={cy - r}
            width={r * 2}
            height={r * 2}
            fill={isCurrent ? "#111111" : "#ffffff"}
            stroke="#333333"
            strokeWidth={1.2}
          />
        );
      })}
    </Svg>
  );
}

function LivingEncounter({ node, monsterHp }: { node: DndCampaignNode; monsterHp: Record<string, number> }) {
  const living = node.monsters.filter((m) => (monsterHp[m.id] ?? m.hp) > 0);
  if (living.length === 0) {
    return <Text style={styles.body}>The room is clear.</Text>;
  }
  return (
    <View>
      {living.map((m) => (
        <View key={m.id} style={styles.monsterRow}>
          <Text style={styles.monsterName}>{m.name}</Text>
          <Text style={styles.monsterMeta}>
            HP {monsterHp[m.id] ?? m.hp} · AC {m.ac} · Perception {m.passivePerception ?? 10} · Initiative{" "}
            {10 + (m.dexMod ?? 0)} · Attack: {m.attack}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** "north (Dry Fountain)" once the destination is discovered, else just
 *  "north" — the map stays fog-of-war. */
function exitLabel(campaign: DndCampaignDefinition, node: DndCampaignNode, direction: string, discoveredNodes: string[]): string {
  const dest = node.exits[direction];
  const name = direction.charAt(0).toUpperCase() + direction.slice(1);
  return discoveredNodes.includes(dest) && campaign.nodes[dest] ? `${name} (${campaign.nodes[dest].title})` : name;
}

function RoomExits({
  campaign,
  node,
  discoveredNodes,
}: {
  campaign: DndCampaignDefinition;
  node: DndCampaignNode;
  discoveredNodes: string[];
}) {
  const exits = moveExitOptions(node);
  return (
    <Text style={[styles.body, { marginTop: 6 }]}>
      <Text style={{ fontFamily: "Helvetica-Bold" }}>Exits: </Text>
      {exits.length > 0 ? exits.map((d) => exitLabel(campaign, node, d, discoveredNodes)).join(" · ") : "none"}
      {exits.length > 0 ? " — tick one on the next page to move." : ""}
    </Text>
  );
}

/** A checkbox drawn at a fixed page position from `DND_MOVE_FIELD_LAYOUT`, so
 *  the mail-back reader can sample its exact pixel region later. Never render
 *  a move-page checkbox any other way. */
function AbsCheckbox({ field, label, labelWidth = 260 }: { field: DndFieldBox; label?: string; labelWidth?: number }) {
  return (
    <>
      <Svg
        style={{ position: "absolute", top: field.top, left: field.left }}
        width={field.width}
        height={field.height}
        viewBox={`0 0 ${field.width} ${field.height}`}
      >
        <Rect x={0.5} y={0.5} width={field.width - 1} height={field.height - 1} fill="none" stroke="#333333" strokeWidth={1.2} />
      </Svg>
      <Text style={{ position: "absolute", top: field.top + 1.5, left: field.left + field.width + 6, fontSize: 9.5, width: labelWidth }}>
        {label ?? field.label}
      </Text>
    </>
  );
}

/** A fill-in box drawn at a fixed page position — see `AbsCheckbox`. */
function AbsFillIn({ field }: { field: DndFieldBox }) {
  return (
    <>
      <Text style={{ position: "absolute", top: field.top - 13, left: field.left, fontSize: 9, color: "#555555" }}>
        {field.label}
      </Text>
      <Svg
        style={{ position: "absolute", top: field.top, left: field.left }}
        width={field.width}
        height={field.height}
        viewBox={`0 0 ${field.width} ${field.height}`}
      >
        <Rect x={0.5} y={0.5} width={field.width - 1} height={field.height - 1} fill="none" stroke="#999999" strokeWidth={1} />
      </Svg>
    </>
  );
}

function RefFooter({ inboundToken, digest }: { inboundToken: string; digest?: boolean }) {
  return (
    <>
      <Text
        style={styles.footer}
        render={({ pageNumber, totalPages }) =>
          digest ? "Delivered by Daily Scribe" : `Delivered by Daily Scribe · Page ${pageNumber} of ${totalPages}`
        }
        fixed
      />
      {/* Its own line, not sharing space with the attribution text above — see
       *  kanji.tsx for why this must never wrap/hyphenate. */}
      <Text style={styles.footerRef} fixed>
        {`Ref: dailyscribe:dnd:${inboundToken}`}
      </Text>
    </>
  );
}

/** Name + six ability-score fill-in boxes + one class checkbox each — read
 *  by the mail-back webhook to (re)start a hero via `applyCharacterSheet`. */
function CharacterCreationSection() {
  return (
    <View>
      <Text style={styles.h2}>Create Your Hero</Text>
      <FillInBox label="Name:" width={160} />
      <Text style={[styles.body, { marginTop: 8, marginBottom: 4 }]}>Choose one class:</Text>
      <Checkbox label="Fighter — d10 HP, chain mail + shield (AC 18), Longsword. Tough and reliable." />
      <Checkbox label="Rogue — d8 HP, leather (AC 11+DEX), Shortsword + bow. Stealth expert." />
      <Checkbox label="Barbarian — d12 HP, unarmored (AC 10+DEX+CON), Greataxe. Big hits, big health." />
      <Text style={[styles.body, { marginTop: 10, marginBottom: 4 }]}>
        Roll each ability score (3d6, or pick your own 3-18) and write the totals:
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        <FillInBox label="STR:" width={40} />
        <FillInBox label="DEX:" width={40} />
        <FillInBox label="CON:" width={40} />
        <FillInBox label="INT:" width={40} />
        <FillInBox label="WIS:" width={40} />
        <FillInBox label="CHA:" width={40} />
      </View>
    </View>
  );
}

function AdventurePage({
  campaign,
  campaignDoc,
  date,
  digest,
}: {
  campaign: DndCampaignDefinition;
  campaignDoc: DndCampaign;
  date: Date;
  digest?: boolean;
}) {
  const { gameState, turnLog } = campaignDoc;
  const node = campaign.nodes[gameState.currentNode];
  const lastTurn: DndTurnLogEntry | undefined = turnLog[turnLog.length - 1];

  return (
    <Page size="A4" style={styles.page} wrap>
      <Text style={styles.masthead}>{campaign.campaignName}</Text>
      <Text style={styles.date}>{formatLongDate(date)}</Text>
      {!digest && (
        <Link src={BUY_ME_A_COFFEE_URL} style={styles.coffee}>
          Enjoy this with your coffee? Consider buying the creator one, it helps cover the running costs.
        </Link>
      )}
      <MailBackNote verb="Mark your move below" />

      <Text style={styles.h2}>{node.title}</Text>
      <Text style={styles.body}>{node.description}</Text>
      <RoomExits campaign={campaign} node={node} discoveredNodes={gameState.discoveredNodes} />

      {lastTurn && (
        <View style={styles.echoBox}>
          <Text style={styles.echoLabel}>Last move, as I read it</Text>
          <Text style={styles.echoText}>{lastTurn.read || "(no notes read)"}</Text>
          <Text style={[styles.echoText, { marginTop: 4 }]}>{lastTurn.result}</Text>
        </View>
      )}

      <Text style={styles.h2}>Encounter</Text>
      <LivingEncounter node={node} monsterHp={gameState.monsterHp} />
      {node.monsters.some((m) => (gameState.monsterHp[m.id] ?? m.hp) > 0) && (
        <Text style={[styles.hint, { marginTop: 4 }]}>
          You roll for the monster too — nothing here rolls its own dice. Its attack (shown above) is a d20 + that
          bonus vs. your Armor Class (character sheet, next page); on a hit, roll its damage die and write the
          total in Damage Taken. That happens most turns — the exceptions are a successful Sneak, or finishing off
          the last enemy here while you have the initiative (it doesn&apos;t get a final swing). Initiative (next
          page, once per encounter): roll a d20 + your DEX modifier and compare it to the monster&apos;s Initiative
          shown above.
        </Text>
      )}

      <Text style={styles.h2}>Map</Text>
      <MapSvg campaign={campaign} gameState={gameState} />

      <RefFooter inboundToken={campaignDoc.inboundToken} digest={digest} />
    </Page>
  );
}

/**
 * The move-input form — deliberately the ONLY content on its own page, with
 * nothing of variable length above it. Every field is drawn at the fixed
 * coordinates in `DND_MOVE_FIELD_LAYOUT` rather than flowed with flexbox, so
 * the mail-back reader can sample/crop the mailed-back scan at those exact
 * same coordinates without re-deriving them (see lib/dnd/layout.ts).
 */
/** Character sheet content only (no Page/footer) — placed as a fixed block
 *  below the move fields on MovePage, well clear of their absolute
 *  positions (see MOVE_FIELDS_BOTTOM), so the two pages/pieces can merge
 *  onto one page without disturbing DND_MOVE_FIELD_LAYOUT's coordinates. */
function fmtBonus(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

function CharacterSheetSection({ character }: { character: DndCharacter }) {
  const profBonus = proficiencyBonus(character.level);
  const toHitBonus = character.modifiers[character.attackAbility] + profBonus;
  const damageBonus = character.modifiers[character.attackAbility];
  const stealthBonus = character.modifiers.dexterity + (character.skillProficiencies.includes("Stealth") ? profBonus : 0);
  const perceptionBonus = character.modifiers.wisdom;

  return (
    <View>
      <Text style={styles.h2}>Character Sheet</Text>
      <View style={styles.sheetRow}>
        <View>
          <Text style={styles.sheetLabel}>Name</Text>
          <Text style={styles.sheetValue}>{character.name}</Text>
        </View>
        <View>
          <Text style={styles.sheetLabel}>Class</Text>
          <Text style={styles.sheetValue}>
            {character.class} (Level {character.level})
          </Text>
        </View>
      </View>
      <View style={styles.sheetRow}>
        <View>
          <Text style={styles.sheetLabel}>Hit Points</Text>
          <Text style={styles.sheetValue}>
            {character.currentHp} / {character.maxHp}
          </Text>
        </View>
        <View>
          <Text style={styles.sheetLabel}>Armor Class</Text>
          <Text style={styles.sheetValue}>{character.ac}</Text>
        </View>
      </View>

      <View style={{ flexDirection: "row" }}>
        {Object.entries(character.scores).map(([ability, score]) => (
          <View key={ability} style={styles.abilityCell}>
            <Text style={styles.sheetLabel}>{ability.slice(0, 3).toUpperCase()}</Text>
            <Text style={styles.sheetValue}>{score}</Text>
            <Text style={styles.sheetLabel}>
              {character.modifiers[ability as keyof typeof character.modifiers] >= 0 ? "+" : ""}
              {character.modifiers[ability as keyof typeof character.modifiers]}
            </Text>
          </View>
        ))}
      </View>

      <Text style={[styles.body, { marginTop: 8 }]}>
        <Text style={styles.sheetLabel}>Weapon: </Text>
        {character.weapon} ({character.damageDie})
      </Text>

      <Text style={[styles.body, { marginTop: 6 }]}>
        <Text style={styles.sheetLabel}>To Hit: </Text>
        {fmtBonus(toHitBonus)}
        {"    "}
        <Text style={styles.sheetLabel}>Damage: </Text>
        {character.damageDie}
        {fmtBonus(damageBonus)}
        {"    "}
        <Text style={styles.sheetLabel}>Stealth: </Text>
        {fmtBonus(stealthBonus)}
        {"    "}
        <Text style={styles.sheetLabel}>Perception: </Text>
        {fmtBonus(perceptionBonus)}
      </Text>

      <Text style={[styles.body, { marginTop: 6 }]}>
        <Text style={styles.sheetLabel}>Inventory: </Text>
        {character.inventory.join(", ")}
      </Text>
    </View>
  );
}

// The lowest move fields (the bottom row of exit slots) bottom out at 420 + 14 = 434 —
// this must stay comfortably below that, and above the footer, however
// DND_MOVE_FIELD_LAYOUT is tuned later. Not derived automatically: kept as
// a plain constant since deriving it would mean importing layout math into a
// styling decision that only needs to know "clear of the fields, above the footer."
const CHARACTER_SHEET_TOP = 460;

// Heading for the exit slots — sits between the "misread" checkbox (ends at
// 354) and the first exit row (DND_MOVE_EXIT_SLOTS, top 396).
const EXIT_HEADING_TOP = 366;

function MovePage({
  campaign,
  campaignDoc,
  digest,
}: {
  campaign: DndCampaignDefinition;
  campaignDoc: DndCampaign;
  digest?: boolean;
}) {
  const node = campaign.nodes[campaignDoc.gameState.currentNode];
  const exits = moveExitOptions(node);
  return (
    <Page size="A4" style={styles.page}>
      <Text style={styles.masthead}>Your Move</Text>
      <Text style={styles.hint}>
        Check only one of Attack / Sneak / Flee / Dodge each turn — if you mark more than one, only the
        highest-priority action (Sneak, then Flee, then Dodge, then Attack) is applied, and I&apos;ll say so next
        time. Roll physically and write your totals below. To Hit: roll a d20 and add your To Hit bonus (see your
        sheet below) — write the total, and it&apos;s a hit if it meets or beats the monster&apos;s AC (previous
        page). Damage on a hit: roll your weapon&apos;s die and add your Damage bonus. Stealth to sneak past: roll a
        d20 and add your Stealth bonus, comparing to the monster&apos;s Perception (previous page). Perception
        (DC 12) to search a room: roll a d20 and add your Perception bonus. Heal (drink a potion): flat 2d4+2, no
        bonus added. Only one monster is fought at a time, in room order.
      </Text>
      {DND_MOVE_CHECKBOXES.map((field) => (
        <AbsCheckbox key={field.id} field={field} />
      ))}
      {DND_MOVE_FILL_INS.map((field) => (
        <AbsFillIn key={field.id} field={field} />
      ))}
      {exits.length > 0 && (
        <Text style={{ position: "absolute", top: EXIT_HEADING_TOP, left: 56, width: 270, fontSize: 9.5, lineHeight: 1.3 }}>
          <Text style={{ fontFamily: "Helvetica-Bold" }}>Take an exit</Text> (tick one). While enemies remain you can
          only leave with a successful Sneak or by Fleeing.
        </Text>
      )}
      {exits.map((direction, i) => (
        <AbsCheckbox
          key={DND_MOVE_EXIT_SLOTS[i].id}
          field={DND_MOVE_EXIT_SLOTS[i]}
          label={exitLabel(campaign, node, direction, campaignDoc.gameState.discoveredNodes)}
          labelWidth={120}
        />
      ))}
      <View style={{ position: "absolute", top: CHARACTER_SHEET_TOP, left: 48, right: 48 }}>
        <CharacterSheetSection character={campaignDoc.character} />
      </View>
      <RefFooter inboundToken={campaignDoc.inboundToken} digest={digest} />
    </Page>
  );
}

function CreationPage({ campaign, campaignDoc, date, digest }: { campaign: DndCampaignDefinition; campaignDoc: DndCampaign; date: Date; digest?: boolean }) {
  return (
    <Page size="A4" style={styles.page} wrap>
      <Text style={styles.masthead}>{campaign.campaignName}</Text>
      <Text style={styles.date}>{formatLongDate(date)}</Text>
      {!digest && (
        <Link src={BUY_ME_A_COFFEE_URL} style={styles.coffee}>
          Enjoy this with your coffee? Consider buying the creator one, it helps cover the running costs.
        </Link>
      )}
      <Text style={styles.body}>
        A new hero stands at the threshold of {campaign.campaignName}. Fill in the sheet below to begin.
      </Text>
      <MailBackNote verb="Fill in your hero" />
      <CharacterCreationSection />
      <RefFooter inboundToken={campaignDoc.inboundToken} digest={digest} />
    </Page>
  );
}

function TerminalPage({
  campaign,
  campaignDoc,
  date,
  digest,
  won,
}: {
  campaign: DndCampaignDefinition;
  campaignDoc: DndCampaign;
  date: Date;
  digest?: boolean;
  won: boolean;
}) {
  const { character, gameState } = campaignDoc;
  return (
    <Page size="A4" style={styles.page} wrap>
      <Text style={styles.masthead}>{campaign.campaignName}</Text>
      <Text style={styles.date}>{formatLongDate(date)}</Text>
      {!digest && (
        <Link src={BUY_ME_A_COFFEE_URL} style={styles.coffee}>
          Enjoy this with your coffee? Consider buying the creator one, it helps cover the running costs.
        </Link>
      )}
      <Text style={styles.h2}>{won ? "Victory!" : "You Have Fallen"}</Text>
      <Text style={styles.body}>
        {won
          ? `${character.name} the ${character.class} cleared the vault in ${gameState.turnCount} turns. The campaign is complete.`
          : `${character.name} the ${character.class} fell after ${gameState.turnCount} turns. The campaign ends here.`}
      </Text>
      <Text style={[styles.body, { marginTop: 10 }]}>
        Ready for another run? Fill in a new hero below and mail this page back to start over.
      </Text>
      <MailBackNote verb="Fill in your new hero" />
      <CharacterCreationSection />
      <RefFooter inboundToken={campaignDoc.inboundToken} digest={digest} />
    </Page>
  );
}

function DndDocument({
  campaign,
  campaignDoc,
  date,
  digest,
}: {
  campaign: DndCampaignDefinition;
  campaignDoc: DndCampaign;
  date: Date;
  digest?: boolean;
}) {
  const status = campaignDoc.gameState.status;
  return (
    <Document title={`${campaign.campaignName} — ${formatIsoDate(date)}`} author="Daily Scribe">
      {status === "awaiting_character" && <CreationPage campaign={campaign} campaignDoc={campaignDoc} date={date} digest={digest} />}
      {status === "won" && <TerminalPage campaign={campaign} campaignDoc={campaignDoc} date={date} digest={digest} won />}
      {status === "dead" && <TerminalPage campaign={campaign} campaignDoc={campaignDoc} date={date} digest={digest} won={false} />}
      {status === "active" && (
        <>
          <AdventurePage campaign={campaign} campaignDoc={campaignDoc} date={date} digest={digest} />
          <MovePage campaign={campaign} campaignDoc={campaignDoc} digest={digest} />
        </>
      )}
    </Document>
  );
}

export async function renderDndPdf(campaign: DndCampaignDefinition, campaignDoc: DndCampaign, date: Date, digest?: boolean): Promise<Buffer> {
  return renderToBuffer(<DndDocument campaign={campaign} campaignDoc={campaignDoc} date={date} digest={digest} />);
}

export const dndPlugin: ServicePlugin = {
  id: "dnd",
  label: "DnD 5e Campaign",
  async run(ctx: RunContext): Promise<Asset[]> {
    const campaignDoc = await getOrCreateDndCampaign(ctx.userId);
    const bytes = await renderDndPdf(SUNKEN_VAULT_CAMPAIGN, campaignDoc, ctx.date, ctx.digest);
    return [
      {
        filename: `dnd-${formatIsoDate(ctx.date)}.pdf`,
        contentType: "application/pdf",
        bytes,
      },
    ];
  },
};
