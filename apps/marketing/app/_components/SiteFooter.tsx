import { BUY_ME_A_COFFEE_URL, CONTACT_EMAIL, OWNER_NAME, SIGN_IN_URL } from "@/lib/site";

// Shared across the landing page and the legal pages so the Privacy / Terms
// links and the ownership line appear identically everywhere.
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div className="footer-brand">
          <h2>The Daily Scribe</h2>
          <p>One inbox. One PDF. Every morning.</p>
        </div>
        <div className="footer-links">
          <div className="footer-col">
            <h4>Sections</h4>
            <a href="/#practice">Practice</a>
            <a href="/#play">Play</a>
            <a href="/#dnd">Dungeons &amp; Dragons</a>
            <a href="/#read">Read</a>
            <a href="/#live">Live</a>
          </div>
          <div className="footer-col">
            <h4>Coming Soon</h4>
            <a href="/#read">Classic Novels</a>
            <a href="/#health">Eating &amp; Drinking</a>
          </div>
          <div className="footer-col">
            <h4>Account</h4>
            <a href="/#open-source">Open Source</a>
            <a href={SIGN_IN_URL}>Sign In</a>
            <a href={BUY_ME_A_COFFEE_URL} target="_blank" rel="noopener">
              Buy Me a Coffee
            </a>
          </div>
          <div className="footer-col">
            <h4>Info</h4>
            <a href="/guides">Guides</a>
            <a href="/faq">FAQ</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href={`mailto:${CONTACT_EMAIL}`}>Contact</a>
          </div>
        </div>
      </div>
      <div className="container footer-legal">
        <span>&copy; {new Date().getFullYear()} The Daily Scribe</span>
        <span>
          An independent project by {OWNER_NAME} &middot;{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </span>
      </div>
    </footer>
  );
}
