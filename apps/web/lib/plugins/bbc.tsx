import { formatIsoDate, type Asset, type RunContext, type ServicePlugin } from "@dailyscribe/core";
import {
  Document,
  Link,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import { XMLParser } from "fast-xml-parser";
import { ALL_BBC_FEEDS, BBC_FEEDS, type BbcFeed } from "@/lib/bbc-feeds";
import { BUY_ME_A_COFFEE_URL } from "@/lib/site";

const FEEDS_BY_KEY = new Map(ALL_BBC_FEEDS.map((f) => [f.key, f]));
const DEFAULT_MAX_PER_FEED = 9;
const SUMMARY_MAX_CHARS = 320;

export interface BbcConfig {
  feeds: BbcFeed[];
  maxPerFeed: number;
}

/** Validate untyped subscription config into a concrete BBC config. */
export function parseBbcConfig(config: unknown): BbcConfig {
  const raw = (config ?? {}) as { feeds?: unknown; maxPerFeed?: unknown };
  const requested = Array.isArray(raw.feeds) ? raw.feeds.filter((k): k is string => typeof k === "string") : [];
  const feeds = requested.map((k) => FEEDS_BY_KEY.get(k)).filter((f): f is BbcFeed => Boolean(f));
  const maxRaw = typeof raw.maxPerFeed === "number" ? Math.floor(raw.maxPerFeed) : DEFAULT_MAX_PER_FEED;
  return {
    feeds: feeds.length > 0 ? feeds : BBC_FEEDS,
    maxPerFeed: Math.min(Math.max(maxRaw, 1), 15),
  };
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** Strip HTML tags + decode common entities from a feed summary, collapsing whitespace. */
export function toPlainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface NewsItem {
  title: string;
  summary: string;
  /** Article URL from the feed; when present the headline renders as a tappable link. */
  link?: string;
}

export interface NewsSection {
  label: string;
  items: NewsItem[];
}

const USER_AGENT = "Mozilla/5.0 (compatible; DailyScribe/0.1)";
const FEED_TIMEOUT_MS = 15000;

// fast-xml-parser folds CDATA into the tag's text value by default, which is what we want.
const xml = new XMLParser({ ignoreAttributes: true, processEntities: true, trimValues: true });

interface RssItem {
  title?: unknown;
  link?: unknown;
  description?: unknown;
  "content:encoded"?: unknown;
}

/** Parse RSS 2.0 XML into our items. Tolerates a single-item channel (parser returns an object, not array). */
function parseRssItems(body: string, max: number): NewsItem[] {
  const doc = xml.parse(body) as { rss?: { channel?: { item?: RssItem | RssItem[] } } };
  const raw = doc?.rss?.channel?.item;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr.slice(0, max).map((it) => {
    const summary = toPlainText(String(it.description ?? it["content:encoded"] ?? ""));
    const rawLink = String(it.link ?? "").trim();
    return {
      title: toPlainText(String(it.title ?? "Untitled")),
      link: /^https?:\/\//.test(rawLink) ? rawLink : undefined,
      summary: summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS)}…` : summary,
    };
  });
}

/**
 * Fetch and parse each feed into a section, using the platform fetch (works under
 * Next/Vercel). Per-feed failures are tolerated (a bad feed is skipped, not fatal)
 * so one outage can't sink the whole edition.
 */
export async function fetchBbcSections(cfg: BbcConfig): Promise<NewsSection[]> {
  const sections = await Promise.all(
    cfg.feeds.map(async (feed): Promise<NewsSection | null> => {
      try {
        const res = await fetch(feed.url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml, text/xml" },
          signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const items = parseRssItems(await res.text(), cfg.maxPerFeed);
        return items.length > 0 ? { label: feed.label, items } : null;
      } catch (err) {
        console.warn(`BBC feed "${feed.key}" failed:`, err instanceof Error ? err.message : err);
        return null;
      }
    }),
  );
  return sections.filter((s): s is NewsSection => s !== null);
}

const styles = StyleSheet.create({
  page: { paddingVertical: 48, paddingHorizontal: 56, fontFamily: "Helvetica", color: "#111111" },
  masthead: { fontSize: 26, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  date: { fontSize: 12, color: "#444444", marginBottom: 18 },
  section: { marginBottom: 16 },
  sectionTitle: {
    fontSize: 15,
    fontFamily: "Helvetica-Bold",
    borderBottom: "1pt solid #000000",
    paddingBottom: 3,
    marginBottom: 8,
  },
  item: { marginBottom: 9 },
  itemTitle: { fontSize: 11.5, fontFamily: "Helvetica-Bold", lineHeight: 1.3 },
  // Tappable headline: keep e-ink-friendly dark text; underline is the tap affordance.
  itemLink: { color: "#111111", textDecoration: "underline" },
  itemSummary: { fontSize: 9.5, color: "#333333", lineHeight: 1.4, marginTop: 2 },
  footer: { position: "absolute", bottom: 24, left: 56, right: 56, fontSize: 8, color: "#888888", textAlign: "center" },
  coffee: { fontSize: 9, color: "#888888", marginBottom: 14 },
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

/** The PDF document for a BBC edition. Grayscale, generous type — built for e-ink.
 *  `digest` suppresses this document's own "Page X of Y" (only correct
 *  relative to its own PDF) since a digest bundle gets one correct page
 *  count drawn across the whole assembled document instead. */
function BbcDocument({ sections, date, digest }: { sections: NewsSection[]; date: Date; digest?: boolean }) {
  return (
    <Document title={`BBC News — ${formatIsoDate(date)}`} author="Daily Scribe">
      <Page size="A4" style={styles.page} wrap>
        <Text style={styles.masthead}>BBC News</Text>
        <Text style={styles.date}>{formatLongDate(date)}</Text>
        {!digest && (
          <Link src={BUY_ME_A_COFFEE_URL} style={styles.coffee}>
            Enjoy this with your coffee? Consider buying the creator one, it helps cover the running costs.
          </Link>
        )}
        {sections.map((section) => (
          <View key={section.label} style={styles.section} wrap={false}>
            <Text style={styles.sectionTitle}>{section.label}</Text>
            {section.items.map((item, i) => (
              <View key={i} style={styles.item} wrap={false}>
                {item.link ? (
                  <Link src={item.link} style={[styles.itemTitle, styles.itemLink]}>
                    {item.title}
                  </Link>
                ) : (
                  <Text style={styles.itemTitle}>{item.title}</Text>
                )}
                {item.summary ? <Text style={styles.itemSummary}>{item.summary}</Text> : null}
              </View>
            ))}
          </View>
        ))}
        <Text
          style={styles.footer}
          render={({ pageNumber, totalPages }) =>
            digest ? "Delivered by Daily Scribe" : `Delivered by Daily Scribe · Page ${pageNumber} of ${totalPages}`
          }
          fixed
        />
      </Page>
    </Document>
  );
}

/** Render BBC sections to a PDF buffer (pure JS — no native deps, runs on Vercel). */
export async function renderBbcPdf(sections: NewsSection[], date: Date, digest?: boolean): Promise<Buffer> {
  return renderToBuffer(<BbcDocument sections={sections} date={date} digest={digest} />);
}

export const bbcNewsPlugin: ServicePlugin = {
  id: "bbc",
  label: "BBC News",
  async run(ctx: RunContext): Promise<Asset[]> {
    const cfg = parseBbcConfig(ctx.config);
    const sections = await fetchBbcSections(cfg);
    if (sections.length === 0) {
      throw new Error("No BBC feeds could be fetched — all sources failed or returned empty.");
    }
    const bytes = await renderBbcPdf(sections, ctx.date, ctx.digest);
    return [
      {
        filename: `bbc-news-${formatIsoDate(ctx.date)}.pdf`,
        contentType: "application/pdf",
        bytes,
      },
    ];
  },
};
