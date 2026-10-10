import type { Asset } from "@dailyscribe/core";
import {
  Document,
  Image,
  Link,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";

import { BUY_ME_A_COFFEE_URL } from "@/lib/site";
import { heroCoverArtBase64 } from "./digest-cover-art";

// A4 in PDF points (pdfkit's own PAGE_SIZES constant) — needed here (not
// just passed to <Page size="A4">) because tocRowRect must compute each
// TOC row's on-page rectangle in the same coordinate space pdf-lib will
// place a Link annotation in.
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 48;
const HEADING_BLOCK_HEIGHT = 64;
const ROW_HEIGHT = 34;
const TOC_ROWS_TOP = MARGIN_TOP + HEADING_BLOCK_HEIGHT;

const styles = StyleSheet.create({
  coverPage: {
    paddingVertical: 48,
    paddingHorizontal: 56,
    fontFamily: "Helvetica",
    color: "#111111",
    alignItems: "center",
    justifyContent: "center",
  },
  coverArt: { width: 146, height: 160 },
  coverTitle: { fontSize: 30, fontWeight: "bold", marginTop: 24, textAlign: "center" },
  coverDate: { fontSize: 13, color: "#444444", marginTop: 8, textAlign: "center" },
  coverTagline: { fontSize: 10, color: "#888888", marginTop: 16, textAlign: "center" },
  coverCoffee: { fontSize: 9, color: "#888888", marginTop: 10, textAlign: "center" },

  tocPage: { paddingVertical: MARGIN_TOP, paddingHorizontal: MARGIN_X, fontFamily: "Helvetica", color: "#111111" },
  tocHeading: { fontSize: 20, fontWeight: "bold" },
  tocRow: {
    height: ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "0.5pt solid #dddddd",
  },
  tocLabel: { fontSize: 12 },
  tocPageNum: { fontSize: 11, color: "#666666" },

  legal: { position: "absolute", bottom: 40, left: MARGIN_X, right: MARGIN_X, fontSize: 8, color: "#888888", textAlign: "center" },
  legalLink: { color: "#6ea8fe" },
});

/** A TOC row's clickable rectangle in PDF points (bottom-left origin) —
 *  must exactly match tocRow's layout (fixed heading block + fixed-height,
 *  unpadded rows) so the link annotation pdf-lib adds later lands where
 *  the row actually is. */
function tocRowRect(index: number): [number, number, number, number] {
  const topFromPageTop = TOC_ROWS_TOP + index * ROW_HEIGHT;
  const bottomFromPageTop = topFromPageTop + ROW_HEIGHT;
  return [MARGIN_X, PAGE_HEIGHT - bottomFromPageTop, PAGE_WIDTH - MARGIN_X, PAGE_HEIGHT - topFromPageTop];
}

export interface DigestCoverSection {
  label: string;
  /** 1-indexed page number in the final assembled digest. */
  startPage: number;
}

export interface DigestCoverResult {
  /** 2-page PDF: page 1 cover, page 2 table of contents. */
  asset: Asset;
  /** One rect per section, same order as the input — for wiring TOC links. */
  tocLinkRects: [number, number, number, number][];
}

function DigestCoverDocument({ sections, dateFormatted }: { sections: DigestCoverSection[]; dateFormatted: string }) {
  return (
    <Document title="Daily Scribe Digest" author="Daily Scribe">
      <Page size="A4" style={styles.coverPage}>
        <Image style={styles.coverArt} src={`data:image/png;base64,${heroCoverArtBase64}`} />
        <Text style={styles.coverTitle}>Daily Scribe</Text>
        <Text style={styles.coverDate}>{dateFormatted}</Text>
        <Text style={styles.coverTagline}>Your daily services, bundled into one PDF.</Text>
        <Link src={BUY_ME_A_COFFEE_URL} style={styles.coverCoffee}>
          Enjoy this with your coffee? Consider buying the creator one, it helps cover the running costs.
        </Link>
      </Page>
      <Page size="A4" style={styles.tocPage}>
        <View style={{ height: HEADING_BLOCK_HEIGHT, justifyContent: "flex-end" }}>
          <Text style={styles.tocHeading}>Table of Contents</Text>
        </View>
        {sections.map((s) => (
          <View key={s.label} style={styles.tocRow}>
            <Text style={styles.tocLabel}>{s.label}</Text>
            <Text style={styles.tocPageNum}>page {s.startPage}</Text>
          </View>
        ))}
        <View style={styles.legal}>
          <Text>
            <Link src="https://www.dailyscribe.ca" style={styles.legalLink}>
              www.dailyscribe.ca
            </Link>
          </Text>
          <Text style={{ marginTop: 4 }}>
            Bundled content is aggregated from third-party sources for personal use. Daily Scribe claims no
            copyright over it and is not liable for its accuracy or any issues arising from its use.
          </Text>
        </View>
      </Page>
    </Document>
  );
}

export async function renderDigestCoverPdf(sections: DigestCoverSection[], date: Date): Promise<DigestCoverResult> {
  const dateFormatted = new Intl.DateTimeFormat("en-CA", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);

  const bytes = await renderToBuffer(<DigestCoverDocument sections={sections} dateFormatted={dateFormatted} />);

  return {
    asset: { filename: "digest-cover.pdf", contentType: "application/pdf", bytes },
    tocLinkRects: sections.map((_, i) => tocRowRect(i)),
  };
}
