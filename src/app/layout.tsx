import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import { AppProviders } from "@/components/providers/Providers";
import "./globals.css";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "open-autoDM",
  description:
    "Open-source, self-hosted Instagram comment-to-DM automation. Your own Meta app, your own Supabase, your own deployment.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${archivo.variable} font-sans antialiased bg-background text-foreground transition-colors duration-300`}
      >
        <AppProviders>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
