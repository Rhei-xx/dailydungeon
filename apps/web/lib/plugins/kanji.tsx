import {
  collections,
  formatIsoDate,
  getOrCreateKanjiProgress,
  KANJI_CURRICULUM,
  parseKanjiConfig,
  selectDailyBatch,
  type Asset,
  type DailyKanjiBatch,
  type KanjiEntry,
  type RunContext,
  type ServicePlugin,
} from "@dailyscribe/core";
import { Document, Font, G, Line, Link, Page, Path, Rect, StyleSheet, Svg, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { BUY_ME_A_COFFEE_URL } from "@/lib/site";
import { NOTO_SANS_JP_400, NOTO_SANS_JP_700 } from "./fonts/noto-sans-jp";

const PRACTICE_BOXES = 6;
const GLYPH_VIEWBOX = 109; // KanjiVG's native coordinate space
const FONT_FAMILY = "NotoSansJP";

// Helvetica (react-pdf's default) has no Japanese glyphs; every kanji/kana
// string in this document needs a CJK-capable font instead. The font is
// inlined as a base64 data URI (see ./fonts/noto-sans-jp.ts) rather than
// loaded from a .ttf file at runtime — Next's serverless file tracing
// didn't reliably bundle a file-based font across a Vercel monorepo build,
// causing an ENOENT in production. It's a Noto Sans JP *subset* containing
// only hiragana/katakana + the kanji curriculum's own glyphs (built via
// Google Fonts' `text=` subsetting param), to keep it small.
Font.register({
  family: FONT_FAMILY,
  fonts: [
    { src: NOTO_SANS_JP_400, fontWeight: "normal" },
    { src: NOTO_SANS_JP_700, fontWeight: "bold" },
  ],
});

// React-PDF Stylesheet
const styles = StyleSheet.create({
  page: { paddingVertical: 40, paddingHorizontal: 48, fontFamily: FONT_FAMILY, color: "#111111" },
  masthead: { fontSize: 24, fontWeight: "bold", marginBottom: 2 },
  date: { fontSize: 11, color: "#444444", marginBottom: 14 },
  completedNote: { fontSize: 9.5, color: "#666666", marginBottom: 14 },
  mailBack: { fontSize: 9.5, color: "#555555", marginBottom: 14 },
  coffee: { fontSize: 9, color: "#888888", marginBottom: 14 },
  mailBackAddr: { fontWeight: "bold", color: "#222222" },
  card: { marginBottom: 22, paddingBottom: 16, borderBottom: "0.5pt solid #dddddd" },
  cardHeader: { flexDirection: "row", marginBottom: 8 },
  glyphCol: { width: 100, alignItems: "center" },
  jlptBadge: { fontSize: 8, color: "#666666", marginTop: 2 },
  infoCol: { flex: 1, paddingLeft: 16 },
  meanings: { fontSize: 13, fontWeight: "bold", marginBottom: 4 },
  readingRow: { fontSize: 9.5, color: "#333333", marginBottom: 2 },
  readingLabel: { fontWeight: "bold" },
  exampleRow: { fontSize: 9.5, color: "#222222", marginTop: 4 },
  practiceLabel: { fontSize: 8, color: "#888888", marginBottom: 4 },
  practiceRow: { flexDirection: "row" },
  footer: { position: "absolute", bottom: 22, left: 48, right: 48, fontSize: 7.5, color: "#888888", textAlign: "center" },
  footerRef: { position: "absolute", bottom: 10, left: 48, right: 48, fontSize: 7.5, color: "#888888", textAlign: "center" },
});

/** The full character rendered from its KanjiVG stroke paths, as a static outline. */
function GlyphSvg({ entry, size }: { entry: KanjiEntry; size: number }) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${GLYPH_VIEWBOX} ${GLYPH_VIEWBOX}`}>
      <G fill="none" stroke="#111111" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
        {entry.strokes.map((s, i) => (
          <Path key={i} d={s.d} />
        ))}
      </G>
    </Svg>
  );
}

/** One genkouyoushi-style practice box: a bordered square with a light dashed
 *  center guide, optionally showing a faint reference glyph to trace first. */
function PracticeBox({ size, traceChar }: { size: number; traceChar?: string }) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Rect x={0} y={0} width={size} height={size} fill="none" stroke="#999999" strokeWidth={1} />
      <Line x1={size / 2} y1={0} x2={size / 2} y2={size} stroke="#dddddd" strokeWidth={0.5} strokeDasharray="2,2" />
      <Line x1={0} y1={size / 2} x2={size} y2={size / 2} stroke="#dddddd" strokeWidth={0.5} strokeDasharray="2,2" />
      {traceChar && (
        <Text
          x={size / 2}
          y={size / 2 + size * 0.17}
          textAnchor="middle"
          style={{ fontFamily: FONT_FAMILY, fontSize: size * 0.55, fill: "#cccccc" }}
        >
          {traceChar}
        </Text>
      )}
    </Svg>
  );
}

function KanjiCard({ entry }: { entry: KanjiEntry }) {
  const boxSize = 52;
  return (
    <View style={styles.card} wrap={false}>
      <View style={styles.cardHeader}>
        <View style={styles.glyphCol}>
          <GlyphSvg entry={entry} size={72} />
          <Text style={styles.jlptBadge}>
            N{entry.jlpt} · {entry.strokeCount} strokes
          </Text>
        </View>
        <View style={styles.infoCol}>
          <Text style={styles.meanings}>{entry.meanings.join(", ")}</Text>
          {entry.onyomi.length > 0 && (
            <Text style={styles.readingRow}>
              <Text style={styles.readingLabel}>On: </Text>
              {entry.onyomi.join("、")}
            </Text>
          )}
          {entry.kunyomi.length > 0 && (
            <Text style={styles.readingRow}>
              <Text style={styles.readingLabel}>Kun: </Text>
              {entry.kunyomi.join("、")}
            </Text>
          )}
          <Text style={styles.exampleRow}>
            {entry.example.word} ({entry.example.reading}) — {entry.example.meaning}
          </Text>
        </View>
      </View>
      <Text style={styles.practiceLabel}>Practice</Text>
      <View style={styles.practiceRow}>
        {Array.from({ length: PRACTICE_BOXES }).map((_, i) => (
          <View key={i} style={{ marginRight: 6 }}>
            <PracticeBox size={boxSize} traceChar={i === 0 ? entry.char : undefined} />
          </View>
        ))}
      </View>
    </View>
  );
}

/** `digest` suppresses this document's own "Page X of Y" (only correct
 *  relative to its own PDF) since a digest bundle gets one correct page
 *  count drawn across the whole assembled document instead — the rest of
 *  the footer (attribution, and critically the `Ref:` marker the inbound
 *  webhook matches on) stays exactly as-is either way. */
export function KanjiDocument({
  batch,
  date,
  inboundToken,
  digest,
}: {
  batch: DailyKanjiBatch;
  date: Date;
  inboundToken: string;
  digest?: boolean;
}) {
  const dateFormatted = new Intl.DateTimeFormat("en-CA", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);

  return (
    <Document title={`Kanji A Day — ${formatIsoDate(date)}`} author="Daily Scribe">
      <Page size="A4" style={styles.page} wrap>
        <Text style={styles.masthead}>Kanji A Day</Text>
        <Text style={styles.date}>{dateFormatted}</Text>
        {/* The address is the literal users whitelist in Amazon and see in
         *  onboarding; the actual inbound routing address is my@${RESEND_INBOUND_DOMAIN}. */}
        <Text style={styles.mailBack}>
          Write your answers in the boxes, then email this page to{" "}
          <Text style={styles.mailBackAddr}>my@dailyscribe.ca</Text>
          {" "}— Daily Scribe reads your handwriting, grades it, and tracks your progress.
        </Text>
        {!digest && (
          <Link src={BUY_ME_A_COFFEE_URL} style={styles.coffee}>
            Enjoy this with your coffee? Consider buying the creator one, it helps cover the running costs.
          </Link>
        )}
        {batch.isRetry && (
          <Text style={styles.completedNote}>
            A few of these didn&apos;t come through clearly last time — here they are again for more practice.
          </Text>
        )}
        {batch.levelCompleted && (
          <Text style={styles.completedNote}>
            You&apos;ve reached the end of this level — here&apos;s a review of the last batch.
          </Text>
        )}
        {batch.entries.map((entry) => (
          <KanjiCard key={entry.char} entry={entry} />
        ))}
        <Text
          style={styles.footer}
          render={({ pageNumber, totalPages }) => {
            const pageInfo = digest ? "" : ` · Page ${pageNumber} of ${totalPages}`;
            return `Delivered by Daily Scribe${pageInfo} · Kanji data: KANJIDIC2/EDRDG (CC BY-SA 4.0). Stroke diagrams: KanjiVG, © Ulrich Apel (CC BY-SA 3.0).`;
          }}
          fixed
        />
        {/* Its own line, never sharing space with the attribution text above:
         *  that line's length varies (digest vs. standalone, retry notes),
         *  and once it wrapped, react-pdf hyphenated across "dailyscribe:kanji:…"
         *  itself — splitting the literal token the inbound webhook regex
         *  matches on, so a real mailed-back digest went unrecognized. */}
        <Text style={styles.footerRef} fixed>
          {`Ref: dailyscribe:kanji:${inboundToken}`}
        </Text>
      </Page>
    </Document>
  );
}

export async function renderKanjiPdf(
  batch: DailyKanjiBatch,
  date: Date,
  inboundToken: string,
  digest?: boolean,
): Promise<Buffer> {
  return renderToBuffer(<KanjiDocument batch={batch} date={date} inboundToken={inboundToken} digest={digest} />);
}

export const kanjiPlugin: ServicePlugin = {
  id: "kanji",
  label: "Kanji A Day",
  async run(ctx: RunContext): Promise<Asset[]> {
    const config = parseKanjiConfig(ctx.config);
    const pool = KANJI_CURRICULUM.filter((e) => e.jlpt >= config.maxJlptLevel);
    if (pool.length === 0) {
      throw new Error(`No kanji available for JLPT N${config.maxJlptLevel}+.`);
    }

    const progress = await getOrCreateKanjiProgress(ctx.userId);
    const batch = selectDailyBatch(KANJI_CURRICULUM, pool, progress.cursor, config.kanjiPerDay, progress.retryChars ?? []);
    const bytes = await renderKanjiPdf(batch, ctx.date, progress.inboundToken, ctx.digest);

    // Only advance the cursor once the PDF has actually been built, so a
    // render failure never skips kanji the user never received. Snapshot
    // the sent batch's characters so a future check-in can know what was
    // expected without re-deriving it from cursor math. A retry batch never
    // advances the cursor — it's a resend of characters a past check-in
    // flagged as unclear/no_attempt, not new curriculum.
    const { kanjiProgress } = await collections();
    if (!batch.isRetry && !batch.levelCompleted) {
      await kanjiProgress.updateOne(
        { userId: ctx.userId },
        {
          $inc: { cursor: batch.entries.length },
          $set: { lastBatchChars: batch.entries.map((e) => e.char), updatedAt: new Date() },
        },
      );
    } else {
      await kanjiProgress.updateOne(
        { userId: ctx.userId },
        { $set: { lastBatchChars: batch.entries.map((e) => e.char), updatedAt: new Date() } },
      );
    }

    return [
      {
        filename: `kanji-${formatIsoDate(ctx.date)}.pdf`,
        contentType: "application/pdf",
        bytes,
      },
    ];
  },
};
