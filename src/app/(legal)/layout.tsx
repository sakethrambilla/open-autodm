import Link from "next/link";

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background px-6 py-10 text-foreground sm:py-16">
      <div className="mx-auto max-w-3xl">
        <header className="mb-10 flex flex-wrap items-center justify-between gap-4 border-b border-border pb-6">
          <Link href="/" className="text-lg font-semibold">open-autoDM</Link>
          <nav aria-label="Privacy information" className="flex gap-5 text-sm underline underline-offset-4">
            <Link href="/privacy">Privacy policy</Link>
            <Link href="/data-deletion">Data deletion</Link>
          </nav>
        </header>
        <main className="space-y-8 text-base leading-7 [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_p+p]:mt-3 [&_a]:underline [&_a]:underline-offset-4 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-6">
          {children}
        </main>
      </div>
    </div>
  );
}
