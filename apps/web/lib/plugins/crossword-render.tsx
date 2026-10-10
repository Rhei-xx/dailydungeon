import { formatIsoDate, type CrosswordClue, type CrosswordPuzzle } from "@dailyscribe/core";
import { Document, Link, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { BUY_ME_A_COFFEE_URL } from "@/lib/site";

const styles = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 36, paddingHorizontal: 40, fontFamily: "Helvetica", color: "#111111" },
  // In a digest bundle, packages/core/src/delivery/merge.ts stamps a
  // "‹ Contents" button in the bottom-left of every page (box top ≈ 74pt up
  // from the trim). Reserve room for it so the flowing clue list breaks
  // above the button instead of rendering behind it.
  pageDigestPad: { paddingBottom: 92 },
  masthead: { fontSize: 24, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  date: { fontSize: 11, color: "#444444", marginBottom: 2 },
  subtitle: { fontSize: 10.5, color: "#555555", marginBottom: 14, fontFamily: "Helvetica-Oblique" },
  gridWrap: { alignItems: "center", marginBottom: 14 },
  row: { flexDirection: "row" },
  cluesRow: { flexDirection: "row" },
  cluesCol: { flex: 1, paddingRight: 12 },
  cluesHeading: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    marginBottom: 4,
    borderBottom: "0.5pt solid #000000",
    paddingBottom: 2,
  },
  clueLine: { fontSize: 7.5, lineHeight: 1.35, marginBottom: 2 },
  footer: { position: "absolute", bottom: 20, left: 40, right: 40, fontSize: 7.5, color: "#888888", textAlign: "center" },
  coffee: { fontSize: 9, color: "#888888", marginBottom: 10 },
  spacerText: { fontSize: 11, color: "#888888", textAlign: "center", marginTop: 260, fontFamily: "Helvetica-Oblique" },
});

// A4 at 72dpi, minus this page's horizontal padding.
const GRID_MAX_WIDTH = 595 - 2 * 40;
const MIN_CELL = 11;
const MAX_CELL = 26;

/** Cell size that fits the grid within a width/height budget — smaller on the puzzle page
 *  (clues need room underneath) than the answer page (nothing else on it). */
function cellSizeFor(rows: number, cols: number, maxHeight: number): number {
  return Math.max(MIN_CELL, Math.min(MAX_CELL, GRID_MAX_WIDTH / cols, maxHeight / rows));
}

function CrosswordGrid({
  puzzle,
  reveal,
  maxHeight,
}: {
  puzzle: Pick<CrosswordPuzzle, "grid" | "rows" | "cols" | "clues">;
  reveal: boolean;
  maxHeight: number;
}) {
  const cell = cellSizeFor(puzzle.rows, puzzle.cols, maxHeight);
  const numberAt = new Map<string, number>();
  for (const c of puzzle.clues) {
    const key = `${c.row},${c.col}`;
    if (!numberAt.has(key)) numberAt.set(key, c.position);
  }
  return (
    <View style={styles.gridWrap}>
      {puzzle.grid.map((rowCells, r) => (
        <View key={r} style={styles.row}>
          {rowCells.map((letter, c) => {
            const blocked = letter === null;
            const num = numberAt.get(`${r},${c}`);
            return (
              <View
                key={c}
                style={{
                  width: cell,
                  height: cell,
                  borderWidth: blocked ? 0 : 0.75,
                  borderColor: "#000000",
                  backgroundColor: blocked ? "#000000" : "#ffffff",
                  justifyContent: "center",
                  alignItems: "center",
                }}
              >
                {!blocked && num !== undefined && (
                  <Text style={{ position: "absolute", top: 1, left: 1.5, fontSize: Math.max(5, cell * 0.24) }}>
                    {num}
                  </Text>
                )}
                {!blocked && reveal && (
                  <Text style={{ fontSize: cell * 0.55, fontFamily: "Helvetica-Bold" }}>{letter}</Text>
                )}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function ClueColumns({ clues }: { clues: CrosswordClue[] }) {
  const across = clues.filter((c) => c.orientation === "across").sort((a, b) => a.position - b.position);
  const down = clues.filter((c) => c.orientation === "down").sort((a, b) => a.position - b.position);
  return (
    <View style={styles.cluesRow}>
      <View style={styles.cluesCol}>
        <Text style={styles.cluesHeading}>Across</Text>
        {across.map((c) => (
          <Text key={`a${c.position}`} style={styles.clueLine}>
            {c.position}. {c.clue}
          </Text>
        ))}
      </View>
      <View style={styles.cluesCol}>
        <Text style={styles.cluesHeading}>Down</Text>
        {down.map((c) => (
          <Text key={`d${c.position}`} style={styles.clueLine}>
            {c.position}. {c.clue}
          </Text>
        ))}
      </View>
    </View>
  );
}

function formatLongDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

/** `digest` suppresses this document's own "Page X of Y" (only correct relative to its own
 *  PDF) since a digest bundle gets one correct page count drawn across the whole assembled
 *  document instead — see packages/core/src/delivery/merge.ts. */
function CrosswordDocument({
  masthead,
  puzzle,
  date,
  digest,
}: {
  masthead: string;
  puzzle: CrosswordPuzzle;
  date: Date;
  digest?: boolean;
}) {
  const dateFormatted = formatLongDate(date);
  const pageStyle = digest ? [styles.page, styles.pageDigestPad] : styles.page;
  const subtitle = [puzzle.title, puzzle.author && `by ${puzzle.author}`].filter(Boolean).join(" — ");
  const footer = (
    <Text
      style={styles.footer}
      render={({ pageNumber, totalPages }) =>
        digest ? "Delivered by Daily Scribe" : `Delivered by Daily Scribe · Page ${pageNumber} of ${totalPages}`
      }
      fixed
    />
  );
  return (
    <Document title={`${masthead} — ${formatIsoDate(date)}`} author="Daily Scribe">
      <Page size="A4" style={pageStyle}>
        <Text style={styles.masthead}>{masthead}</Text>
        <Text style={styles.date}>{dateFormatted}</Text>
        {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        {!digest && (
          <Link src={BUY_ME_A_COFFEE_URL} style={styles.coffee}>
            Enjoy this with your coffee? Consider buying the creator one, it helps cover the running costs.
          </Link>
        )}
        <CrosswordGrid puzzle={puzzle} reveal={false} maxHeight={330} />
        <ClueColumns clues={puzzle.clues} />
        {footer}
      </Page>
      {/* A deliberate spacer page: a swipe or two of friction so a reader
          flipping between pages doesn't land on the answer key by accident
          (real user feedback — see the crossword's SERVICE_CATALOG note). */}
      <Page size="A4" style={pageStyle}>
        <Text style={styles.spacerText}>— Turn the page for today's answers —</Text>
        {footer}
      </Page>
      <Page size="A4" style={pageStyle}>
        <Text style={styles.masthead}>{masthead} — Answers</Text>
        <Text style={styles.date}>{dateFormatted}</Text>
        <CrosswordGrid puzzle={puzzle} reveal maxHeight={660} />
        {footer}
      </Page>
    </Document>
  );
}

/** Render a crossword puzzle to a PDF buffer (pure JS — no native deps, runs on Vercel). */
export async function renderCrosswordPdf(
  puzzle: CrosswordPuzzle,
  date: Date,
  opts: { masthead?: string; digest?: boolean } = {},
): Promise<Buffer> {
  const masthead = opts.masthead ?? "Crossword";
  return renderToBuffer(<CrosswordDocument masthead={masthead} puzzle={puzzle} date={date} digest={opts.digest} />);
}
