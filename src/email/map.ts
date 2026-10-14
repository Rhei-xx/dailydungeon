import type { DndCampaignDefinition, DndGameState } from "../engine/types";
import { COLORS, esc } from "./html";

/**
 * The fog-of-war map: only discovered rooms, joined only where both ends are
 * discovered (the same rule as the old PDF's MapSvg). Drawn as a table grid
 * because Gmail strips SVG: room cells at even indices, connector cells
 * between them. Only the bounding box of discovered rooms is drawn, so the
 * map never hints at the dungeon's full size.
 */

interface MapGrid {
  minX: number;
  minY: number;
  cols: number;
  rows: number;
  rooms: Map<string, { id: string; current: boolean }>;
  /** "x,y|x,y" keys (sorted) for drawn passages between adjacent rooms. */
  links: Set<string>;
}

const key = (x: number, y: number) => `${x},${y}`;
const linkKey = (a: string, b: string) => [a, b].sort().join("|");

function buildGrid(
  campaign: DndCampaignDefinition,
  gs: Pick<DndGameState, "currentNode" | "discoveredNodes">,
): MapGrid {
  const discovered = gs.discoveredNodes.filter((id) => campaign.nodes[id]);
  const xs = discovered.map((id) => campaign.nodes[id].x);
  const ys = discovered.map((id) => campaign.nodes[id].y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const rooms = new Map<string, { id: string; current: boolean }>();
  for (const id of discovered) {
    const n = campaign.nodes[id];
    rooms.set(key(n.x, n.y), { id, current: id === gs.currentNode });
  }
  const links = new Set<string>();
  for (const id of discovered) {
    const a = campaign.nodes[id];
    for (const destId of Object.values(a.exits)) {
      const b = campaign.nodes[destId];
      if (!b || !discovered.includes(destId)) continue;
      // Only neighbouring cells can be joined in a grid; the built-in
      // dungeon's passages all are.
      if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) continue;
      links.add(linkKey(key(a.x, a.y), key(b.x, b.y)));
    }
  }
  return {
    minX,
    minY,
    cols: Math.max(...xs) - minX + 1,
    rows: Math.max(...ys) - minY + 1,
    rooms,
    links,
  };
}

const ROOM_PX = 26;
const GAP_PX = 14;
const BAR_PX = 4;

export function renderMapHtml(
  campaign: DndCampaignDefinition,
  gs: Pick<DndGameState, "currentNode" | "discoveredNodes">,
): string {
  const g = buildGrid(campaign, gs);
  const rowsHtml: string[] = [];
  for (let r = 0; r < g.rows * 2 - 1; r++) {
    const cells: string[] = [];
    for (let c = 0; c < g.cols * 2 - 1; c++) {
      const x = g.minX + Math.floor(c / 2);
      const y = g.minY + Math.floor(r / 2);
      const width = c % 2 === 0 ? ROOM_PX : GAP_PX;
      const height = r % 2 === 0 ? ROOM_PX : GAP_PX;
      let inner = "";
      if (r % 2 === 0 && c % 2 === 0) {
        const room = g.rooms.get(key(x, y));
        if (room) {
          const fill = room.current ? COLORS.accent : COLORS.card;
          const title = esc(campaign.nodes[room.id].title);
          inner = `<div title="${title}" style="width:${ROOM_PX - 4}px;height:${ROOM_PX - 4}px;background:${fill};border:2px solid ${COLORS.ink};"></div>`;
        }
      } else if (r % 2 === 0 && c % 2 === 1) {
        if (g.links.has(linkKey(key(x, y), key(x + 1, y)))) {
          inner = `<div style="height:${BAR_PX}px;background:${COLORS.muted};"></div>`;
        }
      } else if (r % 2 === 1 && c % 2 === 0) {
        if (g.links.has(linkKey(key(x, y), key(x, y + 1)))) {
          inner = `<div style="width:${BAR_PX}px;height:${GAP_PX}px;background:${COLORS.muted};margin:0 auto;"></div>`;
        }
      }
      cells.push(
        `<td width="${width}" height="${height}" align="center" valign="middle" style="width:${width}px;height:${height}px;padding:0;">${inner}</td>`,
      );
    }
    rowsHtml.push(`<tr>${cells.join("")}</tr>`);
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rowsHtml.join("")}</table>`;
}

/** The same map for the plain-text part: [@] you, [ ] visited, --- and | passages. */
export function renderMapText(
  campaign: DndCampaignDefinition,
  gs: Pick<DndGameState, "currentNode" | "discoveredNodes">,
): string {
  const g = buildGrid(campaign, gs);
  const lines: string[] = [];
  for (let r = 0; r < g.rows * 2 - 1; r++) {
    let line = "";
    for (let c = 0; c < g.cols * 2 - 1; c++) {
      const x = g.minX + Math.floor(c / 2);
      const y = g.minY + Math.floor(r / 2);
      if (r % 2 === 0 && c % 2 === 0) {
        const room = g.rooms.get(key(x, y));
        line += room ? (room.current ? "[@]" : "[ ]") : "   ";
      } else if (r % 2 === 0) {
        line += g.links.has(linkKey(key(x, y), key(x + 1, y))) ? "---" : "   ";
      } else if (c % 2 === 0) {
        line += g.links.has(linkKey(key(x, y), key(x, y + 1))) ? " | " : "   ";
      } else {
        line += "   ";
      }
    }
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}
