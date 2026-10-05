import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy policy | open-autoDM",
  description: "How the sakethrambilla open-autoDM application uses and protects Instagram data.",
};

export default function PrivacyPage() {
  return (
    <>
      <section>
        <h1>Privacy policy</h1>
        <p className="mt-3 text-sm text-muted-foreground">Effective date: October 5, 2026</p>
        <p>This policy applies to the open-autoDM application at instagram.sakethrambilla.com, operated by Saketh Ram Billa (@sakethrambilla), and its Meta application named sakethrambilla. The application lets authorized Instagram account owners automate comment replies and direct messages.</p>
      </section>
      <section>
        <h2>Information we process</h2>
        <ul>
          <li>Application sign-in information, such as the authorized user&apos;s email, profile details, and authentication session.</li>
          <li>Connected Instagram account IDs, usernames, profile information, authorization tokens, and token expiry dates.</li>
          <li>Instagram media IDs, captions, thumbnails, comments, messages, story interactions, and button responses made available through the permissions granted to the application.</li>
          <li>Participant IDs and usernames, message content, automation settings, delivery status, timestamps, and operational logs needed to run and troubleshoot automations.</li>
        </ul>
      </section>
      <section>
        <h2>How we use information</h2>
        <p>We use this information to connect an authorized Instagram account, display its media, match interactions to configured rules, send the account owner&apos;s configured replies, prevent duplicate sends, show automation history, and maintain service reliability and security. We access Instagram data through Meta&apos;s APIs and only within the granted permissions.</p>
        <p>We do not sell Instagram data, use it for unrelated advertising, or use it to train AI models.</p>
      </section>
      <section>
        <h2>Service providers and disclosure</h2>
        <p>Meta processes Instagram interactions and receives replies sent through its APIs. Vercel hosts the application, Supabase provides authentication and database storage, and Inngest coordinates background processing. These providers process information needed to deliver their services. The instance operator and authorized application users can access the records needed to manage connected accounts.</p>
        <p>Information may also be disclosed when necessary to comply with a legal obligation or protect the service against abuse. Provider processing may take place outside your country.</p>
      </section>
      <section>
        <h2>Storage, retention, and security</h2>
        <p>Instagram access tokens and Meta application secrets are encrypted before database storage. Access to account data is restricted through authentication and database access controls. No storage or transmission system can guarantee absolute security.</p>
        <p>Connected account information, configured automations, contacts, and related history are retained while needed to operate the account, until disconnected or deleted following a verified request. The application&apos;s scheduled cleanup removes older operational records; completed webhook payloads are eligible for redaction after seven days and terminal webhook records after thirty days. Provider logs and backups follow the providers&apos; retention schedules and may remain after deletion from the active database.</p>
      </section>
      <section>
        <h2>Cookies and your choices</h2>
        <p>The application uses authentication cookies to keep authorized users signed in. You can stop an automation, disconnect an Instagram account in Settings, or revoke the application&apos;s access through Instagram&apos;s Apps and websites settings. Revoking access in Instagram stops future authorized access but does not itself delete information already stored by this application.</p>
        <p>For deletion or correction requests, follow the <Link href="/data-deletion">data-deletion instructions</Link> or contact <a href="https://www.instagram.com/sakethrambilla/">@sakethrambilla on Instagram</a>. Do not send passwords or access tokens.</p>
      </section>
      <section>
        <h2>Policy updates</h2>
        <p>Changes to this policy will be published on this page with an updated effective date.</p>
      </section>
    </>
  );
}
