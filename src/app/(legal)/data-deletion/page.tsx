import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Data deletion | open-autoDM",
  description: "How to request deletion of data held by the sakethrambilla open-autoDM application.",
};

export default function DataDeletionPage() {
  return (
    <>
      <section>
        <h1>Data-deletion instructions</h1>
        <p className="mt-3 text-sm text-muted-foreground">Effective date: October 5, 2026</p>
        <p>These instructions apply to the sakethrambilla Meta application and open-autoDM at instagram.sakethrambilla.com, operated by Saketh Ram Billa (@sakethrambilla).</p>
      </section>
      <section>
        <h2>Connected Instagram account owners</h2>
        <ol>
          <li>Sign in to open-autoDM and open Settings.</li>
          <li>Select Disconnect for the Instagram account you want removed and confirm the deletion.</li>
          <li>To revoke Meta authorization as well, remove sakethrambilla or sakethrambilla-IG from Instagram&apos;s Apps and websites settings.</li>
        </ol>
        <p>Disconnecting deletes the account&apos;s stored access token and account record, along with its automations, contacts, webhook records, jobs, and related conversation history in the active database. It does not delete your application sign-in account or messages and comments already present on Instagram.</p>
      </section>
      <section>
        <h2>Participants and other deletion requests</h2>
        <p>If you interacted with an automation, cannot access Settings, or want your application sign-in account deleted, send a direct message to <a href="https://www.instagram.com/sakethrambilla/">@sakethrambilla on Instagram</a> with the subject “AutoDM data deletion”.</p>
        <ul>
          <li>Identify your Instagram username and the account or automation you interacted with.</li>
          <li>Describe whether you want interaction records, connected account data, or your application sign-in account deleted.</li>
          <li>Send the request from the relevant Instagram account where possible so we can verify ownership. Never send passwords, access tokens, or identity documents.</li>
        </ul>
        <p>After verifying the request, the operator will delete the relevant records from the active database and reply with confirmation or explain any information needed to complete the request. Limited records may be retained where required by law or necessary for security. Provider logs and backups expire under the providers&apos; retention schedules.</p>
      </section>
      <section>
        <h2>Data held by Instagram</h2>
        <p>Deleting application data does not remove content from Instagram or other recipients&apos; inboxes. Manage those comments, messages, and account data directly through Instagram.</p>
      </section>
    </>
  );
}
